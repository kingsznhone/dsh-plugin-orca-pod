import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createAcpExecutor } from "../src/execution/acp/executor.ts";
import { childPodMetadata } from "../src/tasks/delegation.ts";
import { parseEchoScript } from "../src/execution/echo.ts";
import { createOrcaNodeConfig } from "../src/node/config.ts";
import { parsePodMetadata } from "../src/tasks/meta.ts";
import type { ExecuteInput, ExecutorEvent } from "../src/execution/executor.ts";
import { createOrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import { narrowPermissionMode, permissionModeRank } from "../src/protocol/permission.ts";
import type { PodTaskMetadata } from "../src/protocol/task.ts";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));

async function collect(stream: AsyncGenerator<ExecutorEvent, void, void>): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-mode-"));
  await mkdir(join(root, ".state"), { recursive: true });
  return root;
}

function input(root: string, overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    permissionMode: "read-only",
    taskId: "task-1",
    contextId: "context-1",
    originOrcaNode: "ORIGIN",
    selfOrcaNodeId: "SELF",
    prompt: "do it",
    workspaceDir: root,
    podDir: join(root, ".state"),
    model: undefined,
    reasoningEffort: undefined,
    echo: parseEchoScript(undefined),
    ...overrides,
  };
}

function taskText(view: Awaited<ReturnType<ReturnType<typeof createOrcaNode>["getTask"]>>): string {
  return (view.status.message?.parts ?? []).map((part) => (part.kind === "text" ? part.text : "")).join("");
}

describe("permission modes", () => {
  it("ranks modes and keeps the narrower one", () => {
    expect(permissionModeRank("read-only")).toBeLessThan(permissionModeRank("workspace-write"));
    expect(permissionModeRank("workspace-write")).toBeLessThan(permissionModeRank("danger-full-access"));
    expect(narrowPermissionMode("danger-full-access", "read-only")).toBe("read-only");
    expect(narrowPermissionMode("read-only", "workspace-write")).toBe("read-only");
    expect(narrowPermissionMode("workspace-write", "workspace-write")).toBe("workspace-write");
  });

  it("validates and normalizes pod.permission_mode", () => {
    const metadata = { pod: { hop: 0, chain: [], permission_mode: "workspace-write" } };
    expect(parsePodMetadata(metadata, "B", "A")).toMatchObject({ permissionMode: "workspace-write" });
    expect(parsePodMetadata(undefined, "B", "A").permissionMode).toBe("read-only");
    expect(() => parsePodMetadata({ pod: { permission_mode: "root" } }, "B", "A")).toThrowError(/permission_mode/);
  });

  it("child tasks inherit the parent's permission mode", () => {
    const parent: PodTaskMetadata = { hop: 0, chain: ["A"], root: "t_root", permission_mode: "read-only" };
    expect(childPodMetadata(parent, "t_parent", "B")).toMatchObject({
      permission_mode: "read-only",
      hop: 1,
      chain: ["A", "B"],
    });
    expect(childPodMetadata(undefined, "t_parent", "B")).toMatchObject({ hop: 1 });
  });
});

describe("permission mode execution", () => {
  it("acp auto-denies writes when the inherited mode is read-only", async () => {
    const root = await tempDir();
    const executor = createAcpExecutor({
      command: process.execPath,
      extra_args: [FAKE_ACP, "permission", join(root, "acp.log")],
    });
    const events = await collect(
      executor.run(input(root, { permissionMode: "read-only" }), new AbortController().signal),
    );
    expect(events.map((event) => event.type)).not.toContain("suspend");
    expect(events.at(-1)).toEqual({ type: "completed", text: "acp donedenied" });
    executor.close?.();
  });

  it("acp auto-allows writes when the inherited mode is workspace-write", async () => {
    const root = await tempDir();
    const executor = createAcpExecutor({
      command: process.execPath,
      extra_args: [FAKE_ACP, "permission", join(root, "acp.log")],
    });
    const events = await collect(
      executor.run(input(root, { permissionMode: "workspace-write" }), new AbortController().signal),
    );
    expect(events.map((event) => event.type)).not.toContain("suspend");
    expect(events.at(-1)).toEqual({ type: "completed", text: "acp doneallowed" });
    executor.close?.();
  });

  it("acp suspends a request outside workspace-write for the origin to decide", async () => {
    const root = await tempDir();
    const executor = createAcpExecutor({
      command: process.execPath,
      extra_args: [FAKE_ACP, "permission-fetch", join(root, "acp.log")],
    });
    const events = await collect(
      executor.run(input(root, { permissionMode: "workspace-write" }), new AbortController().signal),
    );
    expect(events[0]).toMatchObject({ type: "suspend", suspend: { kind: "permission" } });
    executor.close?.();
  });

  it("runs a task that names no mode read-only", async () => {
    const root = await tempDir();
    const config = createOrcaNodeConfig({
      workgroup_id: "orca-mode",
      workgroup_password: "correct horse",
      data_root: root,
      port: 0,
      executor: "acp",
      acp: { command: process.execPath, extra_args: [FAKE_ACP, "permission", join(root, "acp.log")] },
    });
    const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    await node.start();
    try {
      const view = await node.sendTask(node.endpoints[0]!, {
        message: { role: "user", parts: [{ kind: "text", text: "do it" }] },
      });
      let current = view;
      for (let i = 0; i < 100; i += 1) {
        current = await node.getTask(node.endpoints[0]!, view.id);
        if (current.status.state === "completed" || current.status.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(current.status.state).toBe("completed");
      expect(taskText(current)).toContain("acp donedenied");
    } finally {
      await node.stop();
    }
  });

  it("narrows the origin mode by the local ceiling end to end", async () => {
    const root = await tempDir();
    const config = createOrcaNodeConfig({
      workgroup_id: "orca-mode",
      workgroup_password: "correct horse",
      data_root: root,
      port: 0,
      executor: "acp",
      acp: { command: process.execPath, extra_args: [FAKE_ACP, "permission", join(root, "acp.log")] },
      permission_mode: "read-only",
    });
    const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
    await node.start();
    try {
      const view = await node.sendTask(node.endpoints[0]!, {
        message: { role: "user", parts: [{ kind: "text", text: "do it" }] },
        metadata: { pod: { permission_mode: "danger-full-access" } },
      });
      let current = view;
      for (let i = 0; i < 100; i += 1) {
        current = await node.getTask(node.endpoints[0]!, view.id);
        if (current.status.state === "completed" || current.status.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(current.status.state).toBe("completed");
      expect(taskText(current)).toContain("acp donedenied");
    } finally {
      await node.stop();
    }
  });
});
