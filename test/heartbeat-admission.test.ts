import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import { createOrcaNode } from "../src/orca_node.ts";
import type { OrcaNode } from "../src/orca_node.ts";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "orca-hb-"));
}

function newWorkgroupId(): string {
  return `wg-${randomBytes(6).toString("hex")}`;
}

function makeNode(workgroupId: string, password: string, dataRoot: string, port = 0): OrcaNode {
  const config = createOrcaNodeConfig({
    workgroup_id: workgroupId,
    workgroup_password: password,
    data_root: dataRoot,
    port,
  });
  return createOrcaNode({ config });
}

describe("heartbeat admission", () => {
  it("accepts a peer that proves the workgroup password", async () => {
    const workgroupId = newWorkgroupId();
    const a = makeNode(workgroupId, "same password", tempRoot());
    const b = makeNode(workgroupId, "same password", tempRoot());
    await a.start();
    await b.start();
    try {
      await b.join(a.endpoints[0]!);
      const response = await b.heartbeat(a.endpoints[0]!);
      expect(response.from).toBe(a.orcaNodeId);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("drops a peer that kept the old password instead of leaving it online", async () => {
    const workgroupId = newWorkgroupId();
    const rootA = tempRoot();
    const configA = createOrcaNodeConfig({
      workgroup_id: workgroupId,
      workgroup_password: "old password",
      data_root: rootA,
      port: 0,
    });
    const b = makeNode(workgroupId, "old password", tempRoot());
    const a = createOrcaNode({ config: configA });
    await a.start();
    await b.start();
    try {
      await b.join(a.endpoints[0]!);
      const oldUrl = a.endpoints[0]!;
      const oldPort = Number(new URL(oldUrl).port);
      await expect(b.heartbeat(oldUrl)).resolves.toBeDefined();
      await a.stop();

      // Same data root and port: same Ed25519 identity, a different password.
      const a2 = createOrcaNode({
        config: createOrcaNodeConfig({
          workgroup_id: workgroupId,
          workgroup_password: "new password",
          data_root: rootA,
          port: oldPort,
        }),
      });
      await a2.start();
      try {
        expect(b.members().some((peer) => peer.orca_node_id === a2.orcaNodeId)).toBe(true);
        // The first attempt can reuse a pooled socket to the stopped node.
        const refusal = await b.heartbeat(a2.endpoints[0]!).catch((error: unknown) => error);
        const failure =
          // By name, not instanceof: fetch's TypeError may come from another realm (vm pools).
          (refusal as { name?: unknown } | null)?.name === "TypeError"
            ? await b.heartbeat(a2.endpoints[0]!).catch((error: unknown) => error)
            : refusal;
        expect(failure).toMatchObject({ status: 401 });
        // The old mesh forgets the node on the very first rejected heartbeat.
        expect(b.members().some((peer) => peer.orca_node_id === a2.orcaNodeId)).toBe(false);
      } finally {
        await a2.stop();
      }
    } finally {
      await b.stop();
    }
  });
});
