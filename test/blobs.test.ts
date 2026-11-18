import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { NonceCache, buildAuthHeader, bodySha256 } from "../src/core/signing.ts";
import { createFileBlobRegistry, createMemoryFileBlobStore, createSqliteFileBlobStore } from "../src/core/blobs.ts";
import type { FileBlobRegistry } from "../src/core/blobs.ts";
import { PodError } from "../src/core/errors.ts";
import { runtimeDigest, type BusyState, type SelfRecord } from "../src/core/wire/peer.ts";
import type { TaskRunner } from "../src/task/wire.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/core/identity.ts";
import { createMembership } from "../src/mesh/membership.ts";
import { createGateway, type GatewayDeps } from "../src/api/gateway.ts";
import { fakeNodeId, wg } from "./fixtures/ids.ts";

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
  recover() {
    return 0;
  },
  list() {
    return [];
  },
};

function selfRecord(identity: NodeIdentity): SelfRecord {
  return {
    orca_node_id: identity.orcaNodeId,
    display_name: "blob-test-orca-node",
    endpoints: [ENDPOINT],
    runtime: null,
    runtime_digest: runtimeDigest(null),
    state: "online",
    busy: null,
    last_recv_at: null,
    workgroup_id: wg("orca-dev"),
  };
}

type Harness = {
  app: ReturnType<typeof createGateway>;
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  sign(method: string, path: string, body?: Uint8Array | string): string;
};

/** What the node does when its CLI asks for a member's file; the gateway only relays it. */
type FetchBlob = GatewayDeps["orcaNode"]["fetchBlob"];

const noFetch: FetchBlob = async () => {
  throw new Error("not used");
};

function createHarness(
  tasks: TaskRunner = idleTasks,
  fileBlobs: FileBlobRegistry = createFileBlobRegistry(createMemoryFileBlobStore()),
  fetchBlob: FetchBlob = noFetch,
): Harness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const orcaNodeId = identity.orcaNodeId;
  const deps: GatewayDeps = {
    orcaNode: {
      orca_node_id: orcaNodeId,
      workgroup_id: wg("orca-dev"),
      self: () => selfRecord(identity),
      fetchBlob,
    },
    identity,
    workgroupKey: key,
    peers: createMembership({ selfOrcaNodeId: orcaNodeId }).peers,
    nonceCache: new NonceCache(),
    startedAt: Date.now(),
    tasks,
    fileBlobs,
  };
  return {
    app: createGateway(deps),
    key,
    identity,
    orcaNodeId,
    sign: (method, url, body) => buildAuthHeader({ identity, method, url, targetOrcaNodeId: orcaNodeId, body }),
  };
}

/** A file published on the harness node, as `orca-node publish` would register it. */
async function published(content: Buffer): Promise<{ harness: Harness; blobId: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-blob-route-"));
  const path = join(dir, "result.bin");
  await writeFile(path, content);
  const fileBlobs = createFileBlobRegistry(createMemoryFileBlobStore());
  const { blob_id: blobId } = await fileBlobs.register(path, 120);
  return { harness: createHarness(idleTasks, fileBlobs), blobId, path };
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
    const harness = createHarness(idleTasks, undefined, async (from, blob) => {
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

    const fileBlobs = createFileBlobRegistry(createMemoryFileBlobStore());
    const blob = await fileBlobs.register(filePath, 120);
    expect(blob.blob_id).toBe(bodySha256(content));
    expect(blob.size).toBe(content.length);
    expect(blob.expires_at).not.toBeNull();

    const harness = createHarness(idleTasks, fileBlobs);
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
    await expect(
      createFileBlobRegistry(createMemoryFileBlobStore()).register(join(dir, "absent.txt")),
    ).rejects.toThrow();
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
        throw new PodError("orca_node_busy", "node is busy");
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
        data: { code: "orca_node_busy", message: "node is busy", retry_after_s: 30, holder },
      },
    });
  });
});
