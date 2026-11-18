import { describe, expect, it } from "vitest";

import { HEARTBEAT_INTERVAL_MAX_MS, HEARTBEAT_INTERVAL_MIN_MS, heartbeatIntervalMsFor } from "../src/mesh/timings.ts";
import { createMesh, waitFor } from "./support/harness.ts";
import { peersOf } from "./support/node.ts";
import { labelId } from "./fixtures/ids.ts";
import { listed, testMesh } from "./support/mesh.ts";

async function eventually(probe: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(probe, (ok) => ok, { timeoutMs, label });
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
    const table = testMesh({ intervalMs: 5000 });
    const { mesh } = table;
    const stateAfterEvaluate = () => {
      mesh.evaluate();
      return mesh.get(labelId("PEER01"))?.state;
    };
    mesh.mergeRemote([listed(labelId("PEER01"), "http://127.0.0.1:1")]);
    // The first inbound message is what makes the peer online.
    table.hear(labelId("PEER01"));
    const heardAt = table.clock.monotonicMs();

    mesh.setIntervalMs(5000);
    expect(mesh.timings.intervalMs).toBe(5000);
    expect(mesh.timings.suspectAfterMs).toBe(6250);
    expect(mesh.timings.offlineAfterMs).toBe(15_000);

    table.advance(6249);
    expect(stateAfterEvaluate()).toBe("online");

    table.advance(1);
    expect(stateAfterEvaluate()).toBe("suspect");

    table.advance(14_999 - 6250);
    expect(stateAfterEvaluate()).toBe("suspect");

    table.advance(1);
    expect(table.clock.monotonicMs() - heardAt).toBe(15_000);
    expect(stateAfterEvaluate()).toBe("offline");
  });
});

describe("node cadence follows the mesh", () => {
  it("drops to two seconds for a pair and five for five nodes", async () => {
    const pair = await createMesh({ orcaNodes: 2, workgroupId: "adaptive-pair", password: "correct horse" });
    try {
      await eventually(
        () => pair.orcaNodes.every((orcaNode) => orcaNode.mesh.timings.intervalMs === 2000),
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
            (orcaNode) => peersOf(orcaNode).length === 4 && orcaNode.mesh.timings.intervalMs === 5000,
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
        () => mesh.orcaNodes.every((orcaNode) => orcaNode.mesh.timings.intervalMs === 60),
        "pinned cadence",
        5_000,
      );
    } finally {
      await mesh.stop();
    }
  });
});
