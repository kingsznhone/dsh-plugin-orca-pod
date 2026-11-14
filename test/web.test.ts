/**
 * Panel HTTP bridge (§9.2): `/orca-api` is a same-origin route on the DSH web
 * server, gated to loopback traffic so approvals and workspace paths never leak
 * to another machine through a reverse proxy.
 */

import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import type { PodAdmin } from "../src/plugin/admin.ts";
import type { DispatchEntry } from "../src/dispatches.ts";
import type { PeerView, SelfRecord, TaskView } from "../src/protocol.ts";
import type { HostLogger } from "../src/plugin/dsh.ts";
import { createPodApiHandler, isLocalRequest, POD_API_PREFIX, registerPodWeb } from "../src/plugin/web.ts";

function taskView(id: string, state: TaskView["status"]["state"], artifacts: TaskView["artifacts"] = []): TaskView {
  return {
    kind: "task",
    id,
    contextId: "ctx-1",
    status: { state, timestamp: "2026-01-01T00:00:00.000Z" },
    artifacts,
  } as TaskView;
}

function fakeAdmin(overrides: Partial<PodAdmin> = {}): PodAdmin {
  const calls: string[] = [];
  const admin: PodAdmin = {
    self: () =>
      ({
        orca_node_id: "NODE01",
        display_name: "node one",
        endpoints: ["http://127.0.0.1:11811"],
        state: "online",
        workgroup_id: "wg",
      }) as unknown as SelfRecord,
    members: () => [{ orca_node_id: "NODE02", state: "online", endpoints: [] } as unknown as PeerView],
    tasks: () => [
      taskView("TASK01", "completed", [{ artifactId: "art-1", name: "report.md", bytes: 3 }]),
      taskView("TASK02", "input-required"),
    ],
    dispatches: () => [{ task_id: "TASK01", peer: "http://127.0.0.1:11812", state: "completed" } as DispatchEntry],
    prompts: () => [
      {
        id: "p-1",
        peer: "http://127.0.0.1:11812",
        task_id: "TASK02",
        request_id: "req-1",
        tool: "write_file",
        requested: { path: "report.md" },
        agent_id: "session-1",
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ],
    config: () => ({
      configured: true,
      workgroup_id: "wg",
      node_id: "NODE01",
      display_name: "node one",
      port: 11811,
      endpoints: ["http://127.0.0.1:11811"],
      detected_endpoints: ["http://192.168.1.5:11811"],
      peers: [],
      data_root: "/data",
      advanced: {
        task_timeout_s: null,
        approval_timeout_s: null,
        result_max_bytes: null,
        max_input_files: null,
        max_input_bytes: null,
        allow_public_peers: null,
        allow_loopback_peers: null,
        permission_mode: null,
        executor: null,
      },
      password_set: true,
      running: true,
      error: null,
    }),
    saveConfig: async (patch) => {
      calls.push("saveConfig:" + JSON.stringify(patch));
      return admin.config();
    },
    connect: async (peer) => {
      calls.push("connect:" + peer);
      return admin.config();
    },
    disconnect: async () => {
      calls.push("disconnect");
      return admin.config();
    },
    reset: async () => {
      calls.push("reset");
      return admin.config();
    },
    task: async (_peer, taskId) => {
      calls.push("task:" + taskId);
      return taskView(taskId, "working");
    },
    approvals: () => [
      {
        peer: "http://127.0.0.1:11812",
        taskId: "TASK02",
        view: taskView("TASK02", "input-required"),
        request: { request_id: "req-1", task_id: "TASK02", tool: "write_file" },
      } as never,
    ],
    approve: async (peer, taskId) => {
      calls.push("approve:" + peer + ":" + taskId);
      return taskView(taskId, "working");
    },
    deny: async (peer, taskId, reason) => {
      calls.push("deny:" + peer + ":" + taskId + ":" + (reason ?? ""));
      return taskView(taskId, "failed");
    },
    cancel: async (peer, taskId) => {
      calls.push("cancel:" + peer + ":" + taskId);
      return taskView(taskId, "canceled");
    },
    artifacts: (view) => [{ name: "report.md", blob_id: view.id, bytes: 3, url: "http://127.0.0.1/blobs/x" }],
    workspace: () => ({
      root: "/data/workgroups/wg",
      notes: "/data/workgroups/wg/notes",
      inputs: "/data/workgroups/wg/inputs",
      state: "/data/state/wg",
      notes_files: ["STATUS.md"],
      inputs_dirs: [],
    }),
    subscribe: () => () => {},
    ...overrides,
  };
  return Object.assign(admin, { calls });
}

interface InvokeOptions {
  method?: string;
  url: string;
  body?: unknown;
  address?: string;
  headers?: Record<string, string>;
}

async function invoke(handler: (request: never, response: never) => Promise<void>, options: InvokeOptions) {
  const payload = options.body === undefined ? "" : JSON.stringify(options.body);
  const request = Readable.from(payload.length === 0 ? [] : [Buffer.from(payload)]) as unknown as Record<string, unknown>;
  request["method"] = options.method ?? "GET";
  request["url"] = options.url;
  request["headers"] = options.headers ?? {};
  request["socket"] = { remoteAddress: options.address ?? "127.0.0.1" };

  let status = 0;
  let body = "";
  const response = {
    writeHead(code: number) {
      status = code;
      return response;
    },
    end(chunk?: string) {
      body = chunk ?? "";
      return response;
    },
  };
  await handler(request as never, response as never);
  return { status, body: body.length === 0 ? null : JSON.parse(body) };
}

describe("panel HTTP bridge", () => {
  it("serves one state snapshot with members, tasks and approvals", async () => {
    const admin = fakeAdmin();
    const result = await invoke(createPodApiHandler(admin), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.self.orca_node_id).toBe("NODE01");
    expect(result.body.members).toHaveLength(1);
    expect(result.body.tasks.map((task: TaskView) => task.id)).toEqual(["TASK01", "TASK02"]);
    expect(result.body.approvals).toHaveLength(1);
    expect(result.body.approvals[0].request.tool).toBe("write_file");
    expect(result.body.workspace.notes_files).toEqual(["STATUS.md"]);
    expect(result.body.artifacts.TASK01).toHaveLength(1);
  });

  it("rejects non-loopback callers and proxied requests", async () => {
    const handler = createPodApiHandler(fakeAdmin());
    const remote = await invoke(handler, { url: `${POD_API_PREFIX}/state`, address: "192.168.1.20" });
    expect(remote.status).toBe(403);
    expect(remote.body.error).toBe("local_only");

    const proxied = await invoke(handler, {
      url: `${POD_API_PREFIX}/state`,
      headers: { "x-forwarded-for": "192.168.1.20" },
    });
    expect(proxied.status).toBe(403);
  });

  it("drives approve, deny and cancel without a model round-trip", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const handler = createPodApiHandler(admin);
    const approve = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/approve`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK02" },
    });
    expect(approve.status).toBe(200);
    expect(approve.body.task.status.state).toBe("working");
    expect(admin.calls).toContain("approve:http://127.0.0.1:11812:TASK02");

    const deny = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/deny`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK02", reason: "not now" },
    });
    expect(deny.status).toBe(200);
    expect(admin.calls).toContain("deny:http://127.0.0.1:11812:TASK02:not now");

    const cancel = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/cancel`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK01" },
    });
    expect(cancel.status).toBe(200);
    expect(admin.calls).toContain("cancel:http://127.0.0.1:11812:TASK01");
  });

  it("validates action bodies and surfaces admin errors", async () => {
    const handler = createPodApiHandler(fakeAdmin());
    const missing = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/approve`, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/peer/);

    const failing = createPodApiHandler(
      fakeAdmin({
        approve: async () => {
          throw new Error("task has no pending permission request");
        },
      }),
    );
    const result = await invoke(failing, {
      method: "POST",
      url: `${POD_API_PREFIX}/approve`,
      body: { peer: "p", task_id: "t" },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/no pending permission/);

    const unknown = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/nope`, body: {} });
    expect(unknown.status).toBe(404);
  });

  it("serves one task with its artifact links", async () => {
    const handler = createPodApiHandler(fakeAdmin());
    const result = await invoke(handler, { url: `${POD_API_PREFIX}/task?peer=p&task=TASK01` });
    expect(result.status).toBe(200);
    expect(result.body.task.id).toBe("TASK01");
    expect(result.body.artifacts[0].name).toBe("report.md");
  });

  it("includes the editable config in the state snapshot", async () => {
    const result = await invoke(createPodApiHandler(fakeAdmin()), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.config.workgroup_id).toBe("wg");
    expect(result.body.config.password_set).toBe(true);
  });

  it("includes parked approval prompts for the chat card and popup", async () => {
    const result = await invoke(createPodApiHandler(fakeAdmin()), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.prompts).toHaveLength(1);
    expect(result.body.prompts[0]).toMatchObject({ task_id: "TASK02", agent_id: "session-1" });
  });

  it("saves a config patch from the panel", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const result = await invoke(createPodApiHandler(admin), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        workgroup_id: "wg",
        workgroup_password: "next-password",
        display_name: "renamed",
        port: "11812",
        endpoints: ["http://127.0.0.1:11812"],
        peers: ["http://127.0.0.1:11813"],
        ignored: "drop me",
      },
    });
    expect(result.status).toBe(200);
    expect(admin.calls).toEqual([
      'saveConfig:{"workgroup_id":"wg","workgroup_password":"next-password","display_name":"renamed","port":11812,"endpoints":["http://127.0.0.1:11812"],"peers":["http://127.0.0.1:11813"]}',
    ]);
  });

  it("forwards the advanced local controls from the panel", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const saved = await invoke(createPodApiHandler(admin), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        task_timeout_s: "120",
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        max_input_files: 4,
        max_input_bytes: 1048576,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        executor: "echo",
      },
    });
    expect(saved.status).toBe(200);
    expect(admin.calls).toEqual([
      'saveConfig:{"task_timeout_s":120,"approval_timeout_s":45,"result_max_bytes":4096,"max_input_files":4,"max_input_bytes":1048576,"allow_public_peers":true,"allow_loopback_peers":false,"permission_mode":"workspace-write","executor":"echo"}',
    ]);

    // Clearing a control sends null, so the override (and the persisted config
    // key) disappears and the local default applies again.
    const cleared = await invoke(createPodApiHandler(admin), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: { task_timeout_s: null, allow_public_peers: null, permission_mode: null, executor: null },
    });
    expect(cleared.status).toBe(200);
    expect(admin.calls[1]).toBe(
      'saveConfig:{"task_timeout_s":null,"allow_public_peers":null,"permission_mode":null,"executor":null}',
    );
  });

  it("connects a peer from the panel", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const handler = createPodApiHandler(admin);
    const result = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/connect`,
      body: { peer: "192.168.1.20:11811" },
    });
    expect(result.status).toBe(200);
    expect(admin.calls).toContain("connect:192.168.1.20:11811");

    const missing = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/connect`, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/peer/);
  });

  it("disconnects from the panel", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const handler = createPodApiHandler(admin);
    const result = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/disconnect`, body: {} });
    expect(result.status).toBe(200);
    expect(admin.calls).toEqual(["disconnect"]);
  });

  it("resets the panel configuration", async () => {
    const admin = fakeAdmin() as PodAdmin & { calls: string[] };
    const handler = createPodApiHandler(admin);
    const result = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/reset`, body: {} });
    expect(result.status).toBe(200);
    expect(admin.calls).toEqual(["reset"]);
  });

  it("registers one prefix route through ctx.inject and cleans it up", () => {
    const registered: Array<{ kind: string; path: string }> = [];
    const cleanups: Array<() => void> = [];
    let offCalls = 0;
    const webServer = {
      register(route: { kind: string; path: string }) {
        registered.push(route);
        return () => {
          offCalls += 1;
        };
      },
    };
    const ctx = {
      tools: { register: () => undefined },
      effect(execute: () => () => void) {
        cleanups.push(execute());
        return undefined;
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} } as HostLogger,
      inject(_dependencies: string[], callback: (sub: { webServer: typeof webServer }) => void) {
        callback({ webServer });
      },
    };
    registerPodWeb(ctx as never, fakeAdmin(), ctx.logger);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ kind: "prefix", path: POD_API_PREFIX });
    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    expect(offCalls).toBe(1);
  });

  it("keeps loopback detection immune to header spoofing", () => {
    const base = { socket: { remoteAddress: "::1" }, headers: {} };
    expect(isLocalRequest(base as never)).toBe(true);
    expect(isLocalRequest({ ...base, headers: { "x-real-ip": "10.0.0.1" } } as never)).toBe(false);
    expect(isLocalRequest({ socket: { remoteAddress: "10.0.0.5" }, headers: {} } as never)).toBe(false);
  });
});
