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

import type { ModelCatalogFeed } from "./catalog.ts";
import { PanelModel } from "./panel.ts";
import { ConnectBodySchema, DenyBodySchema, PeerTaskBodySchema, type PodReads } from "./panel-api.ts";
import type { Pod } from "./pod.ts";
import type { Tracker } from "./tracker.ts";
import { PanelPatchSchema } from "../node/settings.ts";
import { readAll } from "../core/stream.ts";
import { isDirectLoopbackRequest } from "../api/access.ts";
import { isRecord, parseOrThrow } from "../core/schema.ts";
import { errorMessage } from "../core/errors.ts";
import { BlobRefSchema, type OpenedBlob } from "../core/blobs.ts";

/** Prefix the client polls; keep in sync with `client/store.ts`. */
const POD_API_PREFIX = "/orca-api";

/** Rows of the panel's "all tasks" view. */
const TASKS_LIMIT = 500;

/** Largest JSON body accepted for one approval action. */
const MAX_BODY_BYTES = 64 * 1024;

/** Custom header the panel sends on every call; browsers preflight it cross-origin. */
const PANEL_HEADER = "x-orca-pod";

/** An answer: the status it goes out with, and its JSON body. */
type Reply = { status: number; body: unknown };

/** A GET route's answer, checked against the shape the panel reads for it. */
const answer = <K extends keyof PodReads>(_route: K, body: PodReads[K]["response"]): Reply => ({ status: 200, body });
const NOT_FOUND: Reply = { status: 404, body: { error: "not_found" } };
/** What every action answers once it is done: the panel reads the new state with its next poll. */
const DONE: Reply = { status: 200, body: {} };

/**
 * The panel's HTTP API (`/orca-api`): reads are the panel model's projections,
 * actions go straight to the pod, or to the tracker for the permission requests it holds.
 */
export class PanelRoutes {
  private readonly panel: PanelModel;

  constructor(
    private readonly pod: Pod,
    private readonly tracker: Tracker,
    /** The host's model catalog; the panel offers its reasoning efforts. */
    catalog: ModelCatalogFeed,
  ) {
    this.panel = new PanelModel(pod, tracker, catalog);
  }

  /** Route handler for `/orca-api`. */
  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const refused = PanelRoutes.rejection(request);
    if (refused !== null) {
      PanelRoutes.sendJson(response, refused.status, refused.body);
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
    PanelRoutes.sendJson(response, reply.status, reply.body);
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
    const { panel } = this;
    switch (url.pathname.slice(POD_API_PREFIX.length)) {
      case "/state":
        return answer("state", await panel.state());
      case "/task": {
        const peer = url.searchParams.get("peer");
        const taskId = url.searchParams.get("task");
        if (peer === null || taskId === null) return { status: 400, body: { error: "peer and task are required" } };
        return answer("task", await panel.task(peer, taskId));
      }
      // Every task this node knows about, for the panel's "all tasks" view.
      case "/tasks":
        return answer("tasks", panel.recent(TASKS_LIMIT));
      default:
        return NOT_FOUND;
    }
  }

  private async handlePost(request: IncomingMessage, url: URL): Promise<Reply> {
    const { pod, tracker } = this;
    const body = async <S extends z.ZodType>(schema: S): Promise<z.output<S>> =>
      parseOrThrow(schema, await PanelRoutes.readJsonBody(request), (problem) => new Error(problem));
    switch (url.pathname.slice(POD_API_PREFIX.length)) {
      case "/config":
        // The password goes to the DSH credential store and the other fields to the
        // settings file (`null` clears a field); the settings parser checks the merged result.
        await pod.reconfigure(await body(PanelPatchSchema));
        return DONE;
      case "/connect":
        await pod.addPeer((await body(ConnectBodySchema)).peer);
        return DONE;
      case "/reset":
        await pod.reset();
        return DONE;
      case "/approve": {
        const { peer, task_id } = await body(PeerTaskBodySchema);
        await tracker.approve(peer, task_id);
        return DONE;
      }
      case "/deny": {
        const { peer, task_id, reason } = await body(DenyBodySchema);
        await tracker.deny(peer, task_id, reason);
        return DONE;
      }
      case "/cancel": {
        const { peer, task_id } = await body(PeerTaskBodySchema);
        await (await pod.orca()).mesh.resolve(peer).cancelTask(task_id);
        return DONE;
      }
      default:
        return NOT_FOUND;
    }
  }

  /**
   * `GET /orca-api/blob?node=&blob_id=`: a file a member published, fetched by this
   * node and streamed to the panel (§5.6). A failure before the first byte is the
   * usual JSON error; one after it can only cut the transfer short.
   */
  private async sendBlob(url: URL, response: ServerResponse): Promise<void> {
    const parsed = BlobRefSchema.safeParse({
      node: url.searchParams.get("node"),
      blob_id: url.searchParams.get("blob_id"),
    });
    if (!parsed.success) {
      PanelRoutes.sendJson(response, 400, { error: "node and blob must name a published file" });
      return;
    }
    let opened: OpenedBlob;
    try {
      opened = await (await this.pod.orca()).mesh.require(parsed.data.node).fetchBlob(parsed.data.blob_id);
    } catch (error) {
      const status =
        error instanceof Error && "status" in error && typeof error.status === "number" ? error.status : 400;
      PanelRoutes.sendJson(response, status, { error: errorMessage(error) });
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
    const host = PanelRoutes.headerOf(request, "host");
    if (host === undefined || !PanelRoutes.isLocalHostHeader(host)) return false;
    const origin = PanelRoutes.headerOf(request, "origin");
    if (origin !== undefined && (!URL.canParse(origin) || new URL(origin).host !== host.trim().toLowerCase())) {
      return false;
    }
    const site = PanelRoutes.headerOf(request, "sec-fetch-site");
    if (site !== undefined && site !== "same-origin") return false;
    return PanelRoutes.headerOf(request, PANEL_HEADER) === "1";
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
    const bytes = await readAll(request, MAX_BODY_BYTES);
    if (bytes === null) throw new Error("request body is too large");
    if (bytes.length === 0) return {};
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (!isRecord(parsed)) throw new Error("request body must be a JSON object");
    return parsed;
  }

  /** The first gate a request fails, as the answer to send; null when it may proceed. */
  private static rejection(request: IncomingMessage): Reply | null {
    if (!isDirectLoopbackRequest(request)) return { status: 403, body: { error: "local_only" } };
    if (!PanelRoutes.isSameOriginPanelRequest(request)) return { status: 403, body: { error: "cross_origin" } };
    const contentType = (PanelRoutes.headerOf(request, "content-type") ?? "").toLowerCase();
    if (request.method !== "GET" && !contentType.startsWith("application/json"))
      return { status: 403, body: { error: "json_required" } };
    return null;
  }
}
