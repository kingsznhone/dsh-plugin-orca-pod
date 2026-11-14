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

import { DEFAULT_PORT, isHttpEndpoint, isWorkgroupId } from "../protocol.ts"

import type { StandardIssue, StandardSchemaV1 } from "./dsh.ts"

/** Build-time default listen port; `@orca/protocol` owns the single source of truth. */
export const DEFAULT_POD_PORT = DEFAULT_PORT

/** Validated configuration accepted by the ORCA pod bundle. */
export interface Config {
  /** Workgroup the orca node joins; required. */
  workgroup_id: string
  /** Workgroup password used to derive the shared key; required (prototype). */
  workgroup_password: string
  /** Human-readable orca node name; defaults to `orca-<orca_node_id>` when omitted. */
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
  /** Initial peers to `join` on startup; failures are logged, not fatal. */
  peers: string[]
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
  const issues: StandardIssue[] = []

  const workgroupIdRaw = value["workgroup_id"]
  const workgroup_id = typeof workgroupIdRaw === "string" ? workgroupIdRaw.trim() : ""
  if (!isWorkgroupId(workgroup_id)) {
    issues.push({
      path: ["workgroup_id"],
      message: "must match [a-z0-9][a-z0-9-]{1,31}",
    })
  }

  const passwordRaw = value["workgroup_password"]
  const workgroup_password = typeof passwordRaw === "string" ? passwordRaw : ""
  if (workgroup_password.length === 0) {
    issues.push({
      path: ["workgroup_password"],
      message:
        "must be a non-empty string (prototype accepts plaintext config; production should use the DSH credentials service)",
    })
  }

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

  if (issues.length > 0) throw new ConfigValidationError(issues)

  const config: Config = { workgroup_id, workgroup_password, port, skill_injection, peers }
  if (display_name !== undefined) config.display_name = display_name
  if (endpoints !== undefined) config.endpoints = endpoints
  if (data_root !== undefined) config.data_root = data_root
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
