import { describe, expect, it } from "vitest";

import { CANDIDATE_MAX_FAILURES, createMembership, type MembershipTimings } from "../src/mesh/membership.ts";
import type { PeerView, OrcaNodeId } from "../src/core/wire/peer.ts";
import { labelId } from "./fixtures/ids.ts";

const TIMINGS: MembershipTimings = {
  intervalMs: 200,
  suspectAfterMs: 600,
  offlineAfterMs: 1200,
  recoverProbeMs: 1500,
  maxRecoverProbeMs: 3000,
  recordTtlMs: 5000,
  tombstoneMs: 10000,
  heartbeatTimeoutMs: 50,
};

function peerView(orcaNodeId: OrcaNodeId, overrides: Partial<PeerView> = {}): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: `orca-node-${orcaNodeId}`,
    endpoints: [`http://127.0.0.1:11811`],
    runtime: null,
    runtime_digest: `digest-${orcaNodeId}`,
    state: "online",
    busy: null,
    last_recv_at: null,
    ...overrides,
  };
}

function setup() {
  let now = 1000;
  const membership = createMembership({
    selfOrcaNodeId: labelId("AAAAAA"),
    timings: TIMINGS,
    clock: { monotonicMs: () => now, wallIso: () => new Date(now).toISOString() },
  });
  return {
    membership,
    advance(ms: number): void {
      now += ms;
    },
  };
}

describe("membership watchdog", () => {
  it("remote member lists add records but never mark them online", () => {
    const { membership } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);

    expect(membership.get(labelId("BBBBBB"))?.state).toBe("unknown");
    expect(membership.get(labelId("BBBBBB"))?.last_recv_at).toBeNull();
    expect(membership.needsProbe(labelId("BBBBBB"), membership.now())).toBe(true);
  });

  it("does not let a third-party roster overwrite a known member", () => {
    const { membership } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.mergeRemote([
      peerView(labelId("BBBBBB"), {
        display_name: "mallory",
        endpoints: ["http://192.0.2.9:11811"],
      }),
    ]);

    const peer = membership.get(labelId("BBBBBB"));
    expect(peer?.display_name).toBe("orca-node-BBBBBB");
    expect(peer?.endpoints).toEqual(["http://127.0.0.1:11811"]);
  });

  it("walks online -> suspect(quiet) -> offline -> pruned from inbound silence", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.observeInbound(labelId("BBBBBB"));
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("online");

    advance(700);
    membership.evaluate();
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("suspect");
    expect(membership.getRecord(labelId("BBBBBB"))?.suspect_reason).toBe("quiet");

    advance(600);
    membership.evaluate();
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("offline");

    advance(5100);
    membership.evaluate();
    expect(membership.get(labelId("BBBBBB"))).toBeNull();
    expect(membership.isTombstoned(labelId("BBBBBB"))).toBe(true);

    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    expect(membership.get(labelId("BBBBBB"))).toBeNull();
  });

  it("marks suspect(unreachable) when sends fail but heartbeats still arrive", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.observeInbound(labelId("BBBBBB"));

    advance(100);
    membership.observeOutboundFail(labelId("BBBBBB"));
    membership.observeOutboundFail(labelId("BBBBBB"));
    membership.observeOutboundFail(labelId("BBBBBB"));

    expect(membership.get(labelId("BBBBBB"))?.state).toBe("suspect");
    expect(membership.getRecord(labelId("BBBBBB"))?.suspect_reason).toBe("unreachable");

    membership.observeOutboundOk(labelId("BBBBBB"));
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("online");

    membership.observeOutboundFail(labelId("BBBBBB"));
    membership.observeOutboundFail(labelId("BBBBBB"));
    membership.observeOutboundFail(labelId("BBBBBB"));
    membership.observeInbound(labelId("BBBBBB"));
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("online");
  });

  it("a removed peer is tombstoned against stale lists", () => {
    const { membership } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.observeInbound(labelId("BBBBBB"));

    membership.remove(labelId("BBBBBB"));
    expect(membership.list()).toHaveLength(0);
    expect(membership.isTombstoned(labelId("BBBBBB"))).toBe(true);

    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.observeInbound(labelId("BBBBBB"));
    expect(membership.get(labelId("BBBBBB"))).toBeNull();
    expect(membership.peers.touch(labelId("BBBBBB"))).toBe(false);
  });

  it("lets a removed node back in through its own join, while stale lists stay blocked", () => {
    const { membership } = setup();
    membership.peers.upsert(peerView(labelId("BBBBBB")));
    membership.remove(labelId("BBBBBB"));
    expect(membership.isTombstoned(labelId("BBBBBB"))).toBe(true);

    // The node leaves and re-joins within the tombstone window: the gateway
    // verified its admission proof, so the record must exist afterwards.
    membership.peers.upsert(peerView(labelId("BBBBBB")));
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("online");
    expect(membership.isTombstoned(labelId("BBBBBB"))).toBe(false);
    expect(membership.peers.touch(labelId("BBBBBB"))).toBe(true);

    membership.remove(labelId("BBBBBB"));
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    expect(membership.get(labelId("BBBBBB"))).toBeNull();
  });

  it("offline peers back off probe attempts", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB"))]);
    membership.observeInbound(labelId("BBBBBB"));
    advance(1300);
    membership.evaluate();
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("offline");
    expect(membership.needsProbe(labelId("BBBBBB"), membership.now())).toBe(true);

    membership.observeOutboundFail(labelId("BBBBBB"));
    expect(membership.needsProbe(labelId("BBBBBB"), membership.now())).toBe(false);
    advance(TIMINGS.recoverProbeMs);
    expect(membership.needsProbe(labelId("BBBBBB"), membership.now())).toBe(true);
  });

  it("backs off an unreached candidate like an offline peer and drops it after five failures (B24)", () => {
    const { membership, advance } = setup();
    const d = labelId("DDDDDD");
    membership.mergeRemote([peerView(d)]);
    for (let attempt = 1; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) {
      expect(membership.needsProbe(d, membership.now())).toBe(true);
      membership.observeOutboundFail(d);
      expect(membership.needsProbe(d, membership.now())).toBe(false);
      advance(TIMINGS.maxRecoverProbeMs);
    }
    membership.observeOutboundFail(d);
    expect(membership.get(d)).toBeNull();
    expect(membership.isTombstoned(d)).toBe(true);
    // A stale list cannot bring it straight back.
    membership.mergeRemote([peerView(d)]);
    expect(membership.get(d)).toBeNull();
  });

  it("keeps a candidate that answers, so its failures start over", () => {
    const { membership } = setup();
    const d = labelId("DDDDDD");
    membership.mergeRemote([peerView(d)]);
    for (let attempt = 1; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) membership.observeOutboundFail(d);
    membership.observeInbound(d);
    membership.observeOutboundOk(d);
    membership.observeOutboundFail(d);
    expect(membership.get(d)?.state).toBe("online");
  });

  it("passes on only the members it hears from, not candidates or offline nodes (B24)", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView(labelId("BBBBBB")), peerView(labelId("CCCCCC"))]);
    membership.observeInbound(labelId("BBBBBB"));
    // CCCCCC is a candidate this node never reached: kept locally, not passed on.
    expect(membership.directory().map((peer) => peer.orca_node_id)).toEqual([labelId("BBBBBB")]);
    expect(membership.list()).toHaveLength(2);
    advance(TIMINGS.offlineAfterMs);
    membership.evaluate();
    expect(membership.get(labelId("BBBBBB"))?.state).toBe("offline");
    expect(membership.directory()).toEqual([]);
  });

  it("stops a dead node from circulating between two members (B24)", () => {
    const a = setup();
    const c = setup();
    const d = labelId("DDDDDD");
    // A knows D first-hand; C learns D only from A's directory.
    a.membership.mergeRemote([peerView(d)]);
    a.membership.observeInbound(d);
    c.membership.mergeRemote(a.membership.directory());
    // D dies. A stops vouching for it once it goes offline; C gives up on its candidate.
    for (let round = 0; round < 20; round += 1) {
      a.advance(TIMINGS.maxRecoverProbeMs);
      c.advance(TIMINGS.maxRecoverProbeMs);
      a.membership.evaluate();
      c.membership.evaluate();
      if (c.membership.needsProbe(d, c.membership.now())) c.membership.observeOutboundFail(d);
      if (a.membership.needsProbe(d, a.membership.now())) a.membership.observeOutboundFail(d);
      // They keep exchanging directories every round.
      a.membership.mergeRemote(c.membership.directory());
      c.membership.mergeRemote(a.membership.directory());
    }
    expect(c.membership.get(d)).toBeNull();
    expect(a.membership.directory().some((peer) => peer.orca_node_id === d)).toBe(false);
    // A keeps its own offline record until the record TTL, then prunes it for good.
    a.advance(TIMINGS.recordTtlMs);
    a.membership.evaluate();
    expect(a.membership.get(d)).toBeNull();
    c.membership.mergeRemote(a.membership.directory());
    a.membership.mergeRemote(c.membership.directory());
    expect(a.membership.get(d)).toBeNull();
    expect(c.membership.get(d)).toBeNull();
  });

  it("lets a dropped candidate back in when it joins itself, tombstone or not", () => {
    const { membership } = setup();
    const d = labelId("DDDDDD");
    membership.mergeRemote([peerView(d)]);
    for (let attempt = 0; attempt < CANDIDATE_MAX_FAILURES; attempt += 1) membership.observeOutboundFail(d);
    expect(membership.isTombstoned(d)).toBe(true);
    // The node comes back and joins with a verified admission proof.
    membership.peers.upsert(peerView(d));
    expect(membership.get(d)?.state).toBe("online");
    expect(membership.isTombstoned(d)).toBe(false);
  });
});
