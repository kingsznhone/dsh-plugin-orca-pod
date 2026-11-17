import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { childPodMetadata } from "../src/delegation/chain.ts";
import { deriveChildGrant, grantCovers } from "../src/security/grants.ts";
import { createOrcaNodeConfig } from "../src/node/config.ts";
import { parsePodMetadata } from "../src/tasks/meta.ts";
import { signGrant } from "../src/security/crypto.ts";
import { generateNodeIdentity, loadIdentity } from "../src/security/identity.ts";
import { connectAll } from "../src/node/harness.ts";
import { createOrcaNode, type OrcaNode } from "../src/node/orca-node.ts";
import { permissionRequestOf, type PodTaskMetadata, type TaskState, type TaskView } from "../src/protocol/task.ts";
import type { Grant, SignedGrant } from "../src/protocol/grant.ts";

const WORKGROUP = "orca-chain";
const PASSWORD = "chain-secret";

let nodes: OrcaNode[] = [];
let dataRoots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of dataRoots) rmSync(root, { recursive: true, force: true });
  dataRoots = [];
});

async function makeNode(): Promise<OrcaNode> {
  const dataRoot = mkdtempSync(join(tmpdir(), "orca-chain-"));
  dataRoots.push(dataRoot);
  const config = createOrcaNodeConfig({
    workgroup_id: WORKGROUP,
    workgroup_password: PASSWORD,
    data_root: dataRoot,
    bind_host: "127.0.0.1",
    port: 0,
  });
  const node = createOrcaNode({ config });
  await node.start();
  nodes.push(node);
  return node;
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

async function waitForState(
  reader: OrcaNode,
  peerUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 5000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await reader.getTask(peerUrl, taskId);
    if (view.status.state === state) return view;
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach ${state}; last ${view.status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function expectCode(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

function podMetadata(hop: number, chain: string[], root = "t_root"): Record<string, unknown> {
  return { pod: { hop, chain, root } satisfies PodTaskMetadata };
}

describe("chain metadata", () => {
  it("child metadata increments the hop and appends this orca node", () => {
    expect(
      childPodMetadata({ hop: 0, chain: ["A"], root: "t_root", permission_mode: "workspace-write" }, "t_parent", "B"),
    ).toEqual({ hop: 1, chain: ["A", "B"], root: "t_root", permission_mode: "workspace-write" });
    expect(childPodMetadata(undefined, "t_parent", "B")).toEqual({
      hop: 1,
      chain: ["B"],
      root: "t_parent",
    });
  });

  it("accepts any hop depth but rejects callbacks to an ancestor", () => {
    expect(() => parsePodMetadata(podMetadata(1, ["A", "B"]), "B", "A")).toThrowError(/ancestors/);
    expect(parsePodMetadata(podMetadata(2, ["A", "B"]), "C", "A")).toMatchObject({
      chain: ["A", "B"],
      rootOrigin: "A",
    });
    expect(parsePodMetadata(undefined, "C", "A")).toMatchObject({
      chain: [],
      rootOrigin: "A",
      permissionMode: "read-only",
      inputs: [],
    });
    expect(parsePodMetadata({ pod: { root_origin: "R" } }, "C", "A").rootOrigin).toBe("R");
  });

  it("rejects malformed hop and chain values", () => {
    expect(() => parsePodMetadata({ pod: { hop: -1 } }, "B", "A")).toThrowError(/non-negative integer/);
    expect(() => parsePodMetadata({ pod: { hop: 0.5 } }, "B", "A")).toThrowError(/non-negative integer/);
    expect(() => parsePodMetadata({ pod: { chain: "A" } }, "B", "A")).toThrowError(/array/);
    expect(() => parsePodMetadata({ pod: { task_ttl_s: -1 } }, "B", "A")).toThrowError(/task_ttl_s/);
    expect(() => parsePodMetadata({ echo: { nope: 1 } }, "B", "A")).toThrowError(/unknown field/);
  });
});

describe("child grants", () => {
  const origin = generateNodeIdentity();

  function parentGrant(overrides: Partial<Grant> = {}): SignedGrant {
    const now = Date.now();
    return signGrant(origin, {
      grant_id: randomUUID(),
      workgroup_id: WORKGROUP,
      origin_orca_node: origin.orcaNodeId,
      task_id: "t_parent",
      target_orca_node: "B",
      tool: "write_file",
      mode: "allow_once",
      chain: [origin.orcaNodeId],
      request_id: "req_parent",
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
      ...overrides,
    });
  }

  it("forwards the origin grant unchanged instead of minting a new one", () => {
    const parent = parentGrant();
    const child = deriveChildGrant({
      parent,
      request: {
        request_id: randomUUID(),
        task_id: "t_child",
        tool: "write_file",
        requested: { path: "note.txt" },
        requested_by: "C",
        via: ["A", "B"],
        expires_at: new Date(Date.now() + 30_000).toISOString(),
      },
      selfOrcaNodeId: "B",
    });
    expect(child).toEqual(parent);
    expect(child.chain).toEqual([origin.orcaNodeId]);
    expect(child.target_orca_node).toBe("B");
    expect(child.tool).toBe("write_file");
  });

  it("requires escalation when the parent grant covers a different tool", () => {
    expect(grantCovers(parentGrant(), { tool: "write_file" })).toBeNull();
    expect(grantCovers(parentGrant(), { tool: "run_command" })).toBe("escalation_required");
    expect(() =>
      deriveChildGrant({
        parent: parentGrant(),
        request: {
          request_id: randomUUID(),
          task_id: "t_child",
          tool: "run_command",
          requested: {},
          requested_by: "C",
          via: ["A", "B"],
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
        selfOrcaNodeId: "B",
      }),
    ).toThrowError(/escalation_required|not "run_command"/);
  });

  it("refuses an expired or tampered parent grant", () => {
    const expired = parentGrant({ expires_at: new Date(Date.now() - 1000).toISOString() });
    expect(grantCovers(expired, { tool: "write_file" })).toBe("grant_expired");
    const tampered = { ...parentGrant(), tool: "run_command" };
    expect(() =>
      deriveChildGrant({
        parent: tampered,
        request: {
          request_id: randomUUID(),
          task_id: "t_child",
          tool: "run_command",
          requested: {},
          requested_by: "C",
          via: ["A", "B"],
          expires_at: new Date(Date.now() + 30_000).toISOString(),
        },
        selfOrcaNodeId: "B",
      }),
    ).toThrowError(/signature/);
  });
});

describe("multi-hop enforcement", () => {
  it("accepts hop > 0 without a depth limit", async () => {
    const sender = await makeNode();
    const target = await makeNode();
    await connectAll([sender, target]);
    const view = await sender.sendTask(target.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "two hops" }] },
      metadata: { ...podMetadata(1, [sender.orcaNodeId]), echo: { final: { state: "completed", text: "hop ok" } } },
    });
    const done = await waitForState(sender, target.endpoints[0]!, view.id, "completed");
    expect(done.status.message?.parts).toContainEqual({ kind: "text", text: "hop ok" });
  });

  it("rejects a task that names this node as the root origin of its tree", () => {
    expect(() => parsePodMetadata({ pod: { chain: ["NODE-B"], root_origin: "NODE-A" } }, "NODE-A", "NODE-B")).toThrow(
      expect.objectContaining({ code: "ancestor_call_forbidden" }),
    );
    // A root task to this node (no tree yet) and a tree started elsewhere are fine.
    expect(parsePodMetadata(undefined, "NODE-A", "NODE-B").rootOrigin).toBe("NODE-B");
    expect(parsePodMetadata({ pod: { chain: ["NODE-B"], root_origin: "NODE-C" } }, "NODE-A", "NODE-B").chain).toEqual([
      "NODE-B",
    ]);
  });

  it("stops A -> B -> A when A dispatched the root task without a chain", async () => {
    const origin = await makeNode();
    const worker = await makeNode();
    await connectAll([origin, worker]);
    // The plugin tool sends a root task: no `pod.chain`, no `root_origin`.
    const root = await origin.sendTask(worker.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "root task" }] },
      metadata: { echo: { final: { state: "completed", text: "done" } } },
    });
    await waitForState(origin, worker.endpoints[0]!, root.id, "completed");
    // The worker delegates from inside that task back to the origin.
    await expectCode(
      () =>
        worker.sendTask(
          origin.endpoints[0]!,
          { message: { role: "user", parts: [{ kind: "text", text: "call the origin back" }] } },
          { parentTaskId: root.id },
        ),
      "ancestor_call_forbidden",
    );
  });

  it("rejects a callback into an ancestor chain", async () => {
    const sender = await makeNode();
    const target = await makeNode();
    await connectAll([sender, target]);
    await expectCode(
      () =>
        sender.sendTask(target.endpoints[0]!, {
          message: { role: "user", parts: [{ kind: "text", text: "callback" }] },
          metadata: podMetadata(1, ["A", target.orcaNodeId]),
        }),
      "ancestor_call_forbidden",
    );
  });
});

describe("chained approval", () => {
  it("derives a child grant from the parent grant and resumes the downstream task", async () => {
    const delegator = await makeNode();
    const worker = await makeNode();
    await connectAll([delegator, worker]);
    const origin = loadIdentity(delegator.config.data_root);
    if (origin === null) throw new Error("delegator identity is missing");

    const view = await delegator.sendTask(worker.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "write the note" }] },
      metadata: {
        ...podMetadata(1, ["A", delegator.orcaNodeId]),
        echo: permissionEcho,
      },
    });
    const suspended = await waitForState(delegator, worker.endpoints[0]!, view.id, "input-required");
    const request = permissionRequestOf(suspended);
    expect(request?.tool).toBe("write_file");
    expect(request?.requested_by).toBe(worker.orcaNodeId);
    expect(request?.via).toEqual(["A", delegator.orcaNodeId]);

    const now = Date.now();
    const pendingRequest = permissionRequestOf(suspended);
    if (pendingRequest === null) throw new Error("worker has no permission request");
    const parent: SignedGrant = signGrant(origin, {
      grant_id: randomUUID(),
      workgroup_id: WORKGROUP,
      origin_orca_node: origin.orcaNodeId,
      task_id: "t_parent",
      target_orca_node: delegator.orcaNodeId,
      tool: "write_file",
      mode: "allow_once",
      chain: [origin.orcaNodeId],
      request_id: pendingRequest.request_id,
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
    });

    await delegator.approveTask(worker.endpoints[0]!, suspended, { parentGrant: parent });
    const done = await waitForState(delegator, worker.endpoints[0]!, view.id, "completed");
    expect(done.status.message?.parts).toContainEqual({ kind: "text", text: "written" });
  });

  it("refuses to derive when the parent grant does not cover the request", async () => {
    const delegator = await makeNode();
    const worker = await makeNode();
    await connectAll([delegator, worker]);
    const origin = loadIdentity(delegator.config.data_root);
    if (origin === null) throw new Error("delegator identity is missing");

    const view = await delegator.sendTask(worker.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "write the note" }] },
      metadata: {
        ...podMetadata(1, ["A", delegator.orcaNodeId]),
        echo: permissionEcho,
      },
    });
    const suspended = await waitForState(delegator, worker.endpoints[0]!, view.id, "input-required");
    const now = Date.now();
    const parent: SignedGrant = signGrant(origin, {
      grant_id: randomUUID(),
      workgroup_id: WORKGROUP,
      origin_orca_node: origin.orcaNodeId,
      task_id: "t_parent",
      target_orca_node: delegator.orcaNodeId,
      tool: "run_command",
      mode: "allow_once",
      chain: [origin.orcaNodeId],
      request_id: "req_parent",
      issued_at: new Date(now).toISOString(),
      expires_at: new Date(now + 60_000).toISOString(),
    });

    await expectCode(
      async () => delegator.approveTask(worker.endpoints[0]!, suspended, { parentGrant: parent }),
      "escalation_required",
    );
    expect((await delegator.getTask(worker.endpoints[0]!, view.id)).status.state).toBe("input-required");
  });
});
describe("relay prototype (7.12)", () => {
  const childEcho = {
    steps: [
      {
        at_ms: 10,
        suspend: { kind: "permission", tool: "write_file", requested: { path: "child.txt", bytes: 9 } },
      },
    ],
    final: { state: "completed", text: "child done" },
  };

  async function relaySetup(): Promise<{
    root: OrcaNode;
    middle: OrcaNode;
    leaf: OrcaNode;
    parentTaskId: string;
    childTaskId: string;
    suspendedParent: TaskView;
  }> {
    const root = await makeNode();
    const middle = await makeNode();
    const leaf = await makeNode();
    await connectAll([root, middle, leaf]);

    const childView = await middle.sendTask(leaf.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "child writes" }] },
      metadata: {
        pod: {
          hop: 1,
          chain: [middle.orcaNodeId],
          root: "t_root",
          root_origin: root.orcaNodeId,
        } satisfies PodTaskMetadata,
        echo: childEcho,
      },
    });
    const waitingChild = await waitForState(leaf, leaf.endpoints[0]!, childView.id, "input-required");
    const childRequest = permissionRequestOf(waitingChild);
    if (childRequest === null) throw new Error("child did not publish a permission request");

    const parentView = await root.sendTask(middle.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "parent delegates writing" }] },
      metadata: {
        echo: {
          steps: [
            {
              at_ms: 10,
              suspend: {
                kind: "permission",
                tool: "write_file",
                requested: { path: "note.txt", bytes: 12 },
                relay: { peer: leaf.endpoints[0]!, task_id: childView.id, request: childRequest },
              },
            },
          ],
          final: { state: "completed", text: "parent done" },
        },
      },
    });
    const suspendedParent = await waitForState(root, middle.endpoints[0]!, parentView.id, "input-required");
    return {
      root,
      middle,
      leaf,
      parentTaskId: parentView.id,
      childTaskId: childView.id,
      suspendedParent,
    };
  }

  it("escalates the child's request and relays a derived grant down on approval", async () => {
    const { root, middle, leaf, parentTaskId, childTaskId, suspendedParent } = await relaySetup();

    const request = permissionRequestOf(suspendedParent);
    expect(request?.requested_by).toBe(middle.orcaNodeId);
    expect(request?.upstream).toEqual([leaf.orcaNodeId]);
    expect(request?.tool).toBe("write_file");

    await root.approveTask(middle.endpoints[0]!, suspendedParent);
    const parentDone = await waitForState(root, middle.endpoints[0]!, parentTaskId, "completed");
    expect(parentDone.status.message?.parts).toContainEqual({ kind: "text", text: "parent done" });

    const childDone = await waitForState(root, leaf.endpoints[0]!, childTaskId, "completed");
    expect(childDone.status.message?.parts).toContainEqual({ kind: "text", text: "child done" });
  });

  it("propagates a denial down so the child fails instead of hanging", async () => {
    const { root, middle, leaf, parentTaskId, childTaskId, suspendedParent } = await relaySetup();

    await root.denyTask(middle.endpoints[0]!, suspendedParent, "policy says no");
    const parentFailed = await waitForState(root, middle.endpoints[0]!, parentTaskId, "failed");
    expect(parentFailed.status.reason).toBe("permission_denied");

    const childFailed = await waitForState(root, leaf.endpoints[0]!, childTaskId, "failed");
    expect(childFailed.status.reason).toBe("permission_denied");
  });
});
