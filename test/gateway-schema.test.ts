import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { PodError } from "../src/kernel/errors.ts";
import { createMembership } from "../src/membership/membership.ts";
import { runtimeDigest, type SelfRecord } from "../src/protocol/peer.ts";
import type { SubmitTaskInput, TaskRunner } from "../src/protocol/task.ts";
import { NonceCache, admissionProof, buildAuthHeader } from "../src/security/crypto.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/security/identity.ts";
import { createFileBlobRegistry } from "../src/storage/file-registry.ts";
import { createMemoryFileBlobStore } from "../src/storage/memory.ts";
import { createGateway } from "../src/transport/gateway/gateway.ts";
import { wg } from "./fixtures/ids.ts";

const WORKGROUP = wg("orca-schema");

const submitted: SubmitTaskInput[] = [];

const tasks: TaskRunner = {
  submit(input) {
    submitted.push(input);
    throw new PodError("internal", "submit reached");
  },
  get: () => null,
  originOf: () => null,
  resume() {
    throw new PodError("internal", "resume reached");
  },
  cancel() {
    throw new PodError("internal", "cancel reached");
  },
  escalate() {
    throw new PodError("internal", "escalate reached");
  },
  busy: () => null,
  recover: () => 0,
  list: () => [],
};

function harness() {
  const key = randomBytes(32);
  const self = generateNodeIdentity();
  const membership = createMembership({ selfOrcaNodeId: self.orcaNodeId });
  const record: SelfRecord = {
    orca_node_id: self.orcaNodeId,
    display_name: "schema-test",
    endpoints: ["http://orca-node.test"],
    runtime: null,
    runtime_digest: runtimeDigest(null),
    state: "online",
    busy: null,
    last_recv_at: null,
    workgroup_id: WORKGROUP,
  };
  const app = createGateway({
    orcaNode: {
      orca_node_id: self.orcaNodeId,
      workgroup_id: WORKGROUP,
      self: () => record,
      linkChildTask: () => {},
      fetchBlob: async () => {
        throw new Error("not used");
      },
    },
    identity: self,
    workgroupKey: key,
    peers: membership.peers,
    nonceCache: new NonceCache(),
    startedAt: Date.now(),
    tasks,
    fileBlobs: createFileBlobRegistry(createMemoryFileBlobStore()),
  });
  const post = (signer: NodeIdentity, url: string, body: unknown) => {
    const payload = JSON.stringify(body);
    return app.inject({
      method: "POST",
      url,
      payload,
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader({
          identity: signer,
          method: "POST",
          url,
          targetOrcaNodeId: self.orcaNodeId,
          body: payload,
        }),
      },
    });
  };
  const joinBody = (joiner: NodeIdentity, extra: Record<string, unknown>) => {
    const ts = Date.now();
    const nonce = randomUUID();
    const fields = { workgroupId: WORKGROUP, orcaNodeId: joiner.orcaNodeId, ts, nonce };
    return {
      workgroup_id: WORKGROUP,
      orca_node_id: joiner.orcaNodeId,
      ts,
      nonce,
      proof: admissionProof("join", key, fields),
      display_name: "joiner",
      endpoints: ["http://127.0.0.1:1"],
      ...extra,
    };
  };
  const heartbeatBody = (sender: NodeIdentity, extra: Record<string, unknown>) => {
    const ts = Date.now();
    const nonce = randomUUID();
    const fields = { workgroupId: WORKGROUP, orcaNodeId: sender.orcaNodeId, ts, nonce };
    return {
      workgroup_id: WORKGROUP,
      orca_node_id: sender.orcaNodeId,
      ts,
      nonce,
      proof: admissionProof("heartbeat", key, fields),
      ...extra,
    };
  };
  return { app, self, peers: membership.peers, post, joinBody, heartbeatBody };
}

describe("gateway body schemas", () => {
  it("requires the params of the method being called", async () => {
    const { self, post } = harness();
    const missing = await post(self, "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ id: 1, error: { message: "bad_request" } });

    const relay = await post(self, "/a2a", { method: "tasks/escalate", params: { taskId: "t" } });
    expect(relay.statusCode).toBe(400);

    // Valid shape: the request reaches the method and fails there instead.
    const unknown = await post(self, "/a2a", { method: "tasks/get", params: { id: "nope" } });
    expect(unknown.json()).toMatchObject({ error: { message: "task_not_found" } });
    const unsupported = await post(self, "/a2a", { method: "tasks/other" });
    expect(unsupported.json()).toMatchObject({ error: { message: "unsupported" } });
  });

  it("passes the message and metadata through with the fields the gateway does not check", async () => {
    const { self, post } = harness();
    submitted.length = 0;
    const message = { role: "user", messageId: "m-1", contextId: "c-1", parts: [{ kind: "text", text: "hi" }] };
    const metadata = { pod: { task_ttl_s: 30 }, echo: { final: { text: "x" } } };
    await post(self, "/a2a", { method: "message/send", params: { message, metadata } });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.message).toEqual(message);
    expect(submitted[0]?.metadata).toEqual(metadata);
  });

  it("names the part and path that failed", async () => {
    const { self, post, joinBody } = harness();
    const noBody = await post(self, "/a2a", "not an object");
    expect(noBody.json()).toMatchObject({ error: { data: { message: expect.stringMatching(/^body Invalid input/) } } });
    const joiner = generateNodeIdentity();
    const bad = await post(joiner, "/cluster/join", joinBody(joiner, { models: [{ provider: "", model: "m" }] }));
    expect(bad.json()).toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/^body\.models\.0\.provider /),
    });
  });

  it("drops unknown keys from a joining node's model catalog", async () => {
    const { post, joinBody, peers } = harness();
    const joiner = generateNodeIdentity();
    const response = await post(
      joiner,
      "/cluster/join",
      joinBody(joiner, {
        models: [{ provider: "p", model: "m", tier: "gold" }],
        default_model: { provider: "p", model: "m", reasoning_effort: "high", note: "x" },
        default_reasoning_effort: null,
        runtime: null,
      }),
    );
    expect(response.statusCode).toBe(200);
    const stored = peers.get(joiner.orcaNodeId);
    expect(stored?.models).toEqual([{ provider: "p", model: "m" }]);
    expect(stored?.default_model).toEqual({ provider: "p", model: "m", reasoning_effort: "high" });
  });

  it("rejects malformed join fields before admission", async () => {
    const { post, joinBody } = harness();
    const joiner = generateNodeIdentity();
    const cases: Record<string, unknown>[] = [
      { models: [{ provider: "", model: "m" }] },
      { models: Array.from({ length: 129 }, (_, index) => ({ provider: "p", model: `m${index}` })) },
      { default_model: { provider: "p" } },
      { default_reasoning_effort: "   " },
      { max_task_ttl_s: 0 },
      { ts: 1.5 },
      { runtime: { arch: "x64" } },
    ];
    for (const extra of cases) {
      const response = await post(joiner, "/cluster/join", joinBody(joiner, extra));
      expect(response.statusCode, JSON.stringify(extra).slice(0, 80)).toBe(400);
      expect(response.json()).toMatchObject({ code: "bad_request" });
    }
  });

  it("takes a member's profile from its heartbeat but screens the endpoints like a join", async () => {
    const { post, joinBody, heartbeatBody, peers } = harness();
    const member = generateNodeIdentity();
    expect((await post(member, "/cluster/join", joinBody(member, {}))).statusCode).toBe(200);

    const self = {
      display_name: "renamed",
      endpoints: ["http://127.0.0.1:2/"],
      models: [{ provider: "p", model: "m" }],
    };
    const ok = await post(member, "/cluster/heartbeat", heartbeatBody(member, { self }));
    expect(ok.statusCode).toBe(200);
    expect(peers.get(member.orcaNodeId)).toMatchObject({
      display_name: "renamed",
      endpoints: ["http://127.0.0.1:2"],
      models: [{ provider: "p", model: "m" }],
    });

    // Link-local (cloud metadata) is refused here exactly as at join (§7.7).
    const metadata = { ...self, endpoints: ["http://169.254.169.254"] };
    const refused = await post(member, "/cluster/heartbeat", heartbeatBody(member, { self: metadata }));
    expect(refused.json()).toMatchObject({ code: "endpoint_refused" });
    expect(peers.get(member.orcaNodeId)?.endpoints).toEqual(["http://127.0.0.1:2"]);

    // A heartbeat without `self` (an older node) leaves the profile alone.
    const bare = await post(member, "/cluster/heartbeat", heartbeatBody(member, {}));
    expect(bare.statusCode).toBe(200);
    expect(peers.get(member.orcaNodeId)?.display_name).toBe("renamed");
  });
});
