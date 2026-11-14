import { describe, expect, it } from "vitest";

import {
  createMembership,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  heartbeatIntervalMsFor,
} from "../src/membership.ts";
import type { PeerView } from "../src/protocol.ts";
import { createMesh, waitFor } from "../src/harness.ts";

async function eventually(probe: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(probe, (ok) => ok, { timeoutMs, label });
}

function peer(orcaNodeId: string): PeerView {
  return {
    orca_node_id: orcaNodeId,
    display_name: orcaNodeId,
    endpoints: [`http://127.0.0.1:1`],
    runtime: null,
    runtime_digest: "digest",
    state: "unknown",
    busy: null,
    last_recv_at: null,
  };
}

describe("heartbeatIntervalMsFor", () => {
  it("is one second per orca node, clamped to the sane window", () => {
    expect(heartbeatIntervalMsFor(1)).toBe(HEARTBEAT_INTERVAL_MIN_MS);
    expect(heartbeatIntervalMsFor(2)).toBe(2000);
    expect(heartbeatIntervalMsFor(3)).toBe(3000);
    expect(heartbeatIntervalMsFor(5)).toBe(5000);
    expect(heartbeatIntervalMsFor(10)).toBe(10_000);
    expect(heartbeatIntervalMsFor(25)).toBe(HEARTBEAT_INTERVAL_MAX_MS);
    expect(heartbeatIntervalMsFor(0)).toBe(HEARTBEAT_INTERVAL_MIN_MS);
    expect(heartbeatIntervalMsFor(Number.NaN)).toBe(HEARTBEAT_INTERVAL_MIN_MS);
  });
});

describe("adaptive membership windows", () => {
  it("derives one-miss suspect and three-miss offline from the cadence", () => {
    let nowMs = 0;
    const membership = createMembership({
      selfOrcaNodeId: "SELF",
      timings: { intervalMs: 5000 },
      clock: { monotonicMs: () => nowMs, wallIso: () => new Date(0).toISOString() },
    });
    membership.peers.upsert(peer("PEER01"));
    // The first inbound heartbeat is what makes the peer online.
    membership.observeInbound("PEER01");

    membership.setIntervalMs(5000);
    expect(membership.timings.intervalMs).toBe(5000);
    expect(membership.timings.suspectAfterMs).toBe(6250);
    expect(membership.timings.offlineAfterMs).toBe(15_000);

    nowMs = 6249;
    expect(membership.evaluate()[0]?.state).toBe("online");

    nowMs = 6250;
    const suspect = membership.evaluate()[0];
    expect(suspect?.state).toBe("suspect");

    nowMs = 14_999;
    expect(membership.evaluate()[0]?.state).toBe("suspect");

    nowMs = 15_000;
    expect(membership.evaluate()[0]?.state).toBe("offline");
  });

  it("ignores nonsense cadences", () => {
    const membership = createMembership({ selfOrcaNodeId: "SELF" });
    membership.setIntervalMs(0);
    membership.setIntervalMs(Number.NaN);
    expect(membership.timings.intervalMs).toBe(2000);
  });
});

describe("node cadence follows the mesh", () => {
  it("drops to two seconds for a pair and five for five nodes", async () => {
    const pair = await createMesh({ orcaNodes: 2, workgroupId: "adaptive-pair", password: "correct horse" });
    try {
      await eventually(
        () => pair.orcaNodes.every((orcaNode) => orcaNode.heartbeatIntervalMs === 2000),
        "pair cadence",
      );
    } finally {
      await pair.stop();
    }

    const mesh = await createMesh({ orcaNodes: 5, workgroupId: "adaptive-five", password: "correct horse" });
    try {
      // Each node must see the other four before the cadence reflects five nodes.
      await eventually(
        () =>
          mesh.orcaNodes.every(
            (orcaNode) => orcaNode.members().length === 4 && orcaNode.heartbeatIntervalMs === 5000,
          ),
        "five-node cadence",
        20_000,
      );
    } finally {
      await mesh.stop();
    }
  }, 30_000);

  it("keeps an explicitly pinned cadence", async () => {
    const mesh = await createMesh({
      orcaNodes: 2,
      workgroupId: "adaptive-pinned",
      password: "correct horse",
      timings: { intervalMs: 60 },
    });
    try {
      await eventually(
        () => mesh.orcaNodes.every((orcaNode) => orcaNode.heartbeatIntervalMs === 60),
        "pinned cadence",
        5_000,
      );
    } finally {
      await mesh.stop();
    }
  });
});
