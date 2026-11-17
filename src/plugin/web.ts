/**
 * Same-origin HTTP bridge for the Orca panel (`/orca-api`).
 *
 * The DSH client bundle cannot import host packages and the package-private
 * `host.call` channel has no documented host-side contract, so the panel talks
 * to its own host half over the DSH web server instead: one prefix route on the
 * already-running origin, polled by the client with plain `fetch` (§9.2).
 *
 * The route is deliberately reachable only from loopback and never through a
 * reverse proxy: it exposes task prompts, workspace paths and approval actions,
 * so we trust the transport, not a signature (same principle as `/cluster/child-link`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import type { z } from "zod";

import type { PodAdmin } from "./admin.ts";
import type { HostContext } from "./dsh.ts";
import { ConnectBodySchema, DenyBodySchema, PeerTaskBodySchema, type PodReads, type PodState } from "./panel-api.ts";
import { PanelPatchSchema } from "../node/settings.ts";
import { isDirectLoopbackRequest } from "../transport/net.ts";
import { describeIssue, isRecord, parseSchema } from "../kernel/schema.ts";
import { errorMessage } from "../kernel/errors.ts";
import { parseBlobRef } from "../protocol/blob.ts";

/** Prefix the client polls; keep in sync with `client/store.ts`. */
export const POD_API_PREFIX = "/orca-api";

/** Largest JSON body accepted for one approval action. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Hostnames a same-origin panel request may carry. This is the DNS-rebinding
 * defense: a malicious page can point `evil.example` at 127.0.0.1, but the
 * browser still sends `Host: evil.example`, which fails this check.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Custom header the panel sends on every call; browsers preflight it cross-origin. */
const PANEL_HEADER = "x-orca-pod";

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function hostNameOf(host: string): string {
  const value = host.trim();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end === -1 ? value.toLowerCase() : value.slice(0, end + 1).toLowerCase();
  }
  return (value.split(":")[0] ?? "").toLowerCase();
}

/**
 * Same-origin gate for the panel API (CSRF). Any page can send a "simple"
 * cross-site POST to a loopback server, and DNS rebinding can make a hostile
 * origin look local; both fail here because the browser still sends the real
 * `Origin`/`Host`. The custom header is the second half: it cannot be attached
 * cross-origin without a CORS preflight, which this route never approves.
 */
function isSameOriginPanelRequest(request: IncomingMessage): boolean {
  const host = headerOf(request, "host");
  if (host === undefined || !LOCAL_HOSTS.has(hostNameOf(host))) return false;
  const origin = headerOf(request, "origin");
  if (origin !== undefined && (!URL.canParse(origin) || new URL(origin).host !== host.trim().toLowerCase())) {
    return false;
  }
  const site = headerOf(request, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") return false;
  return headerOf(request, PANEL_HEADER) === "1";
}

function hasJsonContentType(request: IncomingMessage): boolean {
  return (headerOf(request, "content-type") ?? "").toLowerCase().startsWith("application/json");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
  return parsed;
}

/** Rows of the status page's recent-tasks table. */
const RECENT_LIMIT = 5;

function podState(admin: PodAdmin): PodState {
  const members = admin.members();
  const approvals = admin.approvals();
  return {
    self: admin.self(),
    config: admin.config(),
    members,
    mesh: { reachable: members.length },
    approvals,
    approval_count: approvals.length,
    recent: admin.recent(RECENT_LIMIT),
    workspace: admin.workspace(),
  };
}

/** An answer: the status it goes out with, and its JSON body. */
type Reply = { status: number; body: unknown };

const ok = (body: unknown): Reply => ({ status: 200, body });

/** A GET route's answer, checked against the shape the panel reads for it. */
const answer = <K extends keyof PodReads>(_route: K, body: PodReads[K]["response"]): Reply => ok(body);
const NOT_FOUND: Reply = { status: 404, body: { error: "not_found" } };

/** The first gate a request fails, as the answer to send; null when it may proceed. */
function rejection(request: IncomingMessage): Reply | null {
  if (!isDirectLoopbackRequest(request)) return { status: 403, body: { error: "local_only" } };
  if (!isSameOriginPanelRequest(request)) return { status: 403, body: { error: "cross_origin" } };
  if (request.method !== "GET" && !hasJsonContentType(request))
    return { status: 403, body: { error: "json_required" } };
  return null;
}

async function handleGet(admin: PodAdmin, url: URL): Promise<Reply> {
  switch (url.pathname.slice(POD_API_PREFIX.length)) {
    case "/state":
      return answer("state", podState(admin));
    case "/task": {
      const peer = url.searchParams.get("peer");
      const taskId = url.searchParams.get("task");
      if (peer === null || taskId === null) return { status: 400, body: { error: "peer and task are required" } };
      return answer("task", await admin.task(peer, taskId));
    }
    // Every task this node knows about, for the panel's "all tasks" view.
    case "/tasks": {
      const rawLimit = Number(url.searchParams.get("limit") ?? "500");
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 500;
      return answer("tasks", { recent: admin.recent(limit) });
    }
    default:
      return NOT_FOUND;
  }
}

/** One POST action: the schema its JSON body must satisfy (`null`: it reads none) and what it does with it. */
type PostAction = { body: z.ZodType | null; run(admin: PodAdmin, body: unknown): Promise<unknown> };

/** An action that takes a body; `handlePost` parses it with the same schema before `run` sees it. */
function withBody<S extends z.ZodType>(
  body: S,
  run: (admin: PodAdmin, parsed: z.output<S>) => Promise<unknown>,
): PostAction {
  return { body, run: (admin, parsed) => run(admin, parsed as z.output<S>) };
}

const POST_ACTIONS: Record<string, PostAction> = {
  // The panel sends typed values (`null` clears a field); the settings
  // parser behind `saveConfig` checks the merged result.
  config: withBody(PanelPatchSchema, (admin, patch) => admin.saveConfig(patch)),
  connect: withBody(ConnectBodySchema, (admin, { peer }) => admin.connect(peer)),
  disconnect: { body: null, run: (admin) => admin.disconnect() },
  reset: { body: null, run: (admin) => admin.reset() },
  approve: withBody(PeerTaskBodySchema, async (admin, { peer, task_id }) => ({
    task: await admin.approve(peer, task_id),
  })),
  deny: withBody(DenyBodySchema, async (admin, { peer, task_id, reason }) => ({
    task: await admin.deny(peer, task_id, reason),
  })),
  cancel: withBody(PeerTaskBodySchema, async (admin, { peer, task_id }) => ({
    task: await admin.cancel(peer, task_id),
  })),
};

async function handlePost(admin: PodAdmin, request: IncomingMessage, url: URL): Promise<Reply> {
  const name = url.pathname.slice(POD_API_PREFIX.length + 1);
  const action = Object.hasOwn(POST_ACTIONS, name) ? POST_ACTIONS[name] : undefined;
  if (action === undefined) return NOT_FOUND;
  if (action.body === null) return ok(await action.run(admin, undefined));
  const parsed = parseSchema(action.body, await readJsonBody(request));
  if (!parsed.ok) throw new Error(describeIssue(parsed.issue));
  return ok(await action.run(admin, parsed.value));
}

/**
 * `GET /orca-api/blob?node=&blob=`: a file a member published, fetched by this
 * node and streamed to the panel (§5.6). A failure before the first byte is the
 * usual JSON error; one after it can only cut the transfer short.
 */
async function sendBlob(admin: PodAdmin, url: URL, response: ServerResponse): Promise<void> {
  const ref = parseBlobRef(`${url.searchParams.get("node") ?? ""}/${url.searchParams.get("blob") ?? ""}`);
  if (ref === null) {
    sendJson(response, 400, { error: "node and blob must name a published file" });
    return;
  }
  let opened: Awaited<ReturnType<PodAdmin["blob"]>>;
  try {
    opened = await admin.blob(ref.node, ref.blob);
  } catch (error) {
    const status = error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 400;
    sendJson(response, status, { error: errorMessage(error) });
    return;
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/octet-stream");
  if (opened.size !== undefined) response.setHeader("content-length", String(opened.size));
  await pipeline(opened.stream, response).catch(() => response.destroy());
}

/** Route handler for `/orca-api`; exported for tests. */
export function createPodApiHandler(
  admin: PodAdmin,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    const refused = rejection(request);
    if (refused !== null) {
      sendJson(response, refused.status, refused.body);
      return;
    }
    const url = new URL(request.url ?? POD_API_PREFIX, "http://localhost");
    if (request.method === "GET" && url.pathname === `${POD_API_PREFIX}/blob`) {
      await sendBlob(admin, url, response);
      return;
    }
    let reply: Reply;
    try {
      if (request.method === "GET") reply = await handleGet(admin, url);
      else if (request.method === "POST") reply = await handlePost(admin, request, url);
      else reply = NOT_FOUND;
    } catch (error) {
      reply = { status: 400, body: { error: errorMessage(error) } };
    }
    sendJson(response, reply.status, reply.body);
  };
}

/**
 * Register the panel route on the host web server.
 *
 * Registration is fenced behind `inject(['webServer'])`, so a host without a web
 * UI (ACP, CLI) leaves the plugin without a panel instead of failing startup.
 */
export function registerPodWeb(ctx: HostContext, admin: PodAdmin): void {
  const handler = createPodApiHandler(admin);
  const route = { kind: "prefix", path: POD_API_PREFIX, handler } as const;
  ctx.inject(["webServer"], (scope) => {
    scope.effect(() => scope.webServer.register(route), "orca-pod.panel-route");
  });
}
