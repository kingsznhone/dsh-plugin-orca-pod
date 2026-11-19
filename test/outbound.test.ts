import type { FetchLike } from "../src/mesh/peer-client.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeParts, peersOf } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import { generateNodeIdentity } from "../src/core/identity.ts";
import { wg } from "./fixtures/ids.ts";
import { replyTo } from "./support/replies.ts";

const WORKGROUP = wg("orca-outbound");
const PASSWORD = "outbound-secret";

let nodes: Orca[] = [];
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

async function makeNode(fetchImpl: FetchLike | undefined, requestTimeoutMs?: number): Promise<Orca> {
  const config = nodeParts({
    workgroup_id: WORKGROUP,
    workgroup_password: PASSWORD,
    data_root: tempRoot(),
    bind_host: "127.0.0.1",
    port: 0,
    request_timeout_ms: requestTimeoutMs,
  });
  const node = new Orca(...config, { ...(fetchImpl === undefined ? {} : { fetch: fetchImpl }) });
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
    await node.mesh.probe(peer.mesh.self.endpoints[0]!);
    const started = Date.now();
    await expect(node.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("does not join a stranger to answer a read", async () => {
    const stranger = await makeNode(undefined);
    await stranger.start();
    const node = await makeNode(undefined);
    await node.start();

    for (const call of [
      async () => node.mesh.resolve(stranger.mesh.self.endpoints[0]!).getTask("01TASK"),
      async () => node.mesh.resolve(stranger.mesh.self.endpoints[0]!).cancelTask("01TASK"),
      async () =>
        node.mesh.resolve(stranger.mesh.self.endpoints[0]!).sendTask({
          message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: "unknown_peer" });
    }
    // Nothing was sent: the stranger never saw a request of the node.
    expect(peersOf(stranger)).toHaveLength(0);
    expect(peersOf(node)).toHaveLength(0);

    await node.mesh.probe(stranger.mesh.self.endpoints[0]!);
    await expect(node.mesh.resolve(stranger.mesh.self.endpoints[0]!).getTask("01MISSING")).rejects.toMatchObject({
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
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toThrow(/too large/);
    expect(cancelled).toBe(true);
    expect(pulled).toBeLessThan(16);
  });

  /** An origin whose `/a2a` answers come from `answer`, a peer it knows and can take the identity of. */
  async function originAnsweredBy(peer: Orca, answer: (init: RequestInit) => Response): Promise<Orca> {
    const forged: FetchLike = (url, init) =>
      url.pathname === "/a2a" ? Promise.resolve(answer(init)) : fetch(url, init);
    const origin = await makeNode(forged);
    await origin.start();
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);
    return origin;
  }

  const taskReply = (id: string) =>
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      result: { kind: "task", id, contextId: "c", status: { state: "working", timestamp: "2026-01-01T00:00:00.000Z" } },
    });

  it("rejects a response that is not JSON, even from the right node", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await originAnsweredBy(peer, (init) =>
      replyTo(init, peer.identity, "<html>nope</html>", { contentType: "text/html" }),
    );
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toThrow(/content type/);
  });

  it("accepts a reply the node signed", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await originAnsweredBy(peer, (init) => replyTo(init, peer.identity, taskReply("01TASK")));
    const view = await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK");
    expect(view.id).toBe("01TASK");
  });

  it("refuses a reply that is not signed at all", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await originAnsweredBy(peer, (init) =>
      replyTo(init, peer.identity, taskReply("01TASK"), { sign: false }),
    );
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toMatchObject({
      code: "peer_error",
      message: expect.stringMatching(/not signed by its sender/),
    });
  });

  it("refuses a reply signed by another node than the one addressed", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const impostor = generateNodeIdentity();
    const origin = await originAnsweredBy(peer, (init) => replyTo(init, impostor, taskReply("01TASK")));
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toThrow(
      /was signed by .* but .* was addressed/,
    );
  });

  it("refuses a reply whose body was changed after it was signed", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await originAnsweredBy(peer, (init) =>
      replyTo(init, peer.identity, taskReply("01FORGED"), { signedBody: taskReply("01TASK") }),
    );
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toThrow(
      /not signed by its sender/,
    );
  });

  it("refuses a genuine reply that is moved to answer another request", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await originAnsweredBy(peer, (init) =>
      replyTo(init, peer.identity, taskReply("01TASK"), { nonce: "the-nonce-of-another-request" }),
    );
    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01TASK")).rejects.toThrow(
      /not signed by its sender/,
    );
  });

  it("does not log a read of a task it never dispatched", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await makeNode(undefined);
    await origin.start();
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);

    await expect(origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask("01MISSING")).rejects.toBeDefined();
    expect(origin.dispatches.list()).toHaveLength(0);
  });

  it("leaves the dispatch log to the tracker: reading a dispatched task writes nothing", async () => {
    const peer = await makeNode(undefined);
    await peer.start();
    const origin = await makeNode(undefined);
    await origin.start();
    await origin.mesh.probe(peer.mesh.self.endpoints[0]!);

    const view = await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "ping" }] },
    });
    const recorded = origin.dispatches.list();
    await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask(view.id);
    await origin.mesh.resolve(peer.mesh.self.endpoints[0]!).getTask(view.id);

    expect(origin.dispatches.list()).toEqual(recorded);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.task_id).toBe(view.id);
  });
});
