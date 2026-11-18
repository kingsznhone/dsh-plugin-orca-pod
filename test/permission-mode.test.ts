import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createAcpExecutor } from "../src/executor/acp/executor.ts";
import { parseEchoScript } from "../src/executor/echo.ts";
import { createOrcaNodeConfig } from "../src/node/config.ts";
import { parsePodMetadata } from "../src/task/meta.ts";
import { parseSchema } from "../src/core/schema.ts";
import { permissionRequestOf, TaskMetadataSchema } from "../src/task/wire.ts";
import type { ExecuteInput, ExecutorEvent } from "../src/executor/executor.ts";
import { createOrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import { narrowPermissionMode } from "../src/core/wire/permission.ts";
import { escalationFor, modeAllows } from "../src/executor/acp/permissions.ts";
import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { labelId, wg } from "./fixtures/ids.ts";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));

/** Every event of a run; each suspension is answered with the mode it asked for (an approval). */
async function collect(stream: AsyncGenerator<ExecutorEvent, void, SandboxMode | undefined>): Promise<ExecutorEvent[]> {
  const events: ExecutorEvent[] = [];
  let answer: SandboxMode | undefined;
  for (;;) {
    const step = await stream.next(answer);
    if (step.done) return events;
    events.push(step.value);
    answer = step.value.type === "suspend" ? step.value.suspend.requestedMode : undefined;
  }
}

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "orca-mode-"));
  await mkdir(join(root, ".state"), { recursive: true });
  return root;
}

function input(root: string, overrides: Partial<ExecuteInput> = {}): ExecuteInput {
  return {
    permissionMode: "read-only",
    permissionCeiling: undefined,
    taskId: "task-1",
    contextId: "context-1",
    originOrcaNode: labelId("ORIGIN"),
    selfOrcaNodeId: labelId("SELF"),
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
  it("keeps the narrower mode, by DSH's escalation ladder", () => {
    expect(narrowPermissionMode("danger-full-access", "read-only")).toBe("read-only");
    expect(narrowPermissionMode("read-only", "workspace-write")).toBe("read-only");
    expect(narrowPermissionMode("workspace-write", "workspace-write")).toBe("workspace-write");
  });

  it("asks for the narrowest wider mode that allows a call, within the local ceiling", () => {
    expect(modeAllows("read-only", "read")).toBe(true);
    expect(modeAllows("read-only", "edit")).toBe(false);
    expect(escalationFor("read-only", undefined, "edit")).toBe("workspace-write");
    expect(escalationFor("read-only", undefined, "fetch")).toBe("danger-full-access");
    expect(escalationFor("workspace-write", undefined, "fetch")).toBe("danger-full-access");
    // Past the node's own ceiling nobody may allow it.
    expect(escalationFor("read-only", "read-only", "edit")).toBeNull();
    expect(escalationFor("read-only", "workspace-write", "fetch")).toBeNull();
    expect(escalationFor("read-only", "workspace-write", "edit")).toBe("workspace-write");
  });

  it("validates and normalizes pod.permission_mode", () => {
    const metadata = parseSchema(TaskMetadataSchema, { pod: { permission_mode: "workspace-write" } });
    expect(metadata.ok && parsePodMetadata(metadata.value)).toMatchObject({ permissionMode: "workspace-write" });
    expect(parsePodMetadata(undefined).permissionMode).toBe("read-only");
    // An unknown mode never reaches the runner: the wire schema refuses it.
    const refused = parseSchema(TaskMetadataSchema, { pod: { permission_mode: "root" } });
    expect(refused.ok ? "" : refused.issue.path.join(".")).toBe("pod.permission_mode");
  });
});

describe("permission mode execution", () => {
  it("acp refuses a write without asking when the local ceiling is read-only", async () => {
    const root = await tempDir();
    const executor = createAcpExecutor({
      command: process.execPath,
      extra_args: [FAKE_ACP, "permission", join(root, "acp.log")],
    });
    const events = await collect(
      executor.run(
        input(root, { permissionMode: "read-only", permissionCeiling: "read-only" }),
        new AbortController().signal,
      ),
    );
    expect(events.map((event) => event.type)).not.toContain("suspend");
    expect(events.at(-1)).toEqual({ type: "completed", text: "acp donedenied" });
    executor.close?.();
  });

  it("acp asks once to upgrade a read-only task, then runs the rest of it in the granted mode", async () => {
    const root = await tempDir();
    const executor = createAcpExecutor({
      command: process.execPath,
      extra_args: [FAKE_ACP, "permission-twice", join(root, "acp.log")],
    });
    const events = await collect(
      executor.run(input(root, { permissionMode: "read-only" }), new AbortController().signal),
    );
    // One upgrade request covers both edits: the second is allowed without asking.
    const suspends = events.filter((event) => event.type === "suspend");
    expect(suspends).toHaveLength(1);
    expect(suspends[0]).toMatchObject({ suspend: { requestedMode: "workspace-write" } });
    expect(events.at(-1)).toEqual({ type: "completed", text: "acp doneallowedallowed" });
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

  it("runs a task that names no mode read-only, so a write asks for an upgrade", async () => {
    const root = await tempDir();
    const config = await createOrcaNodeConfig({
      workgroup_id: wg("orca-mode"),
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
        if (current.status.state === "input-required" || current.status.state === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(current.status.state).toBe("input-required");
      expect(permissionRequestOf(current)).toMatchObject({
        current_mode: "read-only",
        requested_mode: "workspace-write",
      });
      await node.cancelTask(node.endpoints[0]!, view.id);
    } finally {
      await node.stop();
    }
  });

  it("narrows the origin mode by the local ceiling end to end", async () => {
    const root = await tempDir();
    const config = await createOrcaNodeConfig({
      workgroup_id: wg("orca-mode"),
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
