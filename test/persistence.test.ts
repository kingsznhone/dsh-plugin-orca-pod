import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeParts } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import type { TaskView } from "../src/task/wire.ts";
import { wg } from "./fixtures/ids.ts";

const dirs: string[] = [];
const orcaNodes: Orca[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "orca-persist-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const orcaNode of orcaNodes.splice(0)) await orcaNode.stop().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function nodeFor(dataRoot: string): Promise<Orca> {
  const config = nodeParts({
    workgroup_id: wg("orca-persist"),
    workgroup_password: "secret",
    data_root: dataRoot,
    port: 0,
  });
  const orcaNode = new Orca(...config);
  orcaNodes.push(orcaNode);
  return orcaNode;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("orca node persistence", () => {
  it("serves a completed task after a restart", async () => {
    const dataRoot = tempDir();
    const first = await nodeFor(dataRoot);
    await first.start();
    const task = await first.mesh.resolve(first.mesh.self.endpoints[0]!).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "persist me" }] },
      metadata: { echo: { final: { state: "completed", text: "from sqlite" } } },
    });
    await waitFor(async () => {
      const view = await first.mesh.resolve(first.mesh.self.endpoints[0]!).getTask(task.id);
      return view.status.state === "completed";
    });
    await first.stop();

    const second = await nodeFor(dataRoot);
    await second.start();
    const after = await second.mesh.resolve(second.mesh.self.endpoints[0]!).getTask(task.id);
    expect(after.status.state).toBe("completed");
  });

  it("marks an interrupted task failed(node_restart) after a restart", async () => {
    const dataRoot = tempDir();
    const first = await nodeFor(dataRoot);
    await first.start();
    const task = await first.mesh.resolve(first.mesh.self.endpoints[0]!).sendTask({
      message: { role: "user", parts: [{ kind: "text", text: "hang" }] },
      metadata: { echo: { steps: [], final: { state: "hang", text: "" } } },
    });
    await waitFor(async () => {
      const view: TaskView = await first.mesh.resolve(first.mesh.self.endpoints[0]!).getTask(task.id);
      return view.status.state === "working";
    });
    await first.stop();

    const second = await nodeFor(dataRoot);
    await second.start();
    const after = await second.mesh.resolve(second.mesh.self.endpoints[0]!).getTask(task.id);
    expect(after.status.state).toBe("failed");
    expect(after.status.reason).toBe("node_restart");
  });
});
