/**
 * Panel HTTP bridge (§9.2): `/orca-api` is a same-origin route on the DSH web
 * server that admits whoever DSH's own `/api` admits (`ctx.connection.admit`),
 * and of those only the owner, so approvals and workspace paths follow the web
 * UI's login whether the browser is on this machine or another.
 */

import { Readable } from "node:stream";
import type { Logger } from "@deepseek-ai/cordis";
import { describe, expect, it, vi } from "vitest";

import { PanelModel } from "../src/plugin/panel.ts";
import type { PodApproval, PodConfigView, PodPeer, PodTaskRow } from "../src/plugin/panel-api.ts";
import type { Pod } from "../src/plugin/pod.ts";
import type { Orca } from "../src/node/orca.ts";
import { parseSettings } from "../src/node/settings.ts";
import { Tracker } from "../src/plugin/tracker.ts";
import type { TaskView } from "../src/task/wire.ts";
import type { ConnectionTrustRequest, PeerAdmission } from "@deepseek-ai/dsh-client-connection";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";
import { PanelRoutes } from "../src/plugin/panel-routes.ts";
import { catalogFeed, idlePod, logger } from "./fixtures/pod.ts";

function taskView(id: string, state: TaskView["status"]["state"]): TaskView {
  return { kind: "task", id, contextId: "ctx-1", status: { state, timestamp: "2026-01-01T00:00:00.000Z" } };
}

const RECENT: PodTaskRow[] = [
  {
    id: "TASK02",
    peer: "NODE02",
    state: "input-required",
    who: "node two",
    who_title: "NODE02",
    at: "2026-01-01T00:00:02.000Z",
    cancellable: true,
  },
  {
    id: "TASK01",
    peer: "NODE02",
    state: "completed",
    who: "node two",
    who_title: "http://127.0.0.1:11812",
    at: "2026-01-01T00:00:01.000Z",
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

/** What the panel routes are built over: the panel model's reads, the pod and the tracker for the actions. */
type FakeApi = { panel: PanelModel; pod: Pod; tracker: Tracker; calls: string[] };

/**
 * A real pod and tracker, and the panel model the routes build, whose answers are
 * replaced (the model's on its prototype), so the HTTP bridge is tested on its
 * own; `calls` records what the routes asked of them.
 */
function fakeApi(): FakeApi {
  const calls: string[] = [];
  const pod = idlePod();
  const tracker = new Tracker(pod, logger, () => undefined);
  const panel = PanelModel.prototype;
  const config: PodConfigView = {
    configured: true,
    settings: parseSettings({ workgroup_id: "wg" }),
    port: 11811,
    suggested_endpoints: ["http://192.168.1.5:11811"],
    bind_choices: ["127.0.0.1", "::", "192.168.1.5"],
    permission_modes: ["read-only", "workspace-write", "danger-full-access"],
    reasoning_efforts: [],
    error: null,
  };
  vi.spyOn(panel, "config").mockResolvedValue(config);
  vi.spyOn(panel, "state").mockResolvedValue({
    self: {
      orca_node_id: "NODE01",
      display_name: "node one",
      endpoints: ["http://127.0.0.1:11811"],
      state: "online",
      workgroup_id: "wg",
      busy_from: null,
    } as unknown as PodPeer,
    config,
    members: [{ orca_node_id: "NODE02", state: "online", endpoints: [], busy_from: null } as unknown as PodPeer],
    approvals: [APPROVAL],
    recent: RECENT,
    workspace_root: "/data/workgroups/wg",
  });
  vi.spyOn(panel, "recent").mockImplementation((limit) => RECENT.slice(0, limit));
  vi.spyOn(panel, "task").mockImplementation(async (peer, taskId) => {
    calls.push(`task:${peer}:${taskId}`);
    return { task: taskView(taskId, "working"), origin: "node two", dispatch: null };
  });
  vi.spyOn(pod, "reconfigure").mockImplementation(async (patch) => {
    calls.push(`reconfigure:${JSON.stringify(patch)}`);
  });
  vi.spyOn(pod, "addPeer").mockImplementation(async (address) => {
    calls.push(`connect:${address}`);
    return address;
  });
  vi.spyOn(pod, "reset").mockImplementation(async () => {
    calls.push("reset");
  });
  const node = (ref: string) => ({
    cancelTask: async (taskId: string) => {
      calls.push(`cancel:${ref}:${taskId}`);
      return taskView(taskId, "canceled");
    },
  });
  vi.spyOn(pod, "orca").mockResolvedValue({ mesh: { resolve: node } } as unknown as Orca);
  vi.spyOn(tracker, "approve").mockImplementation(async (peer, taskId) => {
    calls.push(`approve:${peer}:${taskId}`);
    return taskView(taskId, "working");
  });
  vi.spyOn(tracker, "deny").mockImplementation(async (peer, taskId, reason) => {
    calls.push(`deny:${peer}:${taskId}:${reason ?? ""}`);
    return taskView(taskId, "failed");
  });
  return { panel, pod, tracker, calls };
}

/** The session cookie value the fake admission reads as the browser owner. */
const OWNER_COOKIE = "session=owner";

/**
 * DSH's browser admission, faked by the request's cookie: the owner's session,
 * another principal's, an untrusted Host (403) or no session at all (401).
 * The real checks are DSH's; the panel only acts on the outcome.
 */
const fakeConnection = {
  admit(request: ConnectionTrustRequest): PeerAdmission {
    const headers = request.headers as Record<string, string | undefined>;
    if (headers.host === "evil.example:7775") return { rejection: 403 };
    const kind = { [OWNER_COOKIE]: "owner", "session=guest": "guest" }[headers.cookie ?? ""];
    if (kind === undefined) return { rejection: 401 };
    return { peer: { principal: { kind } } } as unknown as PeerAdmission;
  },
};

/** The route the panel registers on the host's web server, the way the host receives it. */
function registeredRoute({ pod, tracker }: FakeApi): WebRoute {
  let registered: WebRoute | undefined;
  const ctx = {
    inject: (_services: string[], scope: (inner: unknown) => void) =>
      scope({
        effect: (run: () => unknown) => run(),
        webServer: { register: (route: WebRoute) => (registered = route) },
        connection: fakeConnection,
      }),
  };
  new PanelRoutes(pod, tracker, catalogFeed()).register(ctx as never);
  if (registered === undefined) throw new Error("the panel registered no route");
  return registered;
}

/** The prefix the panel's API lives under, as the host routes it. */
const POD_API_PREFIX = registeredRoute(fakeApi()).path;

/** The panel routes, as the plain function the web server calls. */
function apiHandler(api: FakeApi): (request: never, response: never) => Promise<void> {
  const { handler } = registeredRoute(api);
  return async (request, response) => {
    await handler(request, response);
  };
}

interface InvokeOptions {
  method?: string;
  url: string;
  body?: unknown;
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
    cookie: OWNER_COOKIE,
    "x-orca-pod": "1",
    ...(method === "GET" ? {} : { "content-type": "application/json" }),
    ...(options.headers ?? {}),
  };
  request.method = method;
  request.url = options.url;
  request.headers = headers;

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
  it("serves one state snapshot with members, recent tasks and pending approvals", async () => {
    const panel = fakeApi();
    const result = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.self.orca_node_id).toBe("NODE01");
    expect(result.body.members).toHaveLength(1);
    expect(result.body.recent.map((row: PodTaskRow) => row.id)).toEqual(["TASK02", "TASK01"]);
    expect(result.body.approvals).toHaveLength(1);
    expect(result.body.approvals[0]).toMatchObject({ tool: "write_file", from: "node two", agent_id: "session-1" });
    expect(result.body.workspace_root).toBe("/data/workgroups/wg");
    expect(result.body).not.toHaveProperty("tasks");
    expect(result.body).not.toHaveProperty("prompts");
  });

  it("serves a remote browser DSH admitted as the owner, proxied or not", async () => {
    const result = await invoke(apiHandler(fakeApi()), {
      url: `${POD_API_PREFIX}/state`,
      headers: { host: "dsh.example.com", "x-forwarded-for": "192.168.1.20" },
    });
    expect(result.status).toBe(200);
  });

  it("answers DSH's own refusal: 401 without a session, 403 for an untrusted Host", async () => {
    const panel = fakeApi();
    const handler = apiHandler(panel);
    const anonymous = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/reset`,
      headers: { cookie: "" },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error).toBe("unauthorized");

    const rebound = await invoke(handler, { url: `${POD_API_PREFIX}/state`, headers: { host: "evil.example:7775" } });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error).toBe("forbidden");
    expect(panel.calls).toEqual([]);
  });

  it("refuses an admitted Peer that is not the owner", async () => {
    const panel = fakeApi();
    const guest = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/reset`,
      headers: { cookie: "session=guest" },
    });
    expect(guest.status).toBe(403);
    expect(guest.body.error).toBe("forbidden");
    expect(panel.calls).toEqual([]);
  });

  it("requires the panel header even from the owner's session", async () => {
    const noHeader = await invoke(apiHandler(fakeApi()), {
      url: `${POD_API_PREFIX}/state`,
      headers: { "x-orca-pod": "" },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toBe("cross_origin");
  });

  it("requires a JSON content type for panel writes", async () => {
    const handler = apiHandler(fakeApi());
    const plain = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/reset`,
      headers: { "content-type": "text/plain" },
    });
    expect(plain.status).toBe(403);
    expect(plain.body.error).toBe("json_required");
  });

  it("drives approve, deny and cancel without a model round-trip", async () => {
    const panel = fakeApi();
    const handler = apiHandler(panel);
    const approve = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/approve`,
      body: { peer: "http://127.0.0.1:11812", task_id: "TASK02" },
    });
    expect(approve.status).toBe(200);
    expect(approve.body).toEqual({});
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
    const api = fakeApi();
    const handler = apiHandler(api);
    const missing = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/approve`, body: {} });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/peer/);

    vi.spyOn(api.tracker, "approve").mockRejectedValue(new Error("task has no pending permission request"));
    const result = await invoke(handler, {
      method: "POST",
      url: `${POD_API_PREFIX}/approve`,
      body: { peer: "p", task_id: "t" },
    });
    expect(result.status).toBe(400);
    expect(result.body.error).toMatch(/no pending permission/);

    const unknown = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/nope`, body: {} });
    expect(unknown.status).toBe(404);
  });

  it("serves one task with its dispatch in a single call", async () => {
    const panel = fakeApi();
    const result = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/task?peer=p&task=TASK01` });
    expect(result.status).toBe(200);
    expect(result.body.task.id).toBe("TASK01");
    expect(result.body).toMatchObject({ origin: "node two", dispatch: null });
    expect(panel.calls).toEqual(["task:p:TASK01"]);

    const missing = await invoke(apiHandler(panel), { url: `${POD_API_PREFIX}/task?peer=p` });
    expect(missing.status).toBe(400);
  });

  it("serves the merged task rows for the all-tasks view, the newest 10", async () => {
    const limits: number[] = [];
    const api = fakeApi();
    vi.spyOn(api.panel, "recent").mockImplementation((limit) => {
      limits.push(limit ?? 10);
      return RECENT;
    });
    const handler = apiHandler(api);
    const result = await invoke(handler, { url: `${POD_API_PREFIX}/tasks` });
    expect(result.status).toBe(200);
    expect(result.body.map((row: PodTaskRow) => row.id)).toEqual(["TASK02", "TASK01"]);
    expect(result.body[0]).toMatchObject({ peer: "NODE02", cancellable: true });
    expect(limits).toEqual([10]);
  });

  it("includes the editable config in the state snapshot", async () => {
    const result = await invoke(apiHandler(fakeApi()), { url: `${POD_API_PREFIX}/state` });
    expect(result.status).toBe(200);
    expect(result.body.config.settings.workgroup_id).toBe("wg");
    expect(result.body.config.suggested_endpoints).toEqual(["http://192.168.1.5:11811"]);
    expect(result.body.config.bind_choices).toContain("::");
  });

  it("hands the panel body to the pod unchanged", async () => {
    const panel = fakeApi();
    const result = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        workgroup_id: "wg",
        workgroup_password: "next-password",
        display_name: "renamed",
        port: 11812,
        endpoints: ["https://127.0.0.1:11812"],
      },
    });
    expect(result.status).toBe(200);
    expect(panel.calls).toEqual([
      'reconfigure:{"workgroup_id":"wg","workgroup_password":"next-password","display_name":"renamed","port":11812,"endpoints":["https://127.0.0.1:11812"]}',
    ]);
  });

  it("forwards the advanced local controls from the panel", async () => {
    const panel = fakeApi();
    const saved = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        task_timeout_s: 120,
        max_workspace_bytes: 2147483648,
        // Settings that no longer exist (candidate screening is automatic now) are dropped.
        allow_public_peers: true,
        allow_loopback_peers: false,
        permission_mode: "workspace-write",
        default_reasoning_effort: "max",
      },
    });
    expect(saved.status).toBe(200);
    expect(panel.calls).toEqual([
      // Keys come out in the settings table's order, not the body's.
      'reconfigure:{"permission_mode":"workspace-write","task_timeout_s":120,"max_workspace_bytes":2147483648,"default_reasoning_effort":"max"}',
    ]);

    // Clearing a control sends null, so the override (and the persisted config
    // key) disappears and the local default applies again.
    const cleared = await invoke(apiHandler(panel), {
      method: "POST",
      url: `${POD_API_PREFIX}/config`,
      body: {
        task_timeout_s: null,
        max_workspace_bytes: null,
        permission_mode: null,
        default_reasoning_effort: null,
      },
    });
    expect(cleared.status).toBe(200);
    expect(panel.calls[1]).toBe(
      'reconfigure:{"permission_mode":null,"task_timeout_s":null,"max_workspace_bytes":null,"default_reasoning_effort":null}',
    );
  });

  it("connects a peer from the panel", async () => {
    const panel = fakeApi();
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

  it("resets the panel configuration", async () => {
    const panel = fakeApi();
    const handler = apiHandler(panel);
    const result = await invoke(handler, { method: "POST", url: `${POD_API_PREFIX}/reset`, body: {} });
    expect(result.status).toBe(200);
    expect(panel.calls).toEqual(["reset"]);
  });

  it("registers one prefix route through ctx.inject and cleans it up", () => {
    const registered: Array<{ kind: string; path: string }> = [];
    const cleanups: Array<() => void> = [];
    const fenced: string[][] = [];
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
        dependencies: string[],
        callback: (scope: { webServer: typeof webServer; effect(execute: () => () => void): undefined }) => void,
      ) {
        fenced.push(dependencies);
        callback({
          webServer,
          effect(execute) {
            cleanups.push(execute());
            return undefined;
          },
        });
      },
    };
    const api = fakeApi();
    new PanelRoutes(api.pod, api.tracker, catalogFeed()).register(ctx as never);
    // No browser admission, no panel: the route waits for the host's connection service too.
    expect(fenced).toEqual([["webServer", "connection"]]);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatchObject({ kind: "prefix", path: POD_API_PREFIX });
    expect(cleanups).toHaveLength(1);
    cleanups[0]!();
    expect(offCalls).toBe(1);
  });
});
