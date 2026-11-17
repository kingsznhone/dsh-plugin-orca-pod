/**
 * Budget and summary limits (§6.9): a task's hard TTL is the local cap, the
 * summary is truncated to result_max_bytes, and both the cap and usage are
 * visible/recorded so an origin can size its delegations.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createOrcaNodeConfig } from "../src/node/config.ts";
import { createOrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import { isTerminal, type TaskView } from "../src/protocol/task.ts";
import { createTestRunner } from "./fixtures/runner.ts";

const WORKGROUP = "orca-limits";

function hangTask() {
  return {
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: "wait" }] },
    metadata: { echo: { final: { state: "hang" as const, text: "" } } },
  };
}

function completedTask(text: string) {
  return {
    message: { role: "user" as const, parts: [{ kind: "text" as const, text: "go" }] },
    metadata: { echo: { final: { state: "completed" as const, text } } },
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
  it("kills a hung task at the local cap even when the origin asked for longer", async () => {
    const runner = createTestRunner({ taskTimeoutS: 0.15 });
    const view = runner.submit({
      ...hangTask(),
      metadata: { echo: { final: { state: "hang", text: "" } }, pod: { task_ttl_s: 600 } },
    });
    const done = await waitForTerminal(runner, view.id);
    expect(done.status.state).toBe("failed");
    expect(done.status.reason).toBe("timeout");
    expect(textOf(done)).toBe("task ttl exceeded");
  });

  it("uses the local cap when the origin sends no ttl", async () => {
    const runner = createTestRunner({ taskTimeoutS: 0.1 });
    const view = runner.submit(hangTask());
    const done = await waitForTerminal(runner, view.id);
    expect(done.status.reason).toBe("timeout");
  });
});

describe("summary limits", () => {
  it("truncates a summary longer than result_max_bytes", async () => {
    const runner = createTestRunner({ resultMaxBytes: 64 });
    const view = runner.submit(completedTask("x".repeat(200)));
    const done = await waitForTerminal(runner, view.id);
    expect(done.status.state).toBe("completed");
    const text = textOf(done);
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64);
    expect(text).toContain("[summary truncated at 64 bytes]");
  });

  it("truncates on a character boundary", async () => {
    const runner = createTestRunner({ resultMaxBytes: 64 });
    const view = runner.submit(completedTask("é".repeat(200)));
    const text = textOf(await waitForTerminal(runner, view.id));
    expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(64);
    expect(text).not.toContain("�");
    expect(text.startsWith("éé")).toBe(true);
  });

  it("keeps a short summary intact", async () => {
    const runner = createTestRunner({ resultMaxBytes: 1024 });
    const view = runner.submit(completedTask("short and sweet"));
    const done = await waitForTerminal(runner, view.id);
    expect(textOf(done)).toBe("short and sweet");
  });
});

describe("storage failures", () => {
  it("logs a store that cannot save and still ends the task, instead of crashing the node", async () => {
    const warnings: string[] = [];
    const seen: TaskView[] = [];
    const runner = createTestRunner({
      store: {
        save() {
          throw new Error("disk full");
        },
        load: () => undefined,
        list: () => [],
        close() {},
      },
      logger: { warn: (text) => warnings.push(text) },
      onEvent: (view) => seen.push(view),
    });
    runner.submit(completedTask("fine"));

    const deadline = Date.now() + 5_000;
    while (!seen.some((view) => view.status.state === "completed") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(seen.at(-1)?.status.state).toBe("completed");
    expect(warnings.some((text) => text.includes("disk full"))).toBe(true);
    expect(runner.busy()).toBeNull();
  });
});

describe("budget advertisement", () => {
  it("publishes max_task_ttl_s in the agent card and peer records", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-limits-"));
    const config = createOrcaNodeConfig({
      workgroup_id: WORKGROUP,
      workgroup_password: "pw",
      data_root: root,
      port: 0,
      task_timeout_s: 900,
    });
    const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    await node.start();
    try {
      const card = (await (await fetch(`${node.endpoints[0]!}/.well-known/agent-card.json`)).json()) as {
        max_task_ttl_s?: number;
      };
      expect(card.max_task_ttl_s).toBe(900);

      const otherRoot = await mkdtemp(join(tmpdir(), "orca-limits-peer-"));
      const otherConfig = createOrcaNodeConfig({
        workgroup_id: WORKGROUP,
        workgroup_password: "pw",
        data_root: otherRoot,
        port: 0,
      });
      const other = createOrcaNode({ config: otherConfig, storage: createPersistentStorage(otherConfig) });
      await other.start();
      try {
        await other.join(node.endpoints[0]!);
        const peer = node.members().find((candidate) => candidate.orca_node_id === other.orcaNodeId);
        expect(peer?.max_task_ttl_s).toBe(3600);
      } finally {
        await other.stop();
      }
    } finally {
      await node.stop();
    }
  });
});
