import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import { createOrcaNode, type FetchLike, type OrcaNode } from "../src/orca_node.ts";

const WORKGROUP = "orca-outbound";
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

function makeNode(fetchImpl: FetchLike | undefined, requestTimeoutMs?: number): OrcaNode {
  const config = createOrcaNodeConfig({
    workgroupId: WORKGROUP,
    password: PASSWORD,
    dataRoot: tempRoot(),
    host: "127.0.0.1",
    port: 0,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
  const node = createOrcaNode({ config, ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
  nodes.push(node);
  return node;
}

describe("outbound A2A calls (11)", () => {
  it("gives every outbound call a deadline", async () => {
    const stalled: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener(
          "abort",
          () => reject((init.signal as AbortSignal).reason ?? new Error("aborted")),
          { once: true },
        );
      });
    const node = makeNode(stalled, 25);
    const started = Date.now();
    await expect(node.getTask("http://127.0.0.1:9", "01TASK")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("rejects a response that is not JSON", async () => {
    const peer = makeNode(undefined);
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
    const origin = makeNode(degraded);
    await origin.start();
    await origin.join(peer.endpoints[0]!);
    await expect(origin.getTask(peer.endpoints[0]!, "01TASK")).rejects.toThrow(/content type/);
  });

  it("does not log a read of a task it never dispatched", async () => {
    const peer = makeNode(undefined);
    await peer.start();
    const origin = makeNode(undefined);
    await origin.start();
    await origin.join(peer.endpoints[0]!);

    await expect(origin.getTask(peer.endpoints[0]!, "01MISSING")).rejects.toBeDefined();
    expect(origin.listDispatches()).toHaveLength(0);
  });

  it("refreshes an existing dispatch entry without creating more", async () => {
    const peer = makeNode(undefined);
    await peer.start();
    const origin = makeNode(undefined);
    await origin.start();
    await origin.join(peer.endpoints[0]!);

    const view = await origin.sendTask(peer.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "ping" }] },
    });
    await origin.getTask(peer.endpoints[0]!, view.id);
    await origin.getTask(peer.endpoints[0]!, view.id);

    const entries = origin.listDispatches();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.task_id).toBe(view.id);
  });
});
