/**
 * Minimal structural types for the DeepSeek Harness (Cordis) host surface.
 *
 * This workspace does not resolve `@deepseek-ai/*` packages (they are only
 * installed inside the running DSH installation), so the bundle keeps a local
 * mirror of the small host subset it uses instead of importing DSH runtime
 * packages. The authoritative definitions live in `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-llm` and `@deepseek-ai/dsh-tools`.
 */

/** Cleanup returned from `ctx.effect`; Cordis awaits promise-returning disposers. */
export type Cleanup = () => void | Promise<void>

/** One HTTP route served by the host web server on the DSH origin. */
export interface WebServerRoute {
  kind: "exact" | "prefix"
  path: string
  handler(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): void | Promise<void>
}

/** Host web server service (`ctx.webServer`): same-origin routes for the UI. */
export interface WebServerLike {
  register(route: WebServerRoute): Cleanup
}

/** Services visible before and after an `ctx.inject` fence. */
export interface HostWebContext {
  webServer?: WebServerLike
}

/** Subset of the Cordis logger service used for lifecycle messages. */
export interface HostLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

/** One model-facing content block; these tools only emit text. */
export interface ContentBlock {
  type: "text"
  text: string
}

/**
 * Raw JSON Schema accepted by the DSH tool executor. The executor supports a
 * documented subset: `type`/`oneOf`/`properties`/`required`/
 * `additionalProperties`/`items`/`enum`/`const` plus annotations.
 */
export type RawJsonSchema = Record<string, unknown>

/** Canonical output declaration of a registered tool. */
export interface ToolOutputDefinition {
  /** Schema enforced against the value returned by `execute`. */
  schema: RawJsonSchema
  /** Pure projection that turns the canonical value into model content. */
  render(args: unknown, value: unknown): ContentBlock[]
}

/**
 * Registry-ready tool definition. The runtime contract additionally accepts
 * presentation hooks (`presentCall`/`presentResult`) and execution policy
 * metadata; none are needed by this bundle.
 */
export interface ToolDefinition {
  name: string
  description: string
  parameters: RawJsonSchema
  output: ToolOutputDefinition
  execute(args: unknown, exec?: ToolExecution): Promise<unknown>
}

/** User-role notice the bundle hands back to the dispatching agent. */
export interface AgentNotice {
  id: string
  role: "user"
  content: [{ type: "text"; text: string }]
  source: { kind: "orca-pod" | "tool-jobs"; form: "notice"; summary: string }
}

/**
 * The DSH Agent subset needed by `orca_pod`'s send method: identify the caller, observe
 * whether its turn is in flight, and return a notice to it later.
 */
export interface ToolAgent {
  readonly id: string
  readonly status: "idle" | "running"
  /**
   * Live session behind the agent. DSH passes the full Agent instance here, so
   * the optional session lets the bundle read that session's permission preset
   * (§7.10) without an extra registration-time service.
   */
  readonly session?: unknown
  inject(message: AgentNotice): void
  followup(message: AgentNotice): void
}

/** Execution context passed to `ToolDefinition.execute`. */
export interface ToolExecution {
  agent?: ToolAgent
}

/** Tool registry service exposed to plugins as `ctx.tools`. */
export interface ToolRegistry {
  register(definition: ToolDefinition, options?: Record<string, unknown>): unknown
}

/** Closed set of decisions the DSH approval service returns. */
export type ApprovalOutcome = "allowed-once" | "rejected" | "cancelled" | "unavailable"

/** One pending human decision; `agent` is the live agent whose turn asks. */
export interface ApprovalRequest {
  agent: { readonly id: string }
  toolName: string
  reason?: string
  signal?: AbortSignal
}

/** DSH approval service: asks the human through the host's approval card. */
export interface ApprovalService {
  request(req: ApprovalRequest): Promise<ApprovalOutcome>
}

/**
 * One session's effective permission knobs, as projected by DSH's
 * `permissionPresets` service. `sandbox` uses the same three values as the
 * orca node permission mode, so a task inherits it verbatim (§7.10).
 */
export interface PermissionKnobs {
  readonly sandbox?: string | null
  readonly approval?: string | null
  readonly preset?: string | null
}

/**
 * Read-only slice of DSH's `permissionPresets` service. The service resolves
 * per-session preset names and their sandbox/approval bundles; the bundle only
 * needs the projected knobs.
 */
export interface PermissionPresetsService {
  permissionState(session: unknown): PermissionKnobs
}

/** Cordis plugin context subset available to a host-side bundle. */
export interface HostContext {
  /** Hard dependency declared through `inject = ['tools']`. */
  tools: ToolRegistry
  /** Register a lifecycle cleanup that Cordis runs when the fiber unloads. */
  effect(execute: () => Cleanup, label?: string): unknown
  /** Logger service; DSH always provides it, the fallback exists for smoke hosts. */
  logger?: HostLogger
  /** Approval service; present when the host exposes human approvals. */
  approval?: ApprovalService
  /** Same-origin web server, present when the host serves a web UI. */
  webServer?: WebServerLike
  /** Cordis dependency fence; runs `callback` once the services appear. */
  inject?(dependencies: string[], callback: (sub: HostWebContext) => void): void
  /** Contextual service lookup that does not require an `inject` declaration. */
  get?(name: string): unknown
}

/** One Standard Schema validation issue. */
export interface StandardIssue {
  message: string
  path?: ReadonlyArray<string | number>
}

/** Standard Schema (v1) validation result. */
export type StandardResult<T> = { value: T } | { issues: StandardIssue[] }

/**
 * Standard Schema v1 validator. Cordis accepts any Standard Schema as a
 * plugin's `Config`; Schemastery is only the ecosystem convenience wrapper.
 */
export interface StandardSchemaV1<T> {
  readonly "~standard": {
    readonly version: 1
    readonly vendor: string
    validate(value: unknown): StandardResult<T>
  }
}
