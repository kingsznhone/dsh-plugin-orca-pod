import { nodeFetch, type FetchLike } from "../src/mesh/peer-client.ts";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodeParts, peersOf } from "./support/node.ts";
import { createMesh } from "./support/harness.ts";
import { Orca } from "../src/node/orca.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import type { TaskView } from "../src/task/wire.ts";
import { wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/ids.ts";
import { ScriptExecutor, scriptMessage } from "./support/script.ts";

/**
 * 压缩时钟：interval 100ms（生产不传 intervalMs 时按节点数在 2s–10s 间自适应），
 * 所有抖动窗口都按“心跳间隔的倍数”给（2–6 个间隔），避免测出来的只是“一次心跳还没发出去”。
 */
const JITTER: Partial<MeshTimings> = {
  intervalMs: 100,
  suspectAfterMs: 300,
  offlineAfterMs: 600,
  recoverProbeMs: 200,
  maxRecoverProbeMs: 400,
  recordTtlMs: 10000,
  tombstoneMs: 10000,
  heartbeatTimeoutMs: 400,
};

/** 短暂断链沿用 JITTER 的窗口（suspect 3 个间隔、offline 6 个间隔）：确认“抖动”只进 suspect，不会掉到 offline。 */
const SHORT_OUTAGE: Partial<MeshTimings> = {
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
    return nodeFetch(url, init);
  };
}

/** Rewrite one JSON response field in flight; everything else passes through. */
function rewriteJson(
  pathSuffix: string,
  mutate: (body: Record<string, unknown>) => Record<string, unknown>,
): FetchLike {
  return async (url, init) => {
    const response = await nodeFetch(url, init);
    if (!url.pathname.endsWith(pathSuffix)) return response;
    const body = (await response.json()) as Record<string, unknown>;
    // The answer keeps the signature its node put on it, which no longer fits what it now says.
    return new Response(JSON.stringify(mutate(body)), {
      status: response.status,
      headers: { "content-type": "application/json", "pod-reply": response.headers.get("pod-reply") ?? "" },
    });
  };
}

function newWorkgroupId(): WorkgroupId {
  return wg(`wg-${randomBytes(6).toString("hex")}`);
}

async function makeNode(
  workgroupId: WorkgroupId,
  password: string,
  options: { timings?: Partial<MeshTimings>; fetch?: FetchLike; display_name?: string } = {},
): Promise<Orca> {
  const config = nodeParts({
    workgroup_id: workgroupId,
    workgroup_password: password,
    display_name: options.display_name,
    port: 0,
    data_root: mkdtempSync(join(tmpdir(), "orca-transport-")),
  });
  return new Orca(...config, {
    timings: options.timings ?? JITTER,
    fetch: options.fetch,
    executor: new ScriptExecutor(),
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

async function waitForTask(client: Orca, peerUrl: string, taskId: string): Promise<TaskView> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const task = await client.mesh.resolve(peerUrl).getTask(taskId);
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
      await waitFor(() => mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).length === 2));
      await waitFor(() =>
        mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).every((peer) => peer.state === "online")),
      );
      expect(new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.mesh.digest())).size).toBe(1);
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
      await waitFor(() => mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).length === 2));

      // 45% 丢包、持续 3s = 30 个心跳间隔：期间状态可能反复 suspect/online。
      for (const state of states) state.dropRate = 0.45;
      await sleep(3000);

      for (const state of states) state.dropRate = 0;
      await waitFor(() =>
        mesh.orcaNodes.every(
          (orcaNode) => peersOf(orcaNode).length === 2 && peersOf(orcaNode).every((peer) => peer.state === "online"),
        ),
      );
      expect(new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.mesh.digest())).size).toBe(1);
    } finally {
      await mesh.stop();
    }
  });

  it("holds a peer at suspect, not offline, through a 15-heartbeat one-way outbound failure", async () => {
    const workgroupId = newWorkgroupId();
    const a = await makeNode(workgroupId, "jitter", { display_name: "a" });
    const b = await makeNode(workgroupId, "jitter", { display_name: "b" });

    let aHost = "";
    let blocked = false;
    const c = await makeNode(workgroupId, "jitter", {
      display_name: "c",
      fetch: (url, init) => {
        if (blocked && aHost !== "" && url.host === aHost) throw new TypeError("simulated one-way partition");
        return nodeFetch(url, init);
      },
    });

    try {
      const aUrl = (await a.start()).url;
      const bUrl = (await b.start()).url;
      const cUrl = (await c.start()).url;
      if (!aUrl || !bUrl || !cUrl) throw new Error("orca nodes did not start");
      aHost = new URL(aUrl).host;

      await b.mesh.probe(aUrl);
      await c.mesh.probe(aUrl);
      await c.mesh.probe(bUrl);
      await waitFor(() => [a, b, c].every((orcaNode) => peersOf(orcaNode).length === 2));

      // c → a 单向断，持续 1.5s = 15 个心跳间隔（例如 a 在 NAT 后面）。a 的心跳仍能到 c，
      // 所以 c 不把 a 判死（不进 offline）；但 c 连不上 a，a 停在 suspect(unreachable)，
      // 派任务立即得到 peer_not_online，而不是等拨号失败（design.md 2.5）。
      const stateOfA = () => peersOf(c).find((peer) => peer.orca_node_id === a.mesh.self.id)?.state;
      blocked = true;
      await sleep(1500);
      expect(stateOfA()).toBe("suspect");
      expect(peersOf(a).some((peer) => peer.orca_node_id === c.mesh.self.id && peer.state === "online")).toBe(true);
      await expect(
        c.mesh.resolve(aUrl).sendTask({ message: { role: "user", parts: [{ kind: "text", text: "hi" }] } }),
      ).rejects.toMatchObject({ code: "peer_not_online" });

      // 链路恢复：c 的下一拍心跳得到应答，a 回到 online，同一调用成功并跑完。
      blocked = false;
      await waitFor(() => stateOfA() === "online");
      const task = await c.mesh.resolve(aUrl).sendTask({
        message: scriptMessage({ final: { state: "completed", text: "ok" } }),
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
      await b.mesh.probe(aUrl);
      await waitFor(
        () =>
          peersOf(a).some((peer) => peer.orca_node_id === b.mesh.self.id && peer.state === "online") &&
          peersOf(b).some((peer) => peer.orca_node_id === a.mesh.self.id && peer.state === "online"),
      );

      // 500ms 全断 = 5 个心跳间隔：超过 suspect 阈值（3 个间隔），但不到 offline（6 个间隔）。
      blocked = true;
      await sleep(500);
      expect(peersOf(a).every((peer) => peer.state !== "offline")).toBe(true);
      expect(peersOf(b).every((peer) => peer.state !== "offline")).toBe(true);

      blocked = false;
      await waitFor(
        () =>
          peersOf(a).some((peer) => peer.orca_node_id === b.mesh.self.id && peer.state === "online") &&
          peersOf(b).some((peer) => peer.orca_node_id === a.mesh.self.id && peer.state === "online"),
      );
      expect(peersOf(a)).toHaveLength(1);
      expect(a.mesh.digest()).toBe(b.mesh.digest());
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("refuses a hello answer that was changed in flight, and records nothing from it", async () => {
    const workgroupId = newWorkgroupId();
    const forgedId = "ocRQy-mZ2YzHZOVJEQCkFnxmLuG2p51Yp4jq27Cz1ag";
    const a = await makeNode(workgroupId, "jitter", { timings: JITTER });
    const c = await makeNode(workgroupId, "jitter", {
      timings: JITTER,
      // A man in the middle rewrites the hello answer in flight (there is no plain HTTP path) and
      // adds a node to the directory it hands back.
      fetch: rewriteJson("/cluster/hello", (body) => ({
        ...body,
        members: [
          {
            orca_node_id: forgedId,
            display_name: "mallory",
            endpoints: ["http://127.0.0.1:9"],
            runtime: null,
            runtime_digest: "x",
            state: "online",
            busy: null,
            last_recv_at: null,
          },
        ],
      })),
    });

    try {
      const aUrl = (await a.start()).url;
      await c.start();
      if (!aUrl) throw new Error("orca nodes did not start");

      await expect(c.mesh.probe(aUrl)).rejects.toThrow(/not signed by its sender/);
      expect(peersOf(c)).toHaveLength(0);
      expect(peersOf(c).some((peer) => peer.orca_node_id === forgedId)).toBe(false);
    } finally {
      await Promise.all([a.stop(), c.stop()]);
    }
  });
});
