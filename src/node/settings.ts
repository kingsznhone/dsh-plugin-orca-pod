/**
 * The one description of a node's settings: every field is declared once in
 * `FIELDS` with its parser, default and who may edit it. `config.json`, the
 * DSH plugin `Config`, the panel and the install/CLI flags all go
 * through `parseSettings`; nothing else validates a setting.
 */

import { normalizePeerUrl } from "../transport/net.ts";
import {
  DEFAULT_PORT,
  isModelSelection,
  isPermissionMode,
  isReasoningEffort,
  isRecord,
  isWorkgroupId,
  normalizeEndpoints,
  type ModelOffer,
  type ModelSelection,
  type PermissionMode,
} from "../protocol/index.ts";

type ExecutorKind = "echo" | "acp";

/** One MCP server handed to the ACP session at session/new (§6.15). */
export type AcpMcpServer = {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

/** ACP executor options: the `dsh --profile acp` stdio server (§6.15). */
export type AcpExecutorConfig = {
  command?: string;
  profile?: string;
  extra_args?: string[];
  /** MCP servers passed to session/new — how an ACP agent gets extra tools. */
  mcp_servers?: AcpMcpServer[];
};

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

type Field<T> = {
  /** Validates one present value; throws a message that completes "<key> ...". */
  parse: (raw: unknown) => T;
  /** Applied when the value is absent or `null`. */
  default?: T;
  /** The panel may set it. */
  panel?: true;
  /** Plugin-only: not written to `config.json`. */
  local?: true;
};

function fail(message: string): never {
  throw new Error(message);
}

const nonEmpty = (raw: unknown): string =>
  typeof raw === "string" && raw.length > 0 ? raw : fail("must be a non-empty string");
const flag = (raw: unknown): boolean => (typeof raw === "boolean" ? raw : fail("must be a boolean"));
const positiveNumber = (raw: unknown): number =>
  typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fail("must be a positive number");
const positiveInteger = (raw: unknown): number =>
  typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : fail("must be a positive integer");

function strings(raw: unknown, what: string): string[] {
  return Array.isArray(raw) && raw.every((item) => typeof item === "string")
    ? (raw as string[])
    : fail(`${what} must be a string array`);
}

function parseEndpoints(raw: unknown): string[] {
  if (Array.isArray(raw) && raw.length === 0) return [];
  return normalizeEndpoints(raw) ?? fail("must be 1-8 http(s) URLs");
}

function parsePeers(raw: unknown): string[] {
  if (!Array.isArray(raw)) fail("must be an array of peer addresses");
  return [
    ...new Set(
      raw.map((peer) => normalizePeerUrl(typeof peer === "string" ? peer : fail("must be an array of peer addresses"))),
    ),
  ];
}

export const MAX_MODEL_OFFERS = 128;

/** Validate the advertised model catalog (§6.15). */
export function validateModelOffers(raw: unknown): ModelOffer[] {
  if (!Array.isArray(raw)) fail("must be an array");
  if (raw.length > MAX_MODEL_OFFERS) fail(`must have at most ${MAX_MODEL_OFFERS} entries`);
  return raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`[${index}] must be an object`);
    const { provider, model, name, description } = entry;
    if (typeof provider !== "string" || provider.length === 0) fail(`[${index}].provider must be a non-empty string`);
    if (typeof model !== "string" || model.length === 0) fail(`[${index}].model must be a non-empty string`);
    if (name !== undefined && typeof name !== "string") fail(`[${index}].name must be a string`);
    if (description !== undefined && typeof description !== "string") fail(`[${index}].description must be a string`);
    return { provider, model, name, description };
  });
}

/** Validate one provider/model route, optionally pinned to a reasoning effort. */
export function validateModelSelection(raw: unknown): ModelSelection {
  return isModelSelection(raw) ? raw : fail("must name a provider, model and optional reasoning_effort");
}

function parseAcp(raw: unknown): AcpExecutorConfig {
  if (!isRecord(raw)) fail("must be an object");
  const { command, profile, extra_args, mcp_servers } = raw;
  const acp: AcpExecutorConfig = {};
  if (command !== undefined) acp.command = nonEmpty(command);
  if (profile !== undefined) acp.profile = nonEmpty(profile);
  if (extra_args !== undefined) acp.extra_args = strings(extra_args, "extra_args");
  if (mcp_servers !== undefined) {
    if (!Array.isArray(mcp_servers)) fail("mcp_servers must be an array");
    acp.mcp_servers = mcp_servers.map((item, index) => {
      const at = `mcp_servers[${index}]`;
      if (!isRecord(item)) fail(`${at} must be an object`);
      const { name, command: serverCommand, args, env } = item;
      if (typeof name !== "string" || name.length === 0) fail(`${at}.name must be a non-empty string`);
      if (typeof serverCommand !== "string" || serverCommand.length === 0)
        fail(`${at}.command must be a non-empty string`);
      const server: AcpMcpServer = { name, command: serverCommand };
      if (args !== undefined) server.args = strings(args, `${at}.args`);
      if (env !== undefined) {
        if (!isRecord(env) || Object.values(env).some((value) => typeof value !== "string")) {
          fail(`${at}.env must be an object of strings`);
        }
        server.env = env as Record<string, string>;
      }
      return server;
    });
  }
  return acp;
}

/** A DSH credential reference is a POSIX shell identifier (it doubles as an environment variable name). */
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  workgroup_id: {
    parse: (raw) => (isWorkgroupId(raw) ? raw : fail("must match [a-z0-9][a-z0-9-]{1,31}")),
    panel: true,
  },
  workgroup_password: {
    parse: (raw) => (typeof raw === "string" ? raw : fail("must be a string")),
    default: "",
    panel: true,
    local: true,
  },
  workgroup_password_ref: {
    parse: (raw) =>
      typeof raw === "string" && CREDENTIAL_REF_PATTERN.test(raw)
        ? raw
        : fail("must be an environment-variable style name ([A-Za-z_][A-Za-z0-9_]*)"),
    local: true,
  },
  display_name: { parse: nonEmpty, panel: true },
  bind_host: { parse: nonEmpty, default: "127.0.0.1", panel: true },
  port: {
    parse: (raw) =>
      typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= 65535
        ? raw
        : fail("must be an integer between 0 and 65535"),
    default: DEFAULT_PORT,
    panel: true,
  },
  endpoints: { parse: parseEndpoints, default: [], panel: true },
  peers: { parse: parsePeers, default: [], panel: true, local: true },
  data_root: { parse: nonEmpty },
  skill_injection: { parse: flag, default: false, local: true },
  executor: { parse: (raw) => (raw === "echo" || raw === "acp" ? raw : fail('must be "echo" or "acp"')), panel: true },
  acp: { parse: parseAcp },
  permission_mode: {
    parse: (raw) =>
      isPermissionMode(raw) ? raw : fail('must be "read-only", "workspace-write", or "danger-full-access"'),
    panel: true,
  },
  task_timeout_s: { parse: positiveNumber, panel: true },
  approval_timeout_s: { parse: positiveNumber, panel: true },
  result_max_bytes: { parse: positiveInteger, panel: true },
  max_input_files: { parse: positiveInteger, panel: true },
  max_input_bytes: { parse: positiveInteger, panel: true },
  max_workspace_bytes: { parse: positiveInteger, default: 5 * 1024 ** 3, panel: true },
  max_workspace_files: { parse: positiveInteger, default: 50_000, panel: true },
  max_blob_store_bytes: { parse: positiveInteger, default: 5 * 1024 ** 3, panel: true },
  request_timeout_ms: { parse: positiveNumber },
  allow_public_peers: { parse: flag, panel: true },
  allow_loopback_peers: { parse: flag, panel: true },
  models: { parse: validateModelOffers },
  default_model: { parse: validateModelSelection },
  default_reasoning_effort: {
    parse: (raw) => (isReasoningEffort(raw) ? raw : fail("must be a non-empty reasoning-effort string")),
    panel: true,
  },
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
    try {
      value[key] = field.parse(raw);
    } catch (error) {
      issues.push({ path: [key], message: (error as Error).message });
    }
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
