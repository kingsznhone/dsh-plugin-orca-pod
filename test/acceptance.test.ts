import type { FetchLike } from "../src/mesh/peer-client.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createMesh } from "./support/harness.ts";
import { createOrcaNode, createPersistentStorage, type OrcaNode } from "../src/node/orca-node.ts";
import { wg } from "./fixtures/ids.ts";

const WORKGROUP = wg("orca-accept");
const PASSWORD = "correct horse";

const FAST = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 60,
  maxRecoverProbeMs: 120,
  recordTtlMs: 60_000,
  tombstoneMs: 60_000,
};

async function tempDir(prefix = "orca-accept-"): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function waitFor(what: string, predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function stateOf(node: OrcaNode, orcaNodeId: string): string | undefined {
  return node.members().find((peer) => peer.orca_node_id === orcaNodeId)?.state;
}

function hangTask() {
  return {
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: "wait" }] },
    metadata: { echo: { final: { state: "hang" as const, text: "" } } },
  };
}

afterEach(async () => {
  // nothing global; every test stops its own nodes
});

describe("acceptance: membership under partition", () => {
  it("marks a cut-off orca node offline and recovers it after the link returns", async () => {
    let blockedPort: string | null = null;
    let blockedIndex = -1;
    const fetchFor =
      (index: number): FetchLike =>
      (url, init) => {
        if (blockedPort !== null && (url.port === blockedPort || index === blockedIndex)) {
          return Promise.reject(new TypeError("simulated network partition"));
        }
        return fetch(url, init);
      };
    const mesh = await createMesh({
      orcaNodes: 3,
      workgroupId: WORKGROUP,
      password: PASSWORD,
      timings: FAST,
      fetch: (index) => fetchFor(index),
    });
    try {
      const [a, b, c] = mesh.orcaNodes;
      if (a === undefined || b === undefined || c === undefined) throw new Error("mesh is short");
      expect(a).toBeDefined();
      await waitFor(
        "three online members",
        () => a.members().length === 2 && a.members().every((peer) => peer.state === "online"),
      );

      blockedPort = new URL(b.endpoints[0]!).port;
      blockedIndex = 1;
      await waitFor(
        "B offline at A and C",
        () => stateOf(a, b.orcaNodeId) === "offline" && stateOf(c, b.orcaNodeId) === "offline",
      );

      blockedPort = null;
      blockedIndex = -1;
      await waitFor(
        "B back online at A and C",
        () => stateOf(a, b.orcaNodeId) === "online" && stateOf(c, b.orcaNodeId) === "online",
      );
    } finally {
      await mesh.stop();
    }
  });

  it("lets another workgroup member read a task by id", async () => {
    const mesh = await createMesh({ orcaNodes: 3, workgroupId: WORKGROUP, password: PASSWORD });
    try {
      const [a, b, c] = mesh.orcaNodes;
      if (a === undefined || b === undefined || c === undefined) throw new Error("mesh is short");
      const created = await a.sendTask(b.endpoints[0]!, {
        message: { role: "user", parts: [{ kind: "text", text: "hello" }] },
        metadata: { echo: { final: { state: "completed", text: "from b" } } },
      });
      let view = await a.getTask(b.endpoints[0]!, created.id);
      for (let i = 0; i < 100 && view.status.state !== "completed"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        view = await a.getTask(b.endpoints[0]!, created.id);
      }
      expect(view.status.state).toBe("completed");

      const asC = await c.getTask(b.endpoints[0]!, created.id);
      expect(asC.id).toBe(created.id);
      expect(asC.status.state).toBe("completed");
    } finally {
      await mesh.stop();
    }
  });
});

describe("acceptance: single slot concurrency", () => {
  it("starts exactly one agent turn for ten concurrent dispatches", async () => {
    const root = await tempDir();
    const config = await createOrcaNodeConfig({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: root,
      port: 0,
    });
    const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    await node.start();
    try {
      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => node.sendTask(node.endpoints[0]!, hangTask())),
      );
      const accepted = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(accepted).toHaveLength(1);
      expect(rejected).toHaveLength(9);
      for (const result of rejected) {
        if (result.status !== "rejected") continue;
        expect((result.reason as { code?: string }).code).toBe("orca_node_busy");
      }
      const running = accepted[0];
      if (running?.status === "fulfilled") {
        await node.cancelTask(node.endpoints[0]!, running.value.id);
      }
    } finally {
      await node.stop();
    }
  });
});

describe("acceptance: password rotation", () => {
  it("rejects a peer that kept the old password", async () => {
    const rootA = await tempDir("orca-rot-a-");
    const rootB = await tempDir("orca-rot-b-");

    const configA1 = await createOrcaNodeConfig({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: rootA,
      port: 0,
    });
    const configB = await createOrcaNodeConfig({
      workgroup_id: WORKGROUP,
      workgroup_password: PASSWORD,
      data_root: rootB,
      port: 0,
    });
    const a1 = createOrcaNode({ config: configA1, storage: createPersistentStorage(configA1) });
    const b = createOrcaNode({ config: configB, storage: createPersistentStorage(configB) });
    await a1.start();
    await b.start();
    await b.join(a1.endpoints[0]!);
    await a1.stop();
    await b.stop();

    const rotatedRoot = await tempDir("orca-rot-new-");
    const rotated = await createOrcaNodeConfig({
      workgroup_id: WORKGROUP,
      workgroup_password: "a brand new password",
      data_root: rotatedRoot,
      port: 0,
    });
    const a2 = createOrcaNode({ config: rotated, storage: createPersistentStorage(rotated) });
    const b2 = createOrcaNode({ config: configB, storage: createPersistentStorage(configB) });
    await a2.start();
    await b2.start();
    try {
      await expect(b2.join(a2.endpoints[0]!)).rejects.toMatchObject({ status: 401 });
      expect(b2.members().some((peer) => peer.orca_node_id === a2.orcaNodeId)).toBe(false);
    } finally {
      await a2.stop();
      await b2.stop();
    }
  });
});
