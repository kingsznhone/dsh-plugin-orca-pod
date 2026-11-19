import { describe, expect, it } from "vitest";

import { createMesh } from "./support/harness.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import type { Orca } from "../src/node/orca.ts";
import { peersOf } from "./support/node.ts";

const FAST: Partial<MeshTimings> = {
  intervalMs: 20,
  suspectAfterMs: 60,
  offlineAfterMs: 120,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 400,
  tombstoneMs: 200,
};

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

describe("heartbeat loop and watchdog", () => {
  it("converges a three-orca-node mesh, marks a stopped orca node offline, then prunes it", async () => {
    const mesh = await createMesh({ orcaNodes: 3, timings: FAST });
    const victim = mesh.orcaNodes[2];
    const survivors = mesh.orcaNodes.slice(0, 2) as Orca[];
    if (!victim) throw new Error("mesh did not create three orca nodes");

    try {
      await waitFor(() =>
        mesh.orcaNodes.every(
          (orcaNode) => peersOf(orcaNode).length === 2 && peersOf(orcaNode).every((peer) => peer.state === "online"),
        ),
      );

      await victim.stop();

      await waitFor(() =>
        survivors.every((orcaNode) =>
          peersOf(orcaNode).some((peer) => peer.orca_node_id === victim.mesh.self.id && peer.state === "offline"),
        ),
      );

      await expect(
        survivors[0]!.mesh.resolve(victim.mesh.self.endpoints[0]!).sendTask({
          message: { role: "user", parts: [{ kind: "text", text: "hello?" }] },
        }),
      ).rejects.toMatchObject({ code: "peer_not_online" });

      await waitFor(() =>
        survivors.every((orcaNode) => peersOf(orcaNode).every((peer) => peer.orca_node_id !== victim.mesh.self.id)),
      );
    } finally {
      await Promise.allSettled(survivors.map((orcaNode) => orcaNode.stop()));
    }
  });

  it("keeps peers online while heartbeats flow", async () => {
    const mesh = await createMesh({ orcaNodes: 2, timings: FAST });
    try {
      await waitFor(() =>
        mesh.orcaNodes.every(
          (orcaNode) => peersOf(orcaNode).length === 1 && peersOf(orcaNode).every((peer) => peer.state === "online"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (const orcaNode of mesh.orcaNodes) {
        expect(peersOf(orcaNode).every((peer) => peer.state === "online")).toBe(true);
      }
    } finally {
      await mesh.stop();
    }
  });
});
