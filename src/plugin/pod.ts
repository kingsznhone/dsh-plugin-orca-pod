/**
 * The pod of the Orca DSH bundle: this machine's settings, password, peers and orca node.
 *
 * The DSH host must not block on an orca node: `start()` returns at once and
 * performs settings loading, `orcaNode.start()` and the initial `join`s on a
 * promise that never rejects. Failures become the `failed` status and are
 * logged, so `apply` always returns quickly.
 *
 * A machine has one node however many DSH profiles it runs (§3.9), so
 * everything the pod keeps is machine-wide:
 * - **settings** are `<data_root>/settings.json` (`SettingsFile`); the panel
 *   writes it and the pod restarts its node in place;
 * - **the workgroup password and the node's private key** are DSH credentials
 *   (`PodStores`, §3.6); nothing secret is written to a file, and the workgroup
 *   key derived from the password lives in memory only;
 * - **state** — peers joined at runtime — is a file under `<data_root>`, because
 *   remembering a peer must not restart the node.
 *
 * Two DSH processes on one machine share all of this, and the listen port is the
 * lock: the one that cannot bind reports that a node is already running.
 */

import type { Logger } from "@deepseek-ai/cordis";

import { errorMessage } from "../core/errors.ts";
import { isLoopbackEndpoint } from "../core/net.ts";
import { SerialQueue } from "../core/serial-queue.ts";
import { deriveWorkgroupKey } from "../core/signing.ts";
import { createOrcaNodeConfig } from "../node/config.ts";
import { Orca } from "../node/orca.ts";
import { parseSettings } from "../node/settings.ts";
import type { ConfigFields, PanelPatch, Settings } from "../node/settings.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import { RememberedPeers } from "./peers-file.ts";
import { SettingsFile, type RawSettings } from "./settings-file.ts";
import type { PodStores } from "./stores.ts";

/** One started node; replaced as a whole on every restart, never mutated. */
export type PodRun = { readonly orca: Orca; readonly port: number };

/** What the pod is doing, as one value. */
type PodStatus =
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
 * `run` (display, background work) or `orca()` (actions).
 */
export class Pod {
  private readonly queue = new SerialQueue();
  private readonly peers: RememberedPeers;
  private readonly file: SettingsFile;
  /** The settings as the last start read them; the panel's edits are applied to the file and read back by the next start. */
  private saved: Settings = parseSettings({});
  /** The stored workgroup password as the last start read it; in memory only. */
  private password: string | undefined;
  /** Where the last finished (re)start left the pod; only the queue writes it. */
  private outcome: Exclude<PodStatus, { kind: "starting" }> = { kind: "unconfigured" };
  /** Restarts that are queued or have not brought their node up yet. */
  private restarting = 0;
  /** The last queued restart, rejoin of the peers included; it never rejects. */
  private booting: Promise<void> = Promise.resolve();

  constructor(
    private readonly logger: Logger,
    private readonly stores: PodStores,
    private readonly catalog: ModelCatalogFeed,
    /** The data directory of this machine's node (§3.9). */
    readonly dataRoot: string,
    /** The DSH profile this plugin was loaded from; the node runs tasks in it (D46). */
    private readonly profile?: string,
  ) {
    this.peers = new RememberedPeers(dataRoot, logger);
    this.file = new SettingsFile(dataRoot);
    // The host's model catalog changes while the pod lives: install it on whichever node runs.
    catalog.changes.subscribe(() => {
      const run = this.run;
      if (run !== null) this.advertise(run.orca);
    });
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

  /**
   * The running node, once no (re)start is queued or running (the rejoin of the
   * peers included); an error that names the status when there is none.
   */
  async orca(): Promise<Orca> {
    await this.booting;
    return Pod.runOf(this.status).orca;
  }

  /** The settings as the last start read them; they never hold the password. */
  get settings(): Settings {
    return this.saved;
  }

  /** True once a workgroup and its password exist, i.e. the first-run setup is done (as the last start read them). */
  get configured(): boolean {
    return Boolean(this.saved.workgroup_id) && this.password !== undefined;
  }

  /** Whether a password is stored right now: asks the credential store, not what the last start read. */
  passwordConfigured(): Promise<boolean> {
    return this.stores.passwordConfigured();
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
   * Apply a panel patch: store a new password in the credential store, write the
   * panel fields into the settings file (`null` clears a field to its default),
   * and restart the node with the result.
   */
  async reconfigure(patch: PanelPatch): Promise<void> {
    const { workgroup_password: password, ...fields } = patch;
    // Omit the field to keep the current password; a passwordless mesh is not supported.
    if (typeof password === "string" && password.trim().length === 0) {
      throw new Error("a workgroup password is required; a passwordless mesh is not supported");
    }
    // Validate the whole result first, so a bad patch changes nothing.
    const preview = parseSettings(Pod.applyPanelFields(await this.file.read(), fields));
    if (preview.workgroup_id === undefined) throw new Error("a workgroup id is required");
    // The password is machine-wide, so it stays when the workgroup changes. It is stored
    // before the settings are, so whatever starts on them already finds it.
    if (typeof password === "string") await this.stores.writePassword(password);
    else if (!(await this.stores.passwordConfigured())) {
      throw new Error(`a workgroup password is required for ${preview.workgroup_id}`);
    }
    await this.commit((raw) => Pod.applyPanelFields(raw, fields));
  }

  /** `join` one peer now and remember it in the peer state file. */
  addPeer(peer: string): Promise<void> {
    return this.queue.run(async () => {
      await Pod.runOf(this.outcome).orca.mesh.probe(peer);
      await this.peers.add(peer);
    });
  }

  /** Leave the workgroup: tell known peers and forget every remembered and configured peer. */
  async disconnect(): Promise<void> {
    await this.queue.run(async () => {
      if (this.outcome.kind === "running") {
        try {
          await this.outcome.run.orca.mesh.leave();
        } catch (error) {
          this.logger.warn(`orca-pod: leave failed: ${errorMessage(error)}`);
        }
      }
      await this.peers.clear();
    });
    // Startup peers named in the settings are forgotten too.
    if (this.saved.peers.length > 0) await this.commit((raw) => Pod.applyPanelFields(raw, { peers: null }));
  }

  /**
   * Back to the first-run wizard: delete everything this machine's node has, with
   * no exceptions (§3.9): the node, its password, its private key, its settings
   * and its remembered peers.
   */
  async reset(): Promise<void> {
    await this.queue.run(async () => {
      await this.stopNode();
      await this.stores.clearPassword();
      await this.stores.deleteIdentity();
      await this.file.remove();
      await this.peers.remove();
      this.password = undefined;
      this.saved = parseSettings({});
    });
    // Without a stored password nothing starts.
    await this.restart();
  }

  /**
   * The credential store changed a name this pod keeps (the password, the node
   * key): another DSH process, the settings page or an edit of the file did it.
   * Restart once to use the new value; a change this run already uses (the pod's
   * own write) restarts nothing.
   */
  credentialsChanged(): void {
    const done = this.queue.run(async () => {
      if (this.outcome.kind === "stopped" || !(await this.credentialsDiffer())) return;
      this.restarting += 1;
      await this.boot();
    });
    this.booting = done.catch(() => {});
  }

  /** Make a panel action durable, then run the pod on the result: the settings file is written and the node restarts in place. */
  private async commit(change: (raw: RawSettings) => RawSettings): Promise<void> {
    // The write is not queued: it must not wait for the restart that follows it.
    const next = change(await this.file.read());
    // A result the parser refuses is not stored.
    parseSettings(next);
    await this.file.write(next);
    await this.restart();
  }

  /**
   * Queue a (re)start. `status` reads `starting` from this call on, so nobody is
   * handed the node that is about to go, and `orca()` waits for this restart.
   */
  private restart(): Promise<void> {
    this.restarting += 1;
    const done = this.queue.run(() => this.boot());
    this.booting = done.catch(() => {});
    return done;
  }

  /** (Re)start from the stored settings: bring the node up, then seed it with the peers. Queue only. */
  private async boot(): Promise<void> {
    const seeds = await this.bringUp();
    if (seeds !== null) await this.seed(seeds.orca, seeds.peers);
  }

  /**
   * Stop the old node, read the settings and the password and run a new node if
   * setup is complete. Settles the restart's `starting` status, so the new run is
   * visible while its peers are still being joined. Queue only.
   */
  private async bringUp(): Promise<{ orca: Orca; peers: Set<string> } | null> {
    try {
      if (this.outcome.kind === "stopped") return null;
      await this.stopNode();
      try {
        this.saved = parseSettings(await this.file.read());
      } catch (error) {
        return this.fail(error);
      }
      const password = await this.readPassword();
      this.password = password;
      // A node needs both a workgroup and a password. Empty values mean "not
      // configured yet" and keep the node idle instead of opening a passwordless
      // mesh; the first-run wizard fills them in.
      if (password === undefined || this.saved.workgroup_id === undefined) {
        // The panel shows its first-run wizard and calls `reconfigure` once the
        // user has picked a workgroup, password and listen address.
        this.logger.info("orca-pod: waiting for workgroup setup from the panel");
        return null;
      }
      try {
        const run = await this.startNode(password);
        this.outcome = { kind: "running", run };
        // The host's providers may have finished loading since the last read.
        void this.catalog.refresh();
        // Startup peers from the settings, then the ones joined at runtime.
        return { orca: run.orca, peers: new Set([...this.saved.peers, ...this.peers.list()]) };
      } catch (error) {
        return this.fail(error);
      }
    } finally {
      this.restarting -= 1;
    }
  }

  /** The restart ended in `failed`; nothing is running. */
  private fail(error: unknown): null {
    const failure = error instanceof Error ? error : new Error(String(error));
    this.outcome = { kind: "failed", error: failure };
    this.logger.error(`orca-pod: orca node failed to start: ${errorMessage(failure)}`);
    return null;
  }

  /** The stored workgroup password, or undefined when there is none or the store cannot be read. */
  private async readPassword(): Promise<string | undefined> {
    try {
      return await this.stores.readPassword();
    } catch (error) {
      this.logger.warn(`orca-pod: could not read the workgroup password: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** Whether the credential store now holds a password or a node key other than the ones the current run started with. */
  private async credentialsDiffer(): Promise<boolean> {
    const password = await this.readPassword();
    if (password !== this.password) return true;
    const { outcome } = this;
    if (outcome.kind !== "running") return false;
    try {
      return (await this.stores.readIdentity())?.orcaNodeId !== outcome.run.orca.orcaNodeId;
    } catch {
      // A damaged key record is for the next start to report.
      return true;
    }
  }

  /** Create, start and equip a node. One that cannot listen is stopped and dropped, and the failure thrown. */
  private async startNode(password: string): Promise<PodRun> {
    const identity = await this.stores.identity();
    // The plugin runs real DSH sessions by default. A loopback-only advertise list
    // is useless across machines, so it means "derive from the listen address".
    const config = createOrcaNodeConfig(
      parseSettings({
        ...this.saved,
        executor: this.saved.executor ?? "acp",
        endpoints: this.saved.endpoints.every(isLoopbackEndpoint) ? [] : this.saved.endpoints,
      }),
      identity,
      this.dataRoot,
    );
    // One scrypt derivation per start; the key stays in memory (§7.1).
    const key = deriveWorkgroupKey(config.workgroup_id, password);
    const node = new Orca(config, identity, key, { logger: this.logger, profile: this.profile });

    let info: { url: string; port: number };
    try {
      info = await node.start();
    } catch (error) {
      try {
        await node.stop();
      } catch {
        // The node never finished starting; nothing useful to report here.
      }
      // Another process holding the port is another DSH running this machine's node (§3.9).
      throw (error as { code?: unknown } | null)?.code === "EADDRINUSE"
        ? new Error(
            `an orca node is already running on this machine, in another DSH process (port ${config.port} is in use)`,
          )
        : error;
    }
    this.logger.info(
      `orca-pod: orca node ${config.orca_node_id} listening on ${info.url} (workgroup ${config.workgroup_id})`,
    );

    // The node carries the catalog from its first join on, so the self record
    // peers receive and every heartbeat advertise it (§6.15).
    this.advertise(node);
    return { orca: node, port: info.port };
  }

  /** Install the host's current model catalog on a node; the one place it is installed. */
  private advertise(node: Orca): void {
    const { models, defaultModel } = this.catalog.current();
    try {
      node.models.update(models, defaultModel);
    } catch (error) {
      this.logger.warn(`orca-pod: advertising the model catalog failed: ${errorMessage(error)}`);
    }
  }

  /**
   * Seed the node's mesh with the peers it is configured with or remembers. A peer
   * that is down at boot must not take the local orca node down, and is not given
   * up: the mesh tries it again on a backoff until it answers.
   */
  private async seed(orca: Orca, peers: Iterable<string>): Promise<void> {
    const { reached, pending } = await orca.mesh.seed(peers);
    for (const node of reached) this.logger.info(`orca-pod: reached ${node.displayName} (${node.id})`);
    if (pending.length > 0) {
      this.logger.warn(`orca-pod: no answer yet from ${pending.join(", ")}; trying again in the background`);
    }
  }

  /** Stop the node of the current run, if any; the pod then has no run (and stays stopped if it was). */
  private async stopNode(): Promise<void> {
    const { outcome } = this;
    if (outcome.kind !== "stopped") this.outcome = { kind: "unconfigured" };
    if (outcome.kind !== "running") return;
    try {
      await outcome.run.orca.stop();
      this.logger.info("orca-pod: orca node stopped");
    } catch (error) {
      this.logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
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
  /** Apply settings to a raw settings object: a value sets the key, `null` removes it; other keys stay. */
  private static applyPanelFields(raw: RawSettings, fields: ConfigFields): RawSettings {
    const next: Record<string, unknown> = { ...raw };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    // Every key written came from `fields`, so `next` still has the `RawSettings` shape.
    return next as RawSettings;
  }
}
