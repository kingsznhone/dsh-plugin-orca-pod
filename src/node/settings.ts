/**
 * A node's settings: `SettingsSchema` declares every setting once, with its
 * schema and default, and `PanelPatchSchema` names the ones the panel edits.
 * The settings file, the panel and the tests all go through `parseSettings`;
 * nothing else validates a setting.
 */

import { z } from "zod";

import { normalizePeerUrl } from "../core/net.ts";
import { DEFAULT_PORT, EXECUTOR_KINDS } from "../core/constants.ts";
import { HarnessError } from "@deepseek-ai/dsh-error";
import { ModelOffersSchema, ModelSelectionSchema, ReasoningEffortSchema } from "../core/wire/model.ts";
import { SandboxModeSchema } from "../core/wire/permission.ts";
import { WorkgroupIdSchema, normalizeEndpoints } from "../core/wire/peer.ts";
import { errorMessage } from "../core/errors.ts";
import { isRecord } from "../core/schema.ts";
import { AcpExecutorConfigSchema } from "../executor/acp/config.ts";

const NonEmpty = z.string().min(1);
const PositiveNumber = z.number().positive();
const PositiveInteger = z.number().int().min(1);

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

/** Every setting a node has: a field with a default is always present after parsing, the others may be absent. */
const SettingsSchema = z.object({
  /** Unset until the panel wizard picks one. */
  workgroup_id: WorkgroupIdSchema.optional(),
  /** Defaults to the shortened orca node id. */
  display_name: NonEmpty.optional(),
  /** Listen address; `127.0.0.1` keeps a fresh install local until an interface is chosen. */
  bind_host: NonEmpty.default("127.0.0.1"),
  /** Listen port; 0 picks a free one. */
  port: z.number().int().min(0).max(65535).default(DEFAULT_PORT),
  /** Advertised dial URLs, best first; empty derives them from the listen address (§3.2). */
  endpoints: EndpointsSchema.default([]),
  /** Peers joined on startup. */
  peers: PeersSchema.default([]),
  /** `acp` drives a real DSH ACP session; `echo` is the debugging script machine (§6.2). */
  executor: z.enum(EXECUTOR_KINDS).optional(),
  acp: AcpExecutorConfigSchema.optional(),
  /** Local ceiling for tasks this orca node runs; origin sessions can only narrow it (§7.10). */
  permission_mode: SandboxModeSchema.optional(),
  /** Hard cap on a task's lifetime; peers see it as max_task_ttl_s (§6.9). */
  task_timeout_s: PositiveNumber.optional(),
  /** Auto-reject parked approvals after this many seconds; unset waits forever (§7.12). */
  approval_timeout_s: PositiveNumber.optional(),
  /** Inline result summary cap in bytes (§6.11). */
  result_max_bytes: PositiveInteger.optional(),
  /** A new task is refused while the group workspace holds more bytes than this (§6.13). */
  max_workspace_bytes: PositiveInteger.default(5 * 1024 ** 3),
  /** ... or more files than this. */
  max_workspace_files: PositiveInteger.default(50_000),
  /** Timeout for one outbound A2A/cluster call; default 30s (§4.7). */
  request_timeout_ms: PositiveNumber.optional(),
  /** Allow candidate endpoints on public IPs (§7.7). */
  allow_public_peers: z.boolean().optional(),
  /** Reject loopback candidate endpoints; allowed by default for same-host meshes (§7.7). */
  allow_loopback_peers: z.boolean().optional(),
  /** Model routes an ACP executor may switch to; origins pick one per task (§6.15). */
  models: ModelOffersSchema.optional(),
  /** Default ACP session model when a task names none (§6.15). */
  default_model: ModelSelectionSchema.optional(),
  /** Default reasoning effort when a task names none; unset means the provider default (§6.15). */
  default_reasoning_effort: ReasoningEffortSchema.optional(),
});

export type Settings = z.output<typeof SettingsSchema>;

const { shape } = SettingsSchema;

/** A panel field: a value sets the setting, `null` clears it back to its default. */
function clearable<T extends z.ZodType>(schema: T) {
  return schema.nullable().optional();
}

/**
 * A panel edit: the settings the panel may set, checked one by one with the
 * setting's own schema (the merged result is checked again as a whole by
 * `parseSettings`), and the workgroup password, which goes to the credential
 * store and never to the settings file. Other keys are dropped.
 */
export const PanelPatchSchema = z.object({
  workgroup_id: clearable(shape.workgroup_id.unwrap()),
  /** Plaintext; it derives the workgroup key. The stored password is a DSH credential (section 3.6 of the plan). */
  workgroup_password: clearable(z.string()),
  display_name: clearable(shape.display_name.unwrap()),
  bind_host: clearable(shape.bind_host.unwrap()),
  port: clearable(shape.port.unwrap()),
  endpoints: clearable(shape.endpoints.unwrap()),
  peers: clearable(shape.peers.unwrap()),
  executor: clearable(shape.executor.unwrap()),
  permission_mode: clearable(shape.permission_mode.unwrap()),
  task_timeout_s: clearable(shape.task_timeout_s.unwrap()),
  approval_timeout_s: clearable(shape.approval_timeout_s.unwrap()),
  result_max_bytes: clearable(shape.result_max_bytes.unwrap()),
  max_workspace_bytes: clearable(shape.max_workspace_bytes.unwrap()),
  max_workspace_files: clearable(shape.max_workspace_files.unwrap()),
  allow_public_peers: clearable(shape.allow_public_peers.unwrap()),
  allow_loopback_peers: clearable(shape.allow_loopback_peers.unwrap()),
  default_reasoning_effort: clearable(shape.default_reasoning_effort.unwrap()),
});

export type PanelPatch = z.output<typeof PanelPatchSchema>;

/** Where a setting failed its schema and why. */
type SettingsIssue = { path: string[]; message: string };

/** Thrown by `parseSettings`, with every problem found. */
class ConfigValidationError extends HarnessError {
  readonly issues: SettingsIssue[];

  constructor(issues: SettingsIssue[]) {
    super(
      `invalid config: ${issues.map((issue) => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`,
      "INVALID_CONFIG",
    );
    this.issues = issues;
  }
}

/**
 * Parse untrusted settings (the settings file, a file a panel patch was applied
 * to). `undefined` and `null` both mean "unset": the default applies, so a panel
 * patch clears a field by sending `null`. Unknown keys are dropped; every
 * invalid value is reported with its path.
 */
export function parseSettings(input: unknown): Settings {
  const set = isRecord(input) ? Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null)) : input;
  const result = SettingsSchema.safeParse(set);
  if (result.success) return result.data;
  throw new ConfigValidationError(
    result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
  );
}
