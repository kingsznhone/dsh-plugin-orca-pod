import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createAcpExecutor } from "../src/execution/acp/executor.ts";
import { createOrcaNodeConfig } from "../src/node/config.ts";
import type { LocalExecutor } from "../src/execution/executor.ts";
import { connectAll } from "../src/node/harness.ts";
import { createOrcaNode, type OrcaNode } from "../src/node/orca-node.ts";
import { permissionRequestOf, type TaskState, type TaskView } from "../src/protocol/task.ts";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const WORKGROUP = "orca-relay-auto";
const PASSWORD = "relay-auto-secret";

let nodes: OrcaNode[] = [];
let roots: string[] = [];

afterEach(async () => {
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function makeNode(executor?: LocalExecutor): Promise<OrcaNode> {
  const dataRoot = mkdtempSync(join(tmpdir(), "orca-relay-auto-"));
  roots.push(dataRoot);
  const config = createOrcaNodeConfig({
    workgroup_id: WORKGROUP,
    workgroup_password: PASSWORD,
    data_root: dataRoot,
    bind_host: "127.0.0.1",
    port: 0,
  });
  const node = createOrcaNode({ config, ...(executor === undefined ? {} : { executor }) });
  await node.start();
  nodes.push(node);
  return node;
}

async function waitForState(
  reader: OrcaNode,
  peerUrl: string,
  taskId: string,
  state: TaskState,
  timeoutMs = 8000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const view = await reader.getTask(peerUrl, taskId);
    if (view.status.state === state) return view;
    if (Date.now() > deadline)
      throw new Error(
        `task ${taskId} did not reach ${state}; last ${view.status.state} reason=${String(view.status.reason ?? "")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("automatic chain ascent (7.12)", () => {
  it("parks the parent task when a linked child asks for permission, then resumes the child on approval", async () => {
    const root = await makeNode();
    const leaf = await makeNode();
    // The ACP child receives `--profile acp` after our extra args, so give the
    // fake server an explicit log path; otherwise it appends its NDJSON log to
    // a file literally named "--profile" in the workspace.
    const acpRoot = mkdtempSync(join(tmpdir(), "orca-relay-acp-"));
    roots.push(acpRoot);
    // The middle node's local task stays "working" while it delegates, like an
    // agent that keeps thinking after dispatching a child (§7.12).
    const middle = await makeNode(
      createAcpExecutor({
        command: process.execPath,
        extra_args: [FAKE_ACP, "hang", join(acpRoot, "acp.log")],
      }),
    );
    await connectAll([root, middle, leaf]);

    const parentView = await root.sendTask(middle.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "parent keeps working" }] },
    });
    await waitForState(root, middle.endpoints[0]!, parentView.id, "working");

    const childView = await middle.sendTask(
      leaf.endpoints[0]!,
      {
        message: { role: "user", parts: [{ kind: "text", text: "child writes" }] },
        metadata: {
          echo: {
            steps: [
              {
                at_ms: 10,
                suspend: { kind: "permission", tool: "write_file", requested: { path: "child.txt", bytes: 9 } },
              },
            ],
            final: { state: "completed", text: "child done" },
          },
        },
      },
      { parentTaskId: parentView.id },
    );
    await waitForState(root, leaf.endpoints[0]!, childView.id, "input-required");

    // The CLI does this on `send --local-task`; here we call it directly.
    middle.linkChildTask(parentView.id, leaf.endpoints[0]!, childView.id);

    const parkedParent = await waitForState(root, middle.endpoints[0]!, parentView.id, "input-required");
    const request = permissionRequestOf(parkedParent);
    expect(request?.tool).toBe("write_file");
    expect(request?.requested_by).toBe(middle.orcaNodeId);
    expect(request?.upstream).toEqual([leaf.orcaNodeId]);

    await root.approveTask(middle.endpoints[0]!, parkedParent);
    const childDone = await waitForState(root, leaf.endpoints[0]!, childView.id, "completed");
    expect(childDone.status.message?.parts).toContainEqual({ kind: "text", text: "child done" });
    // The parent's executor was never stopped, so it goes back to working.
    await waitForState(root, middle.endpoints[0]!, parentView.id, "working");

    const linked = middle
      .listDispatches()
      .find((entry) => entry.task_id === childView.id && entry.parent_local_task_id === parentView.id);
    expect(linked).toBeDefined();
  });

  it("rejects a child link for an unknown local task", async () => {
    const node = await makeNode();
    expect(() => node.linkChildTask("task-missing", "http://127.0.0.1:1", "child-1")).toThrow(/unknown local task/);
  });
});
