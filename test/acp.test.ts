import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { createOrcaNodeConfig, type OrcaNodeConfig } from "../src/node/config.ts";
import { permissionRequestOf, type PermissionMode, type TaskView } from "../src/protocol/protocol.ts";
import { createAcpExecutor } from "../src/execution/acp/executor.ts";
import type { ExecuteInput, ExecutorEvent } from "../src/execution/executor.ts";
import { connectAll } from "../src/node/harness.ts";
import { parseEchoScript } from "../src/execution/echo.ts";
import { createOrcaNode, createPersistentStorage, type OrcaNode } from "../src/node/orca-node.ts";

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const LIVE: OrcaNode[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
});

function configFor(root: string, mode: string, overrides: Partial<OrcaNodeConfig> = {}): OrcaNodeConfig {
  const config = createOrcaNodeConfig({
    workgroup_id: "acp-test",
    workgroup_password: "correct horse",
    data_root: root,
    port: 0,
    executor: "acp",
    acp: {
      command: process.execPath,
      extra_args: [FAKE_ACP, mode, join(root, "acp.log")],
      mcp_servers: [{ name: "probe", command: process.execPath, args: ["-e", ""] }],
    },
  });
  return { ...config, ...overrides };
}

function echoConfigFor(root: string): OrcaNodeConfig {
  return createOrcaNodeConfig({
    workgroup_id: "acp-test",
    workgroup_password: "correct horse",
    data_root: root,
    port: 0,
  });
}

async function startNode(config: OrcaNodeConfig): Promise<OrcaNode> {
  const node = createOrcaNode({ config, storage: createPersistentStorage(config) });
  await node.start();
  LIVE.push(node);
  return node;
}

async function send(
  node: OrcaNode,
  text: string,
  contextId = "ctx-1",
  permissionMode?: PermissionMode,
): Promise<TaskView> {
  return node.sendTask(node.endpoints[0]!, {
    message: { role: "user", parts: [{ kind: "text", text }], contextId },
    ...(permissionMode === undefined ? {} : { metadata: { pod: { permission_mode: permissionMode } } }),
  });
}

async function waitForState(
  node: OrcaNode,
  taskId: string,
  wanted: readonly string[],
  timeoutMs = 10_000,
): Promise<TaskView> {
  return waitForRemoteState(node, node.endpoints[0]!, taskId, wanted, timeoutMs);
}

async function waitForRemoteState(
  reader: OrcaNode,
  peerUrl: string,
  taskId: string,
  wanted: readonly string[],
  timeoutMs = 10_000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let view = await reader.getTask(peerUrl, taskId);
  while (!wanted.includes(view.status.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    view = await reader.getTask(peerUrl, taskId);
  }
  expect(wanted).toContain(view.status.state);
  return view;
}

type LogEntry = {
  method?: string;
  text?: string;
  cwd?: string;
  mcpServers?: number;
  configId?: string;
  value?: string;
  outcome?: string | null;
  optionId?: string | null;
};

async function logEntries(path: string): Promise<LogEntry[]> {
  const text = await readFile(path, "utf8").catch(() => "");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

async function waitForLog(path: string, predicate: (entry: LogEntry) => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await logEntries(path)).some(predicate)) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return false;
}

function taskText(view: TaskView): string {
  const part = view.status.message?.parts[0];
  return part !== undefined && part.kind === "text" ? part.text : "";
}

describe("AcpExecutor", () => {
  it("completes a task with the accumulated assistant text and runs in the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok"));
    const submitted = await send(node, "say hi");
    const view = await waitForState(node, submitted.id, ["completed"]);
    expect(taskText(view)).toBe("acp done");
    const entries = await logEntries(join(root, "acp.log"));
    const created = entries.find((entry) => entry.method === "session/new");
    expect(created?.cwd?.endsWith(join("workgroups", "acp-test"))).toBe(true);
    expect(created?.mcpServers).toBe(1);
    const promptText = entries.find((entry) => entry.method === "session/prompt")?.text ?? "";
    expect(promptText).toContain("say hi");
    // The preamble tells the ACP agent how to reach the CLI for delegation.
    expect(promptText).toContain("ORCA_POD_CLI");
    expect(promptText).toContain("--data-root");
    // A required peer going offline must end the task with a blocker report.
    expect(promptText).toContain("offline");
    expect(promptText).toContain("BLOCKED");
  }, 15_000);

  it("suspends for a permission request and continues after the origin approves", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "permission-fetch"));
    const submitted = await send(node, "write a file", "ctx-1", "workspace-write");
    const suspended = await waitForState(node, submitted.id, ["input-required"]);
    const request = permissionRequestOf(suspended);
    expect(request?.tool).toBe("write file");
    expect(request?.requested_by).toBe(node.orcaNodeId);

    await node.approveTask(node.endpoints[0]!, suspended);
    const done = await waitForState(node, submitted.id, ["completed"]);
    expect(taskText(done)).toContain("allowed");
  }, 15_000);

  it("answers a denied permission request so the child prompt does not hang", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "permission-fetch"));
    const submitted = await send(node, "write a file", "ctx-1", "workspace-write");
    const suspended = await waitForState(node, submitted.id, ["input-required"]);

    const denied = await node.denyTask(node.endpoints[0]!, suspended);
    expect(denied.status.state).toBe("failed");
    expect(denied.status.reason).toBe("permission_denied");

    const answered = await waitForLog(
      join(root, "acp.log"),
      (entry) => entry.method === "permission_response" && entry.outcome === "cancelled",
    );
    expect(answered).toBe(true);
  }, 15_000);

  it("cancels the ACP prompt when the task is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "hang"));
    const submitted = await send(node, "never finish");
    await waitForState(node, submitted.id, ["working"]);
    await node.cancelTask(node.endpoints[0]!, submitted.id);
    const view = await waitForState(node, submitted.id, ["canceled"]);
    expect(view.status.state).toBe("canceled");
    const cancelled = await waitForLog(join(root, "acp.log"), (entry) => entry.method === "session/cancel");
    expect(cancelled).toBe(true);
  }, 15_000);

  it("reuses one ACP session for the same origin + context", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok"));
    await waitForState(node, (await send(node, "first")).id, ["completed"]);
    await waitForState(node, (await send(node, "second")).id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    expect(entries.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
  }, 15_000);

  it("starts a fresh ACP connection after the child crashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "crash-once"));
    const first = await send(node, "crash me");
    await waitForState(node, first.id, ["failed"]);

    const second = await send(node, "survive");
    const completed = await waitForState(node, second.id, ["completed"]);
    expect(taskText(completed)).toBe("acp done");

    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.filter((entry) => entry.method === "initialize")).toHaveLength(2);
  }, 20_000);

  it("resumes the stored ACP session after the orca node restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const config = configFor(root, "ok");
    const first = await startNode(config);
    await waitForState(first, (await send(first, "before restart")).id, ["completed"]);
    await first.stop();

    const second = await startNode(config);
    await waitForState(second, (await send(second, "after restart")).id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.some((entry) => entry.method === "session/resume")).toBe(true);
  }, 20_000);

  it("starts a new session when the stored one is not found", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const config = configFor(root, "resume-fail");
    const first = await startNode(config);
    await waitForState(first, (await send(first, "before restart")).id, ["completed"]);
    await first.stop();

    const second = await startNode(config);
    await waitForState(second, (await send(second, "after restart")).id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.filter((entry) => entry.method === "session/new")).toHaveLength(2);
  }, 20_000);

  it("fails the task instead of overwriting a corrupt session store", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok"));
    const store = join(node.workspacePaths().state, "sessions.json");
    await writeFile(store, "{not json", "utf8");
    const view = await waitForState(node, (await send(node, "hi")).id, ["failed"]);
    expect(view.status.reason).toBe("executor_error");
    expect(await readFile(store, "utf8")).toBe("{not json");
  }, 15_000);

  it("selects the requested model on the ACP session before prompting", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok"));
    const submitted = await node.sendTask(node.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "use the requested model" }], contextId: "ctx-model" },
      metadata: { pod: { model: { provider: "deepseek", model: "deepseek-v4-pro" } } },
    });
    await waitForState(node, submitted.id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    const selected = entries.findIndex((entry) => entry.method === "session/set_config_option");
    const prompted = entries.findIndex((entry) => entry.method === "session/prompt");
    expect(selected).toBeGreaterThanOrEqual(0);
    expect(prompted).toBeGreaterThan(selected);
    const entry = entries[selected] as { configId?: string; value?: string };
    expect(entry.configId).toBe("model");
    expect(entry.value).toBe(JSON.stringify(["deepseek", "deepseek-v4-pro"]));
  }, 15_000);

  it("uses the node default reasoning effort when the task does not ask", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok", { default_reasoning_effort: "max" }));
    const submitted = await send(node, "use the node default effort");
    await waitForState(node, submitted.id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    const effort = entries.find(
      (entry) => entry.method === "session/set_config_option" && entry.configId === "reasoning_effort",
    );
    expect(effort?.value).toBe("max");
    expect(entries.some((entry) => entry.method === "session/set_config_option" && entry.configId === "model")).toBe(
      false,
    );
  }, 15_000);

  it("lets the task override the node default reasoning effort", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok", { default_reasoning_effort: "high" }));
    const submitted = await node.sendTask(node.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "use the requested effort" }], contextId: "ctx-effort" },
      metadata: { pod: { reasoning_effort: "max" } },
    });
    await waitForState(node, submitted.id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    const effort = entries.find(
      (entry) => entry.method === "session/set_config_option" && entry.configId === "reasoning_effort",
    );
    expect(effort?.value).toBe("max");
  }, 15_000);

  it("does not send a reasoning effort when neither the node nor the task sets one", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "ok"));
    const submitted = await send(node, "provider default effort");
    await waitForState(node, submitted.id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(
      entries.some((entry) => entry.method === "session/set_config_option" && entry.configId === "reasoning_effort"),
    ).toBe(false);
  }, 15_000);

  it("fails the task when the target rejects the requested model", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(configFor(root, "model-reject"));
    const submitted = await node.sendTask(node.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "unknown model" }], contextId: "ctx-model-fail" },
      metadata: { pod: { model: { provider: "deepseek", model: "nope" } } },
    });
    const view = await waitForState(node, submitted.id, ["failed"]);
    expect(view.status.reason).toBe("model_unavailable");
    expect(taskText(view)).toContain("cannot select model");
  }, 15_000);

  it("reports a spawn failure instead of hanging", async () => {
    const pod = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const executor = createAcpExecutor({ command: join(pod, "missing-acp"), profile: "acp" });
    const events: ExecutorEvent[] = [];
    const input: ExecuteInput = {
      taskId: "t1",
      contextId: "c1",
      prompt: "hi",
      originOrcaNode: "ORIGIN",
      selfOrcaNodeId: "SELF",
      workspaceDir: pod,
      podDir: join(pod, ".state"),
      permissionMode: "read-only",
      model: undefined,
      reasoningEffort: undefined,
      echo: parseEchoScript(undefined),
    };
    await expect(async () => {
      for await (const event of executor.run(input, new AbortController().signal)) events.push(event);
    }).rejects.toThrow("cannot start acp server");
    expect(events).toEqual([]);
  }, 15_000);
});

describe("AcpExecutor in a chain", () => {
  it("surfaces an ACP permission request through the relay chain and continues after the root approves", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "orca-acp-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "orca-acp-b-"));
    const rootC = await mkdtemp(join(tmpdir(), "orca-acp-c-"));
    const a = await startNode(echoConfigFor(rootA));
    const b = await startNode(echoConfigFor(rootB));
    const c = await startNode(configFor(rootC, "permission-fetch"));
    await connectAll([a, b, c]);

    // B (mid node) creates the child task on C; C's ACP agent asks for permission.
    const child = await b.sendTask(c.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "write a file" }], contextId: "ctx-child" },
      metadata: {
        pod: { hop: 1, chain: [b.orcaNodeId], root_origin: a.orcaNodeId, permission_mode: "workspace-write" },
      },
    });
    const childSuspended = await waitForRemoteState(b, c.endpoints[0]!, child.id, ["input-required"]);
    const childRequest = permissionRequestOf(childSuspended);
    expect(childRequest?.tool).toBe("write file");
    expect(childRequest?.requested_by).toBe(c.orcaNodeId);

    // A (root) starts B's parent task; B relays C's request upward instead of approving it itself.
    const parentScript = {
      steps: [
        {
          at_ms: 20,
          suspend: {
            kind: "permission",
            tool: childRequest?.tool ?? "write file",
            requested: childRequest?.requested ?? {},
            relay: { peer: c.endpoints[0]!, task_id: child.id, request: childRequest },
          },
        },
      ],
      final: { state: "completed", text: "parent done" },
    };
    const parent = await a.sendTask(b.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "delegate" }], contextId: "ctx-parent" },
      metadata: { echo: parentScript },
    });
    const parentSuspended = await waitForRemoteState(a, b.endpoints[0]!, parent.id, ["input-required"]);
    const parentRequest = permissionRequestOf(parentSuspended);
    expect(parentRequest?.requested_by).toBe(b.orcaNodeId);
    expect(parentRequest?.upstream).toEqual([c.orcaNodeId]);

    await a.approveTask(b.endpoints[0]!, parentSuspended);

    const childDone = await waitForRemoteState(b, c.endpoints[0]!, child.id, ["completed"]);
    expect(taskText(childDone)).toContain("allowed");
    const parentDone = await waitForRemoteState(a, b.endpoints[0]!, parent.id, ["completed"]);
    expect(taskText(parentDone)).toBe("parent done");
  }, 20_000);
});
