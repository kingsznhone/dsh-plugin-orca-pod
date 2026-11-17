import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceCache, admissionProof, blobLinkSignature, buildAuthHeader } from "../src/security/crypto.ts";
import { runtimeDigest, type BusyState, type PeerView, type SelfRecord } from "../src/protocol/peer.ts";
import type { TaskRunner } from "../src/protocol/task.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/security/identity.ts";
import { createMembership } from "../src/membership/membership.ts";
import type { PeerStore } from "../src/membership/membership.ts";
import { createMemoryBlobStore, createMemoryFileBlobStore } from "../src/storage/memory.ts";
import { sha256Hex } from "../src/storage/blob-common.ts";
import { createFileBlobRegistry } from "../src/storage/file-registry.ts";
import { createGateway, type GatewayDeps } from "../src/transport/gateway/index.ts";

const ENDPOINT = "http://orca-node.test";
const WORKGROUP = "orca-dev";

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

function selfRecord(identity: NodeIdentity): SelfRecord {
  return {
    orca_node_id: identity.orcaNodeId,
    display_name: "authorization-test-orca-node",
    endpoints: [ENDPOINT],
    runtime: null,
    runtime_digest: runtimeDigest(null),
    state: "online",
    busy: null,
    last_recv_at: null,
    workgroup_id: WORKGROUP,
  };
}

type Harness = {
  app: ReturnType<typeof createGateway>;
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  peers: PeerStore;
  sign(method: string, path: string, body?: Uint8Array | string, bodySha256?: string): string;
};

function createHarness(): Harness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const orcaNodeId = identity.orcaNodeId;
  const peers = createMembership({ selfOrcaNodeId: orcaNodeId }).peers;
  const deps: GatewayDeps = {
    orcaNode: {
      orca_node_id: orcaNodeId,
      workgroup_id: WORKGROUP,
      self: () => selfRecord(identity),
      linkChildTask: () => {},
    },
    identity,
    workgroupKey: key,
    peers,
    nonceCache: new NonceCache(),
    startedAt: Date.now(),
    tasks: idleTasks,
    blobs: createMemoryBlobStore(),
    fileBlobs: createFileBlobRegistry(createMemoryFileBlobStore()),
  };
  return {
    app: createGateway(deps),
    key,
    identity,
    orcaNodeId,
    peers,
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

function peerView(identity: NodeIdentity, endpoint: string): PeerView {
  return {
    orca_node_id: identity.orcaNodeId,
    display_name: "stranger",
    endpoints: [endpoint],
    runtime: null,
    runtime_digest: "",
    state: "online",
    busy: null as BusyState | null,
    last_recv_at: null,
    max_task_ttl_s: 600,
  };
}

async function upload(harness: Harness, stranger: NodeIdentity, payload: Buffer) {
  const digest = sha256Hex(payload);
  return harness.app.inject({
    method: "POST",
    url: "/blobs",
    payload,
    headers: {
      "content-type": "application/octet-stream",
      authorization: strangerSign(harness, stranger, "POST", "/blobs", payload, digest),
      "x-pod-body-sha256": digest,
    },
  });
}

function strangerSign(
  harness: Harness,
  stranger: NodeIdentity,
  method: string,
  path: string,
  body?: Uint8Array | string,
  bodySha256?: string,
): string {
  return buildAuthHeader({
    identity: stranger,
    method,
    url: path,
    targetOrcaNodeId: harness.orcaNodeId,
    body,
    ...(bodySha256 === undefined ? {} : { bodySha256 }),
  });
}

describe("workgroup membership gate (C1)", () => {
  it("lets a member read the roster and upload blobs", async () => {
    const harness = createHarness();
    const members = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization: harness.sign("GET", "/cluster/members") },
    });
    expect(members.statusCode).toBe(200);

    const uploaded = await upload(harness, harness.identity, Buffer.from("member bytes"));
    expect(uploaded.statusCode).toBe(201);
  });

  it("rejects every signed route from a valid but unknown key", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    const payload = Buffer.from("unknown bytes");

    const calls = [
      {
        method: "GET",
        url: "/cluster/members",
        authorization: strangerSign(harness, stranger, "GET", "/cluster/members"),
      },
      {
        method: "POST",
        url: "/a2a",
        payload: { jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [] } } },
        contentType: "application/json",
        authorization: strangerSign(
          harness,
          stranger,
          "POST",
          "/a2a",
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "message/send",
            params: { message: { role: "user", parts: [] } },
          }),
        ),
      },
      {
        method: "POST",
        url: "/blobs",
        payload,
        contentType: "application/octet-stream",
        headers: { "x-pod-body-sha256": sha256Hex(payload) },
        authorization: strangerSign(harness, stranger, "POST", "/blobs", payload, sha256Hex(payload)),
      },
      {
        method: "GET",
        url: `/blobs/${sha256Hex(payload)}`,
        authorization: strangerSign(harness, stranger, "GET", `/blobs/${sha256Hex(payload)}`),
      },
      {
        method: "POST",
        url: `/blobs/${sha256Hex(payload)}/link`,
        authorization: strangerSign(harness, stranger, "POST", `/blobs/${sha256Hex(payload)}/link`),
      },
    ];

    for (const call of calls) {
      const response = await harness.app.inject({
        method: call.method as "GET" | "POST",
        url: call.url,
        ...(call.payload === undefined ? {} : { payload: call.payload }),
        headers: {
          authorization: call.authorization,
          ...(call.contentType === undefined ? {} : { "content-type": call.contentType }),
          ...(call.headers ?? {}),
        },
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
      // /a2a answers with a JSON-RPC envelope; its error carries the same code.
      const body = response.json<{ code?: string; error?: { message: string } }>();
      expect(body.code ?? body.error?.message).toBe("not_a_member");
    }
  });

  it("admits the same key once the node is in the roster, and rejects it after removal", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    const strangerEndpoint = "http://stranger.test";
    const authorization = strangerSign(harness, stranger, "GET", "/cluster/members");

    harness.peers.upsert(peerView(stranger, strangerEndpoint));
    const admitted = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization },
    });
    expect(admitted.statusCode).toBe(200);

    harness.peers.remove(stranger.orcaNodeId);
    const rejected = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization: strangerSign(harness, stranger, "GET", "/cluster/members") },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "not_a_member" });
  });

  it("keeps /cluster/join open for the first admission and blob links public", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    const ts = Date.now();
    const nonce = randomBytes(16).toString("base64url");
    const proof = admissionProof("join", harness.key, {
      workgroupId: WORKGROUP,
      orcaNodeId: stranger.orcaNodeId,
      ts,
      nonce,
    });
    const body = {
      workgroup_id: WORKGROUP,
      orca_node_id: stranger.orcaNodeId,
      display_name: "stranger",
      endpoints: ["http://stranger.test"],
      runtime: null,
      max_task_ttl_s: 600,
      default_model: null,
      default_reasoning_effort: null,
      ts,
      nonce,
      proof,
    };
    const joined = await harness.app.inject({
      method: "POST",
      url: "/cluster/join",
      payload: body,
      headers: {
        "content-type": "application/json",
        authorization: strangerSign(harness, stranger, "POST", "/cluster/join", JSON.stringify(body)),
      },
    });
    expect(joined.statusCode).toBe(200);

    const payload = Buffer.from("public by link");
    const uploaded = await upload(harness, harness.identity, payload);
    expect(uploaded.statusCode).toBe(201);
    const blobId = uploaded.json<{ blob_id: string }>().blob_id;
    const exp = String(Math.floor(Date.now() / 1000) + 60);
    const sig = blobLinkSignature(harness.identity, blobId, exp);
    const direct = await harness.app.inject({ method: "GET", url: `/blobs/${blobId}?exp=${exp}&sig=${sig}` });
    expect(direct.statusCode).toBe(200);
    expect(direct.rawPayload.equals(payload)).toBe(true);
  });

  it("screens the endpoints a joining node declares", async () => {
    const harness = createHarness();
    const join = async (endpoints: string[], remoteAddress: string) => {
      const stranger = generateNodeIdentity();
      const ts = Date.now();
      const nonce = randomBytes(16).toString("base64url");
      const proof = admissionProof("join", harness.key, {
        workgroupId: WORKGROUP,
        orcaNodeId: stranger.orcaNodeId,
        ts,
        nonce,
      });
      const body = {
        workgroup_id: WORKGROUP,
        orca_node_id: stranger.orcaNodeId,
        display_name: "stranger",
        endpoints,
        runtime: null,
        max_task_ttl_s: 600,
        default_model: null,
        default_reasoning_effort: null,
        ts,
        nonce,
        proof,
      };
      const response = await harness.app.inject({
        method: "POST",
        url: "/cluster/join",
        payload: body,
        remoteAddress,
        headers: {
          "content-type": "application/json",
          authorization: strangerSign(harness, stranger, "POST", "/cluster/join", JSON.stringify(body)),
        },
      });
      return { response, record: harness.peers.get(stranger.orcaNodeId) };
    };

    // Cloud metadata and other link-local targets are never accepted.
    const metadata = await join(["http://169.254.169.254:80"], "10.0.0.5");
    expect(metadata.response.statusCode).toBe(400);
    expect(metadata.response.json()).toMatchObject({ code: "endpoint_refused" });
    expect(metadata.record).toBeUndefined();

    // A remote machine cannot be reached at our loopback address.
    const remoteLoopback = await join(["http://127.0.0.1:22"], "10.0.0.5");
    expect(remoteLoopback.response.statusCode).toBe(400);

    // A same-host node joining over loopback may advertise loopback.
    const local = await join(["http://127.0.0.1:11811"], "127.0.0.1");
    expect(local.response.statusCode).toBe(200);
    expect(local.record?.endpoints).toEqual(["http://127.0.0.1:11811"]);

    // Mixed lists keep only what may be dialed; public addresses are fine for a joiner.
    const mixed = await join(
      ["http://169.254.169.254:80", "http://10.0.0.5:11811", "http://8.8.8.8:11811"],
      "10.0.0.5",
    );
    expect(mixed.response.statusCode).toBe(200);
    expect(mixed.record?.endpoints).toEqual(["http://10.0.0.5:11811", "http://8.8.8.8:11811"]);
  });

  it("answers an unknown path with 404 before any signature check", async () => {
    const response = await createHarness().app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a bad join signature with 401 and a malformed join body with 400", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    const unsigned = await harness.app.inject({
      method: "POST",
      url: "/cluster/join",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.statusCode).toBe(401);
    const body = JSON.stringify({ workgroup_id: WORKGROUP });
    const malformed = await harness.app.inject({
      method: "POST",
      url: "/cluster/join",
      payload: body,
      headers: {
        "content-type": "application/json",
        authorization: strangerSign(harness, stranger, "POST", "/cluster/join", body),
      },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "bad_request" });
  });

  it("rejects a heartbeat whose busy field is not a busy holder", async () => {
    const harness = createHarness();
    const body = JSON.stringify({
      workgroup_id: WORKGROUP,
      orca_node_id: harness.orcaNodeId,
      ts: Date.now(),
      nonce: "n",
      proof: "p",
      busy: "yes",
    });
    const response = await harness.app.inject({
      method: "POST",
      url: "/cluster/heartbeat",
      payload: body,
      headers: { "content-type": "application/json", authorization: harness.sign("POST", "/cluster/heartbeat", body) },
    });
    expect(response.statusCode).toBe(400);
  });

  it("limits local controls to this node over loopback without proxy headers", async () => {
    const harness = createHarness();
    const stranger = generateNodeIdentity();
    harness.peers.upsert(peerView(stranger, "http://stranger.test"));
    const url = "/cluster/task?task=missing";
    const call = (options: { remoteAddress?: string; headers?: Record<string, string>; as?: NodeIdentity }) =>
      harness.app.inject({
        method: "GET",
        url,
        remoteAddress: options.remoteAddress ?? "127.0.0.1",
        headers: {
          authorization: strangerSign(harness, options.as ?? harness.identity, "GET", url),
          ...options.headers,
        },
      });

    expect((await call({})).statusCode).toBe(404);
    for (const rejected of [
      await call({ remoteAddress: "10.0.0.5" }),
      await call({ headers: { "x-forwarded-for": "10.0.0.5" } }),
      await call({ as: stranger }),
    ]) {
      expect(rejected.statusCode).toBe(403);
      expect(rejected.json()).toMatchObject({ code: "local_only" });
    }
  });

  it("returns 404 for an unknown task instead of leaking it to members", async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/a2a",
      payload: { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "missing-task" } },
      headers: {
        "content-type": "application/json",
        authorization: harness.sign(
          "POST",
          "/a2a",
          JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "missing-task" } }),
        ),
      },
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).toContain("task_not_found");
  });
});
