/**
 * Budget and summary limits (design.md 5.3): a task's hard TTL is the local cap, the
 * summary is truncated to 32 KiB, and both the cap and usage are
 * visible/recorded so an origin can size its delegations.
 */

import { JsonTable } from "../src/task/json-table.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { nodeParts, peersOf } from "./support/node.ts";
import { Orca } from "../src/node/orca.ts";
import { isTerminal, type TaskView } from "../src/task/wire.ts";
import { createTestRunner } from "./fixtures/runner.ts";
import { wg } from "./fixtures/ids.ts";
import { ScriptExecutor, scriptMessage } from "./support/script.ts";

const WORKGROUP = wg("orca-limits");

function hangTask() {
  return {
    message: scriptMessage({ final: { state: "hang" as const, text: "" } }),
  };
}

function completedTask(text: string) {
  return {
    message: scriptMessage({ final: { state: "completed" as const, text } }),
  };
}

function textOf(view: TaskView): string {
  for (const part of view.status.message?.parts ?? []) {
    if (part.kind === "text") return part.text;
  }
  return "";
}

async function waitForTerminal(
  runner: { get(id: string): TaskView | null },
  taskId: string,
  timeoutMs = 5_000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = runner.get(taskId);
    if (view && isTerminal(view.status.state)) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for a terminal task");
}

describe("task hard TTL", () => {
  it("kills a hung task at the local cap, whatever the origin's metadata says", async () => {
    const runner = createTestRunner({ settings: { task_timeout_s: 0.15 } });
    const view = runner.submit({ ...hangTask(), metadata: { pod: { task_ttl_s: 600 } } });
    const done = await waitForTerminal(runner, view.id);
    expect(done.status.state).toBe("failed");
    expect(done.status.reason).toBe("timeout");
    expect(textOf(done)).toBe("task ttl exceeded");
  });
});

describe("summary limits", () => {
  /** The inline summary cap (design.md 5.5). */
  const CAP = 32 * 1024;

  it("truncates a summary longer than 32 KiB", async () => {
    const runner = createTestRunner();
    const view = runner.submit(completedTask("x".repeat(40_000)));
    const done = await waitForTerminal(runner, view.id);
    expect(done.status.state).toBe("completed");
    const text = textOf(done);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CAP);
    expect(text).toContain(`[summary truncated at ${CAP} bytes]`);
  });

  it("truncates on a character boundary", async () => {
    const runner = createTestRunner();
    const view = runner.submit(completedTask("é".repeat(20_000)));
    const text = textOf(await waitForTerminal(runner, view.id));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(CAP);
    expect(text).not.toContain("�");
    expect(text.startsWith("éé")).toBe(true);
  });

  it("keeps a short summary intact", async () => {
    const runner = createTestRunner();
    const view = runner.submit(completedTask("short and sweet"));
    const done = await waitForTerminal(runner, view.id);
    expect(textOf(done)).toBe("short and sweet");
  });
});

describe("storage failures", () => {
  it("logs a store that cannot save and still ends the task, instead of crashing the node", async () => {
    const warnings: string[] = [];
    // The task table cannot be written: every save of the runner's table fails.
    const failing = vi.spyOn(JsonTable.prototype, "save").mockImplementation(() => {
      throw new Error("disk full");
    });
    const runner = createTestRunner({ logger: { warn: (text) => warnings.push(text) } });
    runner.submit(completedTask("fine"));

    // The task ends and gives the slot back although none of its changes could be stored.
    const deadline = Date.now() + 5_000;
    while (runner.busy() !== null && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(runner.busy()).toBeNull();
    expect(warnings.some((text) => text.includes("disk full"))).toBe(true);
    failing.mockRestore();
  });
});

describe("budget advertisement", () => {
  it("publishes max_task_ttl_s in the peer records", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-limits-"));
    const config = nodeParts({
      workgroup_id: WORKGROUP,
      workgroup_password: "pw",
      data_root: root,
      port: 0,
      task_timeout_s: 900,
    });
    const node = new Orca(...config, { executor: new ScriptExecutor() });
    await node.start();
    try {
      expect(node.mesh.self.view().max_task_ttl_s).toBe(900);

      const otherRoot = await mkdtemp(join(tmpdir(), "orca-limits-peer-"));
      const otherConfig = nodeParts({
        workgroup_id: WORKGROUP,
        workgroup_password: "pw",
        data_root: otherRoot,
        port: 0,
      });
      const other = new Orca(...otherConfig, { executor: new ScriptExecutor() });
      await other.start();
      try {
        await other.mesh.probe(node.mesh.self.endpoints[0]!);
        const peer = peersOf(node).find((candidate) => candidate.orca_node_id === other.mesh.self.id);
        expect(peer?.max_task_ttl_s).toBe(3600);
      } finally {
        await other.stop();
      }
    } finally {
      await node.stop();
    }
  });
});
