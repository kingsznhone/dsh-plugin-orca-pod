import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NonceCache, blobLinkSignature, buildAuthHeader } from "../src/crypto.ts";
import { createFileBlobRegistry, type FileBlobRegistry } from "../src/blob_files.ts";
import { TaskError, type BusyState, type TaskRunner } from "../src/protocol.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/identity.ts";
import { createSqliteFileBlobStore } from "../src/sqlite.ts";
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
  originOf() {
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
  escalate() {
    throw new Error("not used");
  },
  recover() {
    return 0;
  },
  list() {
    return [];
  },
};

type Harness = {
  app: ReturnType<typeof createGateway>;
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  sign(method: string, path: string, body?: Uint8Array | string, bodySha256?: string): string;
};

function createHarness(tasks: TaskRunner = idleTasks, fileBlobs?: FileBlobRegistry): Harness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const orcaNodeId = identity.orcaNodeId;
  const orcaNode: GatewayOrcaNode = {
    orca_node_id: orcaNodeId,
    display_name: "blob-test-orca-node",
    workgroup_id: "orca-dev",
    endpoints: [ENDPOINT],
  };
  const deps: GatewayDeps = {
    orcaNode,
    identity,
    workgroupKey: key,
    peers: createMemoryPeerStore(),
    nonceCache: new NonceCache(),
    runtime: null,
    tasks,
    blobs: createMemoryBlobStore(),
    ...(fileBlobs === undefined ? {} : { fileBlobs }),
  };
  return {
    app: createGateway(deps),
    key,
    identity,
    orcaNodeId,
    sign: (method, url, body, bodySha256) =>
      buildAuthHeader({
        identity,
        method,
        url,
        targetOrcaNodeId: orcaNodeId,
        body,
        ...(bodySha256 === undefined ? {} : { bodySha256 }),
      }),
  };
}

async function upload(
  harness: Harness,
  payload: Buffer,
  options: { name?: string; digest?: string } = {},
) {
  const url = options.name === undefined ? "/blobs" : `/blobs?name=${encodeURIComponent(options.name)}`;
  const digest = options.digest ?? sha256Hex(payload);
  return harness.app.inject({
    method: "POST",
    url,
    payload,
    headers: {
      "content-type": "application/octet-stream",
      authorization: harness.sign("POST", url, payload, digest),
      "x-pod-body-sha256": digest,
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

  it("streams a large upload and download without buffering it", async () => {
    const harness = createHarness();
    const payload = Buffer.alloc(1024 * 1024, 7);
    const uploaded = await upload(harness, payload, { name: "big.bin" });
    expect(uploaded.statusCode).toBe(201);
    const blobId = uploaded.json<{ blob_id: string; size: number }>().blob_id;
    expect(uploaded.json<{ size: number }>().size).toBe(payload.length);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(response.statusCode).toBe(200);
    expect(Number(response.headers["content-length"])).toBe(payload.length);
    expect(response.rawPayload.equals(payload)).toBe(true);
  });

  it("accepts an upload above the default request cap on the blob route", async () => {
    const harness = createHarness();
    const payload = Buffer.alloc(2 * 1024 * 1024, 9);
    const uploaded = await upload(harness, payload, { name: "two-megabytes.bin" });
    expect(uploaded.statusCode).toBe(201);
    expect(uploaded.json<{ size: number }>().size).toBe(payload.length);
  });

  it("rejects an oversized JSON body before the route handler runs", async () => {
    const harness = createHarness();
    const body = JSON.stringify({ workgroup_id: "orca-dev", padding: "x".repeat(1024 * 1024) });
    const response = await harness.app.inject({
      method: "POST",
      url: "/cluster/join",
      payload: body,
      headers: {
        "content-type": "application/json",
        authorization: harness.sign("POST", "/cluster/join", body),
      },
    });
    expect(response.statusCode).toBe(413);
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
    const sig = blobLinkSignature(harness.identity, blobId, exp);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}?exp=${exp}&sig=${sig}`,
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toEqual({ code: "link_expired" });
  });
});

describe("file blobs registered by the local CLI", () => {
  it("serves a registered file through a signed URL without a request signature", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    const filePath = join(dir, "report.md");
    const content = Buffer.from("# findings\n");
    await writeFile(filePath, content);

    const fileBlobs = createFileBlobRegistry();
    const blob = await fileBlobs.register(filePath, 120);
    expect(blob.blob_id).toBe(sha256Hex(content));
    expect(blob.size).toBe(content.length);
    expect(blob.expires_at).not.toBeNull();

    const harness = createHarness(idleTasks, fileBlobs);
    const exp = String(Math.floor(Date.now() / 1000) + 60);
    const sig = blobLinkSignature(harness.identity, blob.blob_id, exp);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blob.blob_id}?exp=${exp}&sig=${sig}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(content)).toBe(true);
  });

  it("has no HTTP registration route at all", async () => {
    // Publishing a path is reading it; a shared workgroup key cannot prove which
    // orca node signed, so this capability stays local (CLI) and off the network.
    const harness = createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/blobs/register",
      payload: { path: "/etc/passwd" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("keeps the mapping in SQLite so a later process sees it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    const filePath = join(dir, "artifact.bin");
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));
    const dbPath = join(dir, "tasks.db");

    const writer = createSqliteFileBlobStore(dbPath);
    const blob = await createFileBlobRegistry(writer).register(filePath, 60);
    writer.close();

    const reader = createSqliteFileBlobStore(dbPath);
    const seen = createFileBlobRegistry(reader).get(blob.blob_id);
    reader.close();
    expect(seen?.path).toBe(filePath);
    expect(seen?.size).toBe(4);
    expect(seen?.expires_at).not.toBeNull();
  });

  it("refuses a missing path instead of registering it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    await expect(createFileBlobRegistry().register(join(dir, "absent.txt"))).rejects.toThrow();
  });
});

describe("a2a busy response", () => {
  it("answers orca_node_busy with 429, Retry-After and the holder", async () => {
    const holder: BusyState = {
      task_id: "TASK1",
      origin_orca_node: generateNodeIdentity().orcaNodeId,
      since: new Date().toISOString(),
    };
    const tasks: TaskRunner = {
      submit() {
        throw new TaskError("orca_node_busy", "node is busy");
      },
      get() {
        return null;
      },
      originOf() {
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
      escalate() {
        throw new Error("not used");
      },
      recover() {
        return 0;
      },
      list() {
        return [];
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
