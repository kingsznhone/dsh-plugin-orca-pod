import { describe, expect, it } from "vitest";

import { createMembership, type MembershipTimings } from "../src/membership.ts";
import type { PeerView } from "../src/protocol.ts";

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

function peerView(orcaNodeId: string, overrides: Partial<PeerView> = {}): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: `orca-node-${orcaNodeId}`,
    endpoint: `http://127.0.0.1:11811`,
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
    selfOrcaNodeId: "AAAAAA",
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
    membership.mergeRemote([peerView("BBBBBB")]);

    expect(membership.get("BBBBBB")?.state).toBe("unknown");
    expect(membership.get("BBBBBB")?.last_recv_at).toBeNull();
    expect(membership.needsProbe("BBBBBB", membership.now())).toBe(true);
  });

  it("walks online -> suspect(quiet) -> offline -> pruned from inbound silence", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView("BBBBBB")]);
    membership.observeInbound("BBBBBB");
    expect(membership.get("BBBBBB")?.state).toBe("online");

    advance(700);
    membership.evaluate();
    expect(membership.get("BBBBBB")?.state).toBe("suspect");
    expect(membership.getRecord("BBBBBB")?.suspect_reason).toBe("quiet");

    advance(600);
    membership.evaluate();
    expect(membership.get("BBBBBB")?.state).toBe("offline");

    advance(5100);
    membership.evaluate();
    expect(membership.get("BBBBBB")).toBeNull();
    expect(membership.isTombstoned("BBBBBB")).toBe(true);

    membership.mergeRemote([peerView("BBBBBB")]);
    expect(membership.get("BBBBBB")).toBeNull();
  });

  it("marks suspect(unreachable) when sends fail but heartbeats still arrive", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView("BBBBBB")]);
    membership.observeInbound("BBBBBB");

    advance(100);
    membership.observeOutboundFail("BBBBBB");
    membership.observeOutboundFail("BBBBBB");
    membership.observeOutboundFail("BBBBBB");

    expect(membership.get("BBBBBB")?.state).toBe("suspect");
    expect(membership.getRecord("BBBBBB")?.suspect_reason).toBe("unreachable");

    membership.observeOutboundOk("BBBBBB");
    expect(membership.get("BBBBBB")?.state).toBe("online");

    membership.observeOutboundFail("BBBBBB");
    membership.observeOutboundFail("BBBBBB");
    membership.observeOutboundFail("BBBBBB");
    membership.observeInbound("BBBBBB");
    expect(membership.get("BBBBBB")?.state).toBe("online");
  });

  it("a removed peer is tombstoned against stale lists", () => {
    const { membership } = setup();
    membership.mergeRemote([peerView("BBBBBB")]);
    membership.observeInbound("BBBBBB");

    membership.remove("BBBBBB");
    expect(membership.list()).toHaveLength(0);
    expect(membership.isTombstoned("BBBBBB")).toBe(true);

    membership.mergeRemote([peerView("BBBBBB")]);
    membership.observeInbound("BBBBBB");
    expect(membership.get("BBBBBB")).toBeNull();
    expect(membership.peers.touch("BBBBBB")).toBe(false);
  });

  it("offline peers back off probe attempts", () => {
    const { membership, advance } = setup();
    membership.mergeRemote([peerView("BBBBBB")]);
    membership.observeInbound("BBBBBB");
    advance(1300);
    membership.evaluate();
    expect(membership.get("BBBBBB")?.state).toBe("offline");
    expect(membership.needsProbe("BBBBBB", membership.now())).toBe(true);

    membership.observeOutboundFail("BBBBBB");
    expect(membership.needsProbe("BBBBBB", membership.now())).toBe(false);
    advance(TIMINGS.recoverProbeMs);
    expect(membership.needsProbe("BBBBBB", membership.now())).toBe(true);
  });
});
