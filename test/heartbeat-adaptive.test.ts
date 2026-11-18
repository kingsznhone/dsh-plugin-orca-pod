import { describe, expect, it } from "vitest";

import {
  Membership,
  HEARTBEAT_INTERVAL_MAX_MS,
  HEARTBEAT_INTERVAL_MIN_MS,
  heartbeatIntervalMsFor,
} from "../src/mesh/membership.ts";
import type { PeerView, OrcaNodeId } from "../src/core/wire/peer.ts";
import { createMesh, waitFor } from "./support/harness.ts";
import { labelId } from "./fixtures/ids.ts";

async function eventually(probe: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(probe, (ok) => ok, { timeoutMs, label });
}

function peer(orcaNodeId: OrcaNodeId): PeerView {
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
  });
});

describe("adaptive membership windows", () => {
  it("derives one-miss suspect and three-miss offline from the cadence", () => {
    let nowMs = 0;
    const membership = new Membership(labelId("SELF"), {
      timings: { intervalMs: 5000 },
      clock: { monotonicMs: () => nowMs, wallIso: () => new Date(0).toISOString() },
    });
    const stateAfterEvaluate = () => {
      membership.evaluate();
      return membership.get(labelId("PEER01"))?.state;
    };
    membership.upsert(peer(labelId("PEER01")));
    // The first inbound heartbeat is what makes the peer online.
    membership.observeInbound(labelId("PEER01"));

    membership.setIntervalMs(5000);
    expect(membership.timings.intervalMs).toBe(5000);
    expect(membership.timings.suspectAfterMs).toBe(6250);
    expect(membership.timings.offlineAfterMs).toBe(15_000);

    nowMs = 6249;
    expect(stateAfterEvaluate()).toBe("online");

    nowMs = 6250;
    expect(stateAfterEvaluate()).toBe("suspect");

    nowMs = 14_999;
    expect(stateAfterEvaluate()).toBe("suspect");

    nowMs = 15_000;
    expect(stateAfterEvaluate()).toBe("offline");
  });
});

describe("node cadence follows the mesh", () => {
  it("drops to two seconds for a pair and five for five nodes", async () => {
    const pair = await createMesh({ orcaNodes: 2, workgroupId: "adaptive-pair", password: "correct horse" });
    try {
      await eventually(
        () => pair.orcaNodes.every((orcaNode) => orcaNode.membership.timings.intervalMs === 2000),
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
            (orcaNode) => orcaNode.membership.list().length === 4 && orcaNode.membership.timings.intervalMs === 5000,
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
        () => mesh.orcaNodes.every((orcaNode) => orcaNode.membership.timings.intervalMs === 60),
        "pinned cadence",
        5_000,
      );
    } finally {
      await mesh.stop();
    }
  });
});
