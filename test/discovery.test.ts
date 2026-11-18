import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { OrcaNode } from "../src/node/orca-node.ts";
import { wg } from "./fixtures/ids.ts";

const TIMINGS = {
  intervalMs: 30,
  suspectAfterMs: 200,
  offlineAfterMs: 400,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5_000,
  tombstoneMs: 1_000,
};

const orcaNodes: OrcaNode[] = [];

async function make(displayName: string): Promise<OrcaNode> {
  const orcaNode = new OrcaNode(
    await createOrcaNodeConfig({
      workgroup_id: wg("orca-dev"),
      workgroup_password: "secret",
      display_name: displayName,
      bind_host: "127.0.0.1",
      port: 0,
      data_root: mkdtempSync(join(tmpdir(), "orca-discovery-")),
    }),
    { timings: TIMINGS },
  );
  orcaNodes.push(orcaNode);
  return orcaNode;
}

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(async () => {
  await Promise.all(orcaNodes.splice(0).map((orcaNode) => orcaNode.stop().catch(() => undefined)));
});

describe("lazy discovery", () => {
  it("C only joins A, then reaches B via join-on-404", async () => {
    const a = await make("a");
    await a.start();
    const b = await make("b");
    await b.start();
    await b.mesh.join(a.profile.endpoints[0]!);

    const c = await make("c");
    await c.start();
    await c.mesh.join(a.profile.endpoints[0]!);

    // join 的目录里已经有 B，但 B 还不认识 C
    expect(c.membership.list().some((member) => member.orca_node_id === b.orcaNodeId)).toBe(true);
    expect(b.membership.list().some((member) => member.orca_node_id === c.orcaNodeId)).toBe(false);

    // C 心跳 B 撞 404 → 自动重新 join B；拿到目录后 B 也认识 C
    await waitFor(
      () =>
        [a, b, c].every((orcaNode) => orcaNode.membership.list().length === 2) &&
        c.membership.list().every((member) => member.state === "online"),
    );

    for (const orcaNode of [a, b, c]) {
      expect(orcaNode.membership.list()).toHaveLength(2);
    }
  });

  it("two halves that grow independently still converge through heartbeat candidate lists", async () => {
    const a = await make("a");
    await a.start();
    const b = await make("b");
    await b.start();
    await b.mesh.join(a.profile.endpoints[0]!);

    // A 侧来了 C，B 侧来了 D：双方只看 join 快照时谁也看不到对面
    const c = await make("c");
    await c.start();
    await c.mesh.join(a.profile.endpoints[0]!);
    const d = await make("d");
    await d.start();
    await d.mesh.join(b.profile.endpoints[0]!);

    // 心跳里只带摘要；摘要不一致时对端回目录，orca node 据此补齐候选并建立心跳边
    await waitFor(() =>
      [a, b, c, d].every(
        (orcaNode) =>
          orcaNode.membership.list().length === 3 &&
          orcaNode.membership.list().every((member) => member.state === "online"),
      ),
    );

    for (const orcaNode of [a, b, c, d]) {
      expect(orcaNode.membership.list()).toHaveLength(3);
    }
  });
});
