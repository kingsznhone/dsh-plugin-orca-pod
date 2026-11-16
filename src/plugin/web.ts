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

import type { IncomingMessage, ServerResponse } from "node:http"

import type { PodAdmin } from "./admin.ts"
import type { HostContext, HostLogger, WebServerLike, WebServerRoute } from "./dsh.ts"

/** Prefix the client polls; keep in sync with `client.js`. */
export const POD_API_PREFIX = "/orca-api"

/** Largest JSON body accepted for one approval action. */
const MAX_BODY_BYTES = 64 * 1024

/** Loopback peers accepted by the transport gate. */
const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"])

/**
 * Hostnames a same-origin panel request may carry. This is the DNS-rebinding
 * defense: a malicious page can point `evil.example` at 127.0.0.1, but the
 * browser still sends `Host: evil.example`, which fails this check.
 */
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"])

/** Custom header the panel sends on every call; browsers preflight it cross-origin. */
export const PANEL_HEADER = "x-orca-pod"

/** True when the request came straight from this machine. */
export function isLocalRequest(request: IncomingMessage): boolean {
  const address = request.socket?.remoteAddress
  if (address === undefined || !LOOPBACK_ADDRESSES.has(address)) return false
  for (const header of ["x-forwarded-for", "forwarded", "x-real-ip"]) {
    if (request.headers[header] !== undefined) return false
  }
  return true
}

function headerOf(request: IncomingMessage, name: string): string | undefined {
  const raw = request.headers[name]
  return Array.isArray(raw) ? raw[0] : raw
}

function hostNameOf(host: string): string {
  const value = host.trim()
  if (value.startsWith("[")) {
    const end = value.indexOf("]")
    return end === -1 ? value.toLowerCase() : value.slice(0, end + 1).toLowerCase()
  }
  return value.split(":")[0]!.toLowerCase()
}

/**
 * Same-origin gate for the panel API (CSRF). Any page can send a "simple"
 * cross-site POST to a loopback server, and DNS rebinding can make a hostile
 * origin look local; both fail here because the browser still sends the real
 * `Origin`/`Host`. The custom header is the second half: it cannot be attached
 * cross-origin without a CORS preflight, which this route never approves.
 */
export function isSameOriginPanelRequest(request: IncomingMessage): boolean {
  const host = headerOf(request, "host")
  if (host === undefined || !LOCAL_HOSTS.has(hostNameOf(host))) return false
  const origin = headerOf(request, "origin")
  if (origin !== undefined) {
    try {
      if (new URL(origin).host !== host.trim().toLowerCase()) return false
    } catch {
      return false
    }
  }
  const site = headerOf(request, "sec-fetch-site")
  if (site !== undefined && site !== "same-origin") return false
  return headerOf(request, PANEL_HEADER) === "1"
}

function hasJsonContentType(request: IncomingMessage): boolean {
  return (headerOf(request, "content-type") ?? "").toLowerCase().startsWith("application/json")
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(payload),
    "x-content-type-options": "nosniff",
  })
  response.end(payload)
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new Error("request body is too large")
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function stringField(body: Record<string, unknown>, key: string): string {
  const value = body[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} must be a non-empty string`)
  return value
}

/** Panel state snapshot: everything the settings page renders in one poll. */
export function podState(admin: PodAdmin): Record<string, unknown> {
  const tasks = admin.tasks(50)
  const artifacts: Record<string, ReturnType<PodAdmin["artifacts"]>> = {}
  for (const view of tasks) {
    if ((view.artifacts ?? []).length > 0) artifacts[view.id] = admin.artifacts(view)
  }
  return {
    self: admin.self(),
    config: admin.config(),
    members: admin.members(),
    tasks,
    dispatches: admin.dispatches().slice(-50),
    approvals: admin.approvals().map((tracked) => ({
      peer: tracked.peer,
      task_id: tracked.taskId,
      request: tracked.request,
    })),
    // Parked `orca_pod` approve calls: the chat card, popup and panel all answer these.
    prompts: admin.prompts(),
    artifacts,
    workspace: admin.workspace(),
    now: new Date().toISOString(),
  }
}

/** Route handler for `/orca-api`; exported for tests. */
export function createPodApiHandler(admin: PodAdmin): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  return async (request, response) => {
    if (!isLocalRequest(request)) {
      sendJson(response, 403, { error: "local_only" })
      return
    }
    if (!isSameOriginPanelRequest(request)) {
      sendJson(response, 403, { error: "cross_origin" })
      return
    }
    if (request.method !== "GET" && !hasJsonContentType(request)) {
      sendJson(response, 403, { error: "json_required" })
      return
    }
    const url = new URL(request.url ?? POD_API_PREFIX, "http://localhost")
    const path = url.pathname
    try {
      if (request.method === "GET" && path === `${POD_API_PREFIX}/state`) {
        sendJson(response, 200, podState(admin))
        return
      }
      if (request.method === "GET" && path === `${POD_API_PREFIX}/task`) {
        const peer = url.searchParams.get("peer")
        const taskId = url.searchParams.get("task")
        if (peer === null || taskId === null) {
          sendJson(response, 400, { error: "peer and task are required" })
          return
        }
        const view = await admin.task(peer, taskId)
        sendJson(response, 200, { task: view, artifacts: admin.artifacts(view) })
        return
      }
      // Every task this node knows about, for the panel's "all tasks" view:
      // local (inbound) tasks newest first plus the origin dispatch log.
      if (request.method === "GET" && path === `${POD_API_PREFIX}/tasks`) {
        const rawLimit = Number(url.searchParams.get("limit") ?? "500")
        const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(1000, Math.floor(rawLimit))) : 500
        const tasks = admin.tasks(limit)
        const artifacts: Record<string, ReturnType<PodAdmin["artifacts"]>> = {}
        for (const view of tasks) artifacts[view.id] = admin.artifacts(view)
        sendJson(response, 200, { tasks, dispatches: admin.dispatches().slice(-limit), artifacts })
        return
      }
      if (request.method === "GET" && path === `${POD_API_PREFIX}/config`) {
        sendJson(response, 200, admin.config())
        return
      }
      if (request.method === "POST") {
        const action = path.slice(POD_API_PREFIX.length + 1)
        if (action === "config") {
          const body = await readJsonBody(request)
          const patch: Record<string, unknown> = {}
          for (const key of ["workgroup_id", "workgroup_password", "display_name"]) {
            if (typeof body[key] === "string") patch[key] = body[key]
          }
          // The listen address is owned by the panel too: omitting it keeps the
          // loopback default, and the wizard writes the chosen interface here.
          if (typeof body["bind_host"] === "string") patch["bind_host"] = body["bind_host"]
          if (body["port"] !== undefined) {
            patch["port"] = typeof body["port"] === "string" ? Number(body["port"]) : body["port"]
          }
          for (const key of ["endpoints", "peers"]) {
            if (Array.isArray(body[key])) {
              patch[key] = body[key].filter((value): value is string => typeof value === "string")
            }
          }
          // Advanced local controls. `null` clears the override so the local
          // default applies again; the panel sends numbers (or numeric strings)
          // for the numeric knobs and booleans for the three-state selectors.
          for (const key of [
            "task_timeout_s",
            "approval_timeout_s",
            "result_max_bytes",
            "max_input_files",
            "max_input_bytes",
          ]) {
            if (body[key] === null) patch[key] = null
            else if (body[key] !== undefined) {
              patch[key] = typeof body[key] === "string" ? Number(body[key]) : body[key]
            }
          }
          for (const key of ["allow_public_peers", "allow_loopback_peers"]) {
            if (body[key] === null) patch[key] = null
            else if (typeof body[key] === "boolean") patch[key] = body[key]
          }
          if (body["permission_mode"] === null) patch["permission_mode"] = null
          else if (typeof body["permission_mode"] === "string") patch["permission_mode"] = body["permission_mode"]
          if (body["default_reasoning_effort"] === null) patch["default_reasoning_effort"] = null
          else if (typeof body["default_reasoning_effort"] === "string" && body["default_reasoning_effort"].length > 0) {
            patch["default_reasoning_effort"] = body["default_reasoning_effort"]
          }
          if (body["executor"] === null) patch["executor"] = null
          else if (body["executor"] === "echo" || body["executor"] === "acp") patch["executor"] = body["executor"]
          sendJson(response, 200, await admin.saveConfig(patch))
          return
        }
        if (action === "connect") {
          const body = await readJsonBody(request)
          sendJson(response, 200, await admin.connect(stringField(body, "peer")))
          return
        }
        if (action === "disconnect") {
          sendJson(response, 200, await admin.disconnect())
          return
        }
        if (action === "reset") {
          sendJson(response, 200, await admin.reset())
          return
        }
        if (action !== "approve" && action !== "deny" && action !== "cancel") {
          sendJson(response, 404, { error: "not_found" })
          return
        }
        const body = await readJsonBody(request)
        const peer = stringField(body, "peer")
        const taskId = stringField(body, "task_id")
        if (action === "approve") {
          sendJson(response, 200, { task: await admin.approve(peer, taskId) })
          return
        }
        if (action === "deny") {
          const reason = typeof body["reason"] === "string" ? body["reason"] : undefined
          sendJson(response, 200, { task: await admin.deny(peer, taskId, reason) })
          return
        }
        sendJson(response, 200, { task: await admin.cancel(peer, taskId) })
        return
      }
      sendJson(response, 404, { error: "not_found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(response, 400, { error: message })
    }
  }
}

/** The single prefix route registered with the DSH web server. */
export function podApiRoute(admin: PodAdmin): WebServerRoute {
  const handler = createPodApiHandler(admin)
  return {
    kind: "prefix",
    path: POD_API_PREFIX,
    handler: (request, response) => handler(request, response),
  }
}

/** Structural subset of Cordis' `ctx.inject`, which may be absent in smoke hosts. */
interface InjectingContext extends HostContext {
  inject?(dependencies: string[], callback: (sub: { webServer?: WebServerLike }) => void): void
}

/**
 * Register the panel route on the host web server.
 *
 * Registration is fenced behind `inject(['webServer'])` so a host without a web
 * UI (ACP, CLI) simply skips the panel instead of failing startup.
 */
export function registerPodWeb(ctx: HostContext, admin: PodAdmin, logger: HostLogger): void {
  const route = podApiRoute(admin)
  const install = (server: WebServerLike): void => {
    ctx.effect(() => {
      const off = server.register(route)
      return () => {
        off?.()
      }
    }, "orca-pod.panel-route")
  }

  const injecting = ctx as InjectingContext
  if (typeof injecting.inject === "function") {
    injecting.inject(["webServer"], (sub) => {
      const server = sub.webServer
      if (server === undefined) {
        logger.warn("orca-pod: web UI server unavailable; panel route disabled")
        return
      }
      install(server)
    })
    return
  }
  if (injecting.webServer !== undefined) {
    install(injecting.webServer)
    return
  }
  logger.warn("orca-pod: web UI server unavailable; panel route disabled")
}
