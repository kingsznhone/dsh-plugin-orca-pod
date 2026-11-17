/**
 * Node lifecycle for the Orca pod DSH bundle.
 *
 * The DSH host must not block on an orca node: `startPod` returns a handle
 * synchronously and performs config resolution, `orcaNode.start()`, and initial
 * `join`s on a promise that never rejects. Failures are recorded on
 * `handle.runtime.error` and logged, so `apply` always returns quickly.
 *
 * Where things live (§7.3, §9.2):
 * - **settings** are the plugin config. The panel persists them through
 *   `PodStores.writeConfig` — `ctx.configEditor` in DSH, which writes the profile
 *   patch and has the Loader restart the plugin with the new config;
 * - **the workgroup password** is a DSH credential (`ctx.credentials`) under
 *   `passwordRefFor(config)`; the plugin config never holds it;
 * - **state** — peers joined at runtime — is a file under `<data_root>`, because
 *   remembering a peer must not restart the plugin.
 */

import { rm } from "node:fs/promises";

import { configPath, createOrcaNodeConfig, defaultDataRoot, saveConfig } from "../node/config.ts";
import { createOrcaNode, createPersistentStorage } from "../node/orca-node.ts";
import { parseSettings, passwordRefFor } from "../node/settings.ts";
import { identityPath } from "../security/identity.ts";
import { isLoopbackEndpoint, normalizePeerUrl } from "../transport/net.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import type { PanelPatch } from "../node/settings.ts";

import type { Config } from "./config.ts";
import type { HostLogger } from "./dsh.ts";
import { loadRememberedPeers, peerStatePath, saveRememberedPeers, type PodStores, type RawConfig } from "./stores.ts";
import { errorMessage } from "../kernel/errors.ts";

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
  /** Effective config: the plugin config plus the resolved password (in memory only). */
  config: Config;
  /** True once a workgroup and its password exist, i.e. the first-run setup is done. */
  configured: boolean;
  /** Peers joined at runtime (panel or `connect`), rejoined on the next start. */
  rememberedPeers: string[];
  /** Startup completion; resolves after success or failure, never rejects. */
  ready: Promise<void>;
  /**
   * Apply a panel patch: store a new password in the credential store, persist the
   * panel fields into the plugin config (`null` clears a field to its default),
   * and restart the node with the result.
   */
  reconfigure(patch: PanelPatch): Promise<void>;
  /** `join` one peer now and remember it in the peer state file. */
  addPeer(peer: string): Promise<void>;
  /** Leave the workgroup: tell known peers and forget every remembered and configured peer. */
  disconnect(): Promise<void>;
  /** Back to the first-run wizard: drop the workgroup, its stored password and the node identity. */
  reset(): Promise<void>;
  /**
   * Stop accepting lifecycle writes: wait for the current operation, and make
   * pending queue entries skip starting a new node. Used by `stopPod` so a
   * reconfiguration cannot leak a listener after host shutdown (§9.2).
   */
  dispose(): Promise<void>;
  /**
   * Take a config the host persisted, as a plugin restart would: stop the node
   * and start again from `config`. Only the in-memory stores call it.
   */
  adopt(config: Config): Promise<void>;
}

/** Anything thrown, as an `Error`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Apply panel fields to a raw plugin config: a value sets the key, `null` removes it. */
function applyPanelFields(raw: RawConfig, fields: RawConfig): RawConfig {
  const next: RawConfig = { ...raw };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/** The plugin config without the in-memory password: what may be persisted. */
function withoutSecret(config: Config): RawConfig {
  const { workgroup_password: _password, ...rest } = config;
  return rest;
}

/**
 * A panel-configured orca node needs both a workgroup and a password. Empty
 * values mean "not configured yet" and keep the node idle instead of opening a
 * passwordless mesh; the first-run wizard fills them in.
 */
function needsSetup(config: Config): boolean {
  return !config.workgroup_id || !config.workgroup_password;
}

async function startNode(
  config: Config,
  remembered: readonly string[],
  runtime: PodRuntime,
  logger: HostLogger,
  hooks: StartPodHooks,
): Promise<void> {
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

  const info = await startListening(orcaNode, runtime);
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

  // Startup peers from the config, then the ones joined at runtime.
  await joinPeers(orcaNode, new Set([...config.peers, ...remembered]), normalizePeerUrl(info.url), logger);
}

/** Start listening; a node that cannot is stopped and dropped from the runtime, and the failure is kept. */
async function startListening(orcaNode: OrcaNode, runtime: PodRuntime): Promise<{ url: string; port: number }> {
  try {
    return await orcaNode.start();
  } catch (error) {
    runtime.error = toError(error);
    runtime.orcaNode = null;
    try {
      await orcaNode.stop();
    } catch {
      // The node never finished starting; nothing useful to report here.
    }
    throw runtime.error;
  }
}

/** Join each peer but this node itself; a peer that is down at boot must not take the local orca node down. */
async function joinPeers(orcaNode: OrcaNode, peers: Iterable<string>, self: string, logger: HostLogger): Promise<void> {
  for (const peer of peers) {
    if (peer === self) continue;
    try {
      const response = await orcaNode.join(peer);
      logger.info(`orca-pod: joined ${peer} (${response.members.length} members in directory)`);
    } catch (error) {
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
export interface StartPodHooks {
  onNodeStarted?: (orcaNode: OrcaNode) => void;
}

/**
 * Create and start a pod orca node without blocking the caller.
 *
 * The returned `ready` promise resolves after startup (success or failure) and
 * never rejects; inspect `runtime.error` for the failure cause.
 */
export function startPod(
  bundleConfig: Config,
  logger: HostLogger,
  stores: PodStores,
  hooks: StartPodHooks = {},
  defaultRoot?: string,
): PodHandle {
  const runtime: PodRuntime = { orcaNode: null, url: null, port: null, started_at: null, error: null };
  // Resolve the data directory once: an explicit `data_root` wins, else the
  // host-provided default (the DSH profile directory), else the process default.
  // Every later read (peer state, node config, panel) then sees the same path.
  const dataRoot = bundleConfig.data_root ?? defaultRoot ?? defaultDataRoot();
  const rooted = (config: Config): Config => ({
    ...config,
    data_root: config.data_root ?? dataRoot,
    workgroup_password: "",
  });
  /** The plugin config as the host gave it; the password is resolved separately. */
  let pluginConfig = rooted(bundleConfig);

  let disposed = false;
  let queue: Promise<void> = Promise.resolve();

  /**
   * Serialize node restarts and state writes. A failed operation must not
   * poison the lane: the caller still sees its rejection, but the next
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

  /** Remove a file; one that cannot be removed is reported, not fatal. */
  async function removeQuietly(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (error) {
      logger.warn(`orca-pod: could not remove ${path}: ${errorMessage(error)}`);
    }
  }

  /** (Re)start from `pluginConfig`: resolve the password, then run the node if setup is complete. Queue only. */
  async function boot(): Promise<void> {
    await stopNode(runtime, logger);
    runtime.error = null;
    const password = await readPassword(pluginConfig);
    handle.config = { ...pluginConfig, workgroup_password: password ?? "" };
    handle.configured = !needsSetup(handle.config);
    if (disposed) return;
    if (!handle.configured) {
      // The panel shows its first-run wizard and calls `reconfigure` once the
      // user has picked a workgroup, password and listen address.
      logger.info("orca-pod: waiting for workgroup setup from the panel");
      return;
    }
    try {
      await startNode(handle.config, handle.rememberedPeers, runtime, logger, hooks);
    } catch (error) {
      runtime.error = toError(error);
      logger.error(`orca-pod: orca node failed to start: ${errorMessage(runtime.error)}`);
    }
  }

  /** The stored workgroup password, or undefined when there is none or the store cannot be read. */
  async function readPassword(config: Config): Promise<string | undefined> {
    const ref = passwordRefFor(config);
    if (ref === undefined) return undefined;
    try {
      return await stores.readSecret(ref);
    } catch (error) {
      logger.warn(`orca-pod: could not read the workgroup password (${ref}): ${errorMessage(error)}`);
      return undefined;
    }
  }

  const handle: PodHandle = {
    runtime,
    config: pluginConfig,
    configured: false,
    rememberedPeers: [],
    ready: Promise.resolve(),
    async reconfigure(patch) {
      const { workgroup_password: password, ...fields } = patch;
      // Omit the field to keep the current password; a passwordless mesh is not supported.
      if (typeof password === "string" && password.trim().length === 0) {
        throw new Error("a workgroup password is required; a passwordless mesh is not supported");
      }
      // Validate the whole result first, so a bad patch changes nothing.
      const preview = parseSettings(applyPanelFields(withoutSecret(handle.config), fields));
      const ref = passwordRefFor(preview);
      if (ref === undefined) throw new Error("a workgroup id is required");
      // Switching workgroups keeps the current password unless a new one is
      // given: the password is a local secret, not a claim tied to one group.
      const carried =
        ref !== passwordRefFor(handle.config) && handle.config.workgroup_password.length > 0
          ? handle.config.workgroup_password
          : undefined;
      const secret = typeof password === "string" ? password : carried;
      // The secret goes first: in DSH the config write restarts the plugin, and
      // the new instance must already find the password.
      if (secret !== undefined) await stores.writeSecret(ref, secret);
      else if ((await stores.readSecret(ref)) === undefined) {
        throw new Error(`a workgroup password is required for ${preview.workgroup_id ?? "this workgroup"}`);
      }
      // Outside the queue on purpose: a host restart waits for the queue to drain.
      const changed = await stores.writeConfig((raw) => applyPanelFields(raw, fields));
      // Nothing to persist (only the password changed, or the bundle already
      // names the workgroup): no host restart follows, so restart in place.
      if (!changed) await enqueue(boot);
    },
    addPeer: (peer) =>
      enqueue(async () => {
        const orcaNode = runtime.orcaNode;
        if (orcaNode === null) throw new Error("orca node is not running");
        await orcaNode.join(peer);
        if (!handle.rememberedPeers.includes(peer)) handle.rememberedPeers = [...handle.rememberedPeers, peer];
        await saveRememberedPeers(dataRoot, handle.rememberedPeers);
      }),
    async disconnect() {
      await enqueue(async () => {
        const orcaNode = runtime.orcaNode;
        if (orcaNode !== null) {
          try {
            await orcaNode.leave();
          } catch (error) {
            logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`);
          }
        }
        handle.rememberedPeers = [];
        await saveRememberedPeers(dataRoot, []);
      });
      // Startup peers named in the plugin config are forgotten too.
      if (handle.config.peers.length > 0) await stores.writeConfig((raw) => applyPanelFields(raw, { peers: null }));
    },
    async reset() {
      const ref = passwordRefFor(handle.config);
      await enqueue(async () => {
        await stopNode(runtime, logger);
        for (const path of [configPath(dataRoot), identityPath(dataRoot), peerStatePath(dataRoot)]) {
          await removeQuietly(path);
        }
        handle.rememberedPeers = [];
        runtime.error = null;
      });
      if (ref !== undefined) await stores.clearSecret(ref);
      const changed = await stores.writeConfig((raw) =>
        applyPanelFields(raw, { workgroup_id: null, workgroup_password_ref: null, peers: null }),
      );
      // Back to the first-run wizard: without a stored password nothing starts,
      // even when an inherited config layer still names a workgroup.
      if (!changed) await enqueue(boot);
    },
    adopt: (config) =>
      enqueue(async () => {
        pluginConfig = rooted(config);
        await boot();
      }),
    dispose: async () => {
      disposed = true;
      await queue;
    },
  };

  stores.attach?.(handle);
  handle.ready = enqueue(async () => {
    handle.rememberedPeers = await loadRememberedPeers(dataRoot, logger);
    await boot();
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
