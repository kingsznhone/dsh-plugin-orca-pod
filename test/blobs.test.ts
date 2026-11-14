import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceCache, buildAuthHeader } from "../src/crypto.ts";
import {
  TaskError,
  generateOrcaNodeId,
  type BusyState,
  type TaskRunner,
} from "../src/protocol.ts";
import { createMemoryBlobStore, createMemoryPeerStore, sha256Hex } from "../src/storage.ts";
import { createGateway, type GatewayDeps, type GatewayOrcaNode } from "../src/gateway.ts";

const ENDPOINT = "http://orca-node.test";

const idleTasks: TaskRunner = {
  submit() {
    throw new Error("not used");
  },
  get() {
    return null;
  },
  resume() {
    throw new Error("not used");
  },
  cancel() {
    throw new Error("not used");
  },
  busy() {
    return null;
  },
  recover() {
    return 0;
  },
};

type Harness = {
  app: ReturnType<typeof createGateway>;
  key: Buffer;
  sign(method: string, path: string, body?: Uint8Array | string): string;
};

function createHarness(tasks: TaskRunner = idleTasks): Harness {
  const key = randomBytes(32);
  const orcaNodeId = generateOrcaNodeId();
  const orcaNode: GatewayOrcaNode = {
    orca_node_id: orcaNodeId,
    display_name: "blob-test-orca-node",
    workgroup_id: "orca-dev",
    endpoint: ENDPOINT,
  };
  const deps: GatewayDeps = {
    orcaNode,
    key,
    peers: createMemoryPeerStore(),
    nonceCache: new NonceCache(),
    runtime: null,
    tasks,
    blobs: createMemoryBlobStore(),
  };
  return {
    app: createGateway(deps),
    key,
    sign: (method, path, body) => buildAuthHeader({ key, orcaNodeId, method, path, body }),
  };
}

async function upload(
  harness: Harness,
  payload: Buffer,
  options: { name?: string; digest?: string } = {},
) {
  const url = options.name === undefined ? "/blobs" : `/blobs?name=${encodeURIComponent(options.name)}`;
  return harness.app.inject({
    method: "POST",
    url,
    payload,
    headers: {
      "content-type": "application/octet-stream",
      authorization: harness.sign("POST", "/blobs", payload),
      "x-pod-body-sha256": options.digest ?? sha256Hex(payload),
    },
  });
}

describe("blob channel", () => {
  it("rejects an unsigned upload with 401", async () => {
    const harness = createHarness();
    const payload = Buffer.from("unsigned bytes");
    const response = await harness.app.inject({
      method: "POST",
      url: "/blobs",
      payload,
      headers: {
        "content-type": "application/octet-stream",
        "x-pod-body-sha256": sha256Hex(payload),
      },
    });
    expect(response.statusCode).toBe(401);
  });

  it("rejects a mismatched X-Pod-Body-SHA256 with 400", async () => {
    const harness = createHarness();
    const response = await upload(harness, Buffer.from("payload"), {
      digest: sha256Hex(Buffer.from("something else")),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: "blob_digest_mismatch" });
  });

  it("stores bytes and returns 201 with the blob metadata", async () => {
    const harness = createHarness();
    const payload = Buffer.from("hello blob");
    const response = await upload(harness, payload, { name: "notes.txt" });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      blob_id: sha256Hex(payload),
      size: payload.length,
      name: "notes.txt",
      expires_at: null,
    });
  });

  it("returns the original bytes from GET", async () => {
    const harness = createHarness();
    const payload = Buffer.from("roundtrip bytes");
    const blobId = (await upload(harness, payload)).json<{ blob_id: string }>().blob_id;
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("application/octet-stream");
    expect(response.rawPayload.equals(payload)).toBe(true);
  });

  it("dedupes a repeated upload with 200 and the same blob_id", async () => {
    const harness = createHarness();
    const payload = Buffer.from("dedupe me");
    const first = await upload(harness, payload);
    const second = await upload(harness, payload);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json<{ blob_id: string }>().blob_id).toBe(
      first.json<{ blob_id: string }>().blob_id,
    );
  });

  it("serves a /link URL without signed headers", async () => {
    const harness = createHarness();
    const payload = Buffer.from("linked bytes");
    const blobId = (await upload(harness, payload)).json<{ blob_id: string }>().blob_id;
    const link = await harness.app.inject({
      method: "POST",
      url: `/blobs/${blobId}/link`,
      headers: { authorization: harness.sign("POST", `/blobs/${blobId}/link`) },
    });
    expect(link.statusCode).toBe(200);
    const linkUrl = new URL(link.json<{ url: string }>().url);
    expect(linkUrl.origin).toBe(ENDPOINT);
    const response = await harness.app.inject({
      method: "GET",
      url: `${linkUrl.pathname}${linkUrl.search}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(payload)).toBe(true);
  });

  it("rejects an expired link with 410", async () => {
    const harness = createHarness();
    const payload = Buffer.from("expired link");
    const blobId = (await upload(harness, payload)).json<{ blob_id: string }>().blob_id;
    const exp = String(Math.floor(Date.now() / 1000) - 10);
    const sig = createHmac("sha256", harness.key)
      .update(`link|${blobId}|${exp}`)
      .digest("base64url");
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}?exp=${exp}&sig=${sig}`,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ code: "link_expired" });
  });
});

describe("a2a busy response", () => {
  it("answers orca_node_busy with 429, Retry-After and the holder", async () => {
    const holder: BusyState = {
      task_id: "TASK1",
      origin_orca_node: generateOrcaNodeId(),
      since: new Date().toISOString(),
    };
    const tasks: TaskRunner = {
      submit() {
        throw new TaskError("orca_node_busy", "node is busy");
      },
      get() {
        return null;
      },
      resume() {
        throw new Error("not used");
      },
      cancel() {
        throw new Error("not used");
      },
      busy() {
        return holder;
      },
      recover() {
        return 0;
      },
    };
    const harness = createHarness(tasks);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: "req-1",
      method: "message/send",
      params: { message: { role: "user", parts: [{ kind: "text", text: "hi" }] } },
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/a2a",
      payload,
      headers: {
        "content-type": "application/json",
        authorization: harness.sign("POST", "/a2a", payload),
      },
    });
    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("30");
    expect(response.json()).toEqual({
      jsonrpc: "2.0",
      id: "req-1",
      error: {
        code: -32000,
        message: "orca_node_busy",
        data: { code: "orca_node_busy", retry_after_s: 30, holder },
      },
    });
  });
});
