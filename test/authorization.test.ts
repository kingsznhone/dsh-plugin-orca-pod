import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeIdentity } from "../src/core/identity.ts";
import { verifyReplyHeader, bodySha256 } from "../src/core/signing.ts";
import { isDirectLoopbackRequest, parseAuthHeader } from "../src/api/access.ts";
import { wg } from "./fixtures/ids.ts";
import { createGatewayHarness, type GatewayHarness } from "./fixtures/gateway.ts";
import { generateNodeIdentity } from "../src/plugin/stores.ts";
import { deriveWorkgroupKey } from "../src/plugin/pod.ts";

const WORKGROUP = wg("orca-dev");

/** Publish `content` on the harness node; returns the blob id. */
async function publish(harness: GatewayHarness, content: Buffer): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "orca-auth-blob-")), "file.bin");
  await writeFile(path, content);
  return (await harness.blobs.register(path, 60)).blob_id;
}

/** A member-only route whose answer is JSON: a file nobody published. */
const MISSING_BLOB = `/blobs/${"0".repeat(64)}`;

/** A member-only route to probe the gate with: a file the harness published. */
async function probe(harness: GatewayHarness): Promise<string> {
  return `/blobs/${await publish(harness, Buffer.from("probe"))}`;
}

/** What a node says in a `hello`. */
function helloBody(endpoints: string[], extra: Record<string, unknown> = {}) {
  return {
    self: {
      display_name: "stranger",
      endpoints,
      runtime: null,
      max_task_ttl_s: 600,
      default_model: null,
      default_reasoning_effort: null,
    },
    busy: null,
    digest: "",
    ...extra,
  };
}

/** Send a `hello` as `caller`: no receiver id to sign to yet, the way a first contact is. */
function hello(
  harness: GatewayHarness,
  caller: NodeIdentity,
  body: unknown,
  options: { remoteAddress?: string; key?: Buffer } = {},
) {
  const payload = JSON.stringify(body);
  return harness.app.inject({
    method: "POST",
    url: "/cluster/hello",
    payload,
    remoteAddress: options.remoteAddress,
    headers: {
      "content-type": "application/json",
      authorization: harness.signAs(caller, "POST", "/cluster/hello", { body: payload, target: "", key: options.key }),
    },
  });
}

describe("workgroup proof gate (C1)", () => {
  it("lets a node with both proofs read a published file", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const blobId = await publish(harness, Buffer.from("member bytes"));
    const read = await harness.app.inject({
      method: "GET",
      url: `/blobs/${blobId}`,
      headers: { authorization: harness.sign("GET", `/blobs/${blobId}`) },
    });
    expect(read.statusCode).toBe(200);
  });

  it("rejects every signed route from a node that has a key pair but not the password", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const stranger = generateNodeIdentity();
    const wrongKey = deriveWorkgroupKey(WORKGROUP, "not the workgroup password");
    const blobId = await publish(harness, Buffer.from("not for strangers"));
    const a2aBody = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "message/send",
      params: { message: { role: "user", parts: [] } },
    });

    const calls = [
      {
        method: "POST",
        url: "/a2a",
        payload: a2aBody,
        contentType: "application/json",
        authorization: harness.signAs(stranger, "POST", "/a2a", { body: a2aBody, key: wrongKey }),
      },
      {
        method: "GET",
        url: `/blobs/${blobId}`,
        authorization: harness.signAs(stranger, "GET", `/blobs/${blobId}`, { key: wrongKey }),
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
      expect(response.statusCode, `${call.method} ${call.url}`).toBe(401);
      // /a2a answers with a JSON-RPC envelope; its error carries the same code.
      const body = response.json<{ code?: string; error?: { message: string } }>();
      expect(body.code ?? body.error?.message).toBe("bad_proof");
    }
  });

  it("refuses a node whose password changed on its very next request, without waiting for a heartbeat", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = await probe(harness);
    const node = generateNodeIdentity();
    const before = await hello(harness, node, helloBody(["https://node.test"]));
    expect(before.statusCode).toBe(200);
    expect(harness.mesh.get(node.orcaNodeId)?.state).toBe("online");

    const changed = deriveWorkgroupKey(WORKGROUP, "a new password");
    const after = await harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: harness.signAs(node, "GET", path, { key: changed }) },
    });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: "bad_proof" });
  });

  it("does not gate on the member table: both proofs are what admit, in the table or not", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = await probe(harness);
    const node = generateNodeIdentity();
    const members = (): Promise<{ statusCode: number }> =>
      harness.app.inject({
        method: "GET",
        url: path,
        headers: { authorization: harness.signAs(node, "GET", path) },
      });

    // Never greeted: not in the table, and served all the same.
    expect(harness.mesh.get(node.orcaNodeId)).toBeUndefined();
    expect((await members()).statusCode).toBe(200);

    await hello(harness, node, helloBody(["https://node.test"]));
    harness.mesh.remove(node.orcaNodeId);
    expect(harness.mesh.get(node.orcaNodeId)).toBeUndefined();
    expect((await members()).statusCode).toBe(200);
  });

  it("refuses a request for another workgroup", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = await probe(harness);
    const response = await harness.app.inject({
      method: "GET",
      url: path,
      headers: {
        authorization: harness.signAs(generateNodeIdentity(), "GET", path, {
          workgroup: wg("orca-other"),
        }),
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "workgroup_mismatch" });
  });

  it("keeps /cluster/hello open for a first contact, which cannot name the receiver", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = await probe(harness);
    const stranger = generateNodeIdentity();
    const joined = await hello(harness, stranger, helloBody(["https://stranger.test"]));
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ self: { orca_node_id: harness.orcaNodeId, workgroup_id: WORKGROUP } });
    expect(harness.mesh.get(stranger.orcaNodeId)?.state).toBe("online");
    // Every other route insists on being addressed to this node.
    const members = await harness.app.inject({
      method: "GET",
      url: path,
      headers: { authorization: harness.signAs(stranger, "GET", path, { target: "" }) },
    });
    expect(members.statusCode).toBe(401);
    expect(members.json()).toMatchObject({ code: "wrong_target" });
  });

  it("answers with the directory only when the sender's digest differs", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const stranger = generateNodeIdentity();
    const first = await hello(harness, stranger, helloBody(["https://stranger.test"]));
    const { members_digest: digest, members } = first.json<{ members_digest: string; members: unknown[] | null }>();
    expect(members).not.toBeNull();

    const again = await hello(harness, stranger, helloBody(["https://stranger.test"], { digest }));
    expect(again.json()).toMatchObject({ members_digest: digest, members: null });
  });

  it("screens the endpoints a greeting node declares", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const greet = async (endpoints: string[], remoteAddress: string) => {
      const stranger = generateNodeIdentity();
      const response = await hello(harness, stranger, helloBody(endpoints), { remoteAddress });
      return { response, record: harness.mesh.get(stranger.orcaNodeId)?.view() };
    };

    // Cloud metadata and other link-local targets are never accepted.
    const metadata = await greet(["https://169.254.169.254:80"], "10.0.0.5");
    expect(metadata.response.statusCode).toBe(400);
    expect(metadata.response.json()).toMatchObject({ code: "endpoint_refused" });
    expect(metadata.record).toBeUndefined();

    // A remote machine cannot be reached at our loopback address.
    const remoteLoopback = await greet(["https://127.0.0.1:22"], "10.0.0.5");
    expect(remoteLoopback.response.statusCode).toBe(400);

    // A same-host node greeting over loopback may advertise loopback.
    const local = await greet(["https://127.0.0.1:11811"], "127.0.0.1");
    expect(local.response.statusCode).toBe(200);
    expect(local.record?.endpoints).toEqual(["https://127.0.0.1:11811"]);

    // Mixed lists keep only what may be dialed; public addresses are fine for a node that proved the password.
    const mixed = await greet(
      ["https://169.254.169.254:80", "https://10.0.0.5:11811", "https://8.8.8.8:11811"],
      "10.0.0.5",
    );
    expect(mixed.response.statusCode).toBe(200);
    expect(mixed.record?.endpoints).toEqual(["https://10.0.0.5:11811", "https://8.8.8.8:11811"]);
  });

  it("answers an unknown path with 404 before any signature check", async () => {
    const response = await createGatewayHarness({ workgroup: WORKGROUP }).app.inject({ method: "GET", url: "/nope" });
    expect(response.statusCode).toBe(404);
  });

  it("rejects an unsigned hello with 401 and a malformed hello body with 400", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const unsigned = await harness.app.inject({
      method: "POST",
      url: "/cluster/hello",
      payload: {},
      headers: { "content-type": "application/json" },
    });
    expect(unsigned.statusCode).toBe(401);
    const malformed = await hello(harness, generateNodeIdentity(), { workgroup_id: WORKGROUP });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "bad_request" });
  });

  it("rejects a hello whose busy field is not a busy holder", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const response = await hello(harness, generateNodeIdentity(), helloBody(["https://node.test"], { busy: "yes" }));
    expect(response.statusCode).toBe(400);
  });

  it("returns 404 for an unknown task instead of leaking it to members", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tasks/get", params: { id: "missing-task" } });
    const response = await harness.app.inject({
      method: "POST",
      url: "/a2a",
      payload: body,
      headers: { "content-type": "application/json", authorization: harness.sign("POST", "/a2a", body) },
    });
    expect(response.statusCode).toBe(404);
    expect(JSON.stringify(response.json())).toContain("task_not_found");
  });
});

describe("signed replies (§7.1)", () => {
  /** The nonce a request carried, which its reply is bound to. */
  const nonceOf = (authorization: string): string => parseAuthHeader(authorization)?.claim.nonce ?? "";

  it("signs the answer to a request: its nonce, its status and its body", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    // A JSON answer (a file that is not there), whose body the signature covers.
    const path = MISSING_BLOB;
    const authorization = harness.sign("GET", path);
    const response = await harness.app.inject({ method: "GET", url: path, headers: { authorization } });

    const signer = verifyReplyHeader(response.headers["pod-reply"] as string, {
      nonce: nonceOf(authorization),
      status: response.statusCode,
      subject: bodySha256(response.rawPayload),
    });
    expect(signer).toBe(harness.orcaNodeId);
  });

  it("cannot be moved to answer another request, nor reused for another body", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = MISSING_BLOB;
    const authorization = harness.sign("GET", path);
    const response = await harness.app.inject({ method: "GET", url: path, headers: { authorization } });
    const reply = response.headers["pod-reply"] as string;

    expect(
      verifyReplyHeader(reply, {
        nonce: "another-nonce",
        status: response.statusCode,
        subject: bodySha256(response.rawPayload),
      }),
    ).toBeNull();
    expect(
      verifyReplyHeader(reply, {
        nonce: nonceOf(authorization),
        status: response.statusCode,
        subject: bodySha256("{}"),
      }),
    ).toBeNull();
  });

  it("does not sign unauthenticated requests, even when they carry an Authorization header with a nonce", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const path = await probe(harness);
    const stranger = generateNodeIdentity();

    const cases = [
      // Wrong workgroup password (bad_proof)
      {
        url: path,
        authorization: harness.signAs(stranger, "GET", path, {
          key: deriveWorkgroupKey(WORKGROUP, "wrong"),
        }),
        status: 401,
      },
      // Forged signature (bad_signature)
      {
        url: path,
        authorization: harness.sign("GET", path).replace(/sig=[^;]+/, "sig=AAAA"),
        status: 401,
      },
      // Outside clock skew window (clock_skew)
      {
        url: path,
        authorization: harness.signAs(stranger, "GET", path).replace(/ts=\d+/, "ts=1000"),
        status: 401,
      },
      // Wrong workgroup (workgroup_mismatch)
      {
        url: path,
        authorization: harness.signAs(stranger, "GET", path, { workgroup: wg("orca-other") }),
        status: 400,
      },
      // Public route with spoofed Authorization header
      {
        url: "/health",
        authorization: harness.signAs(stranger, "GET", "/health", {
          key: deriveWorkgroupKey(WORKGROUP, "wrong"),
        }),
        status: 200,
      },
      // Unknown 404 route with spoofed Authorization header
      {
        url: "/no-such-route",
        authorization: harness.signAs(stranger, "GET", "/no-such-route", {
          key: deriveWorkgroupKey(WORKGROUP, "wrong"),
        }),
        status: 404,
      },
    ];

    for (const entry of cases) {
      const response = await harness.app.inject({
        method: "GET",
        url: entry.url,
        headers: { authorization: entry.authorization },
      });
      expect(response.statusCode).toBe(entry.status);
      expect(response.headers["pod-reply"]).toBeUndefined();
    }
  });

  it("signs a streamed file by its status and name, not by bytes it has not read yet", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const blobId = await publish(harness, Buffer.from("some bytes"));
    const authorization = harness.sign("GET", `/blobs/${blobId}`);
    const response = await harness.app.inject({ method: "GET", url: `/blobs/${blobId}`, headers: { authorization } });
    expect(
      verifyReplyHeader(response.headers["pod-reply"] as string, {
        nonce: nonceOf(authorization),
        status: 200,
        subject: `blob:${blobId}`,
      }),
    ).toBe(harness.orcaNodeId);
  });

  it("does not sign a public route, which has no request to answer", async () => {
    const harness = createGatewayHarness({ workgroup: WORKGROUP });
    const response = await harness.app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["pod-reply"]).toBeUndefined();
  });
});

describe("direct loopback detection (hello's local-peer hint)", () => {
  it("is immune to header spoofing", () => {
    const base = { socket: { remoteAddress: "::1" }, headers: {} };
    expect(isDirectLoopbackRequest(base as never)).toBe(true);
    expect(isDirectLoopbackRequest({ ...base, headers: { "x-real-ip": "10.0.0.1" } } as never)).toBe(false);
    expect(isDirectLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" }, headers: {} } as never)).toBe(false);
  });
});
