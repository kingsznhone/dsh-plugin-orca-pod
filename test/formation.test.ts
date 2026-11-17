import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createMesh } from "../src/node/harness.ts";
import { createOrcaNode, joinRoster } from "../src/node/orca-node.ts";
import type { OrcaNodeConfig } from "../src/node/config.ts";
import { generateNodeIdentity } from "../src/security/identity.ts";
import type { MembershipTimings } from "../src/membership/membership.ts";
import type { OrcaNode } from "../src/node/orca-node.ts";
import type { TaskView } from "../src/protocol/protocol.ts";

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

/**
 * Ten orca nodes make 90 heartbeat links, all on this one event loop and 40x
 * faster than production (10 nodes beat every 10s there, with a 5s timeout).
 * FAST's 50ms cadence cannot hold on a busy runner, so the scale case gets
 * slower, generous windows — including the per-heartbeat timeout, which would
 * otherwise be derived as interval / 2 = 125ms and turn one slow response
 * during setup into a failed test. The test asserts convergence, not latency.
 */
const TEN_NODE_TIMINGS: Partial<MembershipTimings> = {
  intervalMs: 250,
  heartbeatTimeoutMs: 2000,
  suspectAfterMs: 3000,
  offlineAfterMs: 6000,
  recoverProbeMs: 800,
  maxRecoverProbeMs: 1600,
  recordTtlMs: 30_000,
  tombstoneMs: 30_000,
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "orca-formation-"));
}

function makeNode(
  workgroupId: string,
  password: string,
  options: Partial<Pick<OrcaNodeConfig, "data_root" | "display_name">> & { timings?: Partial<MembershipTimings> } = {},
): OrcaNode {
  const config = createOrcaNodeConfig({
    workgroup_id: workgroupId,
    workgroup_password: password,
    data_root: options.data_root ?? tempRoot(),
    display_name: options.display_name,
    port: 0,
  });
  return createOrcaNode({ config, timings: options.timings ?? FAST });
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
  it("converges five orca nodes that join the same bootstrap concurrently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const orcaNodes = Array.from({ length: 5 }, (_, index) =>
      makeNode(workgroupId, password, { display_name: `n${index}`, timings: TEN_NODE_TIMINGS }),
    );

    try {
      const urls = await Promise.all(orcaNodes.map(async (orcaNode) => (await orcaNode.start()).url));
      const bootstrap = urls[0];
      if (!bootstrap) throw new Error("bootstrap did not start");

      // 五个 orca node 同时 join 同一个 bootstrap：后到者与先到者互相补齐。
      await Promise.all(orcaNodes.slice(1).map((orcaNode) => orcaNode.join(bootstrap)));

      await waitFor(() =>
        orcaNodes.every(
          (orcaNode) => orcaNode.members().length === 4 && orcaNode.members().every((peer) => peer.state === "online"),
        ),
      );
      const digests = new Set(orcaNodes.map((orcaNode) => orcaNode.membersDigest()));
      expect(digests.size).toBe(1);
    } finally {
      await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
    }
  });

  it("handles concurrent cross joins idempotently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = makeNode(workgroupId, password, { display_name: "a" });
    const b = makeNode(workgroupId, password, { display_name: "b" });

    try {
      const [aUrl, bUrl] = await Promise.all([a.start(), b.start()]).then(([ra, rb]) => [ra.url, rb.url]);
      if (!aUrl || !bUrl) throw new Error("orca nodes did not start");

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
      await waitFor(() => a.members().some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"));

      // b 掉线：a 的目录里还留着它的死 endpoint。
      await b.stop();

      const cUrl = (await c.start()).url;
      if (!cUrl) throw new Error("c did not start");
      const directory = await c.join(aUrl);
      const { failed } = await joinRoster(c, directory.members);

      expect(failed).toContain(b.orcaNodeId);
      await waitFor(() => c.members().some((peer) => peer.orca_node_id === a.orcaNodeId && peer.state === "online"));

      // 一个死条目不影响新 orca node 加入，也不影响它对存活 orca node 派任务。
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

  it("recognises a restarted orca node under the same id and endpoint change", async () => {
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
      await waitFor(() => a.members().some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"));

      const firstConfig = b.config;
      await b.stop();
      await waitFor(() =>
        a.members().some((peer) => peer.orca_node_id === firstConfig.orca_node_id && peer.state !== "online"),
      );

      // 同 orca_node_id、同 data_root、新端口：等价于“进程重启”。
      const restarted = makeNode(workgroupId, password, {
        data_root: firstConfig.data_root,
        display_name: firstConfig.display_name,
      });
      try {
        const restartedUrl = (await restarted.start()).url;
        if (!restartedUrl) throw new Error("restarted orca node did not start");
        await restarted.join(aUrl);

        await waitFor(() =>
          a
            .members()
            .some(
              (peer) =>
                peer.orca_node_id === restarted.orcaNodeId &&
                peer.state === "online" &&
                peer.endpoints.includes(restarted.endpoints[0]!),
            ),
        );
        expect(a.members().filter((peer) => peer.orca_node_id === restarted.orcaNodeId)).toHaveLength(1);
      } finally {
        await restarted.stop();
      }
    } finally {
      await a.stop();
    }
  });

  it("converges ten orca nodes (the recommended upper bound)", async () => {
    const workgroupId = newWorkgroupId();
    const mesh = await createMesh({
      orcaNodes: 10,
      workgroupId,
      password: "formation-test",
      timings: TEN_NODE_TIMINGS,
    });

    try {
      await waitFor(
        () =>
          mesh.orcaNodes.every((orcaNode) => {
            const members = orcaNode.members();
            return members.length === 9 && members.every((peer) => peer.state === "online");
          }),
        25_000,
      );
      const digests = new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.membersDigest()));
      expect(digests.size).toBe(1);
      expect(mesh.orcaNodes.every((orcaNode) => orcaNode.members().every((peer) => peer.state === "online"))).toBe(
        true,
      );
    } finally {
      await mesh.stop();
    }
  }, 40_000);

  it("rejoins at most once when a peer answers 404", async () => {
    const counts = { heartbeat: 0, join: 0 };
    const fakeId = generateNodeIdentity().orcaNodeId;
    let fakeUrl = "";
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/cluster/heartbeat")) counts.heartbeat += 1;
      else if (request.url?.endsWith("/cluster/join")) {
        counts.join += 1;
        // Only the first join is admitted, so the peer is a known member afterwards.
        if (counts.join === 1) {
          const self = {
            orca_node_id: fakeId,
            display_name: "fake",
            endpoints: [fakeUrl],
            runtime: null,
            runtime_digest: "none",
            state: "online",
            busy: null,
            last_recv_at: null,
            workgroup_id: "unused",
          };
          response.end(JSON.stringify({ self, members: [], members_digest: "none" }));
          return;
        }
      }
      response.writeHead(404);
      response.end(JSON.stringify({ code: "unknown_orca_node" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("fake peer did not bind a port");
    fakeUrl = `http://127.0.0.1:${address.port}`;

    const workgroupId = newWorkgroupId();
    const orcaNode = makeNode(workgroupId, "formation-test", {
      display_name: "prober",
      // Keep the background loop out of the counts: only the explicit calls talk to the fake peer.
      timings: { intervalMs: 60_000 },
    });

    try {
      await orcaNode.start();
      await orcaNode.join(fakeUrl);
      expect(counts).toEqual({ heartbeat: 0, join: 1 });

      await expect(orcaNode.heartbeat(fakeUrl)).rejects.toBeDefined();
      expect(counts).toEqual({ heartbeat: 1, join: 2 });

      // 第二次仍然是一次心跳 + 一次重 join：没有指数重试。
      await expect(orcaNode.heartbeat(fakeUrl)).rejects.toBeDefined();
      expect(counts).toEqual({ heartbeat: 2, join: 3 });
    } finally {
      await orcaNode.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
