/**
 * Node lifecycle for the Orca pod DSH bundle.
 *
 * The DSH host must not block on an orca node: `start()` returns at once and
 * performs config resolution, `orcaNode.start()` and the initial `join`s on a
 * promise that never rejects. Failures become the `failed` status and are
 * logged, so `apply` always returns quickly.
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

/** One started node; replaced as a whole on every restart, never mutated. */
export type PodRun = { readonly node: OrcaNode; readonly port: number };

/** What the pod is doing, as one value. */
export type PodStatus =
  /** No workgroup or no stored password: the panel shows the first-run wizard. */
  | { kind: "unconfigured" }
  /** A (re)start is queued, or running up to the moment the node listens. */
  | { kind: "starting" }
  | { kind: "running"; run: PodRun }
  | { kind: "failed"; error: Error }
  /** The plugin fiber unloaded. */
  | { kind: "stopped" };

/**
 * The orca node of one plugin fiber, and what drives it: start, panel
 * reconfiguration, peers, reset. Every restart and state write goes through one
 * queue, so two of them never overlap.
 *
 * The pod lives as long as the plugin fiber; a node lives for one run and is
 * replaced as a whole on every restart. Consumers read the current run through
 * `run` (display, background work) or `settled()` and `requireRun()` (actions).
 */
export class PodLifecycle {
  private readonly dataRoot: string;
  private readonly queue = new SerialQueue();
  private readonly peers: RememberedPeers;
  /** The plugin config as the host gave it; the password is resolved separately. */
  private pluginConfig: RootedSettings;
  private effective: RootedSettings;
  /** Where the last finished (re)start left the pod; only the queue writes it. */
  private outcome: Exclude<PodStatus, { kind: "starting" }> = { kind: "unconfigured" };
  /** Restarts that are queued or have not brought their node up yet. */
  private restarting = 0;
  /** The last queued restart, rejoin of the peers included; it never rejects. */
  private booting: Promise<void> = Promise.resolve();

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

  /** What the pod is doing now. A queued restart counts as `starting`: the node it replaces is about to go. */
  get status(): PodStatus {
    return this.restarting > 0 ? { kind: "starting" } : this.outcome;
  }

  /** The current run, or null in every other status. Read-only projections use this. */
  get run(): PodRun | null {
    const { status } = this;
    return status.kind === "running" ? status.run : null;
  }

  /** Settles when no (re)start is queued or running, the rejoin of the peers included; it never rejects. */
  settled(): Promise<void> {
    return this.booting;
  }

  /** The current run, or an error that names the status. */
  requireRun(): PodRun {
    return PodLifecycle.runOf(this.status);
  }

  /** Effective config: the plugin config plus the resolved password (in memory only). */
  get config(): RootedSettings {
    return this.effective;
  }

  /** True once a workgroup and its password exist, i.e. the first-run setup is done. */
  get configured(): boolean {
    return Boolean(this.effective.workgroup_id && this.effective.workgroup_password);
  }

  /** Peers joined at runtime (panel or `connect`), rejoined on the next start. */
  get rememberedPeers(): readonly string[] {
    return this.peers.list();
  }

  /** Begin starting: load the remembered peers and boot the node. Does not wait for it. */
  start(): void {
    void this.queue.run(() => this.peers.load());
    void this.restart();
  }

  /**
   * Stop the pod; safe to call after a failed startup and safe to await twice.
   * It takes its turn in the queue: a restart queued after it finds the pod
   * stopped and starts nothing, so shutdown cannot race a new listener into
   * existence after the host disposed us (§9.2).
   */
  async stop(): Promise<void> {
    await this.queue.run(async () => {
      await this.stopNode();
      this.outcome = { kind: "stopped" };
    });
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
    // The plugin config without the in-memory password is what may be persisted.
    const { workgroup_password: _password, ...persisted } = this.effective;
    const preview = parseSettings(PodLifecycle.applyPanelFields(persisted, fields));
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
    const changed = await this.persist((raw) => PodLifecycle.applyPanelFields(raw, fields));
    // Nothing to persist (only the password changed, or the bundle already
    // names the workgroup): no host restart follows, so restart in place.
    if (!changed) await this.restart();
  }

  /** `join` one peer now and remember it in the peer state file. */
  addPeer(peer: string): Promise<void> {
    return this.queue.run(async () => {
      await PodLifecycle.runOf(this.outcome).node.mesh.join(peer);
      await this.peers.add(peer);
    });
  }

  /** Leave the workgroup: tell known peers and forget every remembered and configured peer. */
  async disconnect(): Promise<void> {
    await this.queue.run(async () => {
      if (this.outcome.kind === "running") {
        try {
          await this.outcome.run.node.mesh.leave();
        } catch (error) {
          this.logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`);
        }
      }
      await this.peers.clear();
    });
    // Startup peers named in the plugin config are forgotten too.
    if (this.effective.peers.length > 0)
      await this.persist((raw) => PodLifecycle.applyPanelFields(raw, { peers: null }));
  }

  /** Back to the first-run wizard: drop the workgroup, its stored password and the node identity. */
  async reset(): Promise<void> {
    const ref = passwordRefFor(this.effective);
    await this.queue.run(async () => {
      await this.stopNode();
      for (const path of [configPath(this.dataRoot), identityPath(this.dataRoot)]) {
        await this.removeQuietly(path);
      }
      await this.peers.remove();
    });
    if (ref !== undefined) await this.stores.clearSecret(ref);
    const changed = await this.persist((raw) =>
      PodLifecycle.applyPanelFields(raw, { workgroup_id: null, workgroup_password_ref: null, peers: null }),
    );
    // Back to the first-run wizard: without a stored password nothing starts,
    // even when an inherited config layer still names a workgroup.
    if (!changed) await this.restart();
  }

  /**
   * Take a config the host persisted, as a plugin restart would: stop the node
   * and start again from `config`. A host that restarts the plugin itself never
   * calls it.
   */
  adopt(config: Settings): Promise<void> {
    this.pluginConfig = this.rooted(config);
    return this.restart();
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

  /**
   * Queue a (re)start. `status` reads `starting` from this call on, so nobody is
   * handed the node that is about to go, and `settled()` waits for this restart.
   */
  private restart(): Promise<void> {
    this.restarting += 1;
    const done = this.queue.run(() => this.boot());
    this.booting = done.catch(() => {});
    return done;
  }

  /** (Re)start from `pluginConfig`: bring the node up, then rejoin the peers. Queue only. */
  private async boot(): Promise<void> {
    const rejoin = await this.bringUp();
    if (rejoin !== null) await this.joinPeers(rejoin.node, rejoin.peers, rejoin.self);
  }

  /**
   * Stop the old node, resolve the password and run a new node if setup is
   * complete. Settles the restart's `starting` status, so the new run is visible
   * while its peers are still being joined. Queue only.
   */
  private async bringUp(): Promise<{ node: OrcaNode; peers: Set<string>; self: string } | null> {
    try {
      if (this.outcome.kind === "stopped") return null;
      await this.stopNode();
      const password = await this.readPassword(this.pluginConfig);
      this.effective = { ...this.pluginConfig, workgroup_password: password ?? "" };
      // A panel-configured orca node needs both a workgroup and a password. Empty
      // values mean "not configured yet" and keep the node idle instead of opening
      // a passwordless mesh; the first-run wizard fills them in.
      if (!this.configured) {
        // The panel shows its first-run wizard and calls `reconfigure` once the
        // user has picked a workgroup, password and listen address.
        this.logger.info("orca-pod: waiting for workgroup setup from the panel");
        return null;
      }
      try {
        const run = await this.startNode(this.effective);
        this.outcome = { kind: "running", run };
        // Startup peers from the config, then the ones joined at runtime.
        return {
          node: run.node,
          peers: new Set([...this.effective.peers, ...this.peers.list()]),
          self: normalizePeerUrl(run.node.profile.endpoints[0] ?? ""),
        };
      } catch (error) {
        const failure = PodLifecycle.toError(error);
        this.outcome = { kind: "failed", error: failure };
        this.logger.error(`orca-pod: orca node failed to start: ${errorMessage(failure)}`);
        return null;
      }
    } finally {
      this.restarting -= 1;
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

  /** Create, start and equip a node. One that cannot listen is stopped and dropped, and the failure thrown. */
  private async startNode(config: RootedSettings): Promise<PodRun> {
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

    let info: { url: string; port: number };
    try {
      info = await node.start();
    } catch (error) {
      try {
        await node.stop();
      } catch {
        // The node never finished starting; nothing useful to report here.
      }
      throw error;
    }
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
    return { node, port: info.port };
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

  /** Stop the node of the current run, if any; the pod then has no run (and stays stopped if it was). */
  private async stopNode(): Promise<void> {
    const { outcome } = this;
    if (outcome.kind !== "stopped") this.outcome = { kind: "unconfigured" };
    if (outcome.kind !== "running") return;
    try {
      await outcome.run.node.stop();
      this.logger.info("orca-pod: orca node stopped");
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

  /** The run of a status, or the error that says why there is none. */
  private static runOf(status: PodStatus): PodRun {
    switch (status.kind) {
      case "running":
        return status.run;
      case "starting":
        throw new Error("orca node is not running: it is still starting");
      case "failed":
        throw new Error(`orca node is not running: ${status.error.message}`);
      case "stopped":
        throw new Error("orca node is not running: the pod was stopped");
      case "unconfigured":
        throw new Error("orca node is not running: the workgroup and its password are not set up yet");
    }
  }

  /** Anything thrown, as an `Error`. */
  private static toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  /** Apply settings to a raw plugin config: a value sets the key, `null` removes it; other keys stay. */
  private static applyPanelFields(raw: RawConfig, fields: ConfigFields): RawConfig {
    const next: Record<string, unknown> = { ...raw };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    // Every key written came from `fields`, so `next` still has the `RawConfig` shape.
    return next as RawConfig;
  }
}
