import type { FetchLike } from "../src/mesh/peer-client.ts";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { nodeParts, peersOf } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import type { MeshTimings } from "../src/mesh/timings.ts";
import { wg } from "./fixtures/ids.ts";
import type { PeerView } from "../src/mesh/wire.ts";
import type { WorkgroupId } from "../src/core/ids.ts";

const TIMINGS: Partial<MeshTimings> = {
  intervalMs: 100,
  suspectAfterMs: 300,
  offlineAfterMs: 600,
  recoverProbeMs: 200,
  maxRecoverProbeMs: 400,
  recordTtlMs: 10000,
  tombstoneMs: 10000,
  heartbeatTimeoutMs: 400,
};

function newWorkgroupId(): WorkgroupId {
  return wg(`wg-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`);
}

async function closedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

describe("multiple advertised endpoints (IPv4/IPv6, LAN, public matrix)", () => {
  it("advertises the whole list and dials past an unreachable one", async () => {
    const workgroupId = newWorkgroupId();
    const password = "correct horse battery staple";
    const deadPort = await closedPort();
    const listenPort = await closedPort();
    const dead = `http://127.0.0.1:${deadPort}`;
    const live = `http://127.0.0.1:${listenPort}`;

    const bConfig = nodeParts({
      workgroup_id: workgroupId,
      workgroup_password: password,
      port: listenPort,
      data_root: mkdtempSync(join(tmpdir(), "orca-multi-endpoint-")),
      endpoints: [dead, live],
    });
    const b: Orca = new Orca(...bConfig, { timings: TIMINGS });
    await b.start();

    let deadAttempts = 0;
    const counting: FetchLike = async (url, init) => {
      if (String(url).includes(`:${deadPort}/`)) deadAttempts += 1;
      return fetch(url, init);
    };
    const aConfig = nodeParts({
      workgroup_id: workgroupId,
      workgroup_password: password,
      port: 0,
      data_root: mkdtempSync(join(tmpdir(), "orca-multi-endpoint-")),
    });
    const a: Orca = new Orca(...aConfig, { timings: TIMINGS, fetch: counting });
    await a.start();

    try {
      const joined = await a.mesh.probe(live);
      expect(joined.endpoints).toEqual([dead, live]);

      const peer = (): PeerView | undefined => peersOf(a).find((view) => view.orca_node_id === b.orcaNodeId);
      await waitFor(() => peer() !== undefined);
      expect(peer()?.endpoints).toEqual([dead, live]);

      // First URL refuses connections; the loop must fall through to the second
      // one instead of counting a heartbeat failure and marking the peer offline.
      await waitFor(() => deadAttempts > 0 && peer()?.state === "online");
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(peer()?.state).toBe("online");
    } finally {
      await a.stop();
      await b.stop();
    }
  });

  it("rejects an empty endpoint list during config creation", async () => {
    expect(() =>
      nodeParts({
        workgroup_id: newWorkgroupId(),
        workgroup_password: "correct horse",
        port: 0,
        endpoints: ["ftp://example.com"],
      }),
    ).toThrow();
  });
});
