import { describe, expect, it } from "vitest";

import { createMesh } from "../src/index.ts";
import type { MembershipTimings } from "../src/membership.ts";
import type { OrcaNode } from "../src/orca_node.ts";

const FAST: Partial<MembershipTimings> = {
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
  it("converges a three-node mesh, marks a stopped node offline, then prunes it", async () => {
    const mesh = await createMesh({ nodes: 3, timings: FAST });
    const victim = mesh.nodes[2];
    const survivors = mesh.nodes.slice(0, 2) as OrcaNode[];
    if (!victim) throw new Error("mesh did not create three nodes");

    try {
      await waitFor(() =>
        mesh.nodes.every(
          (node) =>
            node.members().length === 2 && node.members().every((peer) => peer.state === "online"),
        ),
      );

      await victim.stop();

      await waitFor(() =>
        survivors.every((node) =>
          node
            .members()
            .some((peer) => peer.node_id === victim.nodeId && peer.state === "offline"),
        ),
      );

      try {
        survivors[0]?.sendTask(victim.endpoint, {
          message: { role: "user", parts: [{ kind: "text", text: "hello?" }] },
        });
        throw new Error("sendTask to an offline peer should have thrown");
      } catch (error) {
        expect((error as { code?: string }).code).toBe("peer_not_online");
      }

      await waitFor(() =>
        survivors.every((node) => node.members().every((peer) => peer.node_id !== victim.nodeId)),
      );
    } finally {
      await Promise.allSettled(survivors.map((node) => node.stop()));
    }
  });

  it("keeps peers online while heartbeats flow", async () => {
    const mesh = await createMesh({ nodes: 2, timings: FAST });
    try {
      await waitFor(() =>
        mesh.nodes.every(
          (node) =>
            node.members().length === 1 && node.members().every((peer) => peer.state === "online"),
        ),
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
      for (const node of mesh.nodes) {
        expect(node.members().every((peer) => peer.state === "online")).toBe(true);
      }
    } finally {
      await mesh.stop();
    }
  });
});
