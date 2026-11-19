import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { Orca } from "../src/node/orca.ts";
import { wg } from "./fixtures/ids.ts";
import type { WorkgroupId } from "../src/core/ids.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import { waitFor } from "./support/harness.ts";
import { identityOf, nodeParts, peersOf } from "./support/node.ts";

const FAST: Partial<MeshTimings> = {
  intervalMs: 40,
  suspectAfterMs: 120,
  offlineAfterMs: 240,
  recoverProbeMs: 100,
  maxRecoverProbeMs: 200,
  recordTtlMs: 5000,
  tombstoneMs: 5000,
};

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "orca-hb-"));
}

function newWorkgroupId(): WorkgroupId {
  return wg(`wg-${randomBytes(6).toString("hex")}`);
}

function makeNode(workgroupId: WorkgroupId, password: string, dataRoot: string): Orca {
  return new Orca(
    ...nodeParts({ workgroup_id: workgroupId, workgroup_password: password, data_root: dataRoot, port: 0 }),
    { timings: FAST },
  );
}

describe("hello admission", () => {
  it("accepts a peer that proves the workgroup password, and its answer is the node's own", async () => {
    const workgroupId = newWorkgroupId();
    const a = makeNode(workgroupId, "same password", tempRoot());
    const b = makeNode(workgroupId, "same password", tempRoot());
    await a.start();
    await b.start();
    try {
      const first = await b.mesh.probe(a.mesh.self.endpoints[0]!);
      // The same request again is a heartbeat: a node already known answers as itself.
      const again = await b.mesh.probe(a.mesh.self.endpoints[0]!);
      expect(first.id).toBe(a.mesh.self.id);
      expect(again).toBe(first);
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("drops a peer that kept the old password instead of leaving it online, on its very next request", async () => {
    const workgroupId = newWorkgroupId();
    const rootA = tempRoot();
    const a = makeNode(workgroupId, "old password", rootA);
    const b = makeNode(workgroupId, "old password", tempRoot());
    await a.start();
    await b.start();
    try {
      const oldUrl = a.mesh.self.endpoints[0]!;
      const oldPort = Number(new URL(oldUrl).port);
      await b.mesh.probe(oldUrl);
      expect(peersOf(b).some((peer) => peer.orca_node_id === a.mesh.self.id)).toBe(true);
      await a.stop();

      // Same identity and port, a different password: the node is the same, the workgroup is not.
      const a2 = new Orca(
        ...nodeParts(
          {
            workgroup_id: workgroupId,
            workgroup_password: "new password",
            data_root: rootA,
            port: oldPort,
          },
          identityOf(a),
        ),
        { timings: FAST },
      );
      await a2.start();
      try {
        // Contact is refused with the workgroup proof, not with a membership check.
        const refusal = await b.mesh.probe(a2.mesh.self.endpoints[0]!).catch((error: unknown) => error);
        // The first attempt can reuse a pooled socket to the stopped node.
        const failure =
          // By name, not instanceof: fetch's TypeError may come from another realm (vm pools).
          (refusal as { name?: unknown } | null)?.name === "TypeError"
            ? await b.mesh.probe(a2.mesh.self.endpoints[0]!).catch((error: unknown) => error)
            : refusal;
        expect(failure).toMatchObject({ status: 401, code: "bad_proof" });

        // The old mesh forgets the node when its own greeting is rejected, instead of keeping it online.
        await waitFor(
          () => peersOf(b),
          (peers) => !peers.some((peer) => peer.orca_node_id === a2.mesh.self.id),
          { label: "the old mesh to drop the node that changed its password" },
        );
      } finally {
        await a2.stop();
      }
    } finally {
      await b.stop();
    }
  });
});
