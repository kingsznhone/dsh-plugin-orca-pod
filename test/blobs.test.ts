import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Readable } from "node:stream";
import { buildAuthHeader, bodySha256 } from "../src/core/signing.ts";
import { DiskBlobRegistry, MemoryFileBlobStore, SqliteFileBlobStore } from "../src/core/blobs.ts";
import type { FileBlobRegistry } from "../src/core/blobs.ts";
import { PodError } from "../src/core/errors.ts";
import type { BusyState } from "../src/core/wire/peer.ts";
import type { SingleSlotTaskRunner } from "../src/task/runner.ts";
import { generateNodeIdentity } from "../src/core/identity.ts";
import { fakeNodeId } from "./fixtures/ids.ts";
import { createGatewayHarness, type GatewayHarness } from "./fixtures/gateway.ts";
import { createTestRunner } from "./fixtures/runner.ts";

const createHarness = (tasks?: SingleSlotTaskRunner, blobs?: FileBlobRegistry): GatewayHarness =>
  createGatewayHarness({ tasks, blobs });

/** A file published on the harness node, as `orca-node publish` would register it. */
async function published(content: Buffer): Promise<{ harness: GatewayHarness; blobId: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-blob-route-"));
  const path = join(dir, "result.bin");
  await writeFile(path, content);
  const fileBlobs = new DiskBlobRegistry(new MemoryFileBlobStore());
  const { blob_id: blobId } = await fileBlobs.register(path, 120);
  return { harness: createHarness(createTestRunner(), fileBlobs), blobId, path };
}

describe("blob route", () => {
  it("serves a published file to a member's signed request", async () => {
    const content = Buffer.from("signed read");
    const { harness, blobId } = await published(content);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(content)).toBe(true);
  });

  it("refuses an unsigned request", async () => {
    const { harness, blobId } = await published(Buffer.from("private"));
    const response = await harness.app.inject({ method: "GET", url: `/blobs/${blobId}` });
    expect(response.statusCode).toBe(401);
  });

  it("answers 410 blob_file_missing once the published file is gone", async () => {
    const { harness, blobId, path } = await published(Buffer.from("deleted later"));
    await rm(path);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({ code: "blob_file_missing" });
  });

  it("relays a member's file the node fetched to its own CLI", async () => {
    const asked: string[] = [];
    const node = fakeNodeId("publisher");
    const blobId = "b".repeat(64);
    const harness = createHarness();
    vi.spyOn(harness.files, "fetch").mockImplementation(async (from, blob) => {
      asked.push(`${from}/${blob}`);
      return { stream: Readable.from([Buffer.from("fetched bytes")]), size: 13 };
    });
    const url = `/cluster/blob?node=${node}&blob=${blobId}`;
    const response = await harness.app.inject({
      method: "GET",
      url,
      headers: { authorization: harness.sign("GET", url) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe("fetched bytes");
    expect(asked).toEqual([`${node}/${blobId}`]);
  });

  it("keeps the CLI route to this node itself", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    const url = `/cluster/blob?node=${fakeNodeId("publisher")}&blob=${"b".repeat(64)}`;
    const response = await harness.app.inject({
      method: "GET",
      url,
      headers: {
        authorization: buildAuthHeader({
          identity: stranger,
          method: "GET",
          url,
          targetOrcaNodeId: harness.orcaNodeId,
        }),
      },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "local_only" });
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
    expect(response.json()).toMatchObject({ code: "body_too_large" });
  });
});

describe("file blobs registered by the local CLI", () => {
  it("serves a registered file to a member under its sha256", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    const filePath = join(dir, "report.md");
    const content = Buffer.from("# findings\n");
    await writeFile(filePath, content);

    const fileBlobs = new DiskBlobRegistry(new MemoryFileBlobStore());
    const blob = await fileBlobs.register(filePath, 120);
    expect(blob.blob_id).toBe(bodySha256(content));
    expect(blob.size).toBe(content.length);
    expect(blob.expires_at).not.toBeNull();

    const harness = createHarness(createTestRunner(), fileBlobs);
    const response = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blob.blob_id}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blob.blob_id}`) },
    });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(content)).toBe(true);
  });

  it("keeps the mapping in SQLite so a later process sees it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    const filePath = join(dir, "artifact.bin");
    await writeFile(filePath, Buffer.from([1, 2, 3, 4]));
    const dbPath = join(dir, "tasks.db");

    const writer = new SqliteFileBlobStore(dbPath);
    const blob = await new DiskBlobRegistry(writer).register(filePath, 60);
    writer.close();

    const reader = new SqliteFileBlobStore(dbPath);
    const seen = new DiskBlobRegistry(reader).get(blob.blob_id);
    reader.close();
    expect(seen?.path).toBe(filePath);
    expect(seen?.size).toBe(4);
    expect(seen?.expires_at).not.toBeNull();
  });

  it("refuses a missing path instead of registering it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-blob-file-"));
    await expect(new DiskBlobRegistry(new MemoryFileBlobStore()).register(join(dir, "absent.txt"))).rejects.toThrow();
  });
});

describe("a2a busy response", () => {
  it("answers orca_node_busy with 429, Retry-After and the holder", async () => {
    const holder: BusyState = {
      task_id: "TASK1",
      origin_orca_node: generateNodeIdentity().orcaNodeId,
      since: new Date().toISOString(),
    };
    const tasks = createTestRunner();
    vi.spyOn(tasks, "submit").mockImplementation(() => {
      throw new PodError("orca_node_busy", "node is busy");
    });
    const harness = createHarness(tasks);
    // The node keeps its profile in step with the runner; the gateway reports the profile.
    harness.profile.setBusy(holder);
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
        data: { code: "orca_node_busy", message: "node is busy", retry_after_s: 30, holder },
      },
    });
  });
});
