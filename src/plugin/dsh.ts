/**
 * Minimal structural types for the DeepSeek Harness (Cordis) host surface.
 *
 * This workspace does not resolve `@deepseek-ai/*` packages (they are only
 * installed inside the running DSH installation), so the bundle keeps a local
 * mirror of the small host subset it uses instead of importing DSH runtime
 * packages. The authoritative definitions live in `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-skill`
 * and `@deepseek-ai/dsh-settings`.
 */

/** Cleanup returned from `ctx.effect`; Cordis awaits promise-returning disposers. */
export type Cleanup = () => void | Promise<void>;

/** One Cordis scope: lifecycle hooks bound to the owning fiber (plugin or agent). */
export interface HostFiber {
  effect(execute: () => Cleanup, label?: string): unknown;
}

/** One HTTP route served by the host web server on the DSH origin. */
export interface WebServerRoute {
  kind: "exact" | "prefix";
  path: string;
  handler(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): void | Promise<void>;
}

/** Host web server service (`ctx.webServer`): same-origin routes for the UI. */
export interface WebServerLike {
  register(route: WebServerRoute): Cleanup;
}

/** Subset of the Cordis logger service used for lifecycle messages. */
export interface HostLogger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** One model-facing content block; these tools only emit text. */
export interface ContentBlock {
  type: "text";
  text: string;
}

/**
 * Raw JSON Schema accepted by the DSH tool executor. The executor supports a
 * documented subset: `type`/`oneOf`/`properties`/`required`/
 * `additionalProperties`/`items`/`enum`/`const` plus annotations.
 */
export type RawJsonSchema = Record<string, unknown>;

/** Canonical output declaration of a registered tool. */
interface ToolOutputDefinition {
  /** Schema enforced against the value returned by `execute`. */
  schema: RawJsonSchema;
  /** Pure projection that turns the canonical value into model content. */
  render(args: unknown, value: unknown): ContentBlock[];
}

/**
 * Caller context the tool registry hands to a `when` predicate. A
 * predicate decides whether the tool is visible for this activation; it must
 * not have side effects.
 */
export interface ToolActivationContext {
  readonly agent?: ToolAgent;
  readonly modelSelection?: unknown;
  readonly signal?: AbortSignal;
}

/** Registration options accepted by `ctx.tools.register`. */
export interface ToolRegistrationOptions {
  /** Visibility predicate; a rejected promise counts as "not visible". */
  when?: (context: ToolActivationContext) => boolean | Promise<boolean>;
  /** Cooperative execution budget (milliseconds). */
  timeoutMs?: number;
}

/**
 * Registry-ready tool definition. The runtime contract additionally accepts
 * presentation hooks (`presentCall`/`presentResult`) and execution policy
 * metadata; none are needed by this bundle.
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: RawJsonSchema;
  output: ToolOutputDefinition;
  execute(args: unknown, exec?: ToolRunContext): Promise<unknown>;
}

/** User-role notice the bundle hands back to the dispatching agent. */
export interface AgentNotice {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "orca-pod"; form: "notice"; summary: string };
}

/**
 * The DSH Agent subset needed by `orca_pod`'s send method: identify the caller, observe
 * whether its turn is in flight, and return a notice to it later.
 */
export interface ToolAgent {
  readonly id: string;
  readonly status: "idle" | "running";
  /**
   * Live session behind the agent. DSH passes the full Agent instance here, so
   * the optional session lets the bundle read that session's permission preset
   * (§7.10) without an extra registration-time service.
   */
  readonly session?: unknown;
  /**
   * Agent-scoped Cordis context: effects registered here dispose with the
   * agent, which is where per-agent bookkeeping belongs.
   */
  readonly ctx?: HostFiber;
  inject(message: AgentNotice): void;
  followup(message: AgentNotice): void;
}

/** Execution context passed to `ToolDefinition.execute`. */
export interface ToolExecution {
  agent?: ToolAgent;
}

/**
 * Per-call execution surface. `signal` aborts when the model turn is
 * cancelled; a tool forwards it to every piece of work it starts and stops
 * promptly instead of finishing an unobserved write.
 */
export interface ToolRunContext extends ToolExecution {
  readonly signal?: AbortSignal;
}

/**
 * Host agent registry. Background tracking persists the dispatching session id
 * with the dispatch log and looks the agent up here after a host restart (§8.3).
 */
export interface AgentsService {
  get(id: string): ToolAgent | undefined;
}

/** Tool registry service exposed to plugins as `ctx.tools`. */
export interface ToolRegistry {
  register(definition: ToolDefinition, options?: ToolRegistrationOptions): unknown;
}

/**
 * One session's effective permission knobs, as projected by DSH's
 * `permissionPresets` service. `sandbox` uses the same three values as the
 * orca node permission mode, so a task inherits it verbatim (§7.10).
 */
interface PermissionKnobs {
  readonly sandbox?: string | null;
  readonly approval?: string | null;
  readonly preset?: string | null;
}

/**
 * Read-only slice of DSH's `permissionPresets` service. The service resolves
 * per-session preset names and their sandbox/approval bundles; the bundle only
 * needs the projected knobs.
 */
export interface PermissionPresetsService {
  permissionState(session: unknown): PermissionKnobs;
}

/** One provider the running harness can serve (§6.15). */
export interface LlmProvider {
  id?: unknown;
  name?: unknown;
}

/** One model of a provider. */
export interface LlmModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

/** Subset of the DSH `llm` service used to enumerate the model catalog. */
export interface LlmCatalogService {
  listProviders(): LlmProvider[] | Promise<LlmProvider[]>;
  listModels(provider: string): Promise<LlmModel[]>;
}

/** Subset of the DSH `agent-default-model` service. */
export interface AgentDefaultModelService {
  currentSelection(): {
    provider?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    reasoning_effort?: unknown;
  };
}

/** Whether the model and the human can invoke one skill. */
export interface SkillInvocationPolicy {
  readonly modelInvocable: boolean;
  readonly userInvocable: boolean;
}

/** Base a loaded skill body resolves its relative resources against. */
export type SkillResourceBase =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "opaque"; readonly description: string };

/**
 * Runtime skill contribution accepted by `ctx.skills.register`. The
 * registry keeps the body in memory; nothing is copied onto a user skill root.
 */
export interface SkillRegistration {
  readonly name: string;
  readonly description: string;
  readonly whenToUse?: string;
  /** Markdown body, frontmatter removed. */
  readonly content: string;
  readonly source?: string;
  /** Instruction file path reported by discovery, when the skill has one. */
  readonly path?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly resourceBase?: SkillResourceBase;
  /** Omitted permits both model and user surfaces. */
  readonly invocation?: SkillInvocationPolicy;
}

/** Skill registry service (`ctx.skills`). */
export interface SkillsService {
  register(skill: SkillRegistration): Cleanup;
}

/** A value `credentials.resolve` found, and the layer that supplied it. */
export interface ResolvedCredential {
  readonly value: string;
  readonly source: string;
}

/**
 * DSH credential seam (`ctx.credentials`, `@deepseek-ai/dsh-credentials`).
 * References are POSIX-identifier names; the runtime brand is a plain string.
 * `resolve` reads the stored value first, then the launching environment and
 * the `.env` files; an empty stored value counts as absent.
 */
export interface CredentialsService {
  resolve(ref: string): Promise<ResolvedCredential | undefined>;
  set(ref: string, value: string): Promise<void>;
  unset(ref: string): Promise<void>;
}

/** The Loader entry a plugin was mounted from (`ctx.fiber.entry`). */
export interface LoaderEntry {
  readonly id: string;
  readonly options: { readonly id: string; readonly config?: unknown };
}

/**
 * Profile config writer (`ctx.configEditor`, `@deepseek-ai/dsh-config-editor`).
 * `edit` validates the next raw config through the plugin's `Config`, writes it
 * to the profile patch (0600) and reconciles the Loader, which restarts the
 * plugin with the new config before the promise settles.
 */
export interface ConfigEditorService {
  edit(
    entry: LoaderEntry,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>;
}

/** Settings service subset used to take over the plugin's settings page. */
export interface SettingsService {
  configure(presentation: { readonly auto?: boolean }, owner?: HostFiber): Cleanup;
}

/** Payload of `agent/inbox/claimed`: the agent started consuming one inbox message. */
export interface InboxClaimed {
  agent: { readonly id: string };
  /** `source.kind` is `"user"` for a message the person typed. */
  message: { readonly source?: { readonly kind?: string } };
  turn: number;
}

/** Payload of `agent/created`: a new agent finished factory setup. */
export interface AgentCreated {
  readonly agent: ToolAgent;
  readonly source?: unknown;
  readonly signal?: AbortSignal;
}

/** Every host service this bundle consumes; `ctx.inject` fences on a subset of these names. */
export interface HostServices {
  tools: ToolRegistry;
  webServer: WebServerLike;
  agents: AgentsService;
  permissionPresets: PermissionPresetsService;
  llm: LlmCatalogService;
  agentDefaultModel: AgentDefaultModelService;
  skills: SkillsService;
  settings: SettingsService;
}

/** Cordis plugin context subset available to a host-side bundle; DSH provides every member. */
export interface HostContext {
  /** Hard dependency declared through `inject`. */
  tools: ToolRegistry;
  /** Hard dependency: where the workgroup password is kept (§7.3). */
  credentials: CredentialsService;
  /** Hard dependency: how the panel persists the plugin config. */
  configEditor: ConfigEditorService;
  logger: HostLogger;
  /**
   * The loader's base URL (`Loader.Config.baseUrl`): for a profile-scoped host
   * this is the profile directory, which is the DSH-provided answer to "which
   * profile am I". May be absent when the host does not set one.
   */
  baseUrl?: string;
  /** This plugin instance's fiber: owns the settings page policy and names the Loader entry. */
  fiber: HostFiber & { readonly entry?: LoaderEntry };
  /** Register a lifecycle cleanup that Cordis runs when the fiber unloads. */
  effect(execute: () => Cleanup, label?: string): unknown;
  /** Listen to `agent/inbox/claimed` for the lifetime of the plugin fiber. */
  on(event: "agent/inbox/claimed", listener: (payload: InboxClaimed) => void): unknown;
  /** Listen to `agent/created` for the lifetime of the plugin fiber. */
  on(event: "agent/created", listener: (payload: AgentCreated) => void): unknown;
  /**
   * Cordis dependency fence: runs `callback` in a child scope once every named
   * service is available. When a service goes away or is replaced, the child
   * scope is disposed (its effects run) and the callback runs again in a fresh
   * one. Optional services are declared this way rather than looked up.
   */
  inject<K extends keyof HostServices>(
    dependencies: readonly K[],
    callback: (scope: InjectedScope<K>) => void,
  ): unknown;
}

/**
 * The child scope handed to an `inject` callback: the fenced services plus the
 * scope's own `effect`. Anything registered inside the callback must use this
 * `effect`, so it is disposed together with the services it was registered on.
 */
export type InjectedScope<K extends keyof HostServices> = Pick<HostServices, K> & HostFiber;

/** One Standard Schema validation issue. */
interface StandardIssue {
  message: string;
  path?: ReadonlyArray<string | number>;
}

/** Standard Schema (v1) validation result. */
type StandardResult<T> = { value: T } | { issues: StandardIssue[] };

/**
 * Standard Schema v1 validator. Cordis accepts any Standard Schema as a
 * plugin's `Config`; Schemastery is only the ecosystem convenience wrapper.
 */
export interface StandardSchemaV1<T> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardResult<T>;
  };
}
