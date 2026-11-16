import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { configPath, createOrcaNodeConfig, saveConfig } from "../src/config.ts";
import { createOrcaNode, type OrcaNode } from "../src/orca_node.ts";
import { permissionRequestOf, type TaskState, type TaskView } from "../src/protocol.ts";

const WORKGROUP = "orca-escalate";
const PASSWORD = "escalate-secret";

let nodes: OrcaNode[] = [];
let dataRoots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of dataRoots) rmSync(root, { recursive: true, force: true });
  dataRoots = [];
});

async function makeNode(): Promise<OrcaNode> {
  const dataRoot = mkdtempSync(join(tmpdir(), "orca-escalate-"));
  dataRoots.push(dataRoot);
  const config = createOrcaNodeConfig({
    workgroupId: WORKGROUP,
    password: PASSWORD,
    dataRoot,
    host: "127.0.0.1",
    port: 0,
  });
  const node = createOrcaNode({ config });
  await node.start();
  nodes.push(node);
  return node;
}

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

const permissionEcho = {
  steps: [
    {
      at_ms: 10,
      suspend: { kind: "permission", tool: "write_file", requested: { path: "note.txt", bytes: 12 } },
    },
  ],
  final: { state: "completed", text: "written" },
};

const hangEcho = { final: { state: "hang" } };

/**
 * B parks its running task because C needs an approval (§7.12). The parent task
 * surfaces an upstream request; A's grant derives a child grant for C.
 */
async function scenario(): Promise<{
  a: OrcaNode;
  b: OrcaNode;
  c: OrcaNode;
  parentId: string;
  childId: string;
}> {
  const a = await makeNode();
  const b = await makeNode();
  const c = await makeNode();

  const child = await b.sendTask(c.endpoints[0]!, {
    message: { role: "user", parts: [{ kind: "text", text: "child" }], contextId: "ctx-child" },
    metadata: {
      pod: { hop: 1, chain: [b.orcaNodeId], root_origin: a.orcaNodeId },
      echo: permissionEcho,
    },
  });
  await waitForState(c, c.endpoints[0]!, child.id, "input-required");

  const parent = await a.sendTask(b.endpoints[0]!, {
    message: { role: "user", parts: [{ kind: "text", text: "parent" }], contextId: "ctx-parent" },
    metadata: { echo: hangEcho },
  });
  await waitForState(b, b.endpoints[0]!, parent.id, "working");
  return { a, b, c, parentId: parent.id, childId: child.id };
}

describe("escalating a child permission to the task origin (§7.12)", () => {
  it("parks the parent task and derives a child grant on approval", async () => {
    const { a, b, c, parentId, childId } = await scenario();
    const childView = await b.getTask(c.endpoints[0]!, childId);
    const childRequest = permissionRequestOf(childView);
    expect(childRequest).not.toBeNull();

    const parked = await b.escalateTask(b.endpoints[0]!, parentId, {
      peer: c.endpoints[0]!,
      task_id: childId,
      request: childRequest!,
    });
    expect(parked.status.state).toBe("input-required");
    const upstream = permissionRequestOf(parked);
    expect(upstream?.requested_by).toBe(b.orcaNodeId);
    expect(upstream?.upstream).toEqual([c.orcaNodeId]);
    expect(upstream?.tool).toBe("write_file");

    const working = await a.approveTask(b.endpoints[0]!, parked);
    expect(working.status.state).toBe("working");

    const childDone = await waitForState(c, c.endpoints[0]!, childId, "completed");
    expect(childDone.status.state).toBe("completed");
    expect(permissionRequestOf(childDone)).toBeNull();
  });

  it("treats a repeated escalation as a no-op", async () => {
    const { b, c, parentId, childId } = await scenario();
    const childRequest = permissionRequestOf(await b.getTask(c.endpoints[0]!, childId));
    expect(childRequest).not.toBeNull();
    const relay = { peer: c.endpoints[0]!, task_id: childId, request: childRequest! };
    const first = await b.escalateTask(b.endpoints[0]!, parentId, relay);
    expect(first.status.state).toBe("input-required");

    const again = await b.escalateTask(b.endpoints[0]!, parentId, relay);
    expect(again.status.state).toBe("input-required");
    expect(permissionRequestOf(again)?.request_id).toBe(permissionRequestOf(first)?.request_id);
  });

  it("keeps the deeper requester chain when a relay carries one", async () => {
    const { b, c, parentId, childId } = await scenario();
    const childRequest = permissionRequestOf(await b.getTask(c.endpoints[0]!, childId));
    expect(childRequest).not.toBeNull();
    const parked = await b.escalateTask(b.endpoints[0]!, parentId, {
      peer: c.endpoints[0]!,
      task_id: childId,
      request: { ...childRequest!, upstream: ["deepnode"] },
    });
    const upstream = permissionRequestOf(parked);
    expect(upstream?.requested_by).toBe(b.orcaNodeId);
    expect(upstream?.upstream).toEqual(["deepnode", c.orcaNodeId]);
  });

  it("propagates a denial down to the child", async () => {
    const { a, b, c, parentId, childId } = await scenario();
    const childRequest = permissionRequestOf(await b.getTask(c.endpoints[0]!, childId));
    expect(childRequest).not.toBeNull();
    const parked = await b.escalateTask(b.endpoints[0]!, parentId, {
      peer: c.endpoints[0]!,
      task_id: childId,
      request: childRequest!,
    });

    const denied = await a.denyTask(b.endpoints[0]!, parked, "policy says no");
    expect(denied.status.state).toBe("failed");
    expect(denied.status.reason).toBe("permission_denied");

    const childDenied = await waitForState(c, c.endpoints[0]!, childId, "failed");
    expect(childDenied.status.reason).toBe("permission_denied");
  });

  it("escalates from `orca-node wait --local-task` without a separate escalate call", async () => {
    const { a, b, c, parentId, childId } = await scenario();
    await saveConfig(configPath(b.config.data_root), { ...b.config, endpoints: [b.endpoints[0]!] });
    const run = promisify(execFile);
    const cli = join(import.meta.dirname, "..", "src", "cli.ts");
    const waiting = run(process.execPath, [
      cli,
      "wait",
      "--data-root",
      b.config.data_root,
      "--peer",
      c.endpoints[0]!,
      "--task",
      childId,
      "--local-task",
      parentId,
      "--timeout",
      "20",
      "--json",
    ]);
    waiting.catch(() => undefined);

    const parked = await waitForState(b, b.endpoints[0]!, parentId, "input-required");
    expect(permissionRequestOf(parked)?.requested_by).toBe(b.orcaNodeId);

    await a.approveTask(b.endpoints[0]!, parked);
    const { stdout } = await waiting;
    const view = JSON.parse(stdout) as TaskView;
    expect(view.status.state).toBe("completed");
  });

  it("rejects escalation for a task that is not running", async () => {
    const b = await makeNode();
    const c = await makeNode();
    const child = await b.sendTask(c.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "child" }], contextId: "ctx-child" },
      metadata: { pod: { hop: 1, chain: [b.orcaNodeId] }, echo: permissionEcho },
    });
    const childView = await waitForState(c, c.endpoints[0]!, child.id, "input-required");
    const request = permissionRequestOf(childView);
    expect(request).not.toBeNull();

    await expect(
      b.escalateTask(b.endpoints[0]!, "missing-task", { peer: c.endpoints[0]!, task_id: child.id, request: request! }),
    ).rejects.toMatchObject({ code: "task_not_found" });
  });
});
