import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { NonceCache, blobLinkSignature, buildAuthHeader, buildJoinProof } from "../src/crypto.ts";
import { TaskError, type BusyState, type PeerView, type TaskRunner } from "../src/protocol.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/identity.ts";
import { createMemoryBlobStore, createMemoryPeerStore, sha256Hex } from "../src/storage.ts";
import { createGateway, type GatewayDeps, type GatewayOrcaNode } from "../src/gateway.ts";

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

type Harness = {
  app: ReturnType<typeof createGateway>;
  key: Buffer;
  identity: NodeIdentity;
  orcaNodeId: string;
  peers: ReturnType<typeof createMemoryPeerStore>;
  sign(method: string, path: string, body?: Uint8Array | string, bodySha256?: string): string;
};

function createHarness(): Harness {
  const key = randomBytes(32);
  const identity = generateNodeIdentity();
  const orcaNodeId = identity.orcaNodeId;
  const orcaNode: GatewayOrcaNode = {
    orca_node_id: orcaNodeId,
    display_name: "authorization-test-orca-node",
    workgroup_id: WORKGROUP,
    endpoints: [ENDPOINT],
  };
  const peers = createMemoryPeerStore();
  const deps: GatewayDeps = {
    orcaNode,
    identity,
    workgroupKey: key,
    peers,
    nonceCache: new NonceCache(),
    runtime: null,
    tasks: idleTasks,
    blobs: createMemoryBlobStore(),
  };
  return {
    app: createGateway(deps),
    key,
    identity,
    orcaNodeId,
    peers,
    sign: (method, path, body, bodySha256) =>
      buildAuthHeader({ identity, method, path, body, ...(bodySha256 === undefined ? {} : { bodySha256 }) }),
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
    path,
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
        authorization: strangerSign(harness, stranger, "POST", "/a2a", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "message/send", params: { message: { role: "user", parts: [] } } })),
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
      expect(response.json()).toMatchObject({ code: "not_a_member" });
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
    const proof = buildJoinProof(harness.key, {
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

  it("returns 404 for an unknown task instead of leaking it to members", async () => {
    const harness = createHarness();
    const response = await harness.app.inject({
      method: "POST",
      url: "/a2a",
      payload: { jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "missing-task" } },
      headers: {
        "content-type": "application/json",
        authorization: harness.sign("POST", "/a2a", JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "missing-task" } })),
      },
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).toContain("task_not_found");
  });
});
