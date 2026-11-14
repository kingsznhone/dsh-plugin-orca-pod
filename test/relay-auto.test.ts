import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/config.ts";
import type { LocalExecutor } from "../src/executor.ts";
import { createHeadlessExecutor } from "../src/headless.ts";
import { createOrcaNode, type OrcaNode } from "../src/orca_node.ts";
import { permissionRequestOf, type TaskState, type TaskView } from "../src/protocol.ts";

const FAKE_DSH = fileURLToPath(new URL("./fixtures/fake-dsh.mjs", import.meta.url));
const WORKGROUP = "orca-relay-auto";
const PASSWORD = "relay-auto-secret";

let nodes: OrcaNode[] = [];
let roots: string[] = [];

afterEach(async () => {
  delete process.env.FAKE_DSH_MODE;
  await Promise.all(nodes.map((node) => node.stop().catch(() => undefined)));
  nodes = [];
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots = [];
});

async function makeNode(executor?: LocalExecutor): Promise<OrcaNode> {
  const dataRoot = mkdtempSync(join(tmpdir(), "orca-relay-auto-"));
  roots.push(dataRoot);
  const config = createOrcaNodeConfig({
    workgroupId: WORKGROUP,
    password: PASSWORD,
    dataRoot,
    host: "127.0.0.1",
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
    if (Date.now() > deadline) throw new Error(`task ${taskId} did not reach ${state}; last ${view.status.state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("automatic chain ascent (7.12)", () => {
  it("parks the parent task when a linked child asks for permission, then resumes the child on approval", async () => {
    const root = await makeNode();
    const leaf = await makeNode();
    // The middle node's local task stays "working" while it delegates, like an
    // agent that keeps thinking after dispatching a child (§7.12).
    process.env.FAKE_DSH_MODE = "hang";
    const middle = await makeNode(
      createHeadlessExecutor({ command: process.execPath, extra_args: [FAKE_DSH] }),
    );

    const parentView = await root.sendTask(middle.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "parent keeps working" }] },
    });
    await waitForState(root, middle.endpoints[0]!, parentView.id, "working");

    const childView = await middle.sendTask(leaf.endpoints[0]!, {
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
    });
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
    expect(() => node.linkChildTask("task-missing", "http://127.0.0.1:1", "child-1")).toThrow(
      /unknown local task/,
    );
  });
});
