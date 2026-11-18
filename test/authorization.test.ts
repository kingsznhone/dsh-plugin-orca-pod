import { randomBytes } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAuthHeader } from "../src/core/signing.ts";
import { admissionProof } from "../src/mesh/admission.ts";
import type { BusyState, PeerView } from "../src/core/wire/peer.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/core/identity.ts";
import { wg } from "./fixtures/ids.ts";
import { createGatewayHarness, type GatewayHarness } from "./fixtures/gateway.ts";

const WORKGROUP = wg("orca-dev");

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

/** Publish `content` on the harness node, as `orca-node publish` would; returns the blob id. */
async function publish(harness: GatewayHarness, content: Buffer): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "orca-auth-blob-")), "file.bin");
  await writeFile(path, content);
  return (await harness.blobs.register(path, 60)).blob_id;
}

function strangerSign(
  harness: GatewayHarness,
  stranger: NodeIdentity,
  method: string,
  path: string,
  body?: Uint8Array | string,
): string {
  return buildAuthHeader({ identity: stranger, method, url: path, targetOrcaNodeId: harness.orcaNodeId, body });
}

describe("workgroup membership gate (C1)", () => {
  it("lets a member read the roster and a published file", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const members = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization: harness.sign("GET", "/cluster/members") },
    });
    expect(members.statusCode).toBe(200);

    const blobId = await publish(harness, Buffer.from("member bytes"));
    const read = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(read.statusCode).toBe(200);
  });

  it("rejects every signed route from a valid but unknown key", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const stranger = generateNodeIdentity();
    const blobId = await publish(harness, Buffer.from("not for strangers"));

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
        method: "GET",
        url: `/blobs/${blobId}`,
        authorization: strangerSign(harness, stranger, "GET", `/blobs/${blobId}`),
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
        },
      });
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(403);
      // /a2a answers with a JSON-RPC envelope; its error carries the same code.
      const body = response.json<{ code?: string; error?: { message: string } }>();
      expect(body.code ?? body.error?.message).toBe("not_a_member");
    }
  });

  it("admits the same key once the node is in the roster, and rejects it after removal", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const stranger = generateNodeIdentity();
    const strangerEndpoint = "http://stranger.test";
    const authorization = strangerSign(harness, stranger, "GET", "/cluster/members");

    harness.membership.upsert(peerView(stranger, strangerEndpoint));
    const admitted = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization },
    });
    expect(admitted.statusCode).toBe(200);

    harness.membership.remove(stranger.orcaNodeId);
    const rejected = await harness.app.inject({
      method: "GET",
      url: "/cluster/members",
      headers: { authorization: strangerSign(harness, stranger, "GET", "/cluster/members") },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "not_a_member" });
  });

  it("keeps /cluster/join open for the first admission", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
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
  });

  it("screens the endpoints a joining node declares", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
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
      return { response, record: harness.membership.get(stranger.orcaNodeId) };
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
    const response = await createGatewayHarness({ workgroup: WORKGROUP }).app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects a bad join signature with 401 and a malformed join body with 400", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
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
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
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
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const stranger = generateNodeIdentity();
    harness.membership.upsert(peerView(stranger, "http://stranger.test"));
    // A malformed fetch: past the access check it fails validation, so it never dials anyone.
    const url = "/cluster/blob?node=x&blob=y";
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

    expect((await call({})).statusCode).toBe(400);
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
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
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
