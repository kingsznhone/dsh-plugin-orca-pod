/**
 * Node lifecycle for the Orca pod DSH bundle.
 *
 * The DSH host must not block on a node: `startPod` returns a handle
 * synchronously and performs config resolution, `node.start()`, and initial
 * `join`s on a promise that never rejects. Failures are recorded on
 * `handle.runtime.error` and logged, so `apply` always returns quickly.
 */

import { configPath, createNodeConfig, defaultDataRoot, loadConfig, saveConfig } from "../config.ts"
import type { NodeConfig } from "../config.ts"
import { deriveWorkgroupKey } from "../crypto.ts"
import { createNode, createPersistentStorage } from "../node.ts"
import type { OrcaNode } from "../node.ts"

import type { Config } from "./config.ts"
import type { HostLogger } from "./dsh.ts"
import { errorMessage } from "./util.ts"

/** Observable state of the pod owned by one plugin fiber. */
export interface PodRuntime {
  /** Created node, or null before creation / after a failed creation. */
  node: OrcaNode | null
  /** Endpoint reported by `node.start()`. */
  url: string | null
  /** Bound listen port reported by `node.start()`. */
  port: number | null
  /** ISO timestamp of a successful start. */
  started_at: string | null
  /** First fatal startup error, if any. */
  error: Error | null
}

/** Handle returned by `startPod`; cleanup and tools share it. */
export interface PodHandle {
  runtime: PodRuntime
  /** Startup completion; resolves after success or failure, never rejects. */
  ready: Promise<void>
}

function createRuntime(): PodRuntime {
  return { node: null, url: null, port: null, started_at: null, error: null }
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

async function loadStoredConfig(path: string, logger: HostLogger): Promise<NodeConfig | null> {
  try {
    return await loadConfig(path)
  } catch (error) {
    if (!isMissingFile(error)) {
      logger.warn(`orca-pod: ignoring unreadable node config ${path}: ${errorMessage(error)}`)
    }
    return null
  }
}

function sameConfig(left: NodeConfig, right: NodeConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Resolve the persisted node identity for the configured workgroup.
 *
 * An existing `config.json` for the same workgroup is reused (stable node id
 * and creation time) with its key re-derived from the configured password;
 * otherwise a fresh node config is created and persisted.
 */
export async function resolveNodeConfig(config: Config, logger: HostLogger): Promise<NodeConfig> {
  const dataRoot = config.data_root ?? defaultDataRoot()
  const path = configPath(dataRoot)
  const stored = await loadStoredConfig(path, logger)
  const keyBase64 = deriveWorkgroupKey(config.workgroup_id, config.workgroup_password).toString("base64")

  let next: NodeConfig
  if (stored !== null && stored.workgroup_id === config.workgroup_id) {
    next = {
      ...stored,
      display_name: config.display_name ?? stored.display_name,
      // The advertised endpoint is derived from bind/port unless explicitly
      // configured: reusing a stored endpoint could advertise a stale port.
      endpoint: config.endpoint ?? null,
      data_root: dataRoot,
      bind: { host: stored.bind.host, port: config.port },
      key_base64: keyBase64,
    }
  } else {
    next = createNodeConfig({
      workgroupId: config.workgroup_id,
      password: config.workgroup_password,
      dataRoot,
      port: config.port,
      ...(config.display_name === undefined ? {} : { displayName: config.display_name }),
      ...(config.endpoint === undefined ? {} : { endpoint: config.endpoint }),
    })
  }

  if (stored === null || !sameConfig(stored, next)) {
    try {
      await saveConfig(path, next)
    } catch (error) {
      logger.warn(`orca-pod: could not persist node config ${path}: ${errorMessage(error)}`)
    }
  }
  return next
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * Create and start a pod node without blocking the caller.
 *
 * The returned `ready` promise resolves after startup (success or failure) and
 * never rejects; inspect `runtime.error` for the failure cause.
 */
export function startPod(config: Config, logger: HostLogger): PodHandle {
  const runtime = createRuntime()

  const ready = (async () => {
    try {
      const nodeConfig = await resolveNodeConfig(config, logger)
      const node = createNode({ config: nodeConfig, storage: createPersistentStorage(nodeConfig) })
      runtime.node = node

      const info = await node.start()
      runtime.url = info.url
      runtime.port = info.port
      runtime.started_at = new Date().toISOString()
      logger.info(
        `orca-pod: node ${nodeConfig.node_id} listening on ${info.url} (workgroup ${nodeConfig.workgroup_id})`,
      )

      const seen = new Set<string>()
      for (const rawPeer of config.peers) {
        const peer = trimTrailingSlash(rawPeer)
        if (peer === trimTrailingSlash(info.url) || seen.has(peer)) continue
        seen.add(peer)
        try {
          const response = await node.join(peer)
          logger.info(`orca-pod: joined ${peer} (${response.members.length} members in directory)`)
        } catch (error) {
          // A peer that is down at boot must not take the local node down.
          logger.warn(`orca-pod: join ${peer} failed: ${errorMessage(error)}`)
        }
      }
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      runtime.error = failure
      logger.error(`orca-pod: node failed to start: ${errorMessage(failure)}`)
    }
  })()

  return { runtime, ready }
}

/** Stop the pod; safe to call after a failed startup and safe to await twice. */
export async function stopPod(handle: PodHandle, logger: HostLogger): Promise<void> {
  await handle.ready
  const node = handle.runtime.node
  if (node === null) return
  try {
    await node.stop()
    logger.info("orca-pod: node stopped")
  } catch (error) {
    logger.warn(`orca-pod: node stop failed: ${errorMessage(error)}`)
  }
}
