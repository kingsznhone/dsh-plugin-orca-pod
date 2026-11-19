import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodeParts } from "./support/node.ts";
import { createMesh } from "./support/harness.ts";
import { Orca } from "../src/node/orca.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import type { TaskView } from "../src/task/wire.ts";
import { pickFreePort } from "../src/core/net.ts";
import { wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/wire/peer.ts";
import type { NodeIdentity } from "../src/core/identity.ts";
import { peersOf } from "./support/node.ts";

const FAST: Partial<MeshTimings> = {
  intervalMs: 50,
  suspectAfterMs: 150,
  offlineAfterMs: 300,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

function newWorkgroupId(): WorkgroupId {
  return wg(`wg-${randomBytes(6).toString("hex")}`);
}

/**
 * Ten orca nodes make 90 heartbeat links, all on this one event loop and 40x
 * faster than production (10 nodes beat every 10s there, with a 5s timeout).
 * FAST's 50ms cadence cannot hold on a busy runner, so the scale case gets
 * slower, generous windows — including the per-heartbeat timeout, which would
 * otherwise be derived as interval / 2 = 125ms and turn one slow response
 * during setup into a failed test. The test asserts convergence, not latency.
 */
const TEN_NODE_TIMINGS: Partial<MeshTimings> = {
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

async function makeNode(
  workgroupId: WorkgroupId,
  password: string,
  options: {
    data_root?: string;
    display_name?: string;
    port?: number;
    identity?: NodeIdentity;
    timings?: Partial<MeshTimings>;
  } = {},
): Promise<Orca> {
  const config = nodeParts(
    {
      workgroup_id: workgroupId,
      workgroup_password: password,
      data_root: options.data_root ?? tempRoot(),
      display_name: options.display_name,
      port: options.port ?? 0,
    },
    options.identity,
  );
  return new Orca(...config, { timings: options.timings ?? FAST });
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not finish before the timeout");
}

describe("mesh formation", () => {
  it("converges five orca nodes that join the same bootstrap concurrently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const orcaNodes = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        makeNode(workgroupId, password, { display_name: `n${index}`, timings: TEN_NODE_TIMINGS }),
      ),
    );

    try {
      const urls = await Promise.all(orcaNodes.map(async (orcaNode) => (await orcaNode.start()).url));
      const bootstrap = urls[0];
      if (!bootstrap) throw new Error("bootstrap did not start");

      // 五个 orca node 同时 join 同一个 bootstrap：后到者与先到者互相补齐。
      await Promise.all(orcaNodes.slice(1).map((orcaNode) => orcaNode.mesh.probe(bootstrap)));

      await waitFor(() =>
        orcaNodes.every(
          (orcaNode) => peersOf(orcaNode).length === 4 && peersOf(orcaNode).every((peer) => peer.state === "online"),
        ),
      );
      const digests = new Set(orcaNodes.map((orcaNode) => orcaNode.mesh.digest()));
      expect(digests.size).toBe(1);
    } finally {
      await Promise.all(orcaNodes.map((orcaNode) => orcaNode.stop()));
    }
  });

  it("handles concurrent cross joins idempotently", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = await makeNode(workgroupId, password, { display_name: "a" });
    const bRoot = tempRoot();
    const b = await makeNode(workgroupId, password, { display_name: "b", data_root: bRoot });

    try {
      const [aUrl, bUrl] = await Promise.all([a.start(), b.start()]).then(([ra, rb]) => [ra.url, rb.url]);
      if (!aUrl || !bUrl) throw new Error("orca nodes did not start");

      await Promise.all([a.mesh.probe(bUrl), b.mesh.probe(aUrl)]);
      await waitFor(() => peersOf(a).length === 1 && peersOf(b).length === 1);
      expect(a.mesh.digest()).toBe(b.mesh.digest());

      // 重复 join 不得产生第二条记录，也不得让 digest 抖动。
      const before = a.mesh.digest();
      await a.mesh.probe(bUrl);
      await a.mesh.probe(bUrl);
      expect(peersOf(a)).toHaveLength(1);
      expect(a.mesh.digest()).toBe(before);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("joins the reachable peers even when one directory entry is dead", async () => {
    const workgroupId = newWorkgroupId();
    const password = "formation-test";
    const a = await makeNode(workgroupId, password, { display_name: "a" });
    const bRoot = tempRoot();
    const b = await makeNode(workgroupId, password, { display_name: "b", data_root: bRoot });
    const c = await makeNode(workgroupId, password, { display_name: "c" });

    try {
      const aUrl = (await a.start()).url;
      if (!aUrl) throw new Error("a did not start");
      const bUrl = (await b.start()).url;
      if (!bUrl) throw new Error("b did not start");
      await b.mesh.probe(aUrl);
      await waitFor(() => peersOf(a).some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"));

      // b 掉线：a 的目录里还留着它的死 endpoint。
      await b.stop();

      const cUrl = (await c.start()).url;
      if (!cUrl) throw new Error("c did not start");
      await c.mesh.probe(aUrl);

      // a's directory still names b, so c knows it as a candidate that never answers.
      expect(c.mesh.get(b.orcaNodeId)?.state).not.toBe("online");
      await waitFor(() => peersOf(c).some((peer) => peer.orca_node_id === a.orcaNodeId && peer.state === "online"));

      // 一个死条目不影响新 orca node 加入，也不影响它对存活 orca node 派任务。
      const task = await c.mesh.resolve(aUrl).sendTask({
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
    const a = await makeNode(workgroupId, password, { display_name: "a" });
    const bRoot = tempRoot();
    const b = await makeNode(workgroupId, password, { display_name: "b", data_root: bRoot });

    try {
      const aUrl = (await a.start()).url;
      if (!aUrl) throw new Error("a did not start");
      const bUrl = (await b.start()).url;
      if (!bUrl) throw new Error("b did not start");
      await b.mesh.probe(aUrl);
      await waitFor(() => peersOf(a).some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state === "online"));

      await b.stop();
      await waitFor(() => peersOf(a).some((peer) => peer.orca_node_id === b.orcaNodeId && peer.state !== "online"));

      // 同 orca_node_id、同 data_root、新端口：等价于“进程重启”。
      const restarted = await makeNode(workgroupId, password, {
        data_root: bRoot,
        display_name: "b",
        identity: b.identity,
      });
      try {
        const restartedUrl = (await restarted.start()).url;
        if (!restartedUrl) throw new Error("restarted orca node did not start");
        await restarted.mesh.probe(aUrl);

        await waitFor(() =>
          peersOf(a).some(
            (peer) =>
              peer.orca_node_id === restarted.orcaNodeId &&
              peer.state === "online" &&
              peer.endpoints.includes(restarted.mesh.self.endpoints[0]!),
          ),
        );
        expect(peersOf(a).filter((peer) => peer.orca_node_id === restarted.orcaNodeId)).toHaveLength(1);
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
            const members = peersOf(orcaNode);
            return members.length === 9 && members.every((peer) => peer.state === "online");
          }),
        25_000,
      );
      const digests = new Set(mesh.orcaNodes.map((orcaNode) => orcaNode.mesh.digest()));
      expect(digests.size).toBe(1);
      expect(mesh.orcaNodes.every((orcaNode) => peersOf(orcaNode).every((peer) => peer.state === "online"))).toBe(true);
    } finally {
      await mesh.stop();
    }
  }, 40_000);

  it("is registered again by its next hello when a peer forgot it: there is no rejoin to do", async () => {
    const workgroupId = newWorkgroupId();
    const a = await makeNode(workgroupId, "formation-test", { display_name: "a", timings: { intervalMs: 60_000 } });
    const b = await makeNode(workgroupId, "formation-test", { display_name: "b", timings: { intervalMs: 60_000 } });
    try {
      const bUrl = (await b.start()).url;
      await a.start();
      await a.mesh.probe(bUrl);
      expect(b.mesh.get(a.orcaNodeId)?.state).toBe("online");

      // b prunes a (its record expired, or it was restarted and lost its table).
      b.mesh.remove(a.orcaNodeId);
      expect(b.mesh.get(a.orcaNodeId)).toBeUndefined();

      // Nothing was rejected, so there is nothing to retry: one more hello is all it takes, and
      // a request of a member that b forgot is still answered, because both proofs hold.
      const hello = await a.mesh.probe(bUrl);
      expect(hello.id).toBe(b.orcaNodeId);
      expect(b.mesh.get(a.orcaNodeId)?.state).toBe("online");
      expect(peersOf(b).filter((peer) => peer.orca_node_id === a.orcaNodeId)).toHaveLength(1);
    } finally {
      await Promise.all([a.stop(), b.stop()]);
    }
  });

  it("keeps trying a seed that did not answer at start, until it does", async () => {
    const workgroupId = newWorkgroupId();
    const port = await pickFreePort();
    const late = await makeNode(workgroupId, "formation-test", { display_name: "late", timings: FAST, port });
    const seeded = await makeNode(workgroupId, "formation-test", { display_name: "seeded", timings: FAST });
    try {
      // The late node's address is known (a fixed port), but nothing listens there yet.
      const lateUrl = `http://127.0.0.1:${port}`;
      await seeded.start();
      const { reached, pending } = await seeded.mesh.seed([lateUrl]);
      expect(reached).toEqual([]);
      expect(pending).toEqual([lateUrl]);
      expect(peersOf(seeded)).toHaveLength(0);

      // It comes up: the seed's backoff finds it without anyone connecting again.
      await late.start();
      await waitFor(() =>
        peersOf(seeded).some((peer) => peer.orca_node_id === late.orcaNodeId && peer.state === "online"),
      );
      // The node that came up was greeted as itself, so it knows the seeded node too.
      expect(late.mesh.get(seeded.orcaNodeId)?.state).toBe("online");
    } finally {
      await Promise.all([late.stop(), seeded.stop()]);
    }
  });
});
