/**
 * The one description of a node's settings: every field is declared once in
 * `FIELDS` with its schema, default and who may edit it. `config.json`, the
 * DSH plugin `Config`, the panel and the install/CLI flags all go
 * through `parseSettings`; nothing else validates a setting.
 */

import Type, { type Static, type TSchema } from "typebox";

import { normalizePeerUrl } from "../transport/net.ts";
import {
  DEFAULT_PORT,
  ModelOffersSchema,
  ModelSelectionSchema,
  PermissionModeSchema,
  ReasoningEffortSchema,
  WorkgroupIdSchema,
  normalizeEndpoints,
  type ModelOffer,
  type ModelSelection,
  type PermissionMode,
} from "../protocol/index.ts";
import { errorMessage, isRecord, parseSchema, type SchemaIssue } from "../kernel/index.ts";

const NonEmpty = Type.String({ minLength: 1 });
const PositiveNumber = Type.Number({ exclusiveMinimum: 0 });
const PositiveInteger = Type.Integer({ minimum: 1 });

const ExecutorKindSchema = Type.Enum(["echo", "acp"]);
type ExecutorKind = Static<typeof ExecutorKindSchema>;

/** One MCP server handed to the ACP session at session/new (§6.15). */
const AcpMcpServerSchema = Type.Object({
  name: NonEmpty,
  command: NonEmpty,
  args: Type.Optional(Type.Array(Type.String())),
  env: Type.Optional(Type.Record(Type.String(), Type.String())),
});
export type AcpMcpServer = Static<typeof AcpMcpServerSchema>;

/** ACP executor options: the `dsh --profile acp` stdio server (§6.15). */
const AcpExecutorConfigSchema = Type.Object({
  command: Type.Optional(NonEmpty),
  profile: Type.Optional(NonEmpty),
  extra_args: Type.Optional(Type.Array(Type.String())),
  /** MCP servers passed to session/new — how an ACP agent gets extra tools. */
  mcp_servers: Type.Optional(Type.Array(AcpMcpServerSchema)),
});
export type AcpExecutorConfig = Static<typeof AcpExecutorConfigSchema>;

/** Everything a node can be configured with, after parsing (defaults applied). */
export interface Settings {
  /** Unset until the panel wizard (or the CLI) picks one. */
  workgroup_id?: string;
  /**
   * Plaintext input only (CLI, install, and the in-memory effective config of
   * the plugin): it derives the workgroup key and is never persisted. Empty
   * means "not configured yet". The plugin config refuses it: there the password
   * lives in the DSH credential store under `workgroup_password_ref` (§7.3).
   */
  workgroup_password: string;
  /**
   * Plugin only: name of the DSH credential reference holding the workgroup
   * password. Unset means the name derived from the workgroup id
   * (`passwordRefFor`), so two workgroups never share a stored password.
   */
  workgroup_password_ref?: string;
  /** Defaults to the shortened orca node id. */
  display_name?: string;
  /** Listen address; `127.0.0.1` keeps a fresh install local until an interface is chosen. */
  bind_host: string;
  /** Listen port; 0 picks a free one. */
  port: number;
  /** Advertised dial URLs, best first; empty derives them from the listen address (§3.2). */
  endpoints: string[];
  /** Peers joined on startup (plugin only). */
  peers: string[];
  /** Directory of config, identity and stores; defaults to `defaultDataRoot()`. */
  data_root?: string;
  /** Register the bundled `orca-node` skill with the host's skills service (plugin only). */
  skill_injection: boolean;
  /** `acp` drives a real DSH ACP session; `echo` is the debugging script machine (§6.2). */
  executor?: ExecutorKind;
  acp?: AcpExecutorConfig;
  /** Local ceiling for tasks this orca node runs; origin sessions can only narrow it (§7.10). */
  permission_mode?: PermissionMode;
  /** Hard cap on a task's lifetime; peers see it as max_task_ttl_s (§6.9). */
  task_timeout_s?: number;
  /** Auto-reject parked approvals after this many seconds; unset waits forever (§7.12). */
  approval_timeout_s?: number;
  /** Inline result summary cap in bytes (§6.11). */
  result_max_bytes?: number;
  /** Max number of task inputs one origin may attach (§6.7). */
  max_input_files?: number;
  /** Max total bytes of task inputs materialized per task (§6.7). */
  max_input_bytes?: number;
  /** A new task is refused while the group workspace holds more bytes than this (§6.13). */
  max_workspace_bytes: number;
  /** ... or more files than this. */
  max_workspace_files: number;
  /** Total size of the blob store; uploads that would pass it are refused (§5.6). */
  max_blob_store_bytes: number;
  /** Timeout for one outbound A2A/cluster call; default 30s (§4.7). */
  request_timeout_ms?: number;
  /** Allow candidate endpoints on public IPs (§7.7). */
  allow_public_peers?: boolean;
  /** Reject loopback candidate endpoints; allowed by default for same-host meshes (§7.7). */
  allow_loopback_peers?: boolean;
  /** Model routes an ACP executor may switch to; origins pick one per task (§6.15). */
  models?: ModelOffer[];
  /** Default ACP session model when a task names none (§6.15). */
  default_model?: ModelSelection;
  /** Default reasoning effort when a task names none; unset means the provider default (§6.15). */
  default_reasoning_effort?: string;
}

/** Settings the plugin keeps for itself; they never reach `config.json`. */
type LocalKey = "workgroup_password" | "workgroup_password_ref" | "peers" | "skill_injection";

/** The part of `Settings` that is persisted in `config.json`. */
export type NodeSettings = Omit<Settings, LocalKey>;

type FieldResult<T> = { ok: true; value: T } | { ok: false; issue: SchemaIssue };

type Field<T> = {
  /** Validates one present value; issue paths are relative to the field. */
  parse: (raw: unknown) => FieldResult<T>;
  /** Applied when the value is absent or `null`. */
  default?: T;
  /** The panel may set it. */
  panel?: true;
  /** Plugin-only: not written to `config.json`. */
  local?: true;
};

type FieldOptions<S extends TSchema, T> = {
  /**
   * Checks the schema cannot express (URLs) and the canonical form, run on a
   * value that matched the schema; throws a message that completes "<key> ...".
   */
  normalize?: (value: Static<S>) => T;
  default?: T;
  panel?: true;
  local?: true;
};

function field<S extends TSchema, T = Static<S>>(schema: S, options: FieldOptions<S, T> = {}): Field<T> {
  const { normalize, ...meta } = options;
  return {
    ...meta,
    parse: (raw) => {
      const result = parseSchema(schema, raw);
      if (!result.ok || normalize === undefined) return result as FieldResult<T>;
      try {
        return { ok: true, value: normalize(result.value) };
      } catch (error) {
        return { ok: false, issue: { path: [], message: errorMessage(error) } };
      }
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

/** Empty is allowed: the endpoints are then derived from the listen address (§3.2). */
function normalizeEndpointList(value: string[]): string[] {
  if (value.length === 0) return [];
  return normalizeEndpoints(value) ?? fail("must be 1-8 http(s) URLs");
}

function normalizePeers(value: string[]): string[] {
  return [...new Set(value.map((peer) => normalizePeerUrl(peer)))];
}

/** A DSH credential reference is a POSIX shell identifier (it doubles as an environment variable name). */
const CredentialRefSchema = Type.String({ pattern: "^[A-Za-z_][A-Za-z0-9_]*$" });

/**
 * Credential reference of a workgroup's password: the explicit
 * `workgroup_password_ref`, else `ORCA_POD_PASSWORD_<WORKGROUP>` with the id
 * upper-cased and `-` turned into `_`. The DSH credential store is shared by
 * every profile of one DSH home, so the name is per workgroup: profiles in the
 * same workgroup share its password, profiles in different ones never collide.
 * It is also the environment variable a headless host can export instead.
 */
export function passwordRefFor(
  settings: Pick<Settings, "workgroup_id" | "workgroup_password_ref">,
): string | undefined {
  if (settings.workgroup_password_ref !== undefined) return settings.workgroup_password_ref;
  if (settings.workgroup_id === undefined) return undefined;
  return `ORCA_POD_PASSWORD_${settings.workgroup_id.toUpperCase().replaceAll("-", "_")}`;
}

/** The field table: the single place a setting's type, default and editability live. */
const FIELDS: { [K in keyof Settings]-?: Field<Exclude<Settings[K], undefined>> } = {
  workgroup_id: field(WorkgroupIdSchema, { panel: true }),
  workgroup_password: field(Type.String(), { default: "", panel: true, local: true }),
  workgroup_password_ref: field(CredentialRefSchema, { local: true }),
  display_name: field(NonEmpty, { panel: true }),
  bind_host: field(NonEmpty, { default: "127.0.0.1", panel: true }),
  port: field(Type.Integer({ minimum: 0, maximum: 65535 }), { default: DEFAULT_PORT, panel: true }),
  endpoints: field(Type.Array(Type.String()), { normalize: normalizeEndpointList, default: [], panel: true }),
  peers: field(Type.Array(Type.String()), { normalize: normalizePeers, default: [], panel: true, local: true }),
  data_root: field(NonEmpty),
  skill_injection: field(Type.Boolean(), { default: false, local: true }),
  executor: field(ExecutorKindSchema, { panel: true }),
  acp: field(AcpExecutorConfigSchema),
  permission_mode: field(PermissionModeSchema, { panel: true }),
  task_timeout_s: field(PositiveNumber, { panel: true }),
  approval_timeout_s: field(PositiveNumber, { panel: true }),
  result_max_bytes: field(PositiveInteger, { panel: true }),
  max_input_files: field(PositiveInteger, { panel: true }),
  max_input_bytes: field(PositiveInteger, { panel: true }),
  max_workspace_bytes: field(PositiveInteger, { default: 5 * 1024 ** 3, panel: true }),
  max_workspace_files: field(PositiveInteger, { default: 50_000, panel: true }),
  max_blob_store_bytes: field(PositiveInteger, { default: 5 * 1024 ** 3, panel: true }),
  request_timeout_ms: field(PositiveNumber),
  allow_public_peers: field(Type.Boolean(), { panel: true }),
  allow_loopback_peers: field(Type.Boolean(), { panel: true }),
  models: field(ModelOffersSchema),
  default_model: field(ModelSelectionSchema),
  default_reasoning_effort: field(ReasoningEffortSchema, { panel: true }),
};

const FIELD_MAP: Record<string, Field<unknown>> = FIELDS;
const FIELD_LIST = Object.entries(FIELD_MAP);

export interface SettingsIssue {
  path: string[];
  message: string;
}

/** Thrown by `parseSettings`; the plugin schema reports the same issues instead. */
export class ConfigValidationError extends Error {
  readonly issues: SettingsIssue[];

  constructor(issues: SettingsIssue[]) {
    super(
      `invalid config: ${issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`,
    );
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

/**
 * Parse untrusted settings (config.json, plugin config, panel patches, flags).
 * `undefined` and `null` both mean "unset": the default applies, so a panel
 * patch clears a field by sending `null`. Unknown keys are ignored.
 */
export function safeParseSettings(input: unknown): { value: Settings } | { issues: SettingsIssue[] } {
  if (!isRecord(input)) return { issues: [{ path: [], message: "expected an object" }] };
  const value: Record<string, unknown> = {};
  const issues: SettingsIssue[] = [];
  for (const [key, field] of FIELD_LIST) {
    const raw = input[key] ?? undefined;
    if (raw === undefined) {
      if (field.default !== undefined) value[key] = structuredClone(field.default);
      continue;
    }
    const result = field.parse(raw);
    if (result.ok) value[key] = result.value;
    else issues.push({ path: [key, ...result.issue.path], message: result.issue.message });
  }
  return issues.length > 0 ? { issues } : { value: value as unknown as Settings };
}

export function parseSettings(input: unknown): Settings {
  const result = safeParseSettings(input);
  if ("issues" in result) throw new ConfigValidationError(result.issues);
  return result.value;
}

/** Keep only the keys the panel may edit (`null` values kept: they clear a field). */
export function pickPanelFields(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([key]) => FIELD_MAP[key]?.panel === true));
}

/** Drop the plugin-only settings, leaving what `config.json` holds. */
export function nodeSettings(settings: Settings): NodeSettings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => FIELD_MAP[key]?.local !== true)) as NodeSettings;
}
