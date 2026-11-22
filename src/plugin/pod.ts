/**
 * The pod of the Orca DSH bundle: this machine's settings, password, peers and orca node.
 *
 * The DSH host must not block on an orca node: `start()` returns at once and
 * performs settings loading, `Orca.start()` and the initial peer seeding
 * (`mesh.seed`) on a promise that never rejects. Failures become the `failed`
 * status and are logged, so `apply` always returns quickly.
 *
 * A machine has one node however many DSH profiles it runs (implementation.md 2), so
 * everything the pod keeps is machine-wide:
 * - **settings** are `<data_root>/settings.json` (`SettingsFile`); the panel
 *   writes it and the pod restarts its node in place. A peer joined at runtime
 *   is added to its `peers` without a restart: the node already has it;
 * - **the workgroup password and the node's private key** are DSH credentials
 *   (`PodStores`, design.md 2.2); nothing secret is written to a file, and the workgroup
 *   key derived from the password lives in memory only.
 *
 * Two DSH processes on one machine share all of this, and the listen port is the
 * lock: the one that cannot bind reports that a node is already running.
 */

import { scryptSync } from "node:crypto";

import { isLoopbackHost } from "@deepseek-ai/dsh-host-webserver";
import type { Context, Logger } from "@deepseek-ai/cordis";

import { errorMessage } from "../core/errors.ts";
import { normalizePeerUrl } from "../core/net.ts";
import type { WorkgroupId } from "../core/ids.ts";
import { Orca } from "../node/orca.ts";
import { parseSettings, type PanelPatch, type Settings } from "../node/settings.ts";
import type { ModelCatalogFeed } from "./catalog.ts";
import { SettingsFile } from "./settings-file.ts";
import { NODE_KEY, PASSWORD_REF, PodStores } from "./stores.ts";

/**
 * Runs async operations one after another. A failed operation must not poison
 * the lane: its caller still sees the rejection, but the next operation starts
 * against a clean queue.
 */
export class SerialQueue {
  /** Settles when everything queued so far has; it never rejects. */
  private tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  /** Settles once everything queued so far has; it never rejects. */
  settled(): Promise<void> {
    return this.tail;
  }
}

const KEY_DERIVATION_SALT = "orca-pod";
/** scrypt parameters: ~32 MiB, one derivation per start, ~100ms (design.md 2.2). */
const KEY_DERIVATION_N = 1 << 15;
const KEY_DERIVATION_R = 8;
const KEY_DERIVATION_P = 1;
const KEY_DERIVATION_MAX_MEM = 64 * 1024 * 1024;

/**
 * scrypt(password, salt="orca-pod\x00<workgroup_id>") -> 32 bytes.
 *
 * Memory-hard on purpose: the workgroup key backs the HMAC proof of every
 * request, so HKDF's cheap output would make a stolen proof an offline
 * dictionary target. scrypt is paid once per node start (each restart derives
 * it again); the salt binds the derivation to the workgroup id so the same
 * password yields a different key in another group.
 */
export function deriveWorkgroupKey(workgroupId: WorkgroupId, password: string): Buffer {
  const salt = Buffer.concat([
    Buffer.from(KEY_DERIVATION_SALT, "utf8"),
    Buffer.from([0]),
    Buffer.from(workgroupId, "utf8"),
  ]);
  return scryptSync(Buffer.from(password, "utf8"), salt, 32, {
    N: KEY_DERIVATION_N,
    r: KEY_DERIVATION_R,
    p: KEY_DERIVATION_P,
    maxmem: KEY_DERIVATION_MAX_MEM,
  });
}

/** True for URLs that dial the local machine only. */
export function isLoopbackEndpoint(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || isLoopbackHost(host);
  } catch {
    return false;
  }
}

/** What the pod is doing, as one value. */
type PodStatus =
  /** No workgroup or no stored password: the panel shows the first-run wizard. */
  | { kind: "unconfigured" }
  /** A (re)start is queued, or running up to the moment the node listens. */
  | { kind: "starting" }
  /** A started node; replaced as a whole on every restart. */
  | { kind: "running"; orca: Orca }
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
  private readonly file: SettingsFile;
  /**
   * The settings as the last (re)start read them; a panel patch is written and read
   * back by the same restart, and a peer added at runtime is written to the file
   * but picked up by the next start.
   */
  private saved: Settings = parseSettings({});
  /** The stored workgroup password as the last start read it; in memory only. */
  private password: string | undefined;
  /** Where the last finished (re)start left the pod; only the queue writes it. */
  private outcome: Exclude<PodStatus, { kind: "starting" }> = { kind: "unconfigured" };
  /** Restarts that are queued or have not brought their node up yet. */
  private restarting = 0;

  private readonly stores: PodStores;

  constructor(
    private readonly logger: Logger,
    /** The host's credential store: the workgroup password and the node's private key (design.md 2.1, 2.2). */
    host: Pick<Context, "credentials">,
    private readonly catalog: ModelCatalogFeed,
    /** The data directory of this machine's node (implementation.md 2). */
    readonly dataRoot: string,
  ) {
    this.stores = new PodStores(host);
    this.file = new SettingsFile(dataRoot);
    // The host's model catalog changes while the pod lives: install it on whichever node runs.
    catalog.changes.subscribe(() => {
      const run = this.run;
      if (run !== null) this.advertise(run);
    });
  }

  /** What the pod is doing now. A queued restart counts as `starting`: the node it replaces is about to go. */
  get status(): PodStatus {
    return this.restarting > 0 ? { kind: "starting" } : this.outcome;
  }

  /** The current run, or null in every other status. Read-only projections use this. */
  get run(): Orca | null {
    const { status } = this;
    return status.kind === "running" ? status.orca : null;
  }

  /**
   * The running node, once nothing queued before this call is left (a (re)start,
   * the rejoin of the peers, a peer being joined); an error that names the status
   * when there is none.
   */
  async orca(): Promise<Orca> {
    await this.queue.settled();
    return Pod.runOf(this.status);
  }

  /** The settings as the pod last read or wrote them; they never hold the password. */
  get settings(): Settings {
    return this.saved;
  }

  /** True once a workgroup and its password exist, i.e. the first-run setup is done (as the last start read them). */
  get configured(): boolean {
    return Boolean(this.saved.workgroup_id) && this.password !== undefined;
  }

  /** Begin starting: boot the node. Does not wait for it. */
  start(): void {
    void this.restart();
  }

  /**
   * Stop the pod; safe to call after a failed startup and safe to await twice.
   * It takes its turn in the queue: a restart queued after it finds the pod
   * stopped and starts nothing, so shutdown cannot race a new listener into
   * existence after the host disposed us (implementation.md 2).
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
    // Omit the password to keep the current one (`PanelPatchSchema` refuses a blank one).
    const { workgroup_password: password, ...fields } = patch;
    // Everything happens in the restart's own turn, checked before anything is
    // written, so a bad patch changes nothing. The credential store reports the
    // password write back as a change (`credentialsChanged`); that report is queued
    // behind this restart and finds the new run already using it, so the node
    // restarts once. The password is machine-wide, so it stays when the workgroup
    // changes; it is stored before the settings are, so whatever starts on them finds it.
    await this.restart(async () => {
      const next = Pod.applyPanelFields(await this.file.read(), fields);
      const { workgroup_id: workgroupId } = parseSettings(next);
      if (workgroupId === undefined) throw new Error("a workgroup id is required");
      if (typeof password === "string") await this.stores.writePassword(password);
      else if ((await this.readPassword()) === undefined) {
        throw new Error(`a workgroup password is required for ${workgroupId}; a passwordless mesh is not supported`);
      }
      await this.file.write(next);
    });
  }

  /**
   * `connect` to one peer now and add it to the settings' `peers`, so it is
   * contacted again on every start; answers the address in its canonical form.
   * The node already has it, so nothing restarts.
   */
  async addPeer(address: string): Promise<string> {
    const peer = normalizePeerUrl(address);
    return this.queue.run(async () => {
      await Pod.runOf(this.outcome).mesh.probe(peer);
      const raw = await this.file.read();
      const { peers } = parseSettings(raw);
      if (!peers.includes(peer)) await this.file.write({ ...raw, peers: [...peers, peer] });
      return peer;
    });
  }

  /**
   * Back to the first-run wizard: forget the workgroup, delete the stored password
   * and the node's private key, and remove the settings file; the data root (tasks,
   * blobs and workspaces) is kept. Without a stored password the restart starts
   * nothing.
   */
  reset(): Promise<void> {
    return this.restart(async () => {
      await this.stores.clearPassword();
      await this.stores.deleteIdentity();
      await this.file.remove();
    });
  }

  /**
   * The credential store changed `name`. When it is one this pod keeps (the
   * password, the node key), another DSH process, the settings page or an edit
   * of the file did it: restart once to use the new value. A change this run
   * already uses (the pod's own write) restarts nothing.
   */
  credentialsChanged(name: string): void {
    if (name !== PASSWORD_REF && name !== NODE_KEY) return;
    this.queue
      .run(async () => {
        if (this.outcome.kind === "stopped" || !(await this.credentialsDiffer())) return;
        this.restarting += 1;
        await this.boot();
      })
      .catch(() => {});
  }

  /**
   * Queue a (re)start, after `change` has made a panel action durable (in the same
   * turn, so nothing else runs in between). `status` reads `starting` from this
   * call on, so nobody is handed the node that is about to go, and `orca()` waits
   * for this restart. A change that fails is the caller's error, and the running
   * node is left as it was.
   */
  private restart(change?: () => Promise<void>): Promise<void> {
    this.restarting += 1;
    return this.queue.run(() => this.boot(change));
  }

  /** (Re)start from the stored settings: bring the node up, then seed it with the peers. Queue only. */
  private async boot(change?: () => Promise<void>): Promise<void> {
    const orca = await this.bringUp(change);
    if (orca !== null) await this.seed(orca, this.saved.peers);
  }

  /**
   * Apply `change`, stop the old node, read the settings and the password and run
   * a new node if setup is complete. Settles the restart's `starting` status, so
   * the new run is visible while its peers are still being joined. Queue only.
   */
  private async bringUp(change?: () => Promise<void>): Promise<Orca | null> {
    try {
      if (this.outcome.kind === "stopped") return null;
      await change?.();
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
        const run = await this.startNode(this.saved.workgroup_id, password);
        this.outcome = { kind: "running", orca: run };
        // The host's providers may have finished loading since the last read.
        void this.catalog.refresh();
        return run;
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
      return (await this.stores.readIdentity())?.orcaNodeId !== outcome.orca.mesh.self.id;
    } catch {
      // A damaged key record is for the next start to report.
      return true;
    }
  }

  /** Create, start and equip a node. One that cannot listen is stopped and dropped, and the failure thrown. */
  private async startNode(workgroupId: WorkgroupId, password: string): Promise<Orca> {
    const identity = await this.stores.identity();
    // A loopback-only advertise list is useless across machines, so it means
    // "derive from the listen address".
    const settings: Settings = {
      ...this.saved,
      endpoints: this.saved.endpoints.every(isLoopbackEndpoint) ? [] : this.saved.endpoints,
    };
    // One scrypt derivation per start; the key stays in memory (design.md 2.2).
    const key = deriveWorkgroupKey(workgroupId, password);
    const node = new Orca(settings, identity, key, this.dataRoot, { logger: this.logger });

    let info: { url: string; port: number };
    try {
      info = await node.start();
    } catch (error) {
      try {
        await node.stop();
      } catch {
        // The node never finished starting; nothing useful to report here.
      }
      // Another process holding the port is another DSH running this machine's node (implementation.md 2).
      throw (error as { code?: unknown } | null)?.code === "EADDRINUSE"
        ? new Error(
            `an orca node is already running on this machine, in another DSH process (port ${settings.port} is in use)`,
          )
        : error;
    }
    this.logger.info(`orca-pod: orca node ${node.mesh.self.id} listening on ${info.url} (workgroup ${workgroupId})`);

    // The node carries the catalog from its first join on, so the self record
    // peers receive and every heartbeat advertise it (design.md 5.6).
    this.advertise(node);
    return node;
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
      await outcome.orca.stop();
      this.logger.info("orca-pod: orca node stopped");
    } catch (error) {
      this.logger.warn(`orca-pod: orca node stop failed: ${errorMessage(error)}`);
    }
  }

  /** The run of a status, or the error that says why there is none. */
  private static runOf(status: PodStatus): Orca {
    switch (status.kind) {
      case "running":
        return status.orca;
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

  /** Apply panel fields to the settings as the file holds them: a value sets the key, `null` removes it; other keys stay. */
  private static applyPanelFields(raw: Record<string, unknown>, fields: PanelPatch): Record<string, unknown> {
    const next = { ...raw };
    for (const [key, value] of Object.entries(fields)) {
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    return next;
  }
}
