/**
 * The one description of a node's settings: every field is declared once in
 * `FIELDS` with its schema, default and who may edit it. `config.json`, the
 * DSH plugin `Config`, the panel and the install/CLI flags all go
 * through `parseSettings`; nothing else validates a setting.
 */

import { z } from "zod";

import { normalizePeerUrl } from "../transport/net.ts";
import { DEFAULT_PORT } from "../protocol/constants.ts";
import { HarnessError } from "@deepseek-ai/dsh-error";
import { credentialRef, isCredentialRefName, type CredentialRef } from "@deepseek-ai/dsh-credentials";
import { ModelOffersSchema, ModelSelectionSchema, ReasoningEffortSchema } from "../protocol/model.ts";
import { SandboxModeSchema } from "../protocol/permission.ts";
import { WorkgroupIdSchema, normalizeEndpoints } from "../protocol/peer.ts";
import { errorMessage } from "../kernel/errors.ts";
import { isRecord, parseSchema, type SchemaIssue } from "../kernel/schema.ts";
import { EXECUTOR_KINDS } from "../execution/kinds.ts";
import { AcpExecutorConfigSchema } from "../execution/acp/config.ts";

const NonEmpty = z.string().min(1);
const PositiveNumber = z.number().positive();
const PositiveInteger = z.number().int().min(1);

const ExecutorKindSchema = z.enum(EXECUTOR_KINDS);

type Field<T> = {
  /** Validates one present value and returns its canonical form; issue paths are relative to the field. */
  schema: z.ZodType<T>;
  /** Applied when the value is absent or `null` (readonly, so a literal like `[]` keeps its field's metadata typed). */
  default?: Readonly<T>;
  /** The panel may set it. */
  panel?: true;
  /** Plugin-only: not written to `config.json`. */
  local?: true;
};

function field<T, const M extends Omit<Field<T>, "schema"> = Record<never, never>>(
  schema: z.ZodType<T>,
  meta?: M,
): Field<T> & M {
  return { schema, ...meta } as Field<T> & M;
}

/** Advertised endpoints; empty is allowed, they are then derived from the listen address (§3.2). */
const EndpointsSchema = z.array(z.string()).transform((value, ctx) => {
  if (value.length === 0) return [];
  const endpoints = normalizeEndpoints(value);
  if (endpoints !== null) return endpoints;
  ctx.addIssue({ code: "custom", message: "must be 1-8 http(s) URLs" });
  return z.NEVER;
});

/** Peer addresses in canonical URL form, deduplicated. */
const PeersSchema = z.array(z.string()).transform((value, ctx) => {
  try {
    return [...new Set(value.map((peer) => normalizePeerUrl(peer)))];
  } catch (error) {
    ctx.addIssue({ code: "custom", message: errorMessage(error) });
    return z.NEVER;
  }
});

/** A DSH credential reference, by DSH's own grammar (an environment-variable style name). */
const CredentialRefSchema = z
  .string()
  .refine(isCredentialRefName, "must be an environment-variable style name ([A-Za-z_][A-Za-z0-9_]*)")
  .transform(credentialRef);

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
): CredentialRef | undefined {
  if (settings.workgroup_password_ref !== undefined) return settings.workgroup_password_ref;
  if (settings.workgroup_id === undefined) return undefined;
  return credentialRef(`ORCA_POD_PASSWORD_${settings.workgroup_id.toUpperCase().replaceAll("-", "_")}`);
}

/** The field table: the single place a setting's type, default and editability live. */
const FIELDS = {
  /** Unset until the panel wizard (or the CLI) picks one. */
  workgroup_id: field(WorkgroupIdSchema, { panel: true }),
  /**
   * Plaintext input only (CLI, install, and the in-memory effective config of
   * the plugin): it derives the workgroup key and is never persisted. Empty
   * means "not configured yet". The plugin config refuses it: there the password
   * lives in the DSH credential store under `workgroup_password_ref` (§7.3).
   */
  workgroup_password: field(z.string(), { default: "", panel: true, local: true }),
  /**
   * Plugin only: name of the DSH credential reference holding the workgroup
   * password. Unset means the name derived from the workgroup id
   * (`passwordRefFor`), so two workgroups never share a stored password.
   */
  workgroup_password_ref: field(CredentialRefSchema, { local: true }),
  /** Defaults to the shortened orca node id. */
  display_name: field(NonEmpty, { panel: true }),
  /** Listen address; `127.0.0.1` keeps a fresh install local until an interface is chosen. */
  bind_host: field(NonEmpty, { default: "127.0.0.1", panel: true }),
  /** Listen port; 0 picks a free one. */
  port: field(z.number().int().min(0).max(65535), { default: DEFAULT_PORT, panel: true }),
  /** Advertised dial URLs, best first; empty derives them from the listen address (§3.2). */
  endpoints: field(EndpointsSchema, { default: [], panel: true }),
  /** Peers joined on startup (plugin only). */
  peers: field(PeersSchema, { default: [], panel: true, local: true }),
  /** Directory of config, identity and stores; defaults to `defaultDataRoot()`. */
  data_root: field(NonEmpty),
  /** Register the bundled `orca-node` skill with the host's skills service (plugin only). */
  skill_injection: field(z.boolean(), { default: false, local: true }),
  /** `acp` drives a real DSH ACP session; `echo` is the debugging script machine (§6.2). */
  executor: field(ExecutorKindSchema, { panel: true }),
  acp: field(AcpExecutorConfigSchema),
  /** Local ceiling for tasks this orca node runs; origin sessions can only narrow it (§7.10). */
  permission_mode: field(SandboxModeSchema, { panel: true }),
  /** Hard cap on a task's lifetime; peers see it as max_task_ttl_s (§6.9). */
  task_timeout_s: field(PositiveNumber, { panel: true }),
  /** Auto-reject parked approvals after this many seconds; unset waits forever (§7.12). */
  approval_timeout_s: field(PositiveNumber, { panel: true }),
  /** Inline result summary cap in bytes (§6.11). */
  result_max_bytes: field(PositiveInteger, { panel: true }),
  /** A new task is refused while the group workspace holds more bytes than this (§6.13). */
  max_workspace_bytes: field(PositiveInteger, { default: 5 * 1024 ** 3, panel: true }),
  /** ... or more files than this. */
  max_workspace_files: field(PositiveInteger, { default: 50_000, panel: true }),
  /** Timeout for one outbound A2A/cluster call; default 30s (§4.7). */
  request_timeout_ms: field(PositiveNumber),
  /** Allow candidate endpoints on public IPs (§7.7). */
  allow_public_peers: field(z.boolean(), { panel: true }),
  /** Reject loopback candidate endpoints; allowed by default for same-host meshes (§7.7). */
  allow_loopback_peers: field(z.boolean(), { panel: true }),
  /** Model routes an ACP executor may switch to; origins pick one per task (§6.15). */
  models: field(ModelOffersSchema),
  /** Default ACP session model when a task names none (§6.15). */
  default_model: field(ModelSelectionSchema),
  /** Default reasoning effort when a task names none; unset means the provider default (§6.15). */
  default_reasoning_effort: field(ReasoningEffortSchema, { panel: true }),
};

/** A field's value type: what its schema produces. */
type FieldValue<F> = F extends Field<infer T> ? T : never;
type FieldTable = typeof FIELDS;
/** Keys of the fields whose table entry has `M` (`{ default: unknown }`, `{ local: true }`, `{ panel: true }`). */
type KeysWith<M> = { [K in keyof FieldTable]: FieldTable[K] extends M ? K : never }[keyof FieldTable];

/**
 * Everything a node can be configured with, after parsing: derived from the
 * field table, so a field with a default is always present and the others may
 * be absent.
 */
export type Settings = { [K in KeysWith<{ default: unknown }>]: FieldValue<FieldTable[K]> } & {
  [K in Exclude<keyof FieldTable, KeysWith<{ default: unknown }>>]?: FieldValue<FieldTable[K]>;
};

/** The part of `Settings` that is persisted in `config.json`: everything but the `local` fields. */
export type NodeSettings = Omit<Settings, KeysWith<{ local: true }>>;

const FIELD_MAP: Record<string, Field<unknown>> = FIELDS;
const FIELD_LIST = Object.entries(FIELD_MAP);

/** Settings as the profile stores them: every key optional, `null` or absent means "default". */
export type ConfigFields = { [K in keyof Settings]?: Settings[K] | null };

/** A panel edit: the panel's own fields, a value sets one and `null` clears it back to its default. */
export type PanelPatch = Pick<ConfigFields, KeysWith<{ panel: true }>>;

/**
 * Checks a panel edit field by field against the same schemas `parseSettings`
 * uses; keys the panel may not edit are dropped. The merged result is checked
 * again as a whole by `parseSettings`, where fields can depend on each other.
 */
export const PanelPatchSchema = z.object(
  Object.fromEntries(
    FIELD_LIST.filter(([, meta]) => meta.panel === true).map(([key, meta]) => [key, meta.schema.nullable().optional()]),
  ),
) as unknown as z.ZodType<PanelPatch>;

/** Thrown by `parseSettings`; the plugin schema reports the same issues instead. */
export class ConfigValidationError extends HarnessError {
  readonly issues: SchemaIssue[];

  constructor(issues: SchemaIssue[]) {
    super(
      `invalid config: ${issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`,
      "INVALID_CONFIG",
    );
    this.issues = issues;
  }
}

/**
 * Parse untrusted settings (config.json, plugin config, panel patches, flags).
 * `undefined` and `null` both mean "unset": the default applies, so a panel
 * patch clears a field by sending `null`. Unknown keys are ignored.
 */
export function safeParseSettings(input: unknown): { value: Settings } | { issues: SchemaIssue[] } {
  if (!isRecord(input)) return { issues: [{ path: [], message: "expected an object" }] };
  const value: Record<string, unknown> = {};
  const issues: SchemaIssue[] = [];
  for (const [key, field] of FIELD_LIST) {
    const raw = input[key] ?? undefined;
    if (raw === undefined) {
      if (field.default !== undefined) value[key] = structuredClone(field.default);
      continue;
    }
    const result = parseSchema(field.schema, raw);
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

/** Drop the plugin-only settings, leaving what `config.json` holds. */
export function nodeSettings(settings: Settings): NodeSettings {
  return Object.fromEntries(Object.entries(settings).filter(([key]) => FIELD_MAP[key]?.local !== true)) as NodeSettings;
}
