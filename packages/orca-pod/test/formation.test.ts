import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

import { describe, expect, it } from "vitest";

import { createMesh, createNode, createNodeConfig, joinRoster } from "../src/index.ts";
import type { NodeConfig } from "../src/config.ts";
import type { MembershipTimings } from "../src/membership.ts";
import type { OrcaNode } from "../src/node.ts";
import type { TaskView } from "../src/protocol.ts";

const FAST: Partial<MembershipTimings> = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

function newWorkgroupId(): string {
  return `wg-${randomBytes(6).toString("hex")}`;
}

function makeNode(workgroupId: string, password: string, options: Partial<Pick<NodeConfig, "data_root" | "node_id" | "display_name">> = {}): OrcaNode {
  const config = createNodeConfig({
    workgroupId,
    password,
    dataRoot: options.data_root,
    nodeId: options.node_id,
    displayName: options.display_name,
    port: 0,
  });
  return createNode({ config, timings: FAST });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not finish before the timeout");
}

describe("mesh formation", () => {
  it("converges five nodes that join the same bootstrap concurrently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const nodes = Array.from({ length: 5 }, (_, index) =>
      makeNode(workgroupId, password, { display_name: `n${index}` }),
    );

    try {
      const urls = await Promise.all(nodes.map(async (node) => (await node.start()).url));
      const bootstrap = urls[0];
      if (!bootstrap) throw new Error("bootstrap did not start");

      // 五个节点同时 join 同一个 bootstrap：后到者与先到者互相补齐。
      await Promise.all(nodes.slice(1).map((node) => node.join(bootstrap)));

      await waitFor(() => nodes.every((node) => node.members().length === 4));
      const digests = new Set(nodes.map((node) => node.membersDigest()));
      expect(digests.size).toBe(1);
      expect(nodes.every((node) => node.members().every((peer) => peer.state === "online"))).toBe(true);
    } finally {
      await Promise.all(nodes.map((node) => node.stop()));
    }
  });

  it("handles concurrent cross joins idempotently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = makeNode(workgroupId, password, { display_name: "a" });
    const b = makeNode(workgroupId, password, { display_name: "b" });

    try {
      const [aUrl, bUrl] = await Promise.all([a.start(), b.start()]).then(([ra, rb]) => [ra.url, rb.url]);
      if (!aUrl || !bUrl) throw new Error("nodes did not start");

      await Promise.all([a.join(bUrl), b.join(aUrl)]);
      await waitFor(() => a.members().length === 1 && b.members().length === 1);
      expect(a.membersDigest()).toBe(b.membersDigest());

      // 重复 join 不得产生第二条记录，也不得让 digest 抖动。
      const before = a.membersDigest();
      await a.join(bUrl);
      await a.join(bUrl);
      expect(a.members()).toHaveLength(1);
      expect(a.membersDigest()).toBe(before);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("joins the reachable peers even when one directory entry is dead", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = makeNode(workgroupId, password, { display_name: "a" });
    const b = makeNode(workgroupId, password, { display_name: "b" });
    const c = makeNode(workgroupId, password, { display_name: "c" });

    try {
      const aUrl = (await a.start()).url;
      if (!aUrl) throw new Error("a did not start");
      const bUrl = (await b.start()).url;
      if (!bUrl) throw new Error("b did not start");
      await b.join(aUrl);
      await waitFor(() => a.members().some((peer) => peer.node_id === b.nodeId && peer.state === "online"));

      // b 掉线：a 的目录里还留着它的死 endpoint。
      await b.stop();

      const cUrl = (await c.start()).url;
      if (!cUrl) throw new Error("c did not start");
      const directory = await c.join(aUrl);
      const { failed } = await joinRoster(c, directory.members);

      expect(failed).toContain(b.nodeId);
      await waitFor(() => c.members().some((peer) => peer.node_id === a.nodeId && peer.state === "online"));

      // 一个死条目不影响新节点加入，也不影响它对存活节点派任务。
      const task = await c.sendTask(aUrl, {
        message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
        metadata: { echo: { final: { state: "completed", text: "ok" } } },
      });
      const finished = await waitForTask(c, aUrl, task.id);
      expect(finished.status.state).toBe("completed");
    } finally {
      await Promise.all([a.stop(), c.stop()]);
    }
  });

  it("recognises a restarted node under the same id and endpoint change", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = makeNode(workgroupId, password, { display_name: "a" });
    const b = makeNode(workgroupId, password, { display_name: "b" });

    try {
      const aUrl = (await a.start()).url;
      if (!aUrl) throw new Error("a did not start");
      const bUrl = (await b.start()).url;
      if (!bUrl) throw new Error("b did not start");
      await b.join(aUrl);
      await waitFor(() => a.members().some((peer) => peer.node_id === b.nodeId && peer.state === "online"));

      const firstConfig = b.config;
      await b.stop();
      await waitFor(() => a.members().some((peer) => peer.node_id === firstConfig.node_id && peer.state !== "online"));

      // 同 node_id、同 data_root、新端口：等价于“进程重启”。
      const restarted = makeNode(workgroupId, password, {
        data_root: firstConfig.data_root,
        node_id: firstConfig.node_id,
        display_name: firstConfig.display_name,
      });
      try {
        const restartedUrl = (await restarted.start()).url;
        if (!restartedUrl) throw new Error("restarted node did not start");
        await restarted.join(aUrl);

        await waitFor(() =>
          a.members().some(
            (peer) => peer.node_id === restarted.nodeId && peer.state === "online" && peer.endpoint === restarted.endpoint,
          ),
        );
        expect(a.members().filter((peer) => peer.node_id === restarted.nodeId)).toHaveLength(1);
      } finally {
        await restarted.stop();
      }
    } finally {
      await a.stop();
    }
  });

  it("converges ten nodes (the recommended upper bound)", async () => {
    const workgroupId = newWorkgroupId();
    const mesh = await createMesh({ nodes: 10, workgroupId, password: "formation-test", timings: FAST });

    try {
      await waitFor(() => mesh.nodes.every((node) => node.members().length === 9));
      const digests = new Set(mesh.nodes.map((node) => node.membersDigest()));
      expect(digests.size).toBe(1);
      expect(mesh.nodes.every((node) => node.members().every((peer) => peer.state === "online"))).toBe(true);
    } finally {
      await mesh.stop();
    }
  });

  it("rejoins at most once when a peer answers 404", async () => {
    const counts = { heartbeat: 0, join: 0 };
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/cluster/heartbeat")) counts.heartbeat += 1;
      else if (request.url?.endsWith("/cluster/join")) counts.join += 1;
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ code: "unknown_node" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake peer did not bind a port");
    const fakeUrl = `http://127.0.0.1:${address.port}`;

    const workgroupId = newWorkgroupId();
    const node = makeNode(workgroupId, "formation-test", { display_name: "prober" });

    try {
      await node.start();
      await expect(node.heartbeat(fakeUrl)).rejects.toBeDefined();
      expect(counts).toEqual({ heartbeat: 1, join: 1 });

      // 第二次仍然是一次心跳 + 一次重 join：没有指数重试。
      await expect(node.heartbeat(fakeUrl)).rejects.toBeDefined();
      expect(counts).toEqual({ heartbeat: 2, join: 2 });
    } finally {
      await node.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
