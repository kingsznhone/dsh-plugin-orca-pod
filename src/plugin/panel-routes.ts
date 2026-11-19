/**
 * Same-origin HTTP bridge for the Orca panel (`/orca-api`).
 *
 * The DSH client bundle cannot import host packages and the package-private
 * `host.call` channel has no documented host-side contract, so the panel talks
 * to its own host half over the DSH web server instead: one prefix route on the
 * already-running origin, polled by the client with plain `fetch` (§9.2).
 *
 * The route exposes task prompts, workspace paths and approval actions, so it
 * admits exactly who DSH's own `/api` admits: `ctx.connection.admit` checks the
 * Host/Origin trust (loopback, the bind address or `trustedHosts`) and the signed
 * browser session cookie, and only the owner principal passes. A DSH reached from
 * another machine therefore gets its panel too, with the same login as the rest
 * of the web UI.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import type { z } from "zod";

import type { Context } from "@deepseek-ai/cordis";
import type { HostConnectionHandle } from "@deepseek-ai/dsh-client-connection";
import type { WebRoute } from "@deepseek-ai/dsh-host-webserver";

import type { ModelCatalogFeed } from "./catalog.ts";
import { PanelModel } from "./panel.ts";
import { ConnectBodySchema, DenyBodySchema, PeerTaskBodySchema, type PodReads } from "./panel-api.ts";
import type { Pod } from "./pod.ts";
import type { Tracker } from "./tracker.ts";
import { PanelPatchSchema } from "../node/settings.ts";
import { readAll } from "../core/stream.ts";
import { isRecord, parseOrThrow } from "../core/schema.ts";
import { errorMessage } from "../core/errors.ts";

/** Prefix the client polls; keep in sync with `client/store.ts`. */
const POD_API_PREFIX = "/orca-api";

/** Rows of the panel's "all tasks" view. */
const TASKS_LIMIT = 500;

/** Largest JSON body accepted for one approval action. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Custom header the panel sends on every call; browsers preflight it cross-origin.
 * DSH's trust check only refuses `cross-site`, and its `SameSite=Strict` cookie
 * still rides a same-site request, so this is what keeps a sibling subdomain's page out.
 */
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

  /** Route handler for `/orca-api`; `connection` is the host's browser admission. */
  private async handle(
    connection: HostConnectionHandle,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const refused = PanelRoutes.rejection(connection, request);
    if (refused !== null) {
      PanelRoutes.sendJson(response, refused.status, refused.body);
      return;
    }
    const url = new URL(request.url ?? POD_API_PREFIX, "http://localhost");
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
   * Registration is fenced behind `inject(['webServer', 'connection'])`, so a host
   * without a web UI (ACP, headless) leaves the plugin without a panel instead of
   * failing startup; the browser admission comes with the web composition.
   */
  register(ctx: Pick<Context, "inject">): void {
    ctx.inject(["webServer", "connection"], (scope) => {
      const route: WebRoute = {
        kind: "prefix",
        path: POD_API_PREFIX,
        handler: (request, response) => this.handle(scope.connection, request, response),
      };
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

  private static headerOf(request: IncomingMessage, name: string): string | undefined {
    const raw = request.headers[name];
    return Array.isArray(raw) ? raw[0] : raw;
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

  /**
   * The first gate a request fails, as the answer to send; null when it may proceed.
   * DSH's admission (Host/Origin trust, then the signed session cookie) answers
   * 403 or 401 the way its `/api` does; an admitted Peer must be the owner, since
   * the panel approves work on this machine. The panel header and the JSON
   * content type then shut out what a same-site page could still send.
   */
  private static rejection(connection: HostConnectionHandle, request: IncomingMessage): Reply | null {
    const admission = connection.admit(request);
    if ("rejection" in admission) {
      return admission.rejection === 401
        ? { status: 401, body: { error: "unauthorized" } }
        : { status: 403, body: { error: "forbidden" } };
    }
    if (admission.peer.principal.kind !== "owner") return { status: 403, body: { error: "forbidden" } };
    if (PanelRoutes.headerOf(request, PANEL_HEADER) !== "1") return { status: 403, body: { error: "cross_origin" } };
    const contentType = (PanelRoutes.headerOf(request, "content-type") ?? "").toLowerCase();
    if (request.method !== "GET" && !contentType.startsWith("application/json"))
      return { status: 403, body: { error: "json_required" } };
    return null;
  }
}
