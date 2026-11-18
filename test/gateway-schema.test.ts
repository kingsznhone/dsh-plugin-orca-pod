import { describe, expect, it, vi } from "vitest";

import { PodError } from "../src/core/errors.ts";
import type { SubmitTaskInput } from "../src/task/wire.ts";
import { generateNodeIdentity, type NodeIdentity } from "../src/core/identity.ts";
import { wg } from "./fixtures/ids.ts";
import { createGatewayHarness } from "./fixtures/gateway.ts";
import { createTestRunner } from "./fixtures/runner.ts";

const WORKGROUP = wg("orca-schema");

const submitted: SubmitTaskInput[] = [];

function harness() {
  const tasks = createTestRunner();
  vi.spyOn(tasks, "submit").mockImplementation((input) => {
    submitted.push(input);
    throw new PodError("internal", "submit reached");
  });
  vi.spyOn(tasks, "resume").mockImplementation(() => {
    throw new PodError("internal", "resume reached");
  });
  vi.spyOn(tasks, "cancel").mockImplementation(() => {
    throw new PodError("internal", "cancel reached");
  });
  const {
    app,
    identity: self,
    mesh,
    signAs,
  } = createGatewayHarness({
    tasks,
    workgroup: WORKGROUP,
    displayName: "schema-test",
  });
  const post = (signer: NodeIdentity, url: string, body: unknown) => {
    const payload = JSON.stringify(body);
    return app.inject({
      method: "POST",
      url,
      payload,
      headers: {
        "content-type": "application/json",
        authorization: signAs(signer, "POST", url, { body: payload }),
      },
    });
  };
  /** A `hello`: what the node says about itself, with `self` fields overridden and top-level fields added. */
  const helloBody = (self: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    self: { display_name: "joiner", endpoints: ["http://127.0.0.1:1"], ...self },
    busy: null,
    digest: "",
    ...extra,
  });
  return { app, self, mesh, post, helloBody };
}

describe("gateway body schemas", () => {
  it("requires the params of the method being called", async () => {
    const { self, post } = harness();
    const missing = await post(self, "/a2a", { jsonrpc: "2.0", id: 1, method: "message/send", params: {} });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ id: 1, error: { message: "bad_request" } });

    const noId = await post(self, "/a2a", { method: "tasks/cancel", params: { taskId: "t" } });
    expect(noId.statusCode).toBe(400);

    // Removed with cascading tasks: a node no longer parks a task for a child (§7.9).
    const escalate = await post(self, "/a2a", { method: "tasks/escalate", params: { taskId: "t" } });
    expect(escalate.json()).toMatchObject({ error: { message: "unsupported" } });

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
    const { self, post, helloBody } = harness();
    const noBody = await post(self, "/a2a", "not an object");
    expect(noBody.json()).toMatchObject({ error: { data: { message: expect.stringMatching(/^body Invalid input/) } } });
    const joiner = generateNodeIdentity();
    const bad = await post(joiner, "/cluster/hello", helloBody({ models: [{ provider: "", id: "m", name: "M" }] }));
    expect(bad.json()).toMatchObject({
      code: "bad_request",
      message: expect.stringMatching(/^body\.self\.models\.0\.provider /),
    });
  });

  it("drops unknown keys from a greeting node's model catalog", async () => {
    const { post, helloBody, mesh } = harness();
    const joiner = generateNodeIdentity();
    const response = await post(
      joiner,
      "/cluster/hello",
      helloBody({
        models: [{ provider: "p", id: "m", name: "M", tier: "gold" }],
        default_model: { provider: "p", model: "m", reasoningEffort: "high", note: "x" },
        default_reasoning_effort: null,
        runtime: null,
      }),
    );
    expect(response.statusCode).toBe(200);
    const stored = mesh.get(joiner.orcaNodeId)?.view();
    expect(stored?.models).toEqual([{ provider: "p", id: "m", name: "M" }]);
    expect(stored?.default_model).toEqual({ provider: "p", model: "m", reasoningEffort: "high" });
  });

  it("rejects malformed hello fields", async () => {
    const { post, helloBody } = harness();
    const joiner = generateNodeIdentity();
    const cases: Record<string, unknown>[] = [
      { models: [{ provider: "", id: "m", name: "M" }] },
      { models: Array.from({ length: 129 }, (_, index) => ({ provider: "p", model: `m${index}` })) },
      { default_model: { provider: "p" } },
      { default_reasoning_effort: "   " },
      { max_task_ttl_s: 0 },
      { runtime: { arch: "x64" } },
    ];
    for (const extra of cases) {
      const response = await post(joiner, "/cluster/hello", helloBody(extra));
      expect(response.statusCode, JSON.stringify(extra).slice(0, 80)).toBe(400);
      expect(response.json()).toMatchObject({ code: "bad_request" });
    }
  });

  it("takes a node's latest description from every hello, and screens its endpoints each time", async () => {
    const { post, helloBody, mesh } = harness();
    const member = generateNodeIdentity();
    expect((await post(member, "/cluster/hello", helloBody({}))).statusCode).toBe(200);

    const description = {
      display_name: "renamed",
      endpoints: ["http://127.0.0.1:2/"],
      models: [{ provider: "p", id: "m", name: "M" }],
    };
    const ok = await post(member, "/cluster/hello", helloBody(description));
    expect(ok.statusCode).toBe(200);
    expect(mesh.get(member.orcaNodeId)?.view()).toMatchObject({
      display_name: "renamed",
      endpoints: ["http://127.0.0.1:2"],
      models: [{ provider: "p", id: "m", name: "M" }],
    });

    // Link-local (cloud metadata) is refused on every hello, as on the first one (§7.7).
    const refused = await post(
      member,
      "/cluster/hello",
      helloBody({ ...description, endpoints: ["http://169.254.169.254"] }),
    );
    expect(refused.json()).toMatchObject({ code: "endpoint_refused" });
    expect(mesh.get(member.orcaNodeId)?.view().endpoints).toEqual(["http://127.0.0.1:2"]);
  });
});
