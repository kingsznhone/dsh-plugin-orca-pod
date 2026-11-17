import { describe, expect, it } from "vitest";

import { parseSettings } from "../src/node/settings.ts";
import type { DispatchEntry } from "../src/storage/stores.ts";
import { createApprovalBroker } from "../src/plugin/broker.ts";
import type { Logger } from "@deepseek-ai/cordis";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ToolExecution, ToolRunContext } from "@deepseek-ai/dsh-tools";
import type { PodHandle } from "../src/plugin/lifecycle.ts";
import type { TaskView } from "../src/protocol/task.ts";
import { createPodTools, sessionSandboxMode, type SandboxReader } from "../src/plugin/tools.ts";
import type { TrackerAgent } from "../src/plugin/tracker.ts";
import { createTracker as createTrackerWith, restoreTrackedDispatches } from "../src/plugin/tracker.ts";
import * as plugin from "../src/plugin/bundle.ts";

const logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

function createTracker(
  getNode: () => { getTask(peer: string, taskId: string): Promise<TaskView> } | null,
  options: { intervalMs?: number; coalesceMs?: number },
) {
  return createTrackerWith(
    () => {
      const node = getNode();
      return node === null ? null : { annotateDispatch() {}, nodeIdOf: () => undefined, ...node };
    },
    createApprovalBroker(() => null),
    logger,
    options,
  );
}

function tool(result: ReturnType<typeof createPodTools>) {
  const found = result.find((candidate) => candidate.name === "orca_pod");
  if (found === undefined) throw new Error("missing tool orca_pod");
  return found;
}

/** The host always supplies a run context; tests default it for argument-validation cases. */
function run(tools: ReturnType<typeof createPodTools>, args: unknown, exec: Record<string, unknown> = {}) {
  const { execute } = tool(tools);
  return execute(args, exec as unknown as ToolRunContext);
}

describe("plugin config", () => {
  it("applies defaults and keeps optional fields absent", () => {
    const config = parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" });
    expect(config).toEqual({
      workgroup_id: "wg-a",
      workgroup_password: "pw",
      bind_host: "127.0.0.1",
      port: 11811,
      endpoints: [],
      skill_injection: false,
      peers: [],
      max_workspace_bytes: 5 * 1024 ** 3,
      max_workspace_files: 50_000,
    });
  });

  it("keeps explicit values", () => {
    const config = parseSettings({
      workgroup_id: "wg-a",
      workgroup_password: "pw",
      display_name: "pod-a",
      port: 0,
      endpoints: ["http://127.0.0.1:9000"],
      data_root: "/tmp/orca",
      peers: ["http://127.0.0.1:11811"],
    });
    expect(config.port).toBe(0);
    expect(config.display_name).toBe("pod-a");
    expect(config.endpoints).toEqual(["http://127.0.0.1:9000"]);
    expect(config.data_root).toBe("/tmp/orca");
    expect(config.peers).toEqual(["http://127.0.0.1:11811"]);
  });

  it("allows starting without a workgroup so the panel can run its wizard", () => {
    expect(parseSettings({})).toEqual({
      workgroup_password: "",
      bind_host: "127.0.0.1",
      port: 11811,
      endpoints: [],
      skill_injection: false,
      peers: [],
      max_workspace_bytes: 5 * 1024 ** 3,
      max_workspace_files: 50_000,
    });
  });

  it("rejects an invalid workgroup id", () => {
    expect(() => parseSettings({ workgroup_id: "Bad ID", workgroup_password: "pw" })).toThrow(/workgroup_id/);
  });

  it("rejects malformed peers", () => {
    expect(() =>
      parseSettings({
        workgroup_id: "wg-a",
        workgroup_password: "pw",
        peers: ["not a url"],
      }),
    ).toThrow(/peers/);
  });

  it("exposes the config as a Standard Schema", () => {
    const schema = plugin.Config["~standard"];
    expect(schema.version).toBe(1);
    const ok = schema.validate({ workgroup_id: "wg-a", workgroup_password_ref: "MY_ORCA_PASSWORD" });
    expect("value" in ok).toBe(true);
    const bad = schema.validate({ workgroup_id: "Bad ID" });
    expect("issues" in bad && (bad.issues?.length ?? 0) > 0).toBe(true);
  });

  it("declares the tool registry, credential store and config editor as hard dependencies", () => {
    expect(plugin.inject).toEqual(["tools", "credentials", "configEditor"]);
  });

  it("refuses a plaintext workgroup password in the plugin config", () => {
    const result = plugin.Config["~standard"].validate({ workgroup_id: "wg-a", workgroup_password: "secret" });
    expect(result).toMatchObject({ issues: [{ path: ["workgroup_password"] }] });
    expect(plugin.Config["~standard"].validate({ workgroup_id: "wg-a" })).toHaveProperty("value");
  });
});

describe("orca_pod tool", () => {
  const handle: PodHandle = {
    ready: Promise.resolve(),
    runtime: { orcaNode: null, url: null, port: null, started_at: null, error: null },
    config: parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" }),
    configured: true,
    rememberedPeers: [],
    adopt: async () => {},
    reconfigure: async () => {},
    addPeer: async () => {},
    disconnect: async () => {},
    reset: async () => {},
    dispose: async () => {},
  };
  const tracker = createTracker(() => null, { intervalMs: 60_000 });
  const tools = createPodTools(handle, tracker);

  it("registers exactly one orca_pod tool", () => {
    expect(tools.map((candidate) => candidate.name)).toEqual(["orca_pod"]);
  });

  it("documents the methods and asynchronous remote execution", () => {
    const description = tool(tools).description;
    for (const method of ["send", "status", "cancel", "members", "connect"]) {
      expect(description).toContain(method);
    }
    expect(description).not.toContain("§");
    expect(description).toContain("asynchronously");
    expect(description).toContain("task_id");
  });

  it("renders results as JSON text", () => {
    const blocks = tool(tools).output.render({}, { self: { orca_node_id: "abc" } });
    expect(blocks).toEqual([{ type: "text", text: JSON.stringify({ self: { orca_node_id: "abc" } }, null, 2) }]);
  });

  it("requires a known method", async () => {
    await expect(run(tools, {})).rejects.toThrow(/method/);
    await expect(run(tools, { method: "nope" })).rejects.toThrow(/method must be one of/);
  });

  it("validates each method's arguments before touching the orca node", async () => {
    await expect(run(tools, { method: "send" })).rejects.toThrow(/peer/);
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1" })).rejects.toThrow(/text/);
    await expect(run(tools, { method: "status", peer: "http://127.0.0.1:1" })).rejects.toThrow(/task_id/);
    await expect(run(tools, { method: "cancel", peer: "http://127.0.0.1:1" })).rejects.toThrow(/task_id/);
    await expect(run(tools, { method: "connect" })).rejects.toThrow(/peer/);
    await expect(run(tools, { method: "connect", peer: "not a url" })).rejects.toThrow(/http/);
  });

  it("rejects a malformed model selector before touching the orca node", async () => {
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1", text: "hi", model: "nope" })).rejects.toThrow(
      /provider\/model/,
    );
  });

  it("fails clearly when the orca node is not running", async () => {
    await expect(run(tools, { method: "send", peer: "http://127.0.0.1:1", text: "hi" })).rejects.toThrow(
      /orca node is not running/,
    );
    await expect(run(tools, { method: "members" })).rejects.toThrow(/orca node is not running/);
    await expect(run(tools, { method: "connect", peer: "127.0.0.1:11811" })).rejects.toThrow(
      /orca node is not running/,
    );
  });

  it("inherits the dispatching session's permission mode when send omits one", async () => {
    const sent: unknown[] = [];
    const fakeNode = {
      sendTask: async (_peer: string, input: unknown) => {
        sent.push(input);
        return { id: "task-1", status: { state: "submitted" } };
      },
    } as unknown as import("../src/node/orca-node.ts").OrcaNode;
    const handleForSend = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" }),
      configured: true,
      rememberedPeers: [],
      adopt: async () => {},
      reconfigure: async () => {},
      addPeer: async () => {},
      disconnect: async () => {},
      reset: async () => {},
      dispose: async () => {},
    } as unknown as PodHandle;
    const session = {};
    const sandbox = { resolve: () => ({ mode: "workspace-write" }) } as unknown as SandboxReader;
    const sendTools = createPodTools(handleForSend, tracker, () => sandbox);
    const agent = {
      id: "session-1",
      status: "running" as const,
      session,
      inject: () => {},
      followup: () => {},
    };
    await run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { agent });
    const inherited = sent[0] as { metadata?: { pod?: Record<string, unknown> } };
    expect(inherited.metadata?.pod?.permission_mode).toBe("workspace-write");

    await run(
      sendTools,
      { method: "send", peer: "http://127.0.0.1:11811", text: "hi", permission_mode: "read-only" },
      { agent },
    );
    const explicit = sent[1] as { metadata?: { pod?: Record<string, unknown> } };
    expect(explicit.metadata?.pod?.permission_mode).toBe("read-only");
  });

  it("forwards the caller's abort signal and cancels a task accepted after the turn was cancelled", async () => {
    const controller = new AbortController();
    const signals: Array<AbortSignal | undefined> = [];
    const cancelled: string[] = [];
    const fakeNode = {
      sendTask: async (_peer: string, _input: unknown, options?: { signal?: AbortSignal }) => {
        signals.push(options?.signal);
        // The remote accepts, but the user cancels the turn before the reply lands.
        controller.abort();
        return { id: "task-late", status: { state: "submitted" } };
      },
      cancelTask: async (_peer: string, taskId: string) => {
        cancelled.push(taskId);
        return { id: taskId, status: { state: "canceled" } };
      },
    } as unknown as import("../src/node/orca-node.ts").OrcaNode;
    const handleForSend = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" }),
    } as unknown as PodHandle;
    const watched: string[] = [];
    const recorder = { track: (_agent: unknown, _peer: string, taskId: string) => watched.push(taskId) > 0 };
    const sendTools = createPodTools(handleForSend, recorder as unknown as typeof tracker);
    const agent = { id: "session-1", status: "running" as const, inject: () => {}, followup: () => {} };
    await expect(
      run(
        sendTools,
        { method: "send", peer: "http://127.0.0.1:11811", text: "hi" },
        { agent, signal: controller.signal },
      ),
    ).rejects.toThrow(/cancelled by the caller/);
    expect(signals[0]).toBe(controller.signal);
    await new Promise((resolve) => setImmediate(resolve));
    expect(cancelled).toEqual(["task-late"]);
    expect(watched).toEqual([]);
  });

  it("does not dispatch at all when the turn is already cancelled", async () => {
    let sent = 0;
    const fakeNode = {
      sendTask: async () => {
        sent += 1;
        return { id: "never", status: { state: "submitted" } };
      },
    } as unknown as import("../src/node/orca-node.ts").OrcaNode;
    const handleForSend = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" }),
    } as unknown as PodHandle;
    const sendTools = createPodTools(handleForSend, tracker);
    await expect(
      run(sendTools, { method: "send", peer: "http://127.0.0.1:11811", text: "hi" }, { signal: AbortSignal.abort() }),
    ).rejects.toThrow(/cancelled by the caller/);
    expect(sent).toBe(0);
  });

  it("reads sandbox modes from the session's sandbox policy", () => {
    const session = {};
    const agent = {
      id: "session-1",
      status: "running" as const,
      session,
      inject: () => {},
      followup: () => {},
    };
    /** The policy service the host exposes as `ctx.sandboxPolicy`. */
    const policy = { resolve: () => ({ mode: "danger-full-access" }) } as unknown as SandboxReader;
    expect(sessionSandboxMode(policy, { agent } as unknown as ToolExecution)).toBe("danger-full-access");
    expect(sessionSandboxMode(undefined, { agent } as unknown as ToolExecution)).toBeUndefined();
    expect(sessionSandboxMode(policy, undefined)).toBeUndefined();
    expect(sessionSandboxMode(policy, { agent: {} } as unknown as ToolExecution)).toBeUndefined();
  });

  it("joins a peer and returns the refreshed members", async () => {
    const seen: string[] = [];
    const fakeNode = {
      members: () => [],
      membersDigest: () => "digest",
    } as unknown as import("../src/node/orca-node.ts").OrcaNode;
    const handleForConnect = {
      ready: Promise.resolve(),
      runtime: { orcaNode: fakeNode, url: null, port: null, started_at: null, error: null },
      config: parseSettings({ workgroup_id: "wg-a", workgroup_password: "pw" }),
      configured: true,
      rememberedPeers: [],
      adopt: async () => {},
      reconfigure: async () => {},
      addPeer: async (peer: string) => {
        seen.push(peer);
      },
      disconnect: async () => {},
      reset: async () => {},
      dispose: async () => {},
    } as unknown as PodHandle;
    const connectTools = createPodTools(handleForConnect, tracker);
    const result = await run(connectTools, { method: "connect", peer: "192.168.1.20" });
    expect(seen).toEqual(["http://192.168.1.20:11811"]);
    expect(result).toEqual({
      peer: "http://192.168.1.20:11811",
      members: [],
      members_digest: "digest",
    });
  });
});

describe("tracker recovery (8.3)", () => {
  function dispatch(taskId: string, state: DispatchEntry["state"], agentId?: string): DispatchEntry {
    const now = new Date().toISOString();
    return {
      task_id: taskId,
      peer: "http://127.0.0.1:9",
      state,
      created_at: now,
      updated_at: now,
      ...(agentId === undefined ? {} : { agent_id: agentId }),
    };
  }

  function view(taskId: string): TaskView {
    return {
      kind: "task",
      id: taskId,
      contextId: taskId,
      status: { state: "working", timestamp: new Date().toISOString() },
    };
  }

  it("resumes only non-terminal dispatches with a live dispatching agent", async () => {
    const agent: TrackerAgent = {
      id: "live-session" as SessionId,
      status: "idle",
      inject: () => {},
      followup: () => {},
    };
    const tracker = createTracker(
      () => ({
        async getTask(_peer: string, taskId: string): Promise<TaskView> {
          return view(taskId);
        },
      }),
      { intervalMs: 1000, coalesceMs: 1000 },
    );
    try {
      const restored = restoreTrackedDispatches(
        tracker,
        [
          dispatch("running", "working", "live-session"),
          dispatch("parked", "input-required", "live-session"),
          dispatch("done", "completed", "live-session"),
          dispatch("unattributed", "working"),
          dispatch("orphaned", "working", "gone-session"),
        ],
        (agentId) => (agentId === "live-session" ? agent : undefined),
        logger,
      );
      expect(restored).toBe(2);
      expect(tracker.size()).toBe(2);
    } finally {
      tracker.stop();
    }
  });
});
