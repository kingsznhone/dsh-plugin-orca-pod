import type { FetchLike } from "../src/mesh/peer-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { OrcaNode } from "../src/node/orca-node.ts";
import { wg } from "./fixtures/ids.ts";

const WORKGROUP = wg("orca-outbound");
const PASSWORD = "outbound-secret";

let nodes: OrcaNode[] = [];
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "orca-outbound-"));
  roots.push(root);
  return root;
}

async function makeNode(fetchImpl: FetchLike | undefined, requestTimeoutMs?: number): Promise<OrcaNode> {
  const config = await createOrcaNodeConfig({
    workgroup_id: WORKGROUP,
    workgroup_password: PASSWORD,
    data_root: tempRoot(),
    bind_host: "127.0.0.1",
    port: 0,
    request_timeout_ms: requestTimeoutMs,
  });
  const node = new OrcaNode(config, { ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  nodes.push(node);
  return node;
}

describe("outbound A2A calls (11)", () => {
  it("gives every outbound call a deadline", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const stalled: FetchLike = (url, init) =>
      url.pathname !== "/a2a"
        ? fetch(url, init)
        : new Promise<Response>((_resolve, reject) => {
            init.signal?.addEventListener(
              "abort",
              () => reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
              { once: true },
            );
          });
    const node = await makeNode(stalled, 250);
    await node.start();
    await node.mesh.join(peer.profile.endpoints[0]!);
    const started = Date.now();
    await expect(node.delegation.getTask(peer.profile.endpoints[0]!, "01TASK")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not join a stranger to answer a read", async () => {
    const stranger = await makeNode(undefined);
    await stranger.start();
    const node = await makeNode(undefined);
    await node.start();

    for (const call of [
      () => node.delegation.getTask(stranger.profile.endpoints[0]!, "01TASK"),
      () => node.delegation.cancelTask(stranger.profile.endpoints[0]!, "01TASK"),
      () =>
        node.delegation.sendTask(stranger.profile.endpoints[0]!, {
          message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
        }),
      () => node.mesh.heartbeat(stranger.profile.endpoints[0]!),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "unknown_peer" });
    }
    // Nothing was sent: the stranger never saw the node's admission proof.
    expect(stranger.membership.list()).toHaveLength(0);
    expect(node.membership.list()).toHaveLength(0);

    await node.mesh.join(stranger.profile.endpoints[0]!);
    await expect(node.delegation.getTask(stranger.profile.endpoints[0]!, "01MISSING")).rejects.toMatchObject({
      code: "task_not_found",
      status: 404,
    });
  });

  it("stops reading a response body once it passes the size cap", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    let pulled = 0;
    let cancelled = false;
    const endless: FetchLike = (url, init) =>
      url.pathname !== "/a2a"
        ? fetch(url, init)
        : Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                pull(controller) {
                  pulled += 1;
                  controller.enqueue(new Uint8Array(1024 * 1024));
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            ),
          );
    const origin = await makeNode(endless);
    await origin.start();
    await origin.mesh.join(peer.profile.endpoints[0]!);
    await expect(origin.delegation.getTask(peer.profile.endpoints[0]!, "01TASK")).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(16);
  });

  it("rejects a response that is not JSON", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const degraded: FetchLike = (url, init) =>
      url.pathname === "/a2a"
        ? Promise.resolve(
            new Response("<html>nope</html>", {
              status: 200,
              headers: { "content-type": "text/html" },
            }),
          )
        : fetch(url, init);
    const origin = await makeNode(degraded);
    await origin.start();
    await origin.mesh.join(peer.profile.endpoints[0]!);
    await expect(origin.delegation.getTask(peer.profile.endpoints[0]!, "01TASK")).rejects.toThrow(/content type/);
  });

  it("does not log a read of a task it never dispatched", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await makeNode(undefined);
    await origin.start();
    await origin.mesh.join(peer.profile.endpoints[0]!);

    await expect(origin.delegation.getTask(peer.profile.endpoints[0]!, "01MISSING")).rejects.toBeDefined();
    expect(origin.delegation.log.list()).toHaveLength(0);
  });

  it("refreshes an existing dispatch entry without creating more", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await makeNode(undefined);
    await origin.start();
    await origin.mesh.join(peer.profile.endpoints[0]!);

    const view = await origin.delegation.sendTask(peer.profile.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "ping" }] },
    });
    await origin.delegation.getTask(peer.profile.endpoints[0]!, view.id);
    await origin.delegation.getTask(peer.profile.endpoints[0]!, view.id);

    const entries = origin.delegation.log.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.task_id).toBe(view.id);
  });
});
