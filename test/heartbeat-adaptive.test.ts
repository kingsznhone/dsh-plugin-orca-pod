import { afterEach, describe, expect, it, vi } from "vitest";

import { Mesh } from "../src/mesh/mesh.ts";
import { heartbeatIntervalMsFor, resolveTimings } from "../src/mesh/timings.ts";
import { createMesh, waitFor } from "./support/harness.ts";
import { peersOf } from "./support/node.ts";

async function eventually(probe: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  await waitFor(probe, (ok) => ok, { timeoutMs, label });
}

describe("heartbeatIntervalMsFor", () => {
  it("is one second per orca node, clamped to the sane window", () => {
    expect(heartbeatIntervalMsFor(1)).toBe(2000);
    expect(heartbeatIntervalMsFor(2)).toBe(2000);
    expect(heartbeatIntervalMsFor(3)).toBe(3000);
    expect(heartbeatIntervalMsFor(5)).toBe(5000);
    expect(heartbeatIntervalMsFor(10)).toBe(10_000);
    expect(heartbeatIntervalMsFor(25)).toBe(10_000);
    expect(heartbeatIntervalMsFor(0)).toBe(2000);
  });
});

describe("adaptive membership windows", () => {
  it("derives one-miss suspect and three-miss offline from the cadence", () => {
    // A 5 s cadence: suspect after 6.25 s of silence, offline after 15 s, a hello given up after 2.5 s.
    expect(resolveTimings({ intervalMs: 5000 })).toMatchObject({
      intervalMs: 5000,
      suspectAfterMs: 6250,
      offlineAfterMs: 15_000,
      heartbeatTimeoutMs: 2500,
    });
  });
});

/** Watch the cadence each mesh's tick picks; the tick still does what it does. */
function watchCadence() {
  const retarget = vi.spyOn(Mesh.prototype as unknown as { setIntervalMs(ms: number): void }, "setIntervalMs");
  /** The interval this mesh last retargeted to; undefined while it never did. */
  return (mesh: Mesh): number | undefined => {
    const { calls, contexts } = retarget.mock;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
      if (contexts[index] === mesh) return calls[index]?.[0];
    }
    return undefined;
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("node cadence follows the mesh", () => {
  it("drops to two seconds for a pair and five for five nodes", async () => {
    const cadence = watchCadence();
    const pair = await createMesh({ orcaNodes: 2, workgroupId: "adaptive-pair", password: "correct horse" });
    try {
      await eventually(() => pair.orcaNodes.every((orcaNode) => cadence(orcaNode.mesh) === 2000), "pair cadence");
    } finally {
      await pair.stop();
    }

    const mesh = await createMesh({ orcaNodes: 5, workgroupId: "adaptive-five", password: "correct horse" });
    try {
      // Each node must see the other four before the cadence reflects five nodes.
      await eventually(
        () => mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).length === 4 && cadence(orcaNode.mesh) === 5000),
        "five-node cadence",
        20_000,
      );
    } finally {
      await mesh.stop();
    }
  }, 30_000);

  it("keeps an explicitly pinned cadence", async () => {
    const cadence = watchCadence();
    const mesh = await createMesh({
      orcaNodes: 2,
      workgroupId: "adaptive-pinned",
      password: "correct horse",
      timings: { intervalMs: 60 },
    });
    try {
      // The pair meets at the pinned cadence, and no tick retargets it.
      await eventually(() => mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).length === 1), "pinned pair", 5_000);
      expect(mesh.orcaNodes.map((orcaNode) => cadence(orcaNode.mesh))).toEqual([undefined, undefined]);
    } finally {
      await mesh.stop();
    }
  });
});
