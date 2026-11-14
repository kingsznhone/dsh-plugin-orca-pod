import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createNodeConfig } from "../src/config.ts";
import { createNode, createPersistentStorage } from "../src/node.ts";
import type { OrcaNode } from "../src/node.ts";
import type { TaskView } from "../src/protocol.ts";

const dirs: string[] = [];
const nodes: OrcaNode[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-persist-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const node of nodes.splice(0)) await node.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function nodeFor(dataRoot: string): OrcaNode {
  const config = createNodeConfig({
    workgroupId: "orca-persist",
    password: "secret",
    dataRoot,
    port: 0,
  });
  const node = createNode({ config, storage: createPersistentStorage(config) });
  nodes.push(node);
  return node;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("node persistence", () => {
  it("serves a completed task after a restart", async () => {
    const dataRoot = tempDir();
    const first = nodeFor(dataRoot);
    await first.start();
    const task = await first.sendTask(first.endpoint, {
      message: { role: "user", parts: [{ kind: "text", text: "persist me" }] },
      metadata: { echo: { final: { state: "completed", text: "from sqlite" } } },
    });
    await waitFor(async () => {
      const view = await first.getTask(first.endpoint, task.id);
      return view.status.state === "completed";
    });
    await first.stop();

    const second = nodeFor(dataRoot);
    await second.start();
    const after = await second.getTask(second.endpoint, task.id);
    expect(after.status.state).toBe("completed");
  });

  it("marks an interrupted task failed(node_restart) after a restart", async () => {
    const dataRoot = tempDir();
    const first = nodeFor(dataRoot);
    await first.start();
    const task = await first.sendTask(first.endpoint, {
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { steps: [], final: { state: "hang", text: "" } } },
    });
    await waitFor(async () => {
      const view: TaskView = await first.getTask(first.endpoint, task.id);
      return view.status.state === "working";
    });
    await first.stop();

    const second = nodeFor(dataRoot);
    await second.start();
    const after = await second.getTask(second.endpoint, task.id);
    expect(after.status.state).toBe("failed");
    expect(after.status.reason).toBe("node_restart");
  });
});
