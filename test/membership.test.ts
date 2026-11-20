import { describe, expect, it, vi } from "vitest";

import type { OrcaNodeId } from "../src/core/ids.ts";
import type { Mesh } from "../src/mesh/mesh.ts";
import type { OrcaNode } from "../src/mesh/orca-node.ts";
import { CANDIDATE_MAX_FAILURES, type MeshTimings } from "../src/mesh/timings.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { listed, TestNet, type NetNode } from "./support/net.ts";

/** A fast, pinned cadence: a hello every ~200 ms, suspect after 600 ms of silence, offline after 1.2 s. */
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
/** The latest a round can come after the one before it: the interval plus its jitter. */
const ROUND_MS = TIMINGS.intervalMs * 1.1;

function stateOf(viewer: NetNode, node: NetNode): string | undefined {
  return viewer.mesh.get(node.id)?.state;
}

function ids(mesh: Mesh): OrcaNodeId[] {
  return mesh
    .list()
    .map((node) => node.id)
    .sort();
}

/** What `node` vouches for (§3.5), as a node meeting it for the first time learns it from its answer. */
async function vouchedBy(net: TestNet, node: NetNode): Promise<OrcaNodeId[]> {
  const stranger = net.node();
  await stranger.mesh.probe(node.url);
  // The stranger is in the list only because it asked.
  net.down(stranger);
  return ids(stranger.mesh).filter((id) => id !== stranger.id);
}

/** `node` greets `viewer` with this description, as the hello route hands it over (proofs checked), over loopback. */
async function greet(
  viewer: NetNode,
  id: OrcaNodeId,
  endpoints = ["https://10.9.9.9:11811"],
  display_name = `node-${id}`,
): Promise<OrcaNode> {
  await viewer.mesh.greeted(id, { self: { display_name, endpoints }, busy: null, digest: "" }, true);
  return viewer.mesh.require(id);
}

describe("the node table", () => {
  it("has this node in it, always online, and never greets it", async () => {
    const net = new TestNet(TIMINGS);
    const [a] = (await net.started(1)) as [NetNode];
    await net.advance(20_000);
    expect(ids(a.mesh)).toEqual([a.id]);
    expect(a.mesh.self.state).toBe("online");
    expect(net.dialsTo(a, a)).toBe(0);
    // Nobody can forget it.
    a.mesh.remove(a.id);
    expect(a.mesh.get(a.id)).toBe(a.mesh.self);
  });

  it("lists the others apart from itself", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    expect(a.mesh.list()).toHaveLength(2);
    expect(a.mesh.peers().map((node) => node.id)).toEqual([b.id]);
    expect(b.mesh.peers().map((node) => node.id)).toEqual([a.id]);
  });

  it("learns members from a peer's list as unknown candidates, online only once it reaches them", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    const c = net.node();
    c.mesh.start();
    net.cut(b, c);
    await c.mesh.probe(a.url);
    await net.advance(2 * ROUND_MS);
    expect(b.mesh.get(c.id)?.view()).toMatchObject({ state: "unknown", last_recv_at: null });

    net.heal(b, c);
    await net.advance(TIMINGS.maxRecoverProbeMs + 2 * ROUND_MS);
    expect(stateOf(b, c)).toBe("online");
  });

  it("does not let a third-party roster overwrite a known member", async () => {
    const net = new TestNet(TIMINGS);
    const b = net.node();
    const c = net.node();
    const hostile = net.node();
    await b.mesh.probe(c.url);
    const honest = hostile.mesh.greeted.bind(hostile.mesh);
    vi.spyOn(hostile.mesh, "greeted").mockImplementation(async (caller, request, overLoopback) => ({
      ...(await honest(caller, request, overLoopback)),
      members: [listed(c.id, "https://192.0.2.9:11811", { display_name: "mallory" })],
    }));
    await b.mesh.probe(hostile.url);
    expect(b.mesh.get(c.id)?.view()).toMatchObject({ display_name: c.mesh.self.displayName, endpoints: [c.url] });
  });

  it("walks online -> suspect -> offline -> pruned from silence, and a peer's list cannot bring it back", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b, c] = (await net.started(3)) as [NetNode, NetNode, NetNode];
    await net.advance(1000);
    expect(stateOf(a, b)).toBe("online");

    // A partition: a no longer hears b, while c still does and keeps vouching for it.
    net.cut(a, b);
    // The last round saw 600-1040 ms of silence: past the suspect window, short of the offline one.
    await net.advance(TIMINGS.suspectAfterMs + ROUND_MS);
    expect(stateOf(a, b)).toBe("suspect");
    await net.advance(TIMINGS.offlineAfterMs - TIMINGS.suspectAfterMs + ROUND_MS);
    expect(stateOf(a, b)).toBe("offline");
    expect(await vouchedBy(net, a)).not.toContain(b.id);

    await net.advance(TIMINGS.recordTtlMs + 2 * ROUND_MS);
    expect(a.mesh.get(b.id)).toBeUndefined();
    // c's list still names b every round, but the tombstone holds.
    await net.advance(2000);
    expect(stateOf(c, b)).toBe("online");
    expect(a.mesh.get(b.id)).toBeUndefined();
  });

  it("holds a node it hears but cannot reach (behind NAT) at suspect, until one of its own hellos gets through", async () => {
    const net = new TestNet(TIMINGS);
    // `home` sits behind NAT: its hellos reach `server`, and `server`'s answers come back on
    // the same connection, but `server` cannot open a connection to it.
    const [server, home] = (await net.started(2)) as [NetNode, NetNode];
    net.cut(server, home, true);
    // Unreachable takes as many failed rounds as the suspect window holds.
    await net.advance(TIMINGS.suspectAfterMs + ROUND_MS);

    // Sampled through many rounds, its own greetings arriving in between: never back to
    // online, so the server is not offered it for tasks it could not deliver (§3.3).
    const seen = new Set<string | undefined>();
    for (let step = 0; step < 20; step += 1) {
      await net.advance(ROUND_MS / 4);
      seen.add(stateOf(server, home));
    }
    expect([...seen]).toEqual(["suspect"]);
    // The panel tells this apart from a quiet node: it is heard, just not reachable.
    expect(server.mesh.require(home.id).unreachable).toBe(true);
    await expect(server.mesh.require(home.id).sendTask({ message: { role: "user", parts: [] } })).rejects.toMatchObject(
      { code: "peer_not_online" },
    );
    // The other way round nothing is wrong: the home node hears every answer.
    expect(stateOf(home, server)).toBe("online");

    // Once the server's own hello is answered, the node is online again.
    net.heal(server, home);
    await net.advance(2 * ROUND_MS);
    expect(stateOf(server, home)).toBe("online");
    expect(server.mesh.require(home.id).unreachable).toBe(false);
  });

  it("keeps a removed node out against stale lists, and lets it back in through its own greeting", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b, c] = (await net.started(3)) as [NetNode, NetNode, NetNode];
    await net.advance(1000);
    // b's own hellos do not reach a; c keeps listing b.
    net.cut(b, a, true);
    a.mesh.remove(b.id);
    await net.advance(1000);
    expect(stateOf(c, b)).toBe("online");
    expect(a.mesh.get(b.id)).toBeUndefined();

    // b proves the password in its next hello: the tombstone must not lock it out.
    net.heal(b, a);
    await net.advance(TIMINGS.maxRecoverProbeMs + 2 * ROUND_MS);
    expect(stateOf(a, b)).toBe("online");
  });

  it("probes an offline peer on a backoff instead of every round", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    net.down(b);
    await net.advance(TIMINGS.offlineAfterMs + 2 * ROUND_MS);
    expect(stateOf(a, b)).toBe("offline");
    // Probes at 0, 1.5 s and 4.5 s after it went offline; the record TTL ends them at 5 s.
    await net.advance(TIMINGS.recordTtlMs + ROUND_MS);
    expect(a.mesh.get(b.id)).toBeUndefined();

    const times = net.dialTimes(a, b);
    const backoffs = times
      .slice(1)
      .map((at, index) => at - (times[index] ?? at))
      .filter((gap) => gap > 2 * ROUND_MS);
    const [first, ...rest] = backoffs;
    expect(first).toBeGreaterThanOrEqual(TIMINGS.recoverProbeMs);
    expect(first).toBeLessThanOrEqual(TIMINGS.recoverProbeMs + ROUND_MS);
    expect(rest).toHaveLength(1);
    for (const gap of rest) {
      expect(gap).toBeGreaterThanOrEqual(TIMINGS.maxRecoverProbeMs);
      expect(gap).toBeLessThanOrEqual(TIMINGS.maxRecoverProbeMs + ROUND_MS);
    }
  });

  it("gives up on a candidate it never reaches after five tries, until the node greets it itself (B24)", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    const d = net.node();
    d.mesh.start();
    net.cut(b, d);
    await d.mesh.probe(a.url);
    await net.advance(2 * ROUND_MS);
    expect(stateOf(b, d)).toBe("unknown");

    await net.advance(15_000);
    expect(net.dialsTo(b, d)).toBe(CANDIDATE_MAX_FAILURES);
    expect(b.mesh.get(d.id)).toBeUndefined();
    // a still vouches for d in every answer, but the tombstone holds.
    expect(stateOf(a, d)).toBe("online");
    expect(net.dialsTo(b, d)).toBe(CANDIDATE_MAX_FAILURES);

    // d greets b for itself, with both proofs: tombstone or not, it is a member.
    net.heal(b, d);
    await d.mesh.probe(b.url);
    expect(stateOf(b, d)).toBe("online");
  });

  it("keeps a candidate that answers before it runs out of tries", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    const d = net.node();
    d.mesh.start();
    net.cut(b, d);
    await d.mesh.probe(a.url);
    await net.advance(2 * ROUND_MS);
    // Four tries fail (0, 1.5 s, 4.5 s, 7.5 s from now); the fifth would come at 10.5 s.
    await net.advance(9000);
    expect(net.dialsTo(b, d)).toBe(CANDIDATE_MAX_FAILURES - 1);

    net.heal(b, d);
    await net.advance(TIMINGS.maxRecoverProbeMs + 2 * ROUND_MS);
    expect(stateOf(b, d)).toBe("online");
    // A member it has heard from is not given up like a candidate when it goes quiet.
    net.cut(b, d);
    await net.advance(TIMINGS.offlineAfterMs + 2 * ROUND_MS);
    expect(stateOf(b, d)).toBe("offline");
  });

  it("vouches only for itself and the members it hears from, not candidates or offline nodes (B24)", async () => {
    const net = new TestNet(TIMINGS);
    const [a, b] = (await net.started(2)) as [NetNode, NetNode];
    const d = net.node();
    d.mesh.start();
    net.cut(b, d);
    await d.mesh.probe(a.url);
    await net.advance(2 * ROUND_MS);
    // d is a candidate b never reached: kept locally, not passed on.
    expect(stateOf(b, d)).toBe("unknown");
    expect(await vouchedBy(net, b)).toEqual([a.id, b.id].sort());

    net.cut(b, a);
    await net.advance(TIMINGS.offlineAfterMs + 2 * ROUND_MS);
    expect(stateOf(b, a)).toBe("offline");
    expect(await vouchedBy(net, b)).toEqual([b.id]);
  });

  it("stops a dead node from circulating between two members (B24)", async () => {
    const net = new TestNet(TIMINGS);
    const [a, c] = (await net.started(2)) as [NetNode, NetNode];
    // a knows d first-hand; d dies before c reaches it, so c knows it only from a's list.
    const d = net.node();
    await d.mesh.probe(a.url);
    net.down(d);
    await net.advance(2 * ROUND_MS);
    expect(stateOf(c, d)).toBe("unknown");

    // a stops vouching once d is offline and prunes it after the record TTL; c gives up on its candidate.
    await net.advance(15_000);
    expect(a.mesh.get(d.id)).toBeUndefined();
    expect(c.mesh.get(d.id)).toBeUndefined();
    // Past both tombstones, neither list brings it back.
    await net.advance(TIMINGS.tombstoneMs + 2000);
    expect(a.mesh.get(d.id)).toBeUndefined();
    expect(c.mesh.get(d.id)).toBeUndefined();
  });
});

const NODE_B = fakeNodeId("row-b");
const NODE_C = fakeNodeId("row-c");

describe("a node as the table's row", () => {
  it("is found by id, by a unique display name, and by an address it advertises", async () => {
    const a = new TestNet(TIMINGS).node();
    const node = await greet(a, NODE_B, ["https://10.0.0.2:11811", "https://127.0.0.1:11811"]);

    expect(a.mesh.resolve(NODE_B)).toBe(node);
    expect(a.mesh.resolve(`node-${NODE_B}`)).toBe(node);
    expect(a.mesh.resolve("10.0.0.2:11811")).toBe(node);
    expect(a.mesh.resolve("https://127.0.0.1:11811/")).toBe(node);
    // An address it does not advertise does not name it, even one that would reach it.
    expect(() => a.mesh.resolve("https://localhost:11811")).toThrow(/not a known node/);
    // This node is found like any other.
    expect(a.mesh.resolve(a.mesh.self.displayName)).toBe(a.mesh.self);
    expect(a.mesh.resolve(a.id)).toBe(a.mesh.self);
  });

  it("refuses a stranger, and a name that two nodes have", async () => {
    const a = new TestNet(TIMINGS).node();
    expect(() => a.mesh.resolve("https://203.0.113.9:11811")).toThrow(/not a known node/);
    expect(() => a.mesh.resolve("nobody")).toThrow(/not a known node/);

    await greet(a, NODE_B, ["https://127.0.0.1:11811"], "twin");
    await greet(a, NODE_C, ["https://127.0.0.1:11812"], "twin");
    expect(() => a.mesh.resolve("twin")).toThrow(
      new RegExp(`several nodes.*${NODE_B}.*${NODE_C}|several nodes.*${NODE_C}.*${NODE_B}`),
    );
  });

  it("is not handed a task while it is not online", async () => {
    const net = new TestNet(TIMINGS);
    const a = net.node();
    // Nothing answers at the address it declared.
    const node = await greet(a, NODE_B);
    a.mesh.start();
    await net.advance(TIMINGS.offlineAfterMs + 2 * ROUND_MS);
    expect(node.state).toBe("offline");
    await expect(node.sendTask({ message: { role: "user", parts: [] } })).rejects.toMatchObject({
      code: "peer_not_online",
    });
  });

  it("takes its own latest description, and no one else's", async () => {
    const a = new TestNet(TIMINGS).node();
    const node = await greet(a, NODE_B);
    node.describe({
      display_name: "renamed",
      endpoints: ["https://10.0.0.9:11811"],
      models: [{ provider: "p", id: "m", name: "M" }],
    });
    expect(node.view()).toMatchObject({
      display_name: "renamed",
      endpoints: ["https://10.0.0.9:11811"],
      models: [{ provider: "p", id: "m", name: "M" }],
    });
    // A catalog it stopped advertising does not linger.
    node.describe({ display_name: "renamed", endpoints: ["https://10.0.0.9:11811"] });
    expect(node.view().models).toBeUndefined();
  });
});
