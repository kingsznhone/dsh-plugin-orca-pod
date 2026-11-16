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

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { configPath, createOrcaNodeConfig, defaultDataRoot, saveConfig } from "../config.ts";
import { identityPath } from "../identity.ts";
import { isLoopbackEndpoint, normalizePeerUrl } from "../net.ts";
import { createOrcaNode, createPersistentStorage } from "../orca_node.ts";
import type { OrcaNode } from "../orca_node.ts";
import { parseSettings, pickPanelFields } from "../settings.ts";

import type { Config } from "./config.ts";
import type { HostContext, HostLogger } from "./dsh.ts";
import { discoverModelCatalog } from "./models.ts";
import type { ModelCatalog } from "./models.ts";
import { errorMessage } from "../errors.ts";
import { isRecord } from "../protocol.ts";

/** Observable state of the pod owned by one plugin fiber. */
interface PodRuntime {
  /** Created orca node, or null before creation / after a failed creation. */
  orcaNode: OrcaNode | null;
  /** Endpoint reported by `orcaNode.start()`. */
  url: string | null;
  /** Bound listen port reported by `orcaNode.start()`. */
  port: number | null;
  /** ISO timestamp of a successful start. */
  started_at: string | null;
  /** First fatal startup error, if any. */
  error: Error | null;
}

/** Handle returned by `startPod`; cleanup and tools share it. */
export interface PodHandle {
  runtime: PodRuntime;
  /** Effective config (bundle config with any saved UI override applied). */
  config: Config;
  /** True once the panel completed setup (an override file exists). */
  uiConfigured: boolean;
  /** Startup completion; resolves after success or failure, never rejects. */
  ready: Promise<void>;
  /** Persist an override and restart the orca node with the merged config. */
  reconfigure(patch: Record<string, unknown>): Promise<void>;
  /** `join` one peer now and remember it in the override. */
  addPeer(peer: string): Promise<void>;
  /** Leave the workgroup: tell known peers and clear the persisted peer list. */
  disconnect(): Promise<void>;
  /** Delete the panel override and the persisted orca node identity (full reset). */
  reset(): Promise<void>;
  /**
   * Stop accepting lifecycle writes: wait for the current operation, and make
   * pending queue entries skip starting a new node. Used by `stopPod` so a
   * reconfiguration cannot leak a listener after host shutdown (§9.2).
   */
  dispose(): Promise<void>;
}

/**
 * What the panel saved: a patch over the bundle config holding only panel-editable
 * fields, where `null` clears a field back to its default, plus the setup marker.
 */
type Override = Record<string, unknown>;

function createRuntime(): PodRuntime {
  return { orcaNode: null, url: null, port: null, started_at: null, error: null };
}

/** Treat "file does not exist" as an empty install; other read errors are logged. */
function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "ENOENT"
  );
}

/** Path of the panel-written override next to the persisted orca node config. */
export function overridePath(dataRoot: string): string {
  return join(dataRoot, "ui-config.json");
}

/** Read the panel override; a missing or unreadable file means "not set up". */
async function loadOverride(dataRoot: string, logger: HostLogger): Promise<Override> {
  try {
    const parsed: unknown = JSON.parse(await readFile(overridePath(dataRoot), "utf8"));
    if (!isRecord(parsed)) return {};
    return { ...pickPanelFields(parsed), setup_complete: parsed.setup_complete === true };
  } catch (error) {
    if (!isMissingFile(error)) {
      logger.warn(`orca-pod: ignoring unreadable panel config: ${errorMessage(error)}`);
    }
    return {};
  }
}

async function saveOverride(dataRoot: string, override: Override): Promise<void> {
  await mkdir(dataRoot, { recursive: true });
  await writeFile(
    overridePath(dataRoot),
    `${JSON.stringify(override, null, 2)}
`,
    "utf8",
  );
}

/**
 * A panel-configured orca node needs both a workgroup and a password. Empty
 * values mean "not configured yet" and keep the node idle instead of opening a
 * passwordless mesh; the first-run wizard fills them in.
 */
function needsSetup(config: Config): boolean {
  return !config.workgroup_id || !config.workgroup_password;
}

/** The effective config: the panel override over the bundle config, parsed once. */
function mergeOverride(base: Config, override: Override): Config {
  return parseSettings({ ...base, ...override });
}

async function startNode(config: Config, runtime: PodRuntime, logger: HostLogger, hooks: StartPodHooks): Promise<void> {
  const dataRoot = config.data_root ?? defaultDataRoot();
  // The plugin runs real DSH sessions by default. A loopback-only advertise list
  // is useless across machines, so it means "derive from the listen address".
  const nodeConfig = createOrcaNodeConfig({
    ...config,
    data_root: dataRoot,
    executor: config.executor ?? "acp",
    endpoints: config.endpoints.every(isLoopbackEndpoint) ? [] : config.endpoints,
  });
  await saveConfig(configPath(dataRoot), nodeConfig);
  const orcaNode = createOrcaNode({ config: nodeConfig, storage: createPersistentStorage(nodeConfig), logger });
  runtime.orcaNode = orcaNode;

  let info: { url: string; port: number };
  try {
    info = await orcaNode.start();
  } catch (error) {
    runtime.error = error instanceof Error ? error : new Error(String(error));
    runtime.orcaNode = null;
    try {
      await orcaNode.stop();
    } catch {
      // The node never finished starting; nothing useful to report here.
    }
    throw runtime.error;
  }

  runtime.url = info.url;
  runtime.port = info.port;
  runtime.started_at = new Date().toISOString();
  runtime.error = null;
  logger.info(
    `orca-pod: orca node ${nodeConfig.orca_node_id} listening on ${info.url} (workgroup ${nodeConfig.workgroup_id})`,
  );

  // Install ambient state before the first join so the joined self record and
  // every heartbeat carry it from the start.
  try {
    hooks.onNodeStarted?.(orcaNode);
  } catch (error) {
    logger.warn(`orca-pod: onNodeStarted hook failed: ${errorMessage(error)}`);
  }

  const self = normalizePeerUrl(info.url);
  for (const peer of config.peers) {
    if (peer === self) continue;
    try {
      const response = await orcaNode.join(peer);
      logger.info(`orca-pod: joined ${peer} (${response.members.length} members in directory)`);
    } catch (error) {
      // A peer that is down at boot must not take the local orca node down.
      logger.warn(`orca-pod: join ${peer} failed: ${errorMessage(error)}`);
    }
  }
}

async function stopNode(runtime: PodRuntime, logger: HostLogger): Promise<void> {
  const orcaNode = runtime.orcaNode;
  runtime.orcaNode = null;
  runtime.url = null;
  runtime.port = null;
  if (orcaNode === null) return;
  try {
    await orcaNode.stop();
  } catch (error) {
    logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
  }
}

/**
 * Hooks a host plugin uses to attach ambient state to every orca node start
 * (initial start, panel reconfigure). The model catalog (§6.15) is the
 * only user today: it must be installed before the first `join` so the self
 * record peers receive already advertises it.
 */
interface StartPodHooks {
  onNodeStarted?: (orcaNode: OrcaNode) => void;
}

/**
 * Create and start a pod orca node without blocking the caller.
 *
 * The returned `ready` promise resolves after startup (success or failure) and
 * never rejects; inspect `runtime.error` for the failure cause.
 */
export function startPod(baseConfig: Config, logger: HostLogger, hooks: StartPodHooks = {}): PodHandle {
  const runtime = createRuntime();
  const dataRoot = baseConfig.data_root ?? defaultDataRoot();

  let disposed = false;
  let queue: Promise<void> = Promise.resolve();

  /**
   * Serialize panel writes (override file + node restart). A failed operation
   * must not poison the lane: the caller still sees its rejection, but the next
   * operation runs against a clean queue.
   */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = queue.catch(() => {}).then(operation);
    queue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** Merge `patch` into the saved override, always marking the setup complete. */
  async function saveOverridePatch(patch: Override): Promise<void> {
    await saveOverride(dataRoot, { ...(await loadOverride(dataRoot, logger)), ...patch, setup_complete: true });
  }

  const handle: PodHandle = {
    runtime,
    config: baseConfig,
    uiConfigured: false,
    ready: Promise.resolve(),
    reconfigure: (patch) =>
      enqueue(async () => {
        const next = { ...(await loadOverride(dataRoot, logger)), ...pickPanelFields(patch), setup_complete: true };
        const merged = mergeOverride(baseConfig, next);
        await saveOverride(dataRoot, next);
        handle.uiConfigured = true;
        handle.config = merged;
        await stopNode(runtime, logger);
        if (disposed) return;
        if (needsSetup(merged)) {
          runtime.error = null;
          return;
        }
        try {
          await startNode(merged, runtime, logger, hooks);
        } catch (error) {
          logger.error(`orca-pod: reconfigure failed: ${errorMessage(error)}`);
        }
      }),
    addPeer: (peer) =>
      enqueue(async () => {
        const orcaNode = runtime.orcaNode;
        if (orcaNode === null) throw new Error("orca node is not running");
        await orcaNode.join(peer);
        const peers = handle.config.peers.includes(peer) ? handle.config.peers : [...handle.config.peers, peer];
        handle.config = { ...handle.config, peers };
        await saveOverridePatch({ peers });
      }),
    disconnect: () =>
      enqueue(async () => {
        const orcaNode = runtime.orcaNode;
        if (orcaNode !== null) {
          try {
            await orcaNode.leave();
          } catch (error) {
            logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`);
          }
        }
        handle.config = { ...handle.config, peers: [] };
        await saveOverridePatch({ peers: [] });
      }),
    reset: () =>
      enqueue(async () => {
        await stopNode(runtime, logger);
        for (const path of [overridePath(dataRoot), configPath(dataRoot), identityPath(dataRoot)]) {
          try {
            await rm(path, { force: true });
          } catch (error) {
            logger.warn(`orca-pod: could not remove ${path}: ${errorMessage(error)}`);
          }
        }
        // Back to the first-run wizard: nothing restarts until setup completes,
        // even if the bundle still carries a workgroup.
        handle.uiConfigured = false;
        handle.config = baseConfig;
        runtime.error = null;
      }),
    dispose: async () => {
      disposed = true;
      await queue;
    },
  };

  handle.ready = (async () => {
    try {
      const stored = await loadOverride(dataRoot, logger);
      if (stored.setup_complete === true) {
        handle.config = mergeOverride(baseConfig, stored);
        handle.uiConfigured = true;
      }
    } catch (error) {
      logger.warn(`orca-pod: ignoring panel config: ${errorMessage(error)}`);
    }
    if (!handle.uiConfigured || needsSetup(handle.config)) {
      // No completed panel setup yet: the panel shows its first-run wizard and
      // calls `reconfigure` once the user has picked a workgroup, password and
      // listen address. The bundle no longer carries credentials (§7.1).
      logger.info("orca-pod: waiting for workgroup setup from the panel");
      return;
    }
    try {
      await startNode(handle.config, runtime, logger, hooks);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      runtime.error = failure;
      logger.error(`orca-pod: orca node failed to start: ${errorMessage(failure)}`);
    }
  })();

  return handle;
}

/**
 * Start the pod for a DSH host. The host owns the real model catalog, the node
 * only advertises it: the catalog is read once the node is up and installed on
 * the running node (and on every later panel restart, before its first join).
 */
export function createPodRuntime(ctx: HostContext, config: Config): PodHandle {
  const catalog: ModelCatalog = { models: [], defaultModel: null };
  const advertise = (orcaNode: OrcaNode): void =>
    orcaNode.setModelCatalog(catalog.models, catalog.defaultModel, catalog.defaultModel?.reasoning_effort ?? null);
  const handle = startPod(config, ctx.logger, { onNodeStarted: advertise });
  void handle.ready.then(async () => {
    Object.assign(catalog, await discoverModelCatalog(ctx, ctx.logger));
    if (handle.runtime.orcaNode !== null) advertise(handle.runtime.orcaNode);
    if (catalog.models.length > 0) ctx.logger.info(`orca-pod: advertising ${catalog.models.length} models`);
  });
  return handle;
}

/** Stop the pod; safe to call after a failed startup and safe to await twice. */
export async function stopPod(handle: PodHandle, logger: HostLogger): Promise<void> {
  await handle.ready;
  // Let an in-flight reconfiguration finish (or skip its restart), so shutdown
  // cannot race a new listener into existence after the host disposed us.
  await handle.dispose();
  const orcaNode = handle.runtime.orcaNode;
  if (orcaNode === null) return;
  try {
    await orcaNode.stop();
    logger.info("orca-pod: orca node stopped");
  } catch (error) {
    logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
  }
}
