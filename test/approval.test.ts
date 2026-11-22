import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildAuthHeader, newNonce } from "../src/core/signing.ts";
import { nodeFetch } from "../src/mesh/peer-client.ts";
import { PeerTls } from "../src/mesh/tls.ts";
import type { NodeIdentity } from "../src/core/identity.ts";
import { identityOf } from "./support/node.ts";
import { createMesh, type Mesh } from "./support/harness.ts";
import type { Orca } from "../src/node/orca.ts";
import { permissionRequestOf, type A2AMessage, type TaskState, type TaskView } from "../src/task/wire.ts";
import { wg } from "./fixtures/ids.ts";
import { deriveWorkgroupKey } from "../src/plugin/pod.ts";
import { scriptMessage, type Script } from "./support/script.ts";

const WORKGROUP = wg("orca-approval");
const PASSWORD = "approval-secret";

let mesh: Mesh | null = null;

afterEach(async () => {
  await mesh?.stop();
  mesh = null;
});

type ApprovalMesh = {
  origin: Orca;
  target: Orca;
  outsider: Orca;
  targetUrl: string;
  identity: NodeIdentity;
};

/** An origin, the target it sends to, and a third member; `taskTimeoutS` caps every node's task lifetime. */
async function threeNodes(taskTimeoutS?: number): Promise<ApprovalMesh> {
  mesh = await createMesh({ orcaNodes: 3, workgroupId: WORKGROUP, password: PASSWORD, taskTimeoutS });
  const [origin, target, outsider] = mesh.orcaNodes;
  if (!origin || !target || !outsider) throw new Error("mesh did not create three orca nodes");
  return { origin, target, outsider, targetUrl: target.mesh.self.endpoints[0]!, identity: identityOf(origin) };
}

const permissionScript = {
  steps: [{ at_ms: 10, suspend: { tool: "write_file", requested: { path: "note.txt", bytes: 12 } } }],
  final: { state: "completed", text: "written" },
} satisfies Script;

async function submit(origin: Orca, targetUrl: string): Promise<TaskView> {
  return origin.mesh.resolve(targetUrl).sendTask({
    message: scriptMessage(permissionScript),
  });
}

async function waitForState(
  origin: Orca,
  targetUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 3000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | null = null;
  while (Date.now() < deadline) {
    last = await origin.mesh.resolve(targetUrl).getTask(taskId);
    if (last.status.state === state) return last;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`task ${taskId} did not reach ${state}; last=${last?.status.state}`);
}

function textOf(view: TaskView): string | null {
  const part = view.status.message?.parts.find((item) => item.kind === "text");
  return part && part.kind === "text" ? part.text : null;
}

/** Signed JSON-RPC with an explicit caller identity, bypassing the client API. */
async function signedResume(
  targetUrl: string,
  signer: NodeIdentity,
  message: A2AMessage,
): Promise<{ status: number; code: string | null; view: TaskView | null }> {
  const url = new URL("/a2a", targetUrl);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: randomUUID(),
    method: "message/send",
    params: { message },
  });
  // Signatures bind the receiver id (design.md 6.1); the test signs for a real target node, which it
  // first meets over TLS like any node would (any node's certificate), then dials pinned to it (design.md 6.2).
  const tls = new PeerTls();
  const contact = tls.route("");
  const health = (await (
    await nodeFetch(new URL("/health", targetUrl), { dispatcher: contact.dispatcher })
  ).json()) as { orca_node_id: string };
  contact.release();
  const response = await nodeFetch(url, {
    dispatcher: tls.route(health.orca_node_id).dispatcher,
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: buildAuthHeader(
        signer,
        deriveWorkgroupKey(WORKGROUP, PASSWORD),
        { method: "POST", url: `${url.pathname}${url.search}`, body },
        { target: health.orca_node_id, workgroupId: WORKGROUP, ts: Date.now(), nonce: newNonce() },
      ),
    },
    body,
  });
  const payload = (await response.json()) as {
    result?: TaskView;
    error?: { message?: string };
  };
  await tls.close();
  return { status: response.status, code: payload.error?.message ?? null, view: payload.result ?? null };
}

function resumeMessage(taskId: string, data: Record<string, unknown>): A2AMessage {
  return { role: "user", parts: [{ kind: "data", data }], taskId, messageId: randomUUID() };
}

/** The origin's approval of the request a suspended task is parked on, as a resume part carries it. */
function approvalOf(view: TaskView): Record<string, unknown> {
  const request = permissionRequestOf(view);
  if (request === null) throw new Error("view has no permission request");
  return { permission_granted: true, request_id: request.request_id };
}

describe("Phase 3 approval round trip", () => {
  it("surfaces a permission request and completes after the origin approves", async () => {
    const { origin, targetUrl } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    const request = permissionRequestOf(suspended);
    expect(request).not.toBeNull();
    expect(request?.task_id).toBe(submitted.id);
    expect(request?.tool).toBe("write_file");
    expect(request?.requested).toEqual({ path: "note.txt", bytes: 12 });

    const resumed = await origin.mesh.resolve(targetUrl).approve(suspended);
    expect(resumed.status.state).not.toBe("failed");

    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("written");
    expect(permissionRequestOf(done)).toBeNull();
  });

  it("fails the task when the origin denies", async () => {
    const { origin, targetUrl } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    await origin.mesh.resolve(targetUrl).deny(suspended, "not allowed on this machine");

    const failed = await waitForState(origin, targetUrl, submitted.id, "failed");
    expect(failed.status.reason).toBe("permission_denied");
    expect(textOf(failed)).toContain("permission denied");
    expect(textOf(failed)).toContain("not allowed on this machine");
  });

  it("refuses a resume from a non-origin member", async () => {
    const { origin, outsider, targetUrl } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    const response = await signedResume(
      targetUrl,
      identityOf(outsider),
      resumeMessage(submitted.id, approvalOf(suspended)),
    );

    expect(response.status).toBe(403);
    expect(response.code).toBe("not_task_origin");
    // The task is untouched and still waiting for the origin.
    const still = await origin.mesh.resolve(targetUrl).getTask(submitted.id);
    expect(still.status.state).toBe("input-required");
  });

  it("refuses a plain resume while a permission decision is pending", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    await waitForState(origin, targetUrl, submitted.id, "input-required");

    const response = await signedResume(
      targetUrl,
      identity,
      resumeMessage(submitted.id, { hello: "no decision here" }),
    );

    expect(response.status).toBe(400);
    expect(response.code).toBe("bad_request");
  });

  it("keeps waiting past the task TTL while parked for approval", async () => {
    const { origin, targetUrl } = await threeNodes(1);
    const submitted = await origin.mesh.resolve(targetUrl).sendTask({ message: scriptMessage(permissionScript) });
    await waitForState(origin, targetUrl, submitted.id, "input-required");

    // The task TTL is paused while the task waits for a human (design.md 6.4).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const still = await origin.mesh.resolve(targetUrl).getTask(submitted.id);
    expect(still.status.state).toBe("input-required");

    await origin.mesh.resolve(targetUrl).approve(still);
    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("written");
  });

  it("runs on after an approval with what was left of its TTL, not a fresh one", async () => {
    const { origin, targetUrl } = await threeNodes(1);
    // It works 700 ms of its 1 s before it parks, then would run forever.
    const parksLate: Script = { steps: [{ ...permissionScript.steps[0]!, at_ms: 700 }], final: { state: "hang" } };
    const submitted = await origin.mesh.resolve(targetUrl).sendTask({ message: scriptMessage(parksLate) });
    const parked = await waitForState(origin, targetUrl, submitted.id, "input-required");
    await new Promise((resolve) => setTimeout(resolve, 500));

    await origin.mesh.resolve(targetUrl).approve(parked);
    // About 300 ms are left; a fresh TTL would keep it working for a whole second.
    const failed = await waitForState(origin, targetUrl, submitted.id, "failed", 800);
    expect(failed.status.reason).toBe("timeout");
  });
});

describe("approval binding (design.md 6.4)", () => {
  it("refuses an approval for another permission request and keeps the task waiting", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const view = await submit(origin, targetUrl);
    await waitForState(origin, targetUrl, view.id, "input-required");

    const response = await signedResume(
      targetUrl,
      identity,
      resumeMessage(view.id, { permission_granted: true, request_id: randomUUID() }),
    );
    expect(response.status).toBe(400);
    expect(response.code).toBe("bad_request");
    const still = await origin.mesh.resolve(targetUrl).getTask(view.id);
    expect(still.status.state).toBe("input-required");
  });
});
