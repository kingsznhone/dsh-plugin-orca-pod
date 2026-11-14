/**
 * Configuration for the `orca-pod` DSH bundle.
 *
 * The schema is implemented as a plain Standard Schema (v1) validator rather
 * than a Schemastery object: Cordis only requires `Config['~standard'].validate`,
 * and this workspace does not resolve `@deepseek-ai/*` runtime packages
 * (Schemastery is one of them). Behaviour is the same as a Schemastery schema
 * with `.required()` / `.default(11811)` declarations.
 *
 * SECURITY NOTE: `workgroup_password` is intentionally accepted as plaintext in
 * the patch config for the prototype. A production bundle should read the
 * workgroup password from the DSH credentials service instead of the config
 * file, so it never lands in `cordis.patch.yml` or logs.
 */

import { DEFAULT_PORT, isHttpEndpoint, isPermissionMode, isWorkgroupId } from "../protocol.ts"
import type { PermissionMode } from "../protocol.ts"

import type { StandardIssue, StandardSchemaV1 } from "./dsh.ts"

/** Build-time default listen port; `@orca/protocol` owns the single source of truth. */
export const DEFAULT_POD_PORT = DEFAULT_PORT

/** Validated configuration accepted by the ORCA pod bundle. */
export interface Config {
  /** Workgroup the orca node joins; empty means the panel has not been set up yet. */
  workgroup_id: string
  /** Workgroup password used to derive the shared key; empty means "not configured yet" and never starts a node. */
  workgroup_password: string
  /** Human-readable orca node name; defaults to the orca node id when omitted. */
  display_name?: string
  /** Local listen port; defaults to 11811 (0 picks a free port). */
  port: number
  /** Advertised dial URLs, best first; defaults to `http://<host>:<port>`. */
  endpoints?: string[]
  /** Directory for the persisted orca node config; defaults to `defaultDataRoot()`. */
  data_root?: string
  /**
   * Install the `orca-node` skill under `$DSH_HOME/skills` so headless/ACP
   * sessions on this machine can drive the CLI; defaults to true.
   */
  skill_injection: boolean
  /**
   * Listen address for the orca node HTTP server; defaults to `::` (all
   * interfaces, IPv4+IPv6) so a LAN peer can reach it. Set `127.0.0.1` for a
   * single-machine mesh or when a reverse proxy is the only entry point.
   */
  bind_host?: string
  /** Initial peers to `join` on startup; failures are logged, not fatal. */
  peers: string[]
  /** Local hard cap on a task's lifetime in seconds; peers see it as max_task_ttl_s (§6.9). */
  task_timeout_s?: number
  /** Auto-reject parked approvals after this many seconds; unset waits forever (§7.12). */
  approval_timeout_s?: number
  /** Inline result summary cap in bytes; longer summaries are truncated (§6.11). */
  result_max_bytes?: number
  /** Max number of task inputs one origin may attach (§6.7). */
  max_input_files?: number
  /** Max total bytes of task inputs materialized per task (§6.7). */
  max_input_bytes?: number
  /** Allow candidate endpoints on public IPs (§7.7). */
  allow_public_peers?: boolean
  /** Reject loopback candidate endpoints (§7.7). */
  allow_loopback_peers?: boolean
  /** Local ceiling for tasks this orca node runs (§7.10). */
  permission_mode?: PermissionMode
}

/** Thrown when a config object does not satisfy the bundle's schema. */
export class ConfigValidationError extends Error {
  readonly issues: StandardIssue[]

  constructor(issues: StandardIssue[]) {
    const detail = issues
      .map((issue) => {
        const path = issue.path === undefined || issue.path.length === 0 ? "config" : issue.path.join(".")
        return `${path}: ${issue.message}`
      })
      .join("; ")
    super(`invalid orca-pod config: ${detail}`)
    this.name = "ConfigValidationError"
    this.issues = issues
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Validate untrusted config input (patch `config`, config editor output) and
 * return a normalized `Config` with defaults applied.
 *
 * @throws {ConfigValidationError} when required fields are missing or invalid.
 */
export function validateConfigInput(value: unknown): Config {
  if (!isRecord(value)) {
    throw new ConfigValidationError([{ message: "expected an object" }])
  }
  const source: Record<string, unknown> = value
  const issues: StandardIssue[] = []

  const workgroupIdRaw = value["workgroup_id"]
  const workgroup_id =
    typeof workgroupIdRaw === "string" ? workgroupIdRaw.trim().toLowerCase() : ""
  if (workgroup_id.length > 0 && !isWorkgroupId(workgroup_id)) {
    issues.push({
      path: ["workgroup_id"],
      message: "must match [a-z0-9][a-z0-9-]{1,31}",
    })
  }

  // An empty password means "not configured yet": the node stays idle and the
  // panel's first-run wizard asks for one. A passwordless mesh is never started.
  const passwordRaw = value["workgroup_password"]
  const workgroup_password = typeof passwordRaw === "string" ? passwordRaw : ""

  let display_name: string | undefined
  const displayNameRaw = value["display_name"]
  if (displayNameRaw !== undefined) {
    if (typeof displayNameRaw !== "string" || displayNameRaw.trim().length === 0) {
      issues.push({ path: ["display_name"], message: "must be a non-empty string when present" })
    } else {
      display_name = displayNameRaw.trim()
    }
  }

  let port = DEFAULT_POD_PORT
  const portRaw = value["port"]
  if (portRaw !== undefined) {
    if (typeof portRaw !== "number" || !Number.isInteger(portRaw) || portRaw < 0 || portRaw > 65535) {
      issues.push({ path: ["port"], message: "must be an integer between 0 and 65535" })
    } else {
      port = portRaw
    }
  }

  let endpoints: string[] | undefined
  const endpointsRaw = value["endpoints"]
  if (endpointsRaw !== undefined) {
    if (!Array.isArray(endpointsRaw) || endpointsRaw.length === 0) {
      issues.push({ path: ["endpoints"], message: "must be a non-empty array of http(s) URLs" })
    } else {
      endpoints = []
      endpointsRaw.forEach((candidate, index) => {
        if (typeof candidate !== "string" || !isHttpEndpoint(candidate.trim())) {
          issues.push({ path: ["endpoints", index], message: "must be an http(s) URL" })
        } else {
          endpoints!.push(candidate.trim())
        }
      })
    }
  }

  let bind_host: string | undefined
  const bindHostRaw = value["bind_host"]
  if (bindHostRaw !== undefined) {
    if (typeof bindHostRaw !== "string" || bindHostRaw.trim().length === 0) {
      issues.push({ path: ["bind_host"], message: "must be a non-empty host when present" })
    } else {
      bind_host = bindHostRaw.trim()
    }
  }

  let data_root: string | undefined
  const dataRootRaw = value["data_root"]
  if (dataRootRaw !== undefined) {
    if (typeof dataRootRaw !== "string" || dataRootRaw.trim().length === 0) {
      issues.push({ path: ["data_root"], message: "must be a non-empty path when present" })
    } else {
      data_root = dataRootRaw.trim()
    }
  }

  const peers: string[] = []
  const peersRaw = value["peers"]
  if (peersRaw !== undefined) {
    if (!Array.isArray(peersRaw)) {
      issues.push({ path: ["peers"], message: "must be an array of http(s) URLs" })
    } else {
      peersRaw.forEach((candidate, index) => {
        if (typeof candidate !== "string" || !isHttpEndpoint(candidate.trim())) {
          issues.push({ path: ["peers", index], message: "must be an http(s) URL" })
        } else {
          peers.push(candidate.trim())
        }
      })
    }
  }

  let skill_injection = true
  const skillInjectionRaw = value["skill_injection"]
  if (skillInjectionRaw !== undefined) {
    if (typeof skillInjectionRaw !== "boolean") {
      issues.push({ path: ["skill_injection"], message: "must be a boolean when present" })
    } else {
      skill_injection = skillInjectionRaw
    }
  }

  // Advanced local controls: `null` clears a panel override so the bundle
  // default (or the previous persisted value) applies again.
  function optionalPositiveNumber(key: string, integer: boolean): number | undefined {
    const raw = source[key]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0 || (integer && !Number.isInteger(raw))) {
      issues.push({ path: [key], message: integer ? "must be a positive integer" : "must be a positive number" })
      return undefined
    }
    return raw
  }
  function optionalBoolean(key: string): boolean | undefined {
    const raw = source[key]
    if (raw === undefined || raw === null) return undefined
    if (typeof raw !== "boolean") {
      issues.push({ path: [key], message: "must be a boolean when present" })
      return undefined
    }
    return raw
  }

  const task_timeout_s = optionalPositiveNumber("task_timeout_s", false)
  const approval_timeout_s = optionalPositiveNumber("approval_timeout_s", false)
  const result_max_bytes = optionalPositiveNumber("result_max_bytes", true)
  const max_input_files = optionalPositiveNumber("max_input_files", true)
  const max_input_bytes = optionalPositiveNumber("max_input_bytes", true)
  const allow_public_peers = optionalBoolean("allow_public_peers")
  const allow_loopback_peers = optionalBoolean("allow_loopback_peers")
  let permission_mode: PermissionMode | undefined
  const permissionModeRaw = value["permission_mode"]
  if (permissionModeRaw !== undefined && permissionModeRaw !== null) {
    if (typeof permissionModeRaw !== "string" || !isPermissionMode(permissionModeRaw)) {
      issues.push({
        path: ["permission_mode"],
        message: 'must be "read-only", "workspace-write", or "danger-full-access"',
      })
    } else {
      permission_mode = permissionModeRaw
    }
  }

  if (issues.length > 0) throw new ConfigValidationError(issues)

  const config: Config = { workgroup_id, workgroup_password, port, skill_injection, peers }
  if (display_name !== undefined) config.display_name = display_name
  if (bind_host !== undefined) config.bind_host = bind_host
  if (endpoints !== undefined) config.endpoints = endpoints
  if (data_root !== undefined) config.data_root = data_root
  if (task_timeout_s !== undefined) config.task_timeout_s = task_timeout_s
  if (approval_timeout_s !== undefined) config.approval_timeout_s = approval_timeout_s
  if (result_max_bytes !== undefined) config.result_max_bytes = result_max_bytes
  if (max_input_files !== undefined) config.max_input_files = max_input_files
  if (max_input_bytes !== undefined) config.max_input_bytes = max_input_bytes
  if (allow_public_peers !== undefined) config.allow_public_peers = allow_public_peers
  if (allow_loopback_peers !== undefined) config.allow_loopback_peers = allow_loopback_peers
  if (permission_mode !== undefined) config.permission_mode = permission_mode
  return config
}

/** Create the Standard Schema validator Cordis consumes as the plugin `Config`. */
export function createConfigSchema(): StandardSchemaV1<Config> {
  return {
    "~standard": {
      version: 1,
      vendor: "orca-pod",
      validate(value: unknown) {
        try {
          return { value: validateConfigInput(value) }
        } catch (error) {
          if (error instanceof ConfigValidationError) return { issues: error.issues }
          return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
        }
      },
    },
  }
}
