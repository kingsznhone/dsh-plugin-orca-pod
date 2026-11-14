import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createMesh, createNode, createNodeConfig, type FetchLike, type OrcaNode } from "../src/index.ts";
import type { MembershipTimings } from "../src/membership.ts";

const FAST: Partial<MembershipTimings> = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

/** 短暂断链用更长窗口：确认“抖动”只进 suspect，不会掉到 offline。 */
const SHORT_OUTAGE: Partial<MembershipTimings> = {
  ...FAST,
  suspectAfterMs: 200,
  offlineAfterMs: 500,
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

function newWorkgroupId(): string {
  return `wg-${randomBytes(6).toString("hex")}`;
}

function makeNode(
  workgroupId: string,
  password: string,
  options: { timings?: Partial<MembershipTimings>; fetch?: FetchLike; display_name?: string } = {},
): OrcaNode {
  const config = createNodeConfig({
    workgroupId,
    password,
    displayName: options.display_name,
    port: 0,
  });
  return createNode({ config, timings: options.timings ?? FAST, fetch: options.fetch });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met before the timeout");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("transport jitter during formation", () => {
  it("converges while every request carries random latency", async () => {
    const mesh = await createMesh({
      nodes: 3,
      workgroupId: newWorkgroupId(),
      password: "jitter",
      timings: FAST,
      fetch: () => jittered({ delayMs: () => 5 + Math.random() * 35 }),
    });

    try {
      await waitFor(() => mesh.nodes.every((node) => node.members().length === 2));
      expect(mesh.nodes.every((node) => node.members().every((peer) => peer.state === "online"))).toBe(true);
      expect(new Set(mesh.nodes.map((node) => node.membersDigest())).size).toBe(1);
    } finally {
      await mesh.stop();
    }
  });

  it("recovers after a burst of packet loss", async () => {
    const states: Jitter[] = [];
    const mesh = await createMesh({
      nodes: 3,
      workgroupId: newWorkgroupId(),
      password: "jitter",
      timings: FAST,
      fetch: () => {
        const state: Jitter = { dropRate: 0 };
        states.push(state);
        return jittered(state);
      },
    });

    try {
      await waitFor(() => mesh.nodes.every((node) => node.members().length === 2));

      for (const state of states) state.dropRate = 0.4;
      await sleep(700);

      for (const state of states) state.dropRate = 0;
      await waitFor(() =>
        mesh.nodes.every(
          (node) => node.members().length === 2 && node.members().every((peer) => peer.state === "online"),
        ),
      );
      expect(new Set(mesh.nodes.map((node) => node.membersDigest())).size).toBe(1);
    } finally {
      await mesh.stop();
    }
  });

  it("keeps a peer online when only local outbound calls fail", async () => {
    const workgroupId = newWorkgroupId();
    const a = makeNode(workgroupId, "jitter", { display_name: "a" });
    const b = makeNode(workgroupId, "jitter", { display_name: "b" });

    let aHost = "";
    let blocked = false;
    const c = makeNode(workgroupId, "jitter", {
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
      if (!aUrl || !bUrl || !cUrl) throw new Error("nodes did not start");
      aHost = new URL(aUrl).host;

      await b.join(aUrl);
      await c.join(aUrl);
      await c.join(bUrl);
      await waitFor(() => [a, b, c].every((node) => node.members().length === 2));

      // c → a 单向断：c 发不出去，但仍收得到 a 的心跳。在线判定是“最近有没有收到它”，
      // 所以 c 不应该把 a 误判成离线，也不应该报 peer_not_online。
      blocked = true;
      await sleep(300);
      expect(c.members().some((peer) => peer.node_id === a.nodeId && peer.state === "online")).toBe(true);
      expect(a.members().some((peer) => peer.node_id === c.nodeId && peer.state === "online")).toBe(true);

      let error: unknown;
      try {
        await c.sendTask(aUrl, { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } });
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      expect((error as { code?: string }).code).toBeUndefined();

      // 链路恢复后同一调用应该成功。
      blocked = false;
      const task = await c.sendTask(aUrl, {
        message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
        metadata: { echo: { final: { state: "completed", text: "ok" } } },
      });
      expect(task.id).toBeTruthy();
    } finally {
      await Promise.all([a.stop(), b.stop(), c.stop()]);
    }
  });
  it("survives a short full outage without marking the peer offline", async () => {
    const workgroupId = newWorkgroupId();
    let blocked = false;
    const gate = (): boolean => blocked;

    const a = makeNode(workgroupId, "jitter", { timings: SHORT_OUTAGE, fetch: jittered({ block: gate }) });
    const b = makeNode(workgroupId, "jitter", { timings: SHORT_OUTAGE, fetch: jittered({ block: gate }) });

    try {
      const aUrl = (await a.start()).url;
      const bUrl = (await b.start()).url;
      if (!aUrl || !bUrl) throw new Error("nodes did not start");
      await b.join(aUrl);
      await waitFor(
        () =>
          a.members().some((peer) => peer.node_id === b.nodeId && peer.state === "online") &&
          b.members().some((peer) => peer.node_id === a.nodeId && peer.state === "online"),
      );

      // 250ms 全断：超过 suspect 阈值（200ms），但不到 offline 阈值（500ms）。
      blocked = true;
      await sleep(250);
      expect(a.members().every((peer) => peer.state !== "offline")).toBe(true);
      expect(b.members().every((peer) => peer.state !== "offline")).toBe(true);

      blocked = false;
      await waitFor(
        () =>
          a.members().some((peer) => peer.node_id === b.nodeId && peer.state === "online") &&
          b.members().some((peer) => peer.node_id === a.nodeId && peer.state === "online"),
      );
      expect(a.members()).toHaveLength(1);
      expect(a.membersDigest()).toBe(b.membersDigest());
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });
});
