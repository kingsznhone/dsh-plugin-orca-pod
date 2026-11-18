import { describe, expect, it } from "vitest";

import { CANDIDATE_MAX_FAILURES, type MeshTimings } from "../src/mesh/timings.ts";
import type { OrcaNodeId } from "../src/core/wire/peer.ts";
import { fakeNodeId, labelId } from "./fixtures/ids.ts";
import { listed, testMesh } from "./support/mesh.ts";

const TIMINGS: MeshTimings = {
  intervalMs: 200,
  suspectAfterMs: 600,
  offlineAfterMs: 1200,
  recoverProbeMs: 1500,
  maxRecoverProbeMs: 3000,
  recordTtlMs: 5000,
  tombstoneMs: 10000,
  heartbeatTimeoutMs: 50,
};

const B = labelId("BBBBBB");
const C = labelId("CCCCCC");
const D = labelId("DDDDDD");

function setup() {
  return testMesh(TIMINGS);
}

/** Whether a hello to the node is due now. */
function isDue(table: ReturnType<typeof setup>, id: OrcaNodeId): boolean {
  return table.mesh.require(id).due(table.clock.monotonicMs());
}

/** One failed greeting, the way the mesh counts it: a drop forgets the node and tombstones its id. */
function miss(table: ReturnType<typeof setup>, id: OrcaNodeId): void {
  const node = table.mesh.get(id);
  if (node?.missed(table.clock.monotonicMs(), table.mesh.timings) === "drop") table.mesh.remove(id);
}

describe("the node table", () => {
  it("has this node in it, always online, never due for a hello", () => {
    const { mesh, advance } = setup();
    expect(mesh.list().map((node) => node.id)).toEqual([mesh.self.id]);
    expect(mesh.get(mesh.self.id)).toBe(mesh.self);
    expect(mesh.self.isSelf).toBe(true);
    advance(1_000_000);
    mesh.evaluate();
    expect(mesh.self.state).toBe("online");
    expect(mesh.self.due(1_000_000)).toBe(false);
    // Nobody can forget it.
    mesh.remove(mesh.self.id);
    expect(mesh.get(mesh.self.id)).toBe(mesh.self);
  });

  it("lists the others apart from itself", () => {
    const table = setup();
    table.greeted(B);
    expect(table.mesh.list()).toHaveLength(2);
    expect(table.mesh.peers().map((node) => node.id)).toEqual([B]);
  });

  it("remote member lists add records but never mark them online", () => {
    const { mesh } = setup();
    mesh.mergeRemote([listed(B)]);

    expect(mesh.get(B)?.state).toBe("unknown");
    expect(mesh.get(B)?.view().last_recv_at).toBeNull();
    expect(mesh.get(B)?.isCandidate).toBe(true);
    expect(mesh.require(B).due(0)).toBe(true);
  });

  it("does not let a third-party roster overwrite a known member", () => {
    const { mesh } = setup();
    mesh.mergeRemote([listed(B)]);
    mesh.mergeRemote([listed(B, "http://192.0.2.9:11811", { display_name: "mallory" })]);

    const peer = mesh.get(B)?.view();
    expect(peer?.display_name).toBe("node-BBBBBB");
    expect(peer?.endpoints).toEqual(["http://127.0.0.1:11811"]);
  });

  it("walks online -> suspect(quiet) -> offline -> pruned from inbound silence", () => {
    const table = setup();
    const { mesh, advance } = table;
    mesh.mergeRemote([listed(B)]);
    table.hear(B);
    expect(mesh.get(B)?.state).toBe("online");

    advance(700);
    mesh.evaluate();
    expect(mesh.get(B)?.state).toBe("suspect");

    advance(600);
    mesh.evaluate();
    expect(mesh.get(B)?.state).toBe("offline");

    advance(5100);
    mesh.evaluate();
    expect(mesh.get(B)).toBeUndefined();
    expect(mesh.isTombstoned(B)).toBe(true);

    mesh.mergeRemote([listed(B)]);
    expect(mesh.get(B)).toBeUndefined();
  });

  it("marks suspect(unreachable) when sends fail but heartbeats still arrive", () => {
    const table = setup();
    const { mesh, advance } = table;
    mesh.mergeRemote([listed(B)]);
    table.hear(B);

    advance(100);
    miss(table, B);
    miss(table, B);
    miss(table, B);

    expect(mesh.get(B)?.state).toBe("suspect");

    mesh.require(B).answered();
    expect(mesh.get(B)?.state).toBe("online");

    miss(table, B);
    miss(table, B);
    miss(table, B);
    table.hear(B);
    expect(mesh.get(B)?.state).toBe("online");
  });

  it("a removed peer is tombstoned against stale lists", () => {
    const table = setup();
    const { mesh } = table;
    mesh.mergeRemote([listed(B)]);
    table.hear(B);

    mesh.remove(B);
    expect(mesh.peers()).toHaveLength(0);
    expect(mesh.isTombstoned(B)).toBe(true);

    mesh.mergeRemote([listed(B)]);
    expect(mesh.get(B)).toBeUndefined();
  });

  it("lets a removed node back in through its own greeting, while stale lists stay blocked", () => {
    const table = setup();
    const { mesh } = table;
    table.greeted(B);
    mesh.remove(B);
    expect(mesh.isTombstoned(B)).toBe(true);

    // The node leaves and comes back within the tombstone window: it proved the password
    // in the request, so the record must exist afterwards.
    table.greeted(B);
    expect(mesh.get(B)?.state).toBe("online");
    expect(mesh.isTombstoned(B)).toBe(false);

    mesh.remove(B);
    mesh.mergeRemote([listed(B)]);
    expect(mesh.get(B)).toBeUndefined();
  });

  it("offline peers back off probe attempts", () => {
    const table = setup();
    const { mesh, advance } = table;
    mesh.mergeRemote([listed(B)]);
    table.hear(B);
    advance(1300);
    mesh.evaluate();
    expect(mesh.get(B)?.state).toBe("offline");
    expect(isDue(table, B)).toBe(true);

    miss(table, B);
    expect(isDue(table, B)).toBe(false);
    advance(TIMINGS.recoverProbeMs);
    expect(isDue(table, B)).toBe(true);
  });

  it("backs off an unreached candidate like an offline peer and drops it after five failures (B24)", () => {
    const table = setup();
    const { mesh, advance } = table;
    mesh.mergeRemote([listed(D)]);
    for (let attempt = 1; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) {
      expect(isDue(table, D)).toBe(true);
      miss(table, D);
      expect(isDue(table, D)).toBe(false);
      advance(TIMINGS.maxRecoverProbeMs);
    }
    miss(table, D);
    expect(mesh.get(D)).toBeUndefined();
    expect(mesh.isTombstoned(D)).toBe(true);
    // A stale list cannot bring it straight back.
    mesh.mergeRemote([listed(D)]);
    expect(mesh.get(D)).toBeUndefined();
  });

  it("keeps a candidate that answers, so its failures start over", () => {
    const table = setup();
    const { mesh } = table;
    mesh.mergeRemote([listed(D)]);
    for (let attempt = 1; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) miss(table, D);
    table.hear(D);
    mesh.require(D).answered();
    miss(table, D);
    expect(mesh.get(D)?.state).toBe("online");
  });

  it("passes on only itself and the members it hears from, not candidates or offline nodes (B24)", () => {
    const table = setup();
    const { mesh, advance } = table;
    mesh.mergeRemote([listed(B), listed(C)]);
    table.hear(B);
    // C is a candidate this node never reached: kept locally, not passed on.
    expect(
      mesh
        .directory()
        .map((peer) => peer.orca_node_id)
        .sort(),
    ).toEqual([mesh.self.id, B].sort());
    expect(mesh.list()).toHaveLength(3);
    advance(TIMINGS.offlineAfterMs);
    mesh.evaluate();
    expect(mesh.get(B)?.state).toBe("offline");
    expect(mesh.directory().map((peer) => peer.orca_node_id)).toEqual([mesh.self.id]);
  });

  it("stops a dead node from circulating between two members (B24)", () => {
    const a = setup();
    const c = setup();
    // A knows D first-hand; C learns D only from A's directory.
    a.mesh.mergeRemote([listed(D)]);
    a.hear(D);
    c.mesh.mergeRemote(a.mesh.directory());
    // D dies. A stops vouching for it once it goes offline; C gives up on its candidate.
    for (let round = 0; round < 20; round += 1) {
      a.advance(TIMINGS.maxRecoverProbeMs);
      c.advance(TIMINGS.maxRecoverProbeMs);
      a.mesh.evaluate();
      c.mesh.evaluate();
      if (c.mesh.get(D) && isDue(c, D)) miss(c, D);
      if (a.mesh.get(D) && isDue(a, D)) miss(a, D);
      // They keep exchanging directories every round.
      a.mesh.mergeRemote(c.mesh.directory());
      c.mesh.mergeRemote(a.mesh.directory());
    }
    expect(c.mesh.get(D)).toBeUndefined();
    expect(a.mesh.directory().some((peer) => peer.orca_node_id === D)).toBe(false);
    // A keeps its own offline record until the record TTL, then prunes it for good.
    a.advance(TIMINGS.recordTtlMs);
    a.mesh.evaluate();
    expect(a.mesh.get(D)).toBeUndefined();
    c.mesh.mergeRemote(a.mesh.directory());
    a.mesh.mergeRemote(c.mesh.directory());
    expect(a.mesh.get(D)).toBeUndefined();
    expect(c.mesh.get(D)).toBeUndefined();
  });

  it("lets a dropped candidate back in when it greets itself, tombstone or not", () => {
    const table = setup();
    const { mesh } = table;
    mesh.mergeRemote([listed(D)]);
    for (let attempt = 0; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) miss(table, D);
    expect(mesh.isTombstoned(D)).toBe(true);
    // The node comes back and greets with both proofs.
    table.greeted(D);
    expect(mesh.get(D)?.state).toBe("online");
    expect(mesh.isTombstoned(D)).toBe(false);
  });
});

const NODE_B = fakeNodeId("row-b");
const NODE_C = fakeNodeId("row-c");

describe("a node as the table's row", () => {
  it("is found by id, by a unique display name, and by an address it advertises or answered at", () => {
    const table = setup();
    const { mesh } = table;
    const node = table.greeted(NODE_B, ["http://10.0.0.2:11811", "http://127.0.0.1:11811"]);

    expect(mesh.resolve(NODE_B)).toBe(node);
    expect(mesh.resolve(`node-${NODE_B}`)).toBe(node);
    expect(mesh.resolve("10.0.0.2:11811")).toBe(node);
    expect(mesh.resolve("http://127.0.0.1:11811/")).toBe(node);
    // Another address that reached it, though it does not advertise it.
    node.learnUrl("http://localhost:11811");
    expect(mesh.resolve("http://localhost:11811")).toBe(node);
    // This node is found like any other.
    expect(mesh.resolve("self")).toBe(mesh.self);
    expect(mesh.resolve(mesh.self.id)).toBe(mesh.self);
  });

  it("refuses a stranger, and a name that two nodes have", () => {
    const table = setup();
    const { mesh } = table;
    expect(() => mesh.resolve("http://203.0.113.9:11811")).toThrow(/not a known node/);
    expect(() => mesh.resolve("nobody")).toThrow(/not a known node/);

    table.greeted(NODE_B);
    table.greeted(NODE_C);
    mesh.get(NODE_B)?.describe({ display_name: "twin", endpoints: ["http://127.0.0.1:11811"] });
    mesh.get(NODE_C)?.describe({ display_name: "twin", endpoints: ["http://127.0.0.1:11812"] });
    expect(() => mesh.resolve("twin")).toThrow(
      new RegExp(`several nodes.*${NODE_B}.*${NODE_C}|several nodes.*${NODE_C}.*${NODE_B}`),
    );
  });

  it("forgets what it learned about a node that is forgotten", () => {
    const table = setup();
    const { mesh } = table;
    table.greeted(NODE_B).learnUrl("http://localhost:11811");
    mesh.remove(NODE_B);
    expect(() => mesh.resolve("http://localhost:11811")).toThrow(/not a known node/);
  });

  it("is not handed a task while it is not online", async () => {
    const table = setup();
    const { mesh, advance } = table;
    const node = table.greeted(NODE_B);
    advance(5000);
    mesh.evaluate();
    expect(node.state).toBe("offline");
    await expect(node.sendTask({ message: { role: "user", parts: [] } })).rejects.toMatchObject({
      code: "peer_not_online",
    });
  });

  it("takes its own latest description, and no one else's", () => {
    const table = setup();
    const node = table.greeted(NODE_B);
    node.describe({
      display_name: "renamed",
      endpoints: ["http://10.0.0.9:11811"],
      models: [{ provider: "p", id: "m", name: "M" }],
    });
    expect(node.view()).toMatchObject({
      display_name: "renamed",
      endpoints: ["http://10.0.0.9:11811"],
      models: [{ provider: "p", id: "m", name: "M" }],
    });
    // A catalog it stopped advertising does not linger.
    node.describe({ display_name: "renamed", endpoints: ["http://10.0.0.9:11811"] });
    expect(node.view().models).toBeUndefined();
  });
});
