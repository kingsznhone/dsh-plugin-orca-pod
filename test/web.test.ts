/**
 * Panel HTTP bridge (§9.2): `/orca-api` is a same-origin route on the DSH web
 * server, gated to loopback traffic so approvals and workspace paths never leak
 * to another machine through a reverse proxy.
 */

import { PassThrough, Readable } from "node:stream";
import type { Logger } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";

import { PanelModel } from "../src/plugin/panel.ts";
import type { PodApproval, PodPeer, PodTaskRow } from "../src/plugin/panel-api.ts";
import { ApprovalBroker } from "../src/plugin/broker.ts";
import type { SelfRecord } from "../src/core/wire/peer.ts";
import type { TaskView } from "../src/task/wire.ts";
import { isDirectLoopbackRequest } from "../src/core/net.ts";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { PanelRoutes } from "../src/plugin/panel-routes.ts";
import { fakeNodeId, wg } from "./fixtures/ids.ts";
import { catalogFeed, idlePod } from "./fixtures/pod.ts";

function taskView(id: string, state: TaskView["status"]["state"]): TaskView {
  return { kind: "task", id, contextId: "ctx-1", status: { state, timestamp: "2026-01-01T00:00:00.000Z" } };
}

const FILE = { node: "NODE02", blob_id: "a".repeat(64) };

const RECENT: PodTaskRow[] = [
  {
    id: "TASK02",
    peer: "NODE02",
    state: "input-required",
    who: "node two",
    who_title: "NODE02",
    at: "2026-01-01T00:00:02.000Z",
    files: [],
    cancellable: true,
  },
  {
    id: "TASK01",
    peer: "NODE02",
    state: "completed",
    who: "node two",
    who_title: "http://127.0.0.1:11812",
    at: "2026-01-01T00:00:01.000Z",
    files: [FILE],
    cancellable: false,
  },
];

const APPROVAL: PodApproval = {
  id: "NODE02|TASK02",
  peer: "NODE02",
  task_id: "TASK02",
  tool: "write_file",
  requested: '{"path":"report.md"}',
  from: "node two",
  current_mode: "read-only",
  requested_mode: "workspace-write",
  agent_id: "session-1",
};

/** A real panel model over an idle pod whose answers are replaced, so the HTTP bridge is tested on its own. */
function fakePanel(overrides: Partial<PanelModel> = {}): PanelModel & { calls: string[] } {
  const calls: string[] = [];
  const pod = idlePod();
  const broker = new ApprovalBroker(pod);
  const panel = new PanelModel(pod, broker, catalogFeed());
  const stubs: Partial<PanelModel> = {
    state: async () => ({
      self: {
        orca_node_id: "NODE01",
        display_name: "node one",
        endpoints: ["http://127.0.0.1:11811"],
        state: "online",
        workgroup_id: "wg",
        busy_from: null,
      } as unknown as PodPeer<SelfRecord>,
      config: await panel.config(),
      members: [{ orca_node_id: "NODE02", state: "online", endpoints: [], busy_from: null } as unknown as PodPeer],
      approvals: [APPROVAL],
      recent: RECENT,
      workspace: { root: "/data/workgroups/wg", state: "/data/state/wg" },
    }),
    recent: (limit) => RECENT.slice(0, limit),
    config: async () => ({
      configured: true,
      settings: {
        workgroup_id: wg("wg"),
        bind_host: "127.0.0.1",
        port: 11811,
        endpoints: [],
        peers: [],
        max_workspace_bytes: 5368709120,
        max_workspace_files: 50000,
      },
      node_id: "NODE01",
      display_name: "node one",
      port: 11811,
      endpoints: ["http://127.0.0.1:11811"],
      suggested_endpoints: ["http://192.168.1.5:11811"],
      bind_choices: ["127.0.0.1", "::", "192.168.1.5"],
      permission_modes: ["read-only", "workspace-write", "danger-full-access"],
      reasoning_efforts: [],
      peers: [],
      data_root: "/data",
      password_set: true,
      running: true,
      error: null,
    }),
    saveConfig: async (patch) => {
      calls.push(`saveConfig:${JSON.stringify(patch)}`);
      return panel.config();
    },
    connect: async (peer) => {
      calls.push(`connect:${peer}`);
      return panel.config();
    },
    disconnect: async () => {
      calls.push("disconnect");
      return panel.config();
    },
    reset: async () => {
      calls.push("reset");
      return panel.config();
    },
    task: async (peer, taskId) => {
      calls.push(`task:${peer}:${taskId}`);
      return {
        task: taskView(taskId, "working"),
        origin: "node two",
        dispatch: null,
        files: [FILE],
      };
    },
    approve: async (peer, taskId) => {
      calls.push(`approve:${peer}:${taskId}`);
      return taskView(taskId, "working");
    },
    deny: async (peer, taskId, reason) => {
      calls.push(`deny:${peer}:${taskId}:${reason ?? ""}`);
      return taskView(taskId, "failed");
    },
    cancel: async (peer, taskId) => {
      calls.push(`cancel:${peer}:${taskId}`);
      return taskView(taskId, "canceled");
    },
    blob: async (node, blobId) => {
      calls.push(`blob:${node}/${blobId}`);
      return { stream: Readable.from([Buffer.from("file bytes")]), size: 10 };
    },
    ...overrides,
  };
  for (const [name, stub] of Object.entries(stubs)) {
    vi.spyOn(panel, name as keyof PanelModel).mockImplementation(stub as never);
  }
  return Object.assign(panel, { calls });
}

/** The route the panel registers on the host's web server, the way the host receives it. */
function registeredRoute(panel: PanelModel): WebRoute {
  let registered: WebRoute | undefined;
  const ctx = {
    inject: (_services: string[], scope: (inner: unknown) => void) =>
      scope({
        effect: (run: () => unknown) => run(),
        webServer: { register: (route: WebRoute) => (registered = route) },
      }),
  };
  new PanelRoutes(panel).register(ctx as never);
  if (registered === undefined) throw new Error("the panel registered no route");
  return registered;
}

/** The prefix the panel's API lives under, as the host routes it. */
const POD_API_PREFIX = registeredRoute(new PanelModel(idlePod(), new ApprovalBroker(idlePod()), catalogFeed())).path;

/** The panel routes over a panel model, as the plain function the web server calls. */
function apiHandler(panel: PanelModel): (request: never, response: never) => Promise<void> {
  const { handler } = registeredRoute(panel);
  return async (request, response) => {
    await handler(request, response);
  };
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
  const request = Readable.from(payload.length === 0 ? [] : [Buffer.from(payload)]) as unknown as Record<
    string,
    unknown
  >;
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    host: "127.0.0.1:7775",
    "x-orca-pod": "1",
    ...(method === "GET" ? {} : { "content-type": "application/json" }),
    ...(options.headers ?? {}),
  };
  request.method = method;
  request.url = options.url;
  request.headers = headers;
  request.socket = { remoteAddress: options.address ?? "127.0.0.1" };

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

/** A response that collects what the bridge streams. */
function streamResponse() {
  const sink = new PassThrough();
  const chunks: Buffer[] = [];
  sink.on("data", (chunk: Buffer) => chunks.push(chunk));
  const headers: Record<string, string> = {};
  const response = Object.assign(sink, {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers[name] = value;
    },
    writeHead(code: number) {
      response.statusCode = code;
      return response;
    },
  });
  return { response, headers, body: () => Buffer.concat(chunks).toString("utf8") };
}

describe("panel HTTP bridge", () => {
  it("streams a member's file this node fetched, named by node and sha256", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const node = fakeNodeId("publisher");
    const blobId = "c".repeat(64);
    const { response, headers, body } = streamResponse();
    const request = Object.assign(Readable.from([]), {
      method: "GET",
      url: `${POD_API_PREFIX}/blob?node=${node}&blob=${blobId}`,
      headers: { host: "127.0.0.1:7775", "x-orca-pod": "1" },
      socket: { remoteAddress: "127.0.0.1" },
    });
    await apiHandler(panel)(request as never, response as never);
    expect(response.statusCode).toBe(200);
    expect(headers["content-length"]).toBe("10");
    expect(body()).toBe("file bytes");
    expect(panel.calls).toContain(`blob:${node}/${blobId}`);
  });

  it("refuses a blob request that does not name a published file", async () => {
    const result = await invoke(apiHandler(fakePanel()), { url: `${POD_API_PREFIX}/blob?node=x&blob=y` });
    expect(result.status).toBe(400);
  });

  it("serves one state snapshot with members, recent tasks and pending approvals", async () => {
    const panel = fakePanel();
    const result = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.self.orca_node_id).toBe("NODE01");
    expect(result.body.members).toHaveLength(1);
    expect(result.body.recent.map((row: PodTaskRow) => row.id)).toEqual(["TASK02", "TASK01"]);
    expect(result.body.recent[1].files).toEqual([FILE]);
    expect(result.body.approvals).toHaveLength(1);
    expect(result.body.approvals[0]).toMatchObject({ tool: "write_file", from: "node two", agent_id: "session-1" });
    expect(result.body.workspace).toEqual({ root: "/data/workgroups/wg", state: "/data/state/wg" });
    expect(result.body).not.toHaveProperty("tasks");
    expect(result.body).not.toHaveProperty("prompts");
  });

  it("rejects non-loopback callers and proxied requests", async () => {
    const handler = apiHandler(fakePanel());
    const remote = await invoke(handler, { url: `${POD_API_PREFIX}/state`, address: "192.168.1.20" });
    expect(remote.status).toBe(403);
    expect(remote.body.error).toBe("local_only");

    const proxied = await invoke(handler, {
      url: `${POD_API_PREFIX}/state`,
      headers: { "x-forwarded-for": "192.168.1.20" },
    });
    expect(proxied.status).toBe(403);
  });

  it("rejects a hostile origin, a foreign Host and a missing panel header", async () => {
    const handler = apiHandler(fakePanel());

    const rebound = await invoke(handler, {
      url: `${POD_API_PREFIX}/state`,
      headers: { host: "evil.example:7775" },
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error).toBe("cross_origin");

    const crossSite = await invoke(handler, {
      url: `${POD_API_PREFIX}/state`,
      headers: { origin: "https://evil.example" },
    });
    expect(crossSite.status).toBe(403);

    const noHeader = await invoke(handler, {
      url: `${POD_API_PREFIX}/state`,
      headers: { "x-orca-pod": "" },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe("cross_origin");
  });

  it("requires a JSON content type for panel writes", async () => {
    const handler = apiHandler(fakePanel());
    const plain = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/reset`,
      headers: { "content-type": "text/plain" },
    });
    expect(plain.status).toBe(403);
    expect(plain.body.error).toBe("json_required");
  });

  it("drives approve, deny and cancel without a model round-trip", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const handler = apiHandler(panel);
    const approve = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/approve`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK02" },
    });
    expect(approve.status).toBe(200);
    expect(approve.body.task.status.state).toBe("working");
    expect(panel.calls).toContain("approve:http://127.0.0.1:11812:TASK02");

    const deny = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/deny`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK02", reason: "not now" },
    });
    expect(deny.status).toBe(200);
    expect(panel.calls).toContain("deny:http://127.0.0.1:11812:TASK02:not now");

    const cancel = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/cancel`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK01" },
    });
    expect(cancel.status).toBe(200);
    expect(panel.calls).toContain("cancel:http://127.0.0.1:11812:TASK01");
  });

  it("validates action bodies and surfaces panel errors", async () => {
    const handler = apiHandler(fakePanel());
    const missing = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/approve`, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/peer/);

    const failing = apiHandler(
      fakePanel({
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

  it("serves one task with its dispatch and the files its result names in a single call", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const result = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/task?peer=p&task=TASK01` });
    expect(result.status).toBe(200);
    expect(result.body.task.id).toBe("TASK01");
    expect(result.body).toMatchObject({ origin: "node two", dispatch: null, files: [FILE] });
    expect(panel.calls).toEqual(["task:p:TASK01"]);

    const missing = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/task?peer=p` });
    expect(missing.status).toBe(400);
  });

  it("serves the merged task rows for the all-tasks view and clamps the limit", async () => {
    const limits: number[] = [];
    const handler = apiHandler(
      fakePanel({
        recent: (limit) => {
          limits.push(limit);
          return RECENT;
        },
      }),
    );
    const result = await invoke(handler, { url: `${POD_API_PREFIX}/tasks?limit=10` });
    expect(result.status).toBe(200);
    expect(result.body.recent.map((row: PodTaskRow) => row.id)).toEqual(["TASK02", "TASK01"]);
    expect(result.body.recent[0]).toMatchObject({ peer: "NODE02", cancellable: true });
    await invoke(handler, { url: `${POD_API_PREFIX}/tasks?limit=99999` });
    await invoke(handler, { url: `${POD_API_PREFIX}/tasks` });
    expect(limits).toEqual([10, 1000, 500]);
  });

  it("includes the editable config in the state snapshot", async () => {
    const result = await invoke(apiHandler(fakePanel()), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.config.settings.workgroup_id).toBe("wg");
    expect(result.body.config.password_set).toBe(true);
    expect(result.body.config.suggested_endpoints).toEqual(["http://192.168.1.5:11811"]);
    expect(result.body.config.bind_choices).toContain("::");
  });

  it("hands the panel body to saveConfig unchanged", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const result = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        workgroup_id: "wg",
        workgroup_password: "next-password",
        display_name: "renamed",
        port: 11812,
        endpoints: ["http://127.0.0.1:11812"],
        peers: ["http://127.0.0.1:11813"],
      },
    });
    expect(result.status).toBe(200);
    expect(panel.calls).toEqual([
      'saveConfig:{"workgroup_id":"wg","workgroup_password":"next-password","display_name":"renamed","port":11812,"endpoints":["http://127.0.0.1:11812"],"peers":["http://127.0.0.1:11813"]}',
    ]);
  });

  it("forwards the advanced local controls from the panel", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const saved = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        task_timeout_s: 120,
        approval_timeout_s: 45,
        result_max_bytes: 4096,
        max_workspace_bytes: 2147483648,
        max_workspace_files: 1000,
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: "max",
        executor: "echo",
      },
    });
    expect(saved.status).toBe(200);
    expect(panel.calls).toEqual([
      // Keys come out in the settings table's order, not the body's.
      'saveConfig:{"executor":"echo","permission_mode":"workspace-write","task_timeout_s":120,"approval_timeout_s":45,"result_max_bytes":4096,"max_workspace_bytes":2147483648,"max_workspace_files":1000,"allow_public_peers":true,"allow_loopback_peers":false,"default_reasoning_effort":"max"}',
    ]);

    // Clearing a control sends null, so the override (and the persisted config
    // key) disappears and the local default applies again.
    const cleared = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        task_timeout_s: null,
        allow_public_peers: null,
        permission_mode: null,
        default_reasoning_effort: null,
        executor: null,
      },
    });
    expect(cleared.status).toBe(200);
    expect(panel.calls[1]).toBe(
      'saveConfig:{"executor":null,"permission_mode":null,"task_timeout_s":null,"allow_public_peers":null,"default_reasoning_effort":null}',
    );
  });

  it("connects a peer from the panel", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const handler = apiHandler(panel);
    const result = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/connect`,
      body: { peer: "192.168.1.20:11811" },
    });
    expect(result.status).toBe(200);
    expect(panel.calls).toContain("connect:192.168.1.20:11811");

    const missing = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/connect`, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/peer/);
  });

  it("disconnects from the panel", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const handler = apiHandler(panel);
    const result = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/disconnect`, body: {} });
    expect(result.status).toBe(200);
    expect(panel.calls).toEqual(["disconnect"]);
  });

  it("resets the panel configuration", async () => {
    const panel = fakePanel() as PanelModel & { calls: string[] };
    const handler = apiHandler(panel);
    const result = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/reset`, body: {} });
    expect(result.status).toBe(200);
    expect(panel.calls).toEqual(["reset"]);
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
    // The route belongs to the inject scope, not to the plugin fiber.
    const ctx = {
      tools: { register: () => undefined },
      effect() {
        throw new Error("the panel route must be registered on the inject scope");
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger,
      inject(
        _dependencies: string[],
        callback: (scope: { webServer: typeof webServer; effect(execute: () => () => void): undefined }) => void,
      ) {
        callback({
          webServer,
          effect(execute) {
            cleanups.push(execute());
            return undefined;
          },
        });
      },
    };
    new PanelRoutes(fakePanel()).register(ctx as never);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ kind: "prefix", path: POD_API_PREFIX });
    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    expect(offCalls).toBe(1);
  });

  it("keeps loopback detection immune to header spoofing", () => {
    const base = { socket: { remoteAddress: "::1" }, headers: {} };
    expect(isDirectLoopbackRequest(base as never)).toBe(true);
    expect(isDirectLoopbackRequest({ ...base, headers: { "x-real-ip": "10.0.0.1" } } as never)).toBe(false);
    expect(isDirectLoopbackRequest({ socket: { remoteAddress: "10.0.0.5" }, headers: {} } as never)).toBe(false);
  });
});
