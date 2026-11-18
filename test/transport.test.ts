import type { FetchLike } from "../src/mesh/peer-client.ts";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createMesh } from "./support/harness.ts";
import { createOrcaNode, type OrcaNode } from "../src/node/orca-node.ts";
import type { MembershipTimings } from "../src/mesh/membership.ts";
import type { TaskView } from "../src/task/wire.ts";
import { wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/wire/peer.ts";

/**
 * 压缩时钟：interval 100ms（生产是 2s），但所有抖动窗口都按“心跳间隔的倍数”给，
 * 最少 5 个间隔，避免测出来的只是“一次心跳还没发出去”。
 */
const JITTER: Partial<MembershipTimings> = {
  intervalMs: 100,
  suspectAfterMs: 300,
  offlineAfterMs: 600,
  recoverProbeMs: 200,
  maxRecoverProbeMs: 400,
  recordTtlMs: 10000,
  tombstoneMs: 10000,
  heartbeatTimeoutMs: 400,
};

/** 短暂断链用更长窗口：确认“抖动”只进 suspect，不会掉到 offline。 */
const SHORT_OUTAGE: Partial<MembershipTimings> = {
  ...JITTER,
  suspectAfterMs: 300,
  offlineAfterMs: 600,
};

type Jitter = {
  delayMs?: () => number;
  dropRate?: number;
  block?: (url: URL) => boolean;
};

/** Wrap the global fetch with delay, loss and partition behaviour. */
function jittered(state: Jitter): FetchLike {
  return async (url, init) => {
    if (state.block?.(url)) throw new TypeError("simulated partition");
    if (state.dropRate !== undefined && Math.random() < state.dropRate) {
      throw new TypeError("simulated packet loss");
    }
    const delay = state.delayMs?.() ?? 0;
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    return fetch(url, init);
  };
}

/** Rewrite one JSON response field in flight; everything else passes through. */
function rewriteJson(
  pathSuffix: string,
  mutate: (body: Record<string, unknown>) => Record<string, unknown>,
): FetchLike {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (!url.pathname.endsWith(pathSuffix)) return response;
    const body = (await response.json()) as Record<string, unknown>;
    return new Response(JSON.stringify(mutate(body)), {
      status: response.status,
      headers: { "content-type": "application/json" },
    });
  };
}

function newWorkgroupId(): WorkgroupId {
  return wg(`wg-${randomBytes(6).toString("hex")}`);
}

async function makeNode(
  workgroupId: WorkgroupId,
  password: string,
  options: { timings?: Partial<MembershipTimings>; fetch?: FetchLike; display_name?: string } = {},
): Promise<OrcaNode> {
  const config = await createOrcaNodeConfig({
    workgroup_id: workgroupId,
    workgroup_password: password,
    display_name: options.display_name,
    port: 0,
    data_root: mkdtempSync(join(tmpdir(), "orca-transport-")),
  });
  return createOrcaNode({ config, timings: options.timings ?? JITTER, fetch: options.fetch });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

async function waitForTask(client: OrcaNode, peerUrl: string, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = await client.getTask(peerUrl, taskId);
    if (task.status.state === "completed") return task;
    if (task.status.state === "failed" || task.status.state === "canceled") {
      throw new Error(`task ended as ${task.status.state}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("task did not finish before the timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("transport jitter during formation", () => {
  it("converges while every request carries 0.3–2.5 heartbeat intervals of latency", async () => {
    const mesh = await createMesh({
      orcaNodes: 3,
      workgroupId: newWorkgroupId(),
      password: "jitter",
      timings: JITTER,
      fetch: () => jittered({ delayMs: () => 30 + Math.random() * 220 }),
    });

    try {
      await waitFor(() => mesh.orcaNodes.every((orcaNode) => orcaNode.members().length === 2));
      await waitFor(() =>
        mesh.orcaNodes.every((orcaNode) => orcaNode.members().every((peer) => peer.state === "online")),
      );
      expect(new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.membersDigest())).size).toBe(1);
    } finally {
      await mesh.stop();
    }
  });

  it("recovers after a 30-heartbeat burst of packet loss", async () => {
    const states: Jitter[] = [];
    const mesh = await createMesh({
      orcaNodes: 3,
      workgroupId: newWorkgroupId(),
      password: "jitter",
      timings: JITTER,
      fetch: () => {
        const state: Jitter = { dropRate: 0 };
        states.push(state);
        return jittered(state);
      },
    });

    try {
      await waitFor(() => mesh.orcaNodes.every((orcaNode) => orcaNode.members().length === 2));

      // 45% 丢包、持续 3s = 30 个心跳间隔：期间状态可能反复 suspect/online。
      for (const state of states) state.dropRate = 0.45;
      await sleep(3000);

      for (const state of states) state.dropRate = 0;
      await waitFor(() =>
        mesh.orcaNodes.every(
          (orcaNode) => orcaNode.members().length === 2 && orcaNode.members().every((peer) => peer.state === "online"),
        ),
      );
      expect(new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.membersDigest())).size).toBe(1);
    } finally {
      await mesh.stop();
    }
  });

  it("keeps a peer online through a 15-heartbeat one-way outbound failure", async () => {
    const workgroupId = newWorkgroupId();
    const a = await makeNode(workgroupId, "jitter", { display_name: "a" });
    const b = await makeNode(workgroupId, "jitter", { display_name: "b" });

    let aHost = "";
    let blocked = false;
    const c = await makeNode(workgroupId, "jitter", {
      display_name: "c",
      fetch: (url, init) => {
        if (blocked && aHost !== "" && url.host === aHost) throw new TypeError("simulated one-way partition");
        return fetch(url, init);
      },
    });

    try {
      const aUrl = (await a.start()).url;
      const bUrl = (await b.start()).url;
      const cUrl = (await c.start()).url;
      if (!aUrl || !bUrl || !cUrl) throw new Error("orca nodes did not start");
      aHost = new URL(aUrl).host;

      await b.join(aUrl);
      await c.join(aUrl);
      await c.join(bUrl);
      await waitFor(() => [a, b, c].every((orcaNode) => orcaNode.members().length === 2));

      // c → a 单向断，持续 1.5s = 15 个心跳间隔。在线判定是“最近有没有收到它”：
      // a 的心跳仍能到 c，所以 c 不应该把 a 判死，也不应该报 peer_not_online。
      blocked = true;
      await sleep(1500);
      expect(c.members().some((peer) => peer.orca_node_id === a.orcaNodeId && peer.state === "online")).toBe(true);
      expect(a.members().some((peer) => peer.orca_node_id === c.orcaNodeId && peer.state === "online")).toBe(true);

      let error: unknown;
      try {
        await c.sendTask(aUrl, { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect((error as { code?: string }).code).toBeUndefined();

      // 链路恢复后同一调用应该成功并跑完。
      blocked = false;
      const task = await c.sendTask(aUrl, {
        message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
        metadata: { echo: { final: { state: "completed", text: "ok" } } },
      });
      await waitForTask(c, aUrl, task.id);
    } finally {
      await Promise.all([a.stop(), b.stop(), c.stop()]);
    }
  });

  it("survives a 5-heartbeat full outage without marking the peer offline", async () => {
    const workgroupId = newWorkgroupId();
    let blocked = false;
    const gate = (): boolean => blocked;

    const a = await makeNode(workgroupId, "jitter", { timings: SHORT_OUTAGE, fetch: jittered({ block: gate }) });
    const b = await makeNode(workgroupId, "jitter", { timings: SHORT_OUTAGE, fetch: jittered({ block: gate }) });

    try {
      const aUrl = (await a.start()).url;
      const bUrl = (await b.start()).url;
      if (!aUrl || !bUrl) throw new Error("orca nodes did not start");
      await b.join(aUrl);
      await waitFor(
        () =>
          a.members().some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online") &&
          b.members().some((peer) => peer.orca_node_id === a.orcaNodeId && peer.state === "online"),
      );

      // 500ms 全断 = 5 个心跳间隔：超过 suspect 阈值（3 个间隔），但不到 offline（6 个间隔）。
      blocked = true;
      await sleep(500);
      expect(a.members().every((peer) => peer.state !== "offline")).toBe(true);
      expect(b.members().every((peer) => peer.state !== "offline")).toBe(true);

      blocked = false;
      await waitFor(
        () =>
          a.members().some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online") &&
          b.members().some((peer) => peer.orca_node_id === a.orcaNodeId && peer.state === "online"),
      );
      expect(a.members()).toHaveLength(1);
      expect(a.membersDigest()).toBe(b.membersDigest());
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("refuses a heartbeat response that claims another node", async () => {
    const workgroupId = newWorkgroupId();
    const forgedId = "ocRQy-mZ2YzHZOVJEQCkFnxmLuG2p51Yp4jq27Cz1ag";
    const a = await makeNode(workgroupId, "jitter", { timings: JITTER });
    const c = await makeNode(workgroupId, "jitter", {
      timings: JITTER,
      fetch: rewriteJson("/cluster/heartbeat", (body) => ({ ...body, from: forgedId })),
    });

    try {
      const aUrl = (await a.start()).url;
      await c.start();
      if (!aUrl) throw new Error("orca nodes did not start");
      await c.join(aUrl);

      await expect(c.heartbeat(aUrl)).rejects.toThrow(/claimed .* but .* was expected/);
      expect(c.members().some((peer) => peer.orca_node_id === forgedId)).toBe(false);
    } finally {
      await Promise.all([a.stop(), c.stop()]);
    }
  });
});
