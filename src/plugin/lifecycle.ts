/**
 * Node lifecycle for the Orca pod DSH bundle.
 *
 * The DSH host must not block on an orca node: `startPod` returns a handle
 * synchronously and performs config resolution, `orcaNode.start()`, and initial
 * `join`s on a promise that never rejects. Failures are recorded on
 * `handle.runtime.error` and logged, so `apply` always returns quickly.
 *
 * The panel can reconfigure the orca node at runtime (`handle.reconfigure`): the
 * effective config is the bundle config with a small UI override file on top
 * (`<data_root>/ui-config.json`). The override never touches the profile patch
 * file and is written only from the loopback-gated panel route (§9.2).
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  configPath,
  createOrcaNodeConfig,
  defaultDataRoot,
  loadConfig,
  saveConfig,
} from "../config.ts"
import type { OrcaNodeConfig } from "../config.ts"
import { deriveWorkgroupKey } from "../crypto.ts"
import { isLoopbackEndpoint } from "../net.ts"
import { createOrcaNode, createPersistentStorage } from "../orca_node.ts"
import type { OrcaNode } from "../orca_node.ts"

import { validateConfigInput } from "./config.ts"
import type { Config } from "./config.ts"
import type { HostLogger } from "./dsh.ts"
import { errorMessage } from "./util.ts"

/**
 * Default listen address for the bundle: `::` accepts both IPv4 and IPv6 on
 * Windows and Linux, which is what a LAN mesh needs. Loopback-only setups can
 * set `bind_host: "127.0.0.1"`.
 */
export const DEFAULT_PLUGIN_BIND_HOST = "::"

/** Observable state of the pod owned by one plugin fiber. */
export interface PodRuntime {
  /** Created orca node, or null before creation / after a failed creation. */
  orcaNode: OrcaNode | null
  /** Endpoint reported by `orcaNode.start()`. */
  url: string | null
  /** Bound listen port reported by `orcaNode.start()`. */
  port: number | null
  /** ISO timestamp of a successful start. */
  started_at: string | null
  /** First fatal startup error, if any. */
  error: Error | null
}

/** Handle returned by `startPod`; cleanup and tools share it. */
export interface PodHandle {
  runtime: PodRuntime
  /** Effective config (bundle config with any saved UI override applied). */
  config: Config
  /** True once the panel completed setup (an override file exists). */
  uiConfigured: boolean
  /** Startup completion; resolves after success or failure, never rejects. */
  ready: Promise<void>
  /** Persist an override and restart the orca node with the merged config. */
  reconfigure(patch: Record<string, unknown>): Promise<void>
  /** `join` one peer now and remember it in the override. */
  addPeer(peer: string): Promise<void>
  /** Leave the workgroup: tell known peers and clear the persisted peer list. */
  disconnect(): Promise<void>
  /** Delete the panel override and the persisted orca node identity (full reset). */
  reset(): Promise<void>
}

/** Fields the panel may override; the rest stays owned by the bundle config. */
const OVERRIDE_KEYS = [
  "workgroup_id",
  "workgroup_password",
  "display_name",
  "port",
  "endpoints",
  "peers",
] as const

type Override = Partial<Pick<Config, (typeof OVERRIDE_KEYS)[number]>> & { setup_complete?: boolean }

function createRuntime(): PodRuntime {
  return { orcaNode: null, url: null, port: null, started_at: null, error: null }
}

/** Treat "file does not exist" as an empty install; other read errors are logged. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  )
}

async function loadStoredConfig(path: string, logger: HostLogger): Promise<OrcaNodeConfig | null> {
  try {
    return await loadConfig(path)
  } catch (error) {
    if (!isMissingFile(error)) {
      logger.warn(`orca-pod: ignoring unreadable orca node config ${path}: ${errorMessage(error)}`)
    }
    return null
  }
}

function sameConfig(left: OrcaNodeConfig, right: OrcaNodeConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Path of the panel-written override next to the persisted orca node config. */
export function overridePath(dataRoot: string): string {
  return join(dataRoot, "ui-config.json")
}

/** Read the panel override; a missing or unreadable file means "not set up". */
async function loadOverride(dataRoot: string, logger: HostLogger): Promise<Override | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(overridePath(dataRoot), "utf8"))
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
    const source = parsed as Record<string, unknown>
    const override: Override = {}
    if (source["setup_complete"] === true) override.setup_complete = true
    for (const key of OVERRIDE_KEYS) {
      if (source[key] !== undefined) (override as Record<string, unknown>)[key] = source[key]
    }
    return override
  } catch (error) {
    if (!isMissingFile(error)) {
      logger.warn(`orca-pod: ignoring unreadable panel config: ${errorMessage(error)}`)
    }
    return null
  }
}

async function saveOverride(dataRoot: string, override: Override): Promise<void> {
  await mkdir(dataRoot, { recursive: true })
  await writeFile(overridePath(dataRoot), `${JSON.stringify(override, null, 2)}\n`, "utf8")
}

/** Merge a panel override over the bundle config, then re-validate the result. */
/**
 * A panel-configured orca node needs both a workgroup and a password. Empty
 * values mean "not configured yet" and keep the node idle instead of opening a
 * passwordless mesh; the first-run wizard fills them in.
 */
function needsSetup(config: Config): boolean {
  return config.workgroup_id.length === 0 || config.workgroup_password.length === 0
}

function mergeOverride(base: Config, override: Override): Config {
  const merged: Record<string, unknown> = {
    workgroup_id: base.workgroup_id,
    workgroup_password: base.workgroup_password,
    port: base.port,
    skill_injection: base.skill_injection,
    peers: base.peers,
  }
  if (base.display_name !== undefined) merged["display_name"] = base.display_name
  if (base.endpoints !== undefined) merged["endpoints"] = base.endpoints
  if (base.data_root !== undefined) merged["data_root"] = base.data_root
  for (const key of OVERRIDE_KEYS) {
    if (override[key] !== undefined) merged[key] = override[key]
  }
  return validateConfigInput(merged)
}

/**
 * Resolve the persisted orca node identity for the configured workgroup.
 *
 * An existing `config.json` for the same workgroup is reused (stable orca node id
 * and creation time) with its key re-derived from the configured password;
 * otherwise a fresh orca node config is created and persisted.
 */
export async function resolveOrcaNodeConfig(config: Config, logger: HostLogger): Promise<OrcaNodeConfig> {
  const dataRoot = config.data_root ?? defaultDataRoot()
  const path = configPath(dataRoot)
  const stored = await loadStoredConfig(path, logger)
  const keyBase64 = deriveWorkgroupKey(config.workgroup_id, config.workgroup_password).toString("base64")
  // Listen on all interfaces by default so LAN peers can reach this node; a
  // loopback-only advertise list is useless across machines, so treat it as
  // "derive from bind" and let the node detect the real interface addresses.
  const bindHost = config.bind_host ?? DEFAULT_PLUGIN_BIND_HOST
  const advertised =
    config.endpoints !== undefined && config.endpoints.length > 0 && !config.endpoints.every(isLoopbackEndpoint)
      ? [...config.endpoints]
      : []

  let next: OrcaNodeConfig
  if (stored !== null && stored.workgroup_id === config.workgroup_id) {
    next = {
      ...stored,
      display_name: config.display_name ?? stored.display_name,
      // Advertised endpoints are derived from bind/port unless explicitly
      // configured: reusing stored endpoints could advertise a stale port.
      endpoints: advertised,
      data_root: dataRoot,
      bind: { host: bindHost, port: config.port },
      key_base64: keyBase64,
    }
  } else {
    next = createOrcaNodeConfig({
      workgroupId: config.workgroup_id,
      password: config.workgroup_password,
      dataRoot,
      host: bindHost,
      port: config.port,
      ...(config.display_name === undefined ? {} : { displayName: config.display_name }),
      ...(advertised.length === 0 ? {} : { endpoints: advertised }),
    })
  }

  if (stored === null || !sameConfig(stored, next)) {
    try {
      await saveConfig(path, next)
    } catch (error) {
      logger.warn(`orca-pod: could not persist orca node config ${path}: ${errorMessage(error)}`)
    }
  }
  return next
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

async function startNode(
  config: Config,
  runtime: PodRuntime,
  logger: HostLogger,
): Promise<void> {
  const nodeConfig = await resolveOrcaNodeConfig(config, logger)
  const orcaNode = createOrcaNode({ config: nodeConfig, storage: createPersistentStorage(nodeConfig) })
  runtime.orcaNode = orcaNode

  let info: { url: string; port: number }
  try {
    info = await orcaNode.start()
  } catch (error) {
    runtime.error = error instanceof Error ? error : new Error(String(error))
    runtime.orcaNode = null
    try {
      await orcaNode.stop()
    } catch {
      // The node never finished starting; nothing useful to report here.
    }
    throw runtime.error
  }

  runtime.url = info.url
  runtime.port = info.port
  runtime.started_at = new Date().toISOString()
  runtime.error = null
  logger.info(
    `orca-pod: orca node ${nodeConfig.orca_node_id} listening on ${info.url} (workgroup ${nodeConfig.workgroup_id})`,
  )

  const seen = new Set<string>()
  for (const rawPeer of config.peers) {
    const peer = trimTrailingSlash(rawPeer)
    if (peer === trimTrailingSlash(info.url) || seen.has(peer)) continue
    seen.add(peer)
    try {
      const response = await orcaNode.join(peer)
      logger.info(`orca-pod: joined ${peer} (${response.members.length} members in directory)`)
    } catch (error) {
      // A peer that is down at boot must not take the local orca node down.
      logger.warn(`orca-pod: join ${peer} failed: ${errorMessage(error)}`)
    }
  }
}

async function stopNode(runtime: PodRuntime, logger: HostLogger): Promise<void> {
  const orcaNode = runtime.orcaNode
  runtime.orcaNode = null
  runtime.url = null
  runtime.port = null
  if (orcaNode === null) return
  try {
    await orcaNode.stop()
  } catch (error) {
    logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`)
  }
}

/**
 * Create and start a pod orca node without blocking the caller.
 *
 * The returned `ready` promise resolves after startup (success or failure) and
 * never rejects; inspect `runtime.error` for the failure cause.
 */
export function startPod(baseConfig: Config, logger: HostLogger): PodHandle {
  const runtime = createRuntime()
  const dataRoot = baseConfig.data_root ?? defaultDataRoot()

  let effective = baseConfig
  let uiConfigured = false
  let queue: Promise<void> = Promise.resolve()

  const handle: PodHandle = {
    runtime,
    config: effective,
    uiConfigured: false,
    ready: Promise.resolve(),
    reconfigure: async (patch) => {
      queue = queue.then(async () => {
        const previous = await loadOverride(dataRoot, logger)
        const next: Override = {
          ...(previous ?? {}),
          ...pickOverride(patch),
          setup_complete: true,
        }
        const merged = mergeOverride(baseConfig, next)
        await saveOverride(dataRoot, next)
        uiConfigured = true
        handle.uiConfigured = true
        effective = merged
        handle.config = merged
        await stopNode(runtime, logger)
        if (needsSetup(merged)) {
          runtime.error = null
          return
        }
        try {
          await startNode(merged, runtime, logger)
        } catch (error) {
          logger.error(`orca-pod: reconfigure failed: ${errorMessage(error)}`)
        }
      })
      return queue
    },
    addPeer: async (peer) => {
      const orcaNode = runtime.orcaNode
      if (orcaNode === null) throw new Error("orca node is not running")
      await orcaNode.join(peer)
      const peers = effective.peers.includes(peer) ? effective.peers : [...effective.peers, peer]
      effective = { ...effective, peers }
      handle.config = effective
      const previous = (await loadOverride(dataRoot, logger)) ?? {}
      await saveOverride(dataRoot, { ...previous, peers, setup_complete: true })
    },
    disconnect: async () => {
      queue = queue.then(async () => {
        const orcaNode = runtime.orcaNode
        if (orcaNode !== null) {
          try {
            await orcaNode.leave()
          } catch (error) {
            logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`)
          }
        }
        effective = { ...effective, peers: [] }
        handle.config = effective
        const previous = (await loadOverride(dataRoot, logger)) ?? {}
        await saveOverride(dataRoot, { ...previous, peers: [], setup_complete: true })
      })
      return queue
    },
    reset: async () => {
      queue = queue.then(async () => {
        await stopNode(runtime, logger)
        for (const path of [overridePath(dataRoot), configPath(dataRoot)]) {
          try {
            await rm(path, { force: true })
          } catch (error) {
            logger.warn(`orca-pod: could not remove ${path}: ${errorMessage(error)}`)
          }
        }
        uiConfigured = false
        handle.uiConfigured = false
        effective = baseConfig
        handle.config = effective
        runtime.error = null
        if (effective.workgroup_id.length === 0) return
        try {
          await startNode(effective, runtime, logger)
        } catch (error) {
          logger.error(`orca-pod: restart after reset failed: ${errorMessage(error)}`)
        }
      })
      return queue
    },
  }

  handle.ready = (async () => {
    try {
      const stored = await loadOverride(dataRoot, logger)
      if (stored !== null) {
        uiConfigured = stored.setup_complete === true
        handle.uiConfigured = uiConfigured
        effective = mergeOverride(baseConfig, stored)
        handle.config = effective
      }
    } catch (error) {
      logger.warn(`orca-pod: ignoring panel config: ${errorMessage(error)}`)
    }
    if (needsSetup(effective)) {
      // No workgroup or no password yet: the panel shows its first-run wizard
      // and calls `reconfigure` once the user has picked both.
      logger.info("orca-pod: waiting for workgroup setup from the panel")
      return
    }
    try {
      await startNode(effective, runtime, logger)
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      runtime.error = failure
      logger.error(`orca-pod: orca node failed to start: ${errorMessage(failure)}`)
    }
  })()

  return handle
}

/** Keep only the panel-editable keys with defined values. */
function pickOverride(patch: Record<string, unknown>): Override {
  const picked: Override = {}
  for (const key of OVERRIDE_KEYS) {
    if (patch[key] !== undefined) (picked as Record<string, unknown>)[key] = patch[key]
  }
  return picked
}

/** Stop the pod; safe to call after a failed startup and safe to await twice. */
export async function stopPod(handle: PodHandle, logger: HostLogger): Promise<void> {
  await handle.ready
  const orcaNode = handle.runtime.orcaNode
  if (orcaNode === null) return
  try {
    await orcaNode.stop()
    logger.info("orca-pod: orca node stopped")
  } catch (error) {
    logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`)
  }
}
