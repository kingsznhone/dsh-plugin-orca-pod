import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { buildAuthHeader, signGrant } from "../src/security/crypto.ts";
import { loadIdentity, type NodeIdentity } from "../src/security/identity.ts";
import { createMesh, type Mesh } from "../src/node/harness.ts";
import type { OrcaNode } from "../src/node/orca-node.ts";
import { permissionRequestOf } from "../src/protocol/task.ts";
import type { A2AMessage, TaskState, TaskView } from "../src/protocol/task.ts";
import type { Grant, SignedGrant } from "../src/protocol/grant.ts";

const WORKGROUP = "orca-approval";
const PASSWORD = "approval-secret";

let mesh: Mesh | null = null;

afterEach(async () => {
  await mesh?.stop();
  mesh = null;
});

type ApprovalMesh = {
  origin: OrcaNode;
  target: OrcaNode;
  outsider: OrcaNode;
  targetUrl: string;
  identity: NodeIdentity;
};

async function threeNodes(): Promise<ApprovalMesh> {
  mesh = await createMesh({ orcaNodes: 3, workgroupId: WORKGROUP, password: PASSWORD });
  const [origin, target, outsider] = mesh.orcaNodes;
  if (!origin || !target || !outsider) throw new Error("mesh did not create three orca nodes");
  const identity = loadIdentity(origin.config.data_root);
  if (identity === null) throw new Error("origin identity is missing");
  return { origin, target, outsider, targetUrl: target.endpoints[0]!, identity };
}

const permissionEcho = {
  steps: [
    {
      at_ms: 10,
      suspend: { kind: "permission", tool: "write_file", requested: { path: "note.txt", bytes: 12 } },
    },
  ],
  final: { state: "completed", text: "written" },
};

async function submit(origin: OrcaNode, targetUrl: string): Promise<TaskView> {
  return origin.sendTask(targetUrl, {
    message: { role: "user", parts: [{ kind: "text", text: "write the note" }] },
    metadata: { echo: permissionEcho },
  });
}

async function waitForState(
  origin: OrcaNode,
  targetUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 3000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let last: TaskView | null = null;
  while (Date.now() < deadline) {
    last = await origin.getTask(targetUrl, taskId);
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
  // Signatures bind the receiver id (§7.1); the test signs for a real target node.
  const health = (await (await fetch(new URL("/health", targetUrl))).json()) as { orca_node_id: string };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: buildAuthHeader({
        identity: signer,
        method: "POST",
        url: `${url.pathname}${url.search}`,
        targetOrcaNodeId: health.orca_node_id,
        body,
      }),
    },
    body,
  });
  const payload = (await response.json()) as {
    result?: TaskView;
    error?: { message?: string };
  };
  return { status: response.status, code: payload.error?.message ?? null, view: payload.result ?? null };
}

function resumeMessage(taskId: string, data: Record<string, unknown>): A2AMessage {
  return { role: "user", parts: [{ kind: "data", data }], taskId, messageId: randomUUID() };
}

function grantFor(view: TaskView, originOrcaNode: string, tool = "write_file"): Grant {
  const request = permissionRequestOf(view);
  if (request === null) throw new Error("view has no permission request");
  const issuedAt = new Date();
  return {
    grant_id: randomUUID(),
    workgroup_id: WORKGROUP,
    origin_orca_node: originOrcaNode,
    task_id: view.id,
    target_orca_node: request.requested_by,
    tool,
    mode: "allow_once",
    chain: [originOrcaNode, ...request.via],
    request_id: request.origin_request_id ?? request.request_id,
    issued_at: issuedAt.toISOString(),
    expires_at: new Date(issuedAt.getTime() + 60_000).toISOString(),
  };
}

describe("Phase 3 approval round trip", () => {
  it("surfaces a permission request and completes after the origin approves", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    const request = permissionRequestOf(suspended);
    expect(request).not.toBeNull();
    expect(request?.task_id).toBe(submitted.id);
    expect(request?.tool).toBe("write_file");
    expect(request?.requested).toEqual({ path: "note.txt", bytes: 12 });
    expect(request?.expires_at).toBeUndefined();

    const resumed = await origin.approveTask(targetUrl, suspended);
    expect(resumed.status.state).not.toBe("failed");

    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("written");
    expect(permissionRequestOf(done)).toBeNull();
    // The grant is signed by the origin node's Ed25519 identity.
    expect(identity.orcaNodeId).toBe(origin.orcaNodeId);
  });

  it("fails the task when the origin denies", async () => {
    const { origin, targetUrl } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    await origin.denyTask(targetUrl, suspended, "not allowed on this machine");

    const failed = await waitForState(origin, targetUrl, submitted.id, "failed");
    expect(failed.status.reason).toBe("permission_denied");
    expect(textOf(failed)).toContain("permission denied");
    expect(textOf(failed)).toContain("not allowed on this machine");
  });

  it("rejects a tampered grant", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    const signed = signGrant(identity, grantFor(suspended, origin.orcaNodeId));
    const tampered: SignedGrant = { ...signed, tool: "delete_everything" };
    const response = await signedResume(targetUrl, identity, resumeMessage(submitted.id, { grant: tampered }));
    expect(response.status).toBe(200);

    const failed = await waitForState(origin, targetUrl, submitted.id, "failed");
    expect(failed.status.reason).toBe("grant_invalid");
  });

  it("rejects an expired grant", async () => {
    const { origin, targetUrl } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    await origin.approveTask(targetUrl, suspended, { ttlS: -1 });

    const failed = await waitForState(origin, targetUrl, submitted.id, "failed");
    expect(failed.status.reason).toBe("grant_expired");
  });

  it("refuses a resume from a non-origin member", async () => {
    const { origin, outsider, targetUrl, identity } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, submitted.id, "input-required");

    const grant = signGrant(identity, grantFor(suspended, origin.orcaNodeId));
    const outsiderIdentity = loadIdentity(outsider.config.data_root);
    if (outsiderIdentity === null) throw new Error("outsider identity is missing");
    const response = await signedResume(targetUrl, outsiderIdentity, resumeMessage(submitted.id, { grant }));

    expect(response.status).toBe(403);
    expect(response.code).toBe("not_task_origin");
    // The task is untouched and still waiting for the origin.
    const still = await origin.getTask(targetUrl, submitted.id);
    expect(still.status.state).toBe("input-required");
  });

  it("refuses a plain resume while a permission decision is pending", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const submitted = await submit(origin, targetUrl);
    await waitForState(origin, targetUrl, submitted.id, "input-required");

    const response = await signedResume(targetUrl, identity, resumeMessage(submitted.id, { hello: "no grant here" }));

    expect(response.status).toBe(400);
    expect(response.code).toBe("bad_request");
  });

  it("keeps waiting past the task TTL while parked for approval", async () => {
    const { origin, targetUrl } = await threeNodes();
    const submitted = await origin.sendTask(targetUrl, {
      message: { role: "user", parts: [{ kind: "text", text: "write the note" }] },
      metadata: { echo: permissionEcho, pod: { task_ttl_s: 1 } },
    });
    await waitForState(origin, targetUrl, submitted.id, "input-required");

    // The task TTL is paused while the task waits for a human (§7.12).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const still = await origin.getTask(targetUrl, submitted.id);
    expect(still.status.state).toBe("input-required");

    await origin.approveTask(targetUrl, still);
    const done = await waitForState(origin, targetUrl, submitted.id, "completed");
    expect(textOf(done)).toBe("written");
  });

  it("auto-rejects a parked request when approval_timeout_s is configured", async () => {
    mesh = await createMesh({ orcaNodes: 2, workgroupId: WORKGROUP, password: PASSWORD, approvalTimeoutS: 1 });
    const [origin, target] = mesh.orcaNodes;
    if (!origin || !target) throw new Error("mesh did not create two orca nodes");
    const submitted = await submit(origin, target.endpoints[0]!);
    await waitForState(origin, target.endpoints[0]!, submitted.id, "input-required");

    const failed = await waitForState(origin, target.endpoints[0]!, submitted.id, "failed", 4000);
    expect(failed.status.reason).toBe("permission_timeout");
    expect(textOf(failed)).toContain("permission request timed out");
  });
});

describe("grant binding (§7.11)", () => {
  it("rejects a grant issued for another permission request", async () => {
    const { origin, targetUrl, identity } = await threeNodes();
    const view = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, view.id, "input-required");
    const grant = grantFor(suspended, origin.self().orca_node_id);
    const tampered = signGrant(identity, { ...grant, request_id: randomUUID() });

    await signedResume(targetUrl, identity, resumeMessage(suspended.id, { grant: tampered }));
    const failed = await waitForState(origin, targetUrl, view.id, "failed");
    expect(failed.status.reason).toBe("grant_invalid");
  });

  it("rejects a grant whose origin is not the task root origin", async () => {
    const { origin, targetUrl, outsider, identity } = await threeNodes();
    const outsiderIdentity = loadIdentity(outsider.config.data_root);
    if (outsiderIdentity === null) throw new Error("outsider identity is missing");
    const view = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, view.id, "input-required");
    const forged = signGrant(outsiderIdentity, grantFor(suspended, outsider.orcaNodeId));

    // The origin still drives the resume (only it may); the grant itself is forged.
    await signedResume(targetUrl, identity, resumeMessage(suspended.id, { grant: forged }));
    const failed = await waitForState(origin, targetUrl, view.id, "failed");
    expect(failed.status.reason).toBe("grant_invalid");
  });

  it("rejects a grant whose chain does not start with its origin", async () => {
    const { origin, targetUrl, outsider, identity } = await threeNodes();
    const view = await submit(origin, targetUrl);
    const suspended = await waitForState(origin, targetUrl, view.id, "input-required");
    const grant = grantFor(suspended, origin.self().orca_node_id);
    const relabelled = signGrant(identity, { ...grant, chain: [outsider.orcaNodeId, ...grant.chain] });

    await signedResume(targetUrl, identity, resumeMessage(suspended.id, { grant: relabelled }));
    const failed = await waitForState(origin, targetUrl, view.id, "failed");
    expect(failed.status.reason).toBe("grant_invalid");
  });
});
