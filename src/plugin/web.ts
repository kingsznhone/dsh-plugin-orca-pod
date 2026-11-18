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
 * so we trust the transport, not a signature (same principle as the local `/cluster/blob`).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { pipeline } from "node:stream/promises";

import type { z } from "zod";

import type { Context } from "@deepseek-ai/cordis";
import { isLoopbackHost, type WebRoute } from "@deepseek-ai/dsh-host-webserver";

import type { PodAdmin } from "./admin.ts";
import { ConnectBodySchema, DenyBodySchema, PeerTaskBodySchema, type PodReads } from "./panel-api.ts";
import { PanelPatchSchema } from "../node/settings.ts";
import { isDirectLoopbackRequest } from "../core/net.ts";
import { describeIssue, isRecord, parseSchema } from "../core/schema.ts";
import { errorMessage } from "../core/errors.ts";
import { parseBlobRef, type OpenedBlob } from "../core/blobs.ts";

/** Prefix the client polls; keep in sync with `client/store.ts`. */
export const POD_API_PREFIX = "/orca-api";

/** Largest JSON body accepted for one approval action. */
const MAX_BODY_BYTES = 64 * 1024;

/** Custom header the panel sends on every call; browsers preflight it cross-origin. */
const PANEL_HEADER = "x-orca-pod";

/** An answer: the status it goes out with, and its JSON body. */
type Reply = { status: number; body: unknown };

const ok = (body: unknown): Reply => ({ status: 200, body });

/** A GET route's answer, checked against the shape the panel reads for it. */
const answer = <K extends keyof PodReads>(_route: K, body: PodReads[K]["response"]): Reply => ok(body);
const NOT_FOUND: Reply = { status: 404, body: { error: "not_found" } };

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

/** The panel's HTTP API (`/orca-api`) over one admin surface. */
export class PodApi {
  constructor(private readonly admin: PodAdmin) {}

  /** Route handler for `/orca-api`. */
  async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refused = PodApi.rejection(request);
    if (refused !== null) {
      PodApi.sendJson(response, refused.status, refused.body);
      return;
    }
    const url = new URL(request.url ?? POD_API_PREFIX, "http://localhost");
    if (request.method === "GET" && url.pathname === `${POD_API_PREFIX}/blob`) {
      await this.sendBlob(url, response);
      return;
    }
    let reply: Reply;
    try {
      if (request.method === "GET") reply = await this.handleGet(url);
      else if (request.method === "POST") reply = await this.handlePost(request, url);
      else reply = NOT_FOUND;
    } catch (error) {
      reply = { status: 400, body: { error: errorMessage(error) } };
    }
    PodApi.sendJson(response, reply.status, reply.body);
  }

  /**
   * Register the panel route on the host web server.
   *
   * Registration is fenced behind `inject(['webServer'])`, so a host without a web
   * UI (ACP, CLI) leaves the plugin without a panel instead of failing startup.
   */
  register(ctx: Pick<Context, "inject">): void {
    const route: WebRoute = {
      kind: "prefix",
      path: POD_API_PREFIX,
      handler: (request, response) => this.handle(request, response),
    };
    ctx.inject(["webServer"], (scope) => {
      scope.effect(() => scope.webServer.register(route), "orca-pod.panel-route");
    });
  }

  private async handleGet(url: URL): Promise<Reply> {
    const { admin } = this;
    switch (url.pathname.slice(POD_API_PREFIX.length)) {
      case "/state":
        return answer("state", admin.state());
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

  private async handlePost(request: IncomingMessage, url: URL): Promise<Reply> {
    const name = url.pathname.slice(POD_API_PREFIX.length + 1);
    const action = Object.hasOwn(POST_ACTIONS, name) ? POST_ACTIONS[name] : undefined;
    if (action === undefined) return NOT_FOUND;
    if (action.body === null) return ok(await action.run(this.admin, undefined));
    const parsed = parseSchema(action.body, await PodApi.readJsonBody(request));
    if (!parsed.ok) throw new Error(describeIssue(parsed.issue));
    return ok(await action.run(this.admin, parsed.value));
  }

  /**
   * `GET /orca-api/blob?node=&blob=`: a file a member published, fetched by this
   * node and streamed to the panel (§5.6). A failure before the first byte is the
   * usual JSON error; one after it can only cut the transfer short.
   */
  private async sendBlob(url: URL, response: ServerResponse): Promise<void> {
    const ref = parseBlobRef(`${url.searchParams.get("node") ?? ""}/${url.searchParams.get("blob") ?? ""}`);
    if (ref === null) {
      PodApi.sendJson(response, 400, { error: "node and blob must name a published file" });
      return;
    }
    let opened: OpenedBlob;
    try {
      opened = await this.admin.blob(ref.node, ref.blob);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 400;
      PodApi.sendJson(response, status, { error: errorMessage(error) });
      return;
    }
    response.statusCode = 200;
    response.setHeader("content-type", "application/octet-stream");
    if (opened.size !== undefined) response.setHeader("content-length", String(opened.size));
    await pipeline(opened.stream, response).catch(() => response.destroy());
  }

  private static headerOf(request: IncomingMessage, name: string): string | undefined {
    const raw = request.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
  }

  /**
   * Whether a `Host` header names this machine: a loopback address by DSH's own
   * rule (`isLoopbackHost`: 127/8, `::1` and their mapped forms) or `localhost`.
   * This is the DNS-rebinding defense: a malicious page can point `evil.example`
   * at 127.0.0.1, but the browser still sends `Host: evil.example`.
   */
  private static isLocalHostHeader(host: string): boolean {
    const value = host.trim().toLowerCase();
    const name = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : (value.split(":")[0] ?? "");
    return name === "localhost" || isLoopbackHost(name);
  }

  /**
   * Same-origin gate for the panel API (CSRF). Any page can send a "simple"
   * cross-site POST to a loopback server, and DNS rebinding can make a hostile
   * origin look local; both fail here because the browser still sends the real
   * `Origin`/`Host`. The custom header is the second half: it cannot be attached
   * cross-origin without a CORS preflight, which this route never approves.
   */
  private static isSameOriginPanelRequest(request: IncomingMessage): boolean {
    const host = PodApi.headerOf(request, "host");
    if (host === undefined || !PodApi.isLocalHostHeader(host)) return false;
    const origin = PodApi.headerOf(request, "origin");
    if (origin !== undefined && (!URL.canParse(origin) || new URL(origin).host !== host.trim().toLowerCase())) {
      return false;
    }
    const site = PodApi.headerOf(request, "sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return false;
    return PodApi.headerOf(request, PANEL_HEADER) === "1";
  }

  private static hasJsonContentType(request: IncomingMessage): boolean {
    return (PodApi.headerOf(request, "content-type") ?? "").toLowerCase().startsWith("application/json");
  }

  private static sendJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(payload),
      "x-content-type-options": "nosniff",
    });
    response.end(payload);
  }

  private static async readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
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

  /** The first gate a request fails, as the answer to send; null when it may proceed. */
  private static rejection(request: IncomingMessage): Reply | null {
    if (!isDirectLoopbackRequest(request)) return { status: 403, body: { error: "local_only" } };
    if (!PodApi.isSameOriginPanelRequest(request)) return { status: 403, body: { error: "cross_origin" } };
    if (request.method !== "GET" && !PodApi.hasJsonContentType(request))
      return { status: 403, body: { error: "json_required" } };
    return null;
  }
}
