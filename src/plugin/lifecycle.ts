/**
 * Node lifecycle for the Orca pod DSH bundle.
 *
 * The DSH host must not block on an orca node: `start()` returns at once and
 * performs config resolution, `orcaNode.start()` and the initial `join`s on a
 * promise that never rejects. Failures are recorded in `error` and logged, so
 * `apply` always returns quickly.
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

import type { Logger } from "@deepseek-ai/cordis";

import { errorMessage } from "../core/errors.ts";
import { identityPath } from "../core/identity.ts";
import { isLoopbackEndpoint, normalizePeerUrl } from "../core/net.ts";
import { SerialQueue } from "../core/serial-queue.ts";
import { configPath, createOrcaNodeConfig, defaultDataRoot, saveConfig } from "../node/config.ts";
import { OrcaNode, createPersistentStorage } from "../node/orca-node.ts";
import { parseSettings, passwordRefFor } from "../node/settings.ts";
import type { ConfigFields, PanelPatch, Settings } from "../node/settings.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import { RememberedPeers } from "./peers-file.ts";
import type { PodStores, RawConfig } from "./stores.ts";

/** Settings with the data directory resolved: the lifecycle fixes it once, at start (DX13). */
export type RootedSettings = Settings & { data_root: string };

/** Anything thrown, as an `Error`. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/** Apply settings to a raw plugin config: a value sets the key, `null` removes it; other keys stay. */
function applyPanelFields(raw: RawConfig, fields: ConfigFields): RawConfig {
  const next: Record<string, unknown> = { ...raw };
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete next[key];
    else if (value !== undefined) next[key] = value;
  }
  // Every key written came from `fields`, so `next` still has the `RawConfig` shape.
  return next as RawConfig;
}

/** The plugin config without the in-memory password: what may be persisted. */
function withoutSecret(config: Settings): RawConfig {
  const { workgroup_password: _password, ...rest } = config;
  return rest;
}

/**
 * A panel-configured orca node needs both a workgroup and a password. Empty
 * values mean "not configured yet" and keep the node idle instead of opening a
 * passwordless mesh; the first-run wizard fills them in.
 */
function needsSetup(config: Settings): boolean {
  return !config.workgroup_id || !config.workgroup_password;
}

/**
 * The orca node of one plugin fiber, and what drives it: start, panel
 * reconfiguration, peers, reset. Every restart and state write goes through one
 * queue, so two of them never overlap.
 */
export class PodLifecycle {
  private readonly dataRoot: string;
  private readonly queue = new SerialQueue();
  private readonly peers: RememberedPeers;
  /** The plugin config as the host gave it; the password is resolved separately. */
  private pluginConfig: RootedSettings;
  private effective: RootedSettings;
  private isConfigured = false;
  private disposed = false;
  private readyPromise: Promise<void> = Promise.resolve();

  private runningNode: OrcaNode | null = null;
  private listenUrl: string | null = null;
  private listenPort: number | null = null;
  private startedAtIso: string | null = null;
  private failure: Error | null = null;

  constructor(
    config: Settings,
    private readonly logger: Logger,
    private readonly stores: PodStores,
    private readonly catalog: ModelCatalogFeed,
    defaultRoot?: string,
  ) {
    // Resolve the data directory once: an explicit `data_root` wins, else the
    // host-provided default (the DSH profile directory), else the process default.
    // Every later read (peer state, node config, panel) then sees the same path.
    this.dataRoot = config.data_root ?? defaultRoot ?? defaultDataRoot();
    this.peers = new RememberedPeers(this.dataRoot, logger);
    this.pluginConfig = this.rooted(config);
    this.effective = this.pluginConfig;
  }

  /** The created orca node, or null before creation, after a failed start and after `stop`. */
  get node(): OrcaNode | null {
    return this.runningNode;
  }

  /** Endpoint reported by `orcaNode.start()`. */
  get url(): string | null {
    return this.listenUrl;
  }

  /** Bound listen port reported by `orcaNode.start()`. */
  get port(): number | null {
    return this.listenPort;
  }

  /** ISO timestamp of a successful start. */
  get startedAt(): string | null {
    return this.startedAtIso;
  }

  /** The first fatal startup error, if any. */
  get error(): Error | null {
    return this.failure;
  }

  /** Effective config: the plugin config plus the resolved password (in memory only). */
  get config(): RootedSettings {
    return this.effective;
  }

  /** True once a workgroup and its password exist, i.e. the first-run setup is done. */
  get configured(): boolean {
    return this.isConfigured;
  }

  /** Peers joined at runtime (panel or `connect`), rejoined on the next start. */
  get rememberedPeers(): readonly string[] {
    return this.peers.list();
  }

  /** Startup completion; resolves after success or failure, never rejects. */
  get ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Begin starting: load the remembered peers and boot the node. Does not wait for it. */
  start(): void {
    this.readyPromise = this.queue.run(async () => {
      await this.peers.load();
      await this.boot();
    });
  }

  /**
   * Stop the pod; safe to call after a failed startup and safe to await twice.
   * It lets an in-flight reconfiguration finish (or skip its restart), so shutdown
   * cannot race a new listener into existence after the host disposed us (§9.2).
   */
  async stop(): Promise<void> {
    await this.readyPromise;
    this.disposed = true;
    await this.queue.drain();
    const node = this.runningNode;
    if (node === null) return;
    try {
      await node.stop();
      this.logger.info("orca-pod: orca node stopped");
    } catch (error) {
      this.logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Apply a panel patch: store a new password in the credential store, persist the
   * panel fields into the plugin config (`null` clears a field to its default),
   * and restart the node with the result.
   */
  async reconfigure(patch: PanelPatch): Promise<void> {
    const { workgroup_password: password, ...fields } = patch;
    // Omit the field to keep the current password; a passwordless mesh is not supported.
    if (typeof password === "string" && password.trim().length === 0) {
      throw new Error("a workgroup password is required; a passwordless mesh is not supported");
    }
    // Validate the whole result first, so a bad patch changes nothing.
    const preview = parseSettings(applyPanelFields(withoutSecret(this.effective), fields));
    const ref = passwordRefFor(preview);
    if (ref === undefined) throw new Error("a workgroup id is required");
    // Switching workgroups keeps the current password unless a new one is
    // given: the password is a local secret, not a claim tied to one group.
    const carried =
      ref !== passwordRefFor(this.effective) && this.effective.workgroup_password.length > 0
        ? this.effective.workgroup_password
        : undefined;
    const secret = typeof password === "string" ? password : carried;
    // The secret goes first: in DSH the config write restarts the plugin, and
    // the new instance must already find the password.
    if (secret !== undefined) await this.stores.writeSecret(ref, secret);
    else if ((await this.stores.readSecret(ref)) === undefined) {
      throw new Error(`a workgroup password is required for ${preview.workgroup_id ?? "this workgroup"}`);
    }
    // Outside the queue on purpose: a host restart waits for the queue to drain.
    const changed = await this.persist((raw) => applyPanelFields(raw, fields));
    // Nothing to persist (only the password changed, or the bundle already
    // names the workgroup): no host restart follows, so restart in place.
    if (!changed) await this.queue.run(() => this.boot());
  }

  /** `join` one peer now and remember it in the peer state file. */
  addPeer(peer: string): Promise<void> {
    return this.queue.run(async () => {
      const node = this.runningNode;
      if (node === null) throw new Error("orca node is not running");
      await node.mesh.join(peer);
      await this.peers.add(peer);
    });
  }

  /** Leave the workgroup: tell known peers and forget every remembered and configured peer. */
  async disconnect(): Promise<void> {
    await this.queue.run(async () => {
      const node = this.runningNode;
      if (node !== null) {
        try {
          await node.mesh.leave();
        } catch (error) {
          this.logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`);
        }
      }
      await this.peers.clear();
    });
    // Startup peers named in the plugin config are forgotten too.
    if (this.effective.peers.length > 0) await this.persist((raw) => applyPanelFields(raw, { peers: null }));
  }

  /** Back to the first-run wizard: drop the workgroup, its stored password and the node identity. */
  async reset(): Promise<void> {
    const ref = passwordRefFor(this.effective);
    await this.queue.run(async () => {
      await this.stopNode();
      for (const path of [configPath(this.dataRoot), identityPath(this.dataRoot), this.peers.path]) {
        await this.removeQuietly(path);
      }
      this.peers.forgetInMemory();
      this.failure = null;
    });
    if (ref !== undefined) await this.stores.clearSecret(ref);
    const changed = await this.persist((raw) =>
      applyPanelFields(raw, { workgroup_id: null, workgroup_password_ref: null, peers: null }),
    );
    // Back to the first-run wizard: without a stored password nothing starts,
    // even when an inherited config layer still names a workgroup.
    if (!changed) await this.queue.run(() => this.boot());
  }

  /**
   * Take a config the host persisted, as a plugin restart would: stop the node
   * and start again from `config`. A host that restarts the plugin itself never
   * calls it.
   */
  adopt(config: Settings): Promise<void> {
    return this.queue.run(async () => {
      this.pluginConfig = this.rooted(config);
      await this.boot();
    });
  }

  private rooted(config: Settings): RootedSettings {
    return { ...config, data_root: config.data_root ?? this.dataRoot, workgroup_password: "" };
  }

  /** Write a config change; true when something was stored (the host restarts the plugin, or we adopt it here). */
  private async persist(change: (raw: RawConfig) => RawConfig): Promise<boolean> {
    const written = await this.stores.writeConfig(change);
    if (written === null) return false;
    if (!this.stores.restartsOnWrite) await this.adopt(parseSettings(written));
    return true;
  }

  /** (Re)start from `pluginConfig`: resolve the password, then run the node if setup is complete. Queue only. */
  private async boot(): Promise<void> {
    await this.stopNode();
    this.failure = null;
    const password = await this.readPassword(this.pluginConfig);
    this.effective = { ...this.pluginConfig, workgroup_password: password ?? "" };
    this.isConfigured = !needsSetup(this.effective);
    if (this.disposed) return;
    if (!this.isConfigured) {
      // The panel shows its first-run wizard and calls `reconfigure` once the
      // user has picked a workgroup, password and listen address.
      this.logger.info("orca-pod: waiting for workgroup setup from the panel");
      return;
    }
    try {
      await this.startNode(this.effective);
    } catch (error) {
      this.failure = toError(error);
      this.logger.error(`orca-pod: orca node failed to start: ${errorMessage(this.failure)}`);
    }
  }

  /** The stored workgroup password, or undefined when there is none or the store cannot be read. */
  private async readPassword(config: Settings): Promise<string | undefined> {
    const ref = passwordRefFor(config);
    if (ref === undefined) return undefined;
    try {
      return await this.stores.readSecret(ref);
    } catch (error) {
      this.logger.warn(`orca-pod: could not read the workgroup password (${ref}): ${errorMessage(error)}`);
      return undefined;
    }
  }

  private async startNode(config: RootedSettings): Promise<void> {
    const dataRoot = config.data_root;
    // The plugin runs real DSH sessions by default. A loopback-only advertise list
    // is useless across machines, so it means "derive from the listen address".
    const nodeConfig = await createOrcaNodeConfig({
      ...config,
      data_root: dataRoot,
      executor: config.executor ?? "acp",
      endpoints: config.endpoints.every(isLoopbackEndpoint) ? [] : config.endpoints,
    });
    await saveConfig(configPath(dataRoot), nodeConfig);
    const node = new OrcaNode(nodeConfig, { storage: createPersistentStorage(nodeConfig), logger: this.logger });
    this.runningNode = node;

    const info = await this.startListening(node);
    this.listenUrl = info.url;
    this.listenPort = info.port;
    this.startedAtIso = new Date().toISOString();
    this.failure = null;
    this.logger.info(
      `orca-pod: orca node ${nodeConfig.orca_node_id} listening on ${info.url} (workgroup ${nodeConfig.workgroup_id})`,
    );

    // Install the model catalog before the first join so the joined self record
    // and every heartbeat carry it from the start (§6.15).
    try {
      this.catalog.advertise(node);
    } catch (error) {
      this.logger.warn(`orca-pod: advertising the model catalog failed: ${errorMessage(error)}`);
    }

    // Startup peers from the config, then the ones joined at runtime.
    await this.joinPeers(node, new Set([...config.peers, ...this.peers.list()]), normalizePeerUrl(info.url));
  }

  /** Start listening; a node that cannot is stopped and dropped, and the failure is kept. */
  private async startListening(node: OrcaNode): Promise<{ url: string; port: number }> {
    try {
      return await node.start();
    } catch (error) {
      this.failure = toError(error);
      this.runningNode = null;
      try {
        await node.stop();
      } catch {
        // The node never finished starting; nothing useful to report here.
      }
      throw this.failure;
    }
  }

  /** Join each peer but this node itself; a peer that is down at boot must not take the local orca node down. */
  private async joinPeers(node: OrcaNode, peers: Iterable<string>, self: string): Promise<void> {
    for (const peer of peers) {
      if (peer === self) continue;
      try {
        const response = await node.mesh.join(peer);
        this.logger.info(`orca-pod: joined ${peer} (${response.members.length} members in directory)`);
      } catch (error) {
        this.logger.warn(`orca-pod: join ${peer} failed: ${errorMessage(error)}`);
      }
    }
  }

  private async stopNode(): Promise<void> {
    const node = this.runningNode;
    this.runningNode = null;
    this.listenUrl = null;
    this.listenPort = null;
    if (node === null) return;
    try {
      await node.stop();
    } catch (error) {
      this.logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
    }
  }

  /** Remove a file; one that cannot be removed is reported, not fatal. */
  private async removeQuietly(path: string): Promise<void> {
    try {
      await rm(path, { force: true });
    } catch (error) {
      this.logger.warn(`orca-pod: could not remove ${path}: ${errorMessage(error)}`);
    }
  }
}
