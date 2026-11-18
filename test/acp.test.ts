import { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { createOrcaNodeConfig, type OrcaNodeConfig } from "../src/node/config.ts";
import { permissionRequestOf, type TaskView } from "../src/task/wire.ts";
import type { AcpExecutorConfig } from "../src/executor/acp/config.ts";
import { AcpExecutor } from "../src/executor/acp/executor.ts";
import { ModelCatalog } from "../src/core/model-catalog.ts";
import type { ExecuteInput, ExecutorEvent } from "../src/executor/executor.ts";
import { parseEchoScript } from "../src/executor/echo.ts";
import { OrcaNode, createPersistentStorage } from "../src/node/orca-node.ts";
import { labelId, wg } from "./fixtures/ids.ts";

/** An ACP executor with the defaults of an empty model catalog and a silent logger. */
const acpExecutor = (config: AcpExecutorConfig) => new AcpExecutor(config, tmpdir(), new ModelCatalog(), { warn() {} });

const FAKE_ACP = fileURLToPath(new URL("./fixtures/fake-acp.mjs", import.meta.url));
const LIVE: OrcaNode[] = [];

afterEach(async () => {
  for (const node of LIVE.splice(0)) await node.stop();
});

async function configFor(root: string, mode: string, overrides: Partial<OrcaNodeConfig> = {}): Promise<OrcaNodeConfig> {
  const config = await createOrcaNodeConfig({
    workgroup_id: wg("acp-test"),
    workgroup_password: "correct horse",
    data_root: root,
    port: 0,
    executor: "acp",
    acp: {
      command: process.execPath,
      extra_args: [FAKE_ACP, mode, join(root, "acp.log")],
      mcp_servers: [
        { name: "probe", command: process.execPath, args: ["-e", ""], env: { PROBE_TOKEN: "t" } },
        { name: "bare", command: process.execPath },
      ],
    },
  });
  return { ...config, ...overrides };
}

async function startNode(config: OrcaNodeConfig): Promise<OrcaNode> {
  const node = new OrcaNode(config, { storage: createPersistentStorage(config) });
  await node.start();
  LIVE.push(node);
  return node;
}

async function send(
  node: OrcaNode,
  text: string,
  contextId = "ctx-1",
  permissionMode?: SandboxMode,
): Promise<TaskView> {
  return node.delegation.sendTask(node.profile.endpoints[0]!, {
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
  return waitForRemoteState(node, node.profile.endpoints[0]!, taskId, wanted, timeoutMs);
}

async function waitForRemoteState(
  reader: OrcaNode,
  peerUrl: string,
  taskId: string,
  wanted: readonly string[],
  timeoutMs = 10_000,
): Promise<TaskView> {
  const deadline = Date.now() + timeoutMs;
  let view = await reader.delegation.getTask(peerUrl, taskId);
  while (!wanted.includes(view.status.state) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    view = await reader.delegation.getTask(peerUrl, taskId);
  }
  expect(wanted).toContain(view.status.state);
  return view;
}

type LogEntry = {
  method?: string;
  inTask?: string;
  text?: string;
  cwd?: string;
  mcpServers?: unknown[];
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
    const node = await startNode(await configFor(root, "ok"));
    const submitted = await send(node, "say hi");
    const view = await waitForState(node, submitted.id, ["completed"]);
    expect(taskText(view)).toBe("acp done");
    const entries = await logEntries(join(root, "acp.log"));
    // The agent runs inside a task: the CLI and the plugin refuse to send from it (§7.9).
    expect(entries.find((entry) => entry.method === "initialize")?.inTask).toBe("1");
    const created = entries.find((entry) => entry.method === "session/new");
    expect(created?.cwd?.endsWith(join("workgroups", "acp-test"))).toBe(true);
    // ACP's McpServerStdio shape: args and env always present, env as name/value pairs.
    expect(created?.mcpServers).toEqual([
      { name: "probe", command: process.execPath, args: ["-e", ""], env: [{ name: "PROBE_TOKEN", value: "t" }] },
      { name: "bare", command: process.execPath, args: [], env: [] },
    ]);
    const promptText = entries.find((entry) => entry.method === "session/prompt")?.text ?? "";
    expect(promptText).toContain("say hi");
    // The preamble tells the ACP agent how to reach the CLI for files, and that it cannot delegate.
    expect(promptText).toContain("ORCA_POD_CLI");
    expect(promptText).toContain("single-hop");
    expect(promptText).not.toContain("--local-task");
    expect(promptText).toContain("--data-root");
    // A required peer going offline must end the task with a blocker report.
    expect(promptText).toContain("offline");
    expect(promptText).toContain("BLOCKED");
  }, 15_000);

  it("suspends for a permission request and continues after the origin approves", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "permission-fetch"));
    const submitted = await send(node, "write a file", "ctx-1", "workspace-write");
    const suspended = await waitForState(node, submitted.id, ["input-required"]);
    const request = permissionRequestOf(suspended);
    expect(request?.tool).toBe("write file");
    expect(request?.requested_by).toBe(node.orcaNodeId);

    await node.delegation.approveTask(node.profile.endpoints[0]!, suspended);
    const done = await waitForState(node, submitted.id, ["completed"]);
    expect(taskText(done)).toContain("allowed");
  }, 15_000);

  it("answers a denied permission request so the child prompt does not hang", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "permission-fetch"));
    const submitted = await send(node, "write a file", "ctx-1", "workspace-write");
    const suspended = await waitForState(node, submitted.id, ["input-required"]);

    const denied = await node.delegation.denyTask(node.profile.endpoints[0]!, suspended);
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
    const node = await startNode(await configFor(root, "hang"));
    const submitted = await send(node, "never finish");
    await waitForState(node, submitted.id, ["working"]);
    await node.delegation.cancelTask(node.profile.endpoints[0]!, submitted.id);
    const view = await waitForState(node, submitted.id, ["canceled"]);
    expect(view.status.state).toBe("canceled");
    const cancelled = await waitForLog(join(root, "acp.log"), (entry) => entry.method === "session/cancel");
    expect(cancelled).toBe(true);
  }, 15_000);

  it("reuses one ACP session for the same origin + context", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "ok"));
    await waitForState(node, (await send(node, "first")).id, ["completed"]);
    await waitForState(node, (await send(node, "second")).id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.filter((entry) => entry.method === "session/new")).toHaveLength(1);
    expect(entries.filter((entry) => entry.method === "session/prompt")).toHaveLength(2);
  }, 15_000);

  it("starts a fresh ACP connection after the child crashes", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "crash-once"));
    const first = await send(node, "crash me");
    const crashed = await waitForState(node, first.id, ["failed"]);
    // The pending prompt learns how the child ended, not just that the connection closed.
    expect(taskText(crashed)).toMatch(/acp server exited \(code 1\): fake-acp: crashing on purpose/);

    const second = await send(node, "survive");
    const completed = await waitForState(node, second.id, ["completed"]);
    expect(taskText(completed)).toBe("acp done");

    const entries = await logEntries(join(root, "acp.log"));
    expect(entries.filter((entry) => entry.method === "initialize")).toHaveLength(2);
  }, 20_000);

  it("resumes the stored ACP session after the orca node restarts", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const config = await configFor(root, "ok");
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
    const config = await configFor(root, "resume-fail");
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
    const node = await startNode(await configFor(root, "ok"));
    const store = join(node.workspace.state, "sessions.json");
    await writeFile(store, "{not json", "utf8");
    const view = await waitForState(node, (await send(node, "hi")).id, ["failed"]);
    expect(view.status.reason).toBe("executor_error");
    expect(await readFile(store, "utf8")).toBe("{not json");
  }, 15_000);

  it("selects the requested model on the ACP session before prompting", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "ok"));
    const submitted = await node.delegation.sendTask(node.profile.endpoints[0]!, {
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
    const node = await startNode(await configFor(root, "ok", { default_reasoning_effort: ReasoningEffortId("max") }));
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
    const node = await startNode(await configFor(root, "ok", { default_reasoning_effort: ReasoningEffortId("high") }));
    const submitted = await node.delegation.sendTask(node.profile.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "use the requested effort" }], contextId: "ctx-effort" },
      metadata: { pod: { reasoning_effort: ReasoningEffortId("max") } },
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
    const node = await startNode(await configFor(root, "ok"));
    const submitted = await send(node, "provider default effort");
    await waitForState(node, submitted.id, ["completed"]);
    const entries = await logEntries(join(root, "acp.log"));
    expect(
      entries.some((entry) => entry.method === "session/set_config_option" && entry.configId === "reasoning_effort"),
    ).toBe(false);
  }, 15_000);

  it("fails the task when the target rejects the requested model", async () => {
    const root = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const node = await startNode(await configFor(root, "model-reject"));
    const submitted = await node.delegation.sendTask(node.profile.endpoints[0]!, {
      message: { role: "user", parts: [{ kind: "text", text: "unknown model" }], contextId: "ctx-model-fail" },
      metadata: { pod: { model: { provider: "deepseek", model: "nope" } } },
    });
    const view = await waitForState(node, submitted.id, ["failed"]);
    expect(view.status.reason).toBe("model_unavailable");
    expect(taskText(view)).toContain("cannot select model");
  }, 15_000);

  it("reports a spawn failure instead of hanging", async () => {
    const pod = await mkdtemp(join(tmpdir(), "orca-acp-"));
    const executor = acpExecutor({ command: join(pod, "missing-acp"), profile: "acp" });
    const events: ExecutorEvent[] = [];
    const input: ExecuteInput = {
      taskId: "t1",
      contextId: "c1",
      prompt: "hi",
      originOrcaNode: labelId("ORIGIN"),
      selfOrcaNodeId: labelId("SELF"),
      workspaceDir: pod,
      podDir: join(pod, ".state"),
      permissionMode: "read-only",
      permissionCeiling: undefined,
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
