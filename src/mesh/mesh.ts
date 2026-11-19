import { EventBus } from "../core/events.ts";
import { PodError } from "../core/errors.ts";
import { normalizePeerUrl } from "../core/net.ts";
import {
  membersDigest,
  OrcaNodeIdSchema,
  type HelloResponse,
  type OrcaNodeId,
  type PeerView,
  type WorkgroupId,
} from "../core/wire/peer.ts";
import { AckSchema } from "../core/wire/reply.ts";
import type { MeshContext } from "./context.ts";
import { OrcaNode } from "./orca-node.ts";
import type { EndpointScreen } from "./screening.ts";
import { heartbeatIntervalMsFor, resolveTimings, windowsFor, type MeshTimings } from "./timings.ts";
import type { HelloRequest, MembersEvent, SelfDescription } from "./wire.ts";

/** A seed address that has not answered yet, and when it is tried again. */
type Seed = { fails: number; nextAtMs: number; trying: boolean };

/**
 * The node table (§3.1): every node of the workgroup is an `OrcaNode` in one map,
 * and this node is one of them. Using a node is `mesh.resolve(ref)` and then
 * calling it; what takes the whole table is done here: the directory this node
 * vouches for and its digest, the tombstones that keep a stale list from reviving
 * a forgotten node, merging a list someone else sent, the greeting loop, and
 * making first contact at an address (`probe`).
 */
export class Mesh {
  /** Fires when something a panel would render about the roster changed (§9.2). */
  readonly events: EventBus<MembersEvent>;
  /** This node, as a row of the table like any other. */
  readonly self: OrcaNode;

  private readonly nodes = new Map<OrcaNodeId, OrcaNode>();
  private readonly tombstones = new Map<OrcaNodeId, number>();
  private readonly seeds = new Map<string, Seed>();
  private readonly current: MeshTimings;
  /** Whether the heartbeat cadence follows the size of the mesh; a pinned period keeps itself. */
  private readonly adaptive: boolean;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private membersSignature = "";

  constructor(
    private readonly ctx: MeshContext,
    /** What this node says about itself to begin with; whoever runs it pushes the changes with `self.describe`. */
    description: SelfDescription,
    options: { timings?: Partial<MeshTimings> } = {},
  ) {
    this.current = resolveTimings(options.timings);
    this.adaptive = options.timings?.intervalMs === undefined;
    this.events = new EventBus(ctx.logger);
    this.self = OrcaNode.self(ctx, description);
    this.nodes.set(this.self.id, this.self);
  }

  get workgroupId(): WorkgroupId {
    return this.ctx.workgroupId;
  }

  /** What this node concluded about endpoints it was told of; the `hello` route screens a sender's declaration with it. */
  get screening(): EndpointScreen {
    return this.ctx.screening;
  }

  /** Retarget the expected cadence, and with it the suspect, offline and timeout windows. */
  private setIntervalMs(intervalMs: number): void {
    Object.assign(this.current, windowsFor(intervalMs));
  }

  // ---- the table ----

  get(id: OrcaNodeId): OrcaNode | undefined {
    return this.nodes.get(id);
  }

  /** The node, or `unknown_orca_node` for one that is not in the table. */
  require(id: OrcaNodeId): OrcaNode {
    const node = this.nodes.get(id);
    if (node === undefined) throw new PodError("unknown_orca_node", `${id} is not a member of this workgroup`);
    return node;
  }

  /** Every node of the table, this one included, by id. */
  list(): OrcaNode[] {
    return [...this.nodes.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  /** The other nodes: everyone but this one. */
  peers(): OrcaNode[] {
    return this.list().filter((node) => !node.isSelf);
  }

  /**
   * The node a person or a tool names (§3.4): its id, its display name when that
   * is unique, or an address it has: one it advertises, or one that reached it.
   * Anything else is an `unknown_peer`: only `probe` may meet a stranger.
   */
  resolve(ref: string): OrcaNode {
    const text = ref.trim();
    const id = OrcaNodeIdSchema.safeParse(text);
    const byId = id.success ? this.nodes.get(id.data) : undefined;
    if (byId !== undefined) return byId;
    const named = this.list().filter((node) => node.displayName === text);
    if (named.length === 1 && named[0] !== undefined) return named[0];
    if (named.length > 1) {
      throw new PodError(
        "bad_request",
        `${text} names several nodes; use an id: ${named.map((node) => node.id).join(", ")}`,
      );
    }
    let url: string | undefined;
    try {
      url = normalizePeerUrl(text);
    } catch {
      // Not an address either.
    }
    const byUrl = url === undefined ? undefined : this.list().find((node) => node.hasUrl(url));
    if (byUrl !== undefined) return byUrl;
    throw new PodError("unknown_peer", `${text} is not a known node, name or address; connect to it first`);
  }

  /**
   * The directory this node vouches for to others (§3.5): itself and the nodes it
   * hears from. Candidates it never reached and nodes gone quiet stay in `list()`
   * but are never passed on.
   */
  private directory(): PeerView[] {
    return this.list()
      .filter((node) => node.listed)
      .map((node) => node.view());
  }

  /** What this node passes on (§3.5); its digest is what peers compare. */
  digest(): string {
    return membersDigest(this.directory());
  }

  /** Whether a node was forgotten recently enough that a stale list must not bring it back. */
  private isTombstoned(id: OrcaNodeId): boolean {
    const until = this.tombstones.get(id);
    if (until === undefined) return false;
    if (this.ctx.clock.monotonicMs() < until) return true;
    this.tombstones.delete(id);
    return false;
  }

  /** Forget a node; its id is tombstoned so a stale remote list cannot bring it back. */
  remove(id: OrcaNodeId): void {
    if (id === this.self.id || !this.nodes.delete(id)) return;
    this.tombstones.set(id, this.ctx.clock.monotonicMs() + this.current.tombstoneMs);
  }

  /** Remote lists only add records; they never touch online state. */
  private mergeRemote(members: readonly PeerView[]): void {
    for (const member of members) {
      if (member.orca_node_id === this.self.id) continue;
      if (this.isTombstoned(member.orca_node_id)) continue;
      // A third-party roster is only a hint for nodes we have never met (§7.1).
      // Once a record exists, only that node's own signed self-description may
      // update its endpoints or profile; otherwise any member could redirect
      // everyone's traffic to itself.
      if (this.nodes.has(member.orca_node_id)) continue;
      this.nodes.set(member.orca_node_id, OrcaNode.candidate(this.ctx, member));
    }
  }

  /** Apply timeout transitions and prune stale records. */
  private evaluate(): void {
    const nowMs = this.ctx.clock.monotonicMs();
    for (const node of [...this.nodes.values()]) {
      node.reassess(nowMs, this.current);
      if (node.expired(nowMs, this.current)) this.remove(node.id);
    }
  }

  /** Emit a `members` event if something a panel would render changed (§9.2). */
  emitMembersIfChanged(): void {
    const current = this.list().map((node) => node.view());
    const signature = Mesh.signatureOf(current);
    if (signature === this.membersSignature) return;
    this.membersSignature = signature;
    this.events.emit({ type: "members", members: current, digest: membersDigest(current) });
  }

  // ---- contact ----

  /**
   * First contact, or contact again, at an address (§3.3): the one call that may
   * reach a stranger, so only an address someone chose may come here (settings,
   * the panel, the `connect` tool). A node that is already known at the address is
   * greeted as itself, so its answer must be its own; a stranger's answer names it.
   */
  async probe(url: string): Promise<OrcaNode> {
    const known = this.list().find((node) => node.hasUrl(url));
    const answer = await OrcaNode.contact(this.ctx, url, known?.id ?? "", this.helloRequest());
    const { clock } = this.ctx;
    const description = OrcaNode.describing(answer.body.self);
    let node = this.nodes.get(answer.from);
    if (answer.from === this.self.id) {
      // This node's own address under another name: nothing to learn but the name.
      this.self.learnUrl(url);
      return this.self;
    }
    if (node === undefined) {
      this.tombstones.delete(answer.from);
      node = OrcaNode.explicit(
        this.ctx,
        answer.from,
        description,
        answer.body.self.busy,
        clock.monotonicMs(),
        clock.wallIso(),
      );
      this.nodes.set(node.id, node);
    } else {
      node.describe(description);
      node.setBusy(answer.body.self.busy);
    }
    node.learnUrl(url);
    this.hears(node);
    if (answer.body.members !== null) this.mergeRemote(answer.body.members);
    this.emitMembersIfChanged();
    return node;
  }

  /**
   * Seed the mesh with the addresses this node is configured or remembers (§3.3):
   * each is contacted now, and one that does not answer is tried again on the
   * recover backoff until it does, instead of being given up at start.
   */
  async seed(urls: Iterable<string>): Promise<{ reached: OrcaNode[]; pending: string[] }> {
    const fresh: string[] = [];
    for (const url of urls) {
      if (this.self.hasUrl(url) || this.seeds.has(url)) continue;
      this.seeds.set(url, { fails: 0, nextAtMs: 0, trying: false });
      fresh.push(url);
    }
    const reached: OrcaNode[] = [];
    const pending: string[] = [];
    for (const url of fresh) {
      const node = await this.contactSeed(url);
      if (node === null) pending.push(url);
      else reached.push(node);
    }
    return { reached, pending };
  }

  /** Leave the workgroup (§9.2): tell each peer, best effort, then clear the table; resolves to the nodes that answered and so know this node is gone. */
  async leave(): Promise<OrcaNodeId[]> {
    const left: OrcaNodeId[] = [];
    for (const node of this.peers()) {
      if (await this.notifyLeave(node)) left.push(node.id);
      this.remove(node.id);
    }
    this.seeds.clear();
    this.emitMembersIfChanged();
    return left;
  }

  /**
   * A node greeted this one (§3.3): record it (or refresh it) as an explicit
   * member that was heard just now, and answer with this node's own record and,
   * when its digest differs, the directory. The route has already checked the
   * request's proofs and screened the endpoints the sender declared.
   */
  answer(caller: OrcaNodeId, request: HelloRequest, endpoints: string[]): HelloResponse {
    if (caller !== this.self.id) {
      const { clock } = this.ctx;
      const description = { ...request.self, endpoints };
      let node = this.nodes.get(caller);
      if (node === undefined) {
        // Tombstones only keep stale *remote lists* from reviving a removed id; they
        // must not lock out a node that comes back on its own with a valid proof.
        this.tombstones.delete(caller);
        node = OrcaNode.explicit(this.ctx, caller, description, request.busy, clock.monotonicMs(), clock.wallIso());
        this.nodes.set(caller, node);
      } else {
        node.describe(description);
        node.setBusy(request.busy);
        node.heard(clock.monotonicMs(), clock.wallIso());
      }
      this.emitMembersIfChanged();
    }
    const digest = this.digest();
    return {
      self: this.self.selfRecord(),
      members_digest: digest,
      members: request.digest === digest ? null : this.directory(),
    };
  }

  // ---- the greeting loop ----

  /** Start greeting the nodes that are due, once per interval (§3.3). */
  start(): void {
    this.stopped = false;
    void this.tick();
    this.emitMembersIfChanged();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    if (this.stopped) return;
    // ±10% jitter: senders must not stay phase-locked, and the receiver's
    // suspect window (1.25 ticks) leaves room for this spread.
    this.timer = setTimeout(() => void this.tick(), this.current.intervalMs * (0.9 + Math.random() * 0.2));
    this.timer.unref();
  }

  /**
   * One round: re-evaluate every node, greet the ones that are due and try the
   * seeds that have not answered. §3.3: the cadence follows the size of the mesh
   * (one hello per node per second) so cluster traffic stays linear.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (this.adaptive) this.setIntervalMs(heartbeatIntervalMsFor(this.nodes.size));
    this.evaluate();
    const nowMs = this.ctx.clock.monotonicMs();
    const greetings = [...this.nodes.values()].filter((node) => node.due(nowMs)).map((node) => this.greet(node));
    const retries = [...this.seeds.entries()]
      .filter(([, seed]) => !seed.trying && seed.nextAtMs <= nowMs)
      .map(([url]) => this.contactSeed(url));
    await Promise.allSettled([...greetings, ...retries]);
    this.emitMembersIfChanged();
    this.schedule();
  }

  /** One hello to a node already in the table; a failure is counted once per node, not once per address. */
  private async greet(node: OrcaNode): Promise<void> {
    const { clock } = this.ctx;
    try {
      const answer = await node.hello(this.helloRequest(), this.current.heartbeatTimeoutMs);
      node.describe({ ...OrcaNode.describing(answer.body.self), endpoints: [...node.endpoints] });
      node.setBusy(answer.body.self.busy);
      this.hears(node);
      if (answer.body.members !== null) this.mergeRemote(answer.body.members);
    } catch (error) {
      if (OrcaNode.isRejection(error)) {
        // This node still uses another password: stop answering it and forget it
        // (§7.1). Its own hellos to us fail identically, so the whole old mesh
        // drops the changed node instead of keeping it "online" forever.
        this.ctx.logger.warn(`orca-pod: dropping node ${node.id} (workgroup admission rejected, §7.1)`);
        this.remove(node.id);
        return;
      }
      if (node.missed(clock.monotonicMs(), this.current) === "drop") {
        // The tombstone keeps a stale list from adding it straight back (§3.5).
        this.remove(node.id);
      }
    }
    this.emitMembersIfChanged();
  }

  /** A node answered us: it is online, and what we asked of it is no longer owed. */
  private hears(node: OrcaNode): void {
    const { clock } = this.ctx;
    node.heard(clock.monotonicMs(), clock.wallIso());
    node.answered();
  }

  /** Contact a seed address; one that does not answer waits for its turn on the backoff. Null when it did not answer. */
  private async contactSeed(url: string): Promise<OrcaNode | null> {
    const seed = this.seeds.get(url);
    if (seed === undefined) return null;
    seed.trying = true;
    try {
      const node = await this.probe(url);
      this.seeds.delete(url);
      return node;
    } catch (error) {
      seed.fails += 1;
      const backoff = this.current.recoverProbeMs * 2 ** (seed.fails - 1);
      seed.nextAtMs = this.ctx.clock.monotonicMs() + Math.min(backoff, this.current.maxRecoverProbeMs);
      this.ctx.logger.warn(
        `orca-pod: contact with ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      seed.trying = false;
    }
  }

  /** Tell one node we are leaving; true when it acknowledged. A node that is already gone must not keep us from leaving. */
  private async notifyLeave(node: OrcaNode): Promise<boolean> {
    const [endpoint] = node.endpoints;
    if (endpoint === undefined) return false;
    try {
      await this.ctx.client.call(
        endpoint,
        { method: "POST", path: "/cluster/leave", reply: AckSchema },
        { target: node.id },
      );
      return true;
    } catch {
      return false;
    }
  }

  /** What this node says in every hello: who it is, how busy, and the digest of what it knows. */
  private helloRequest(): HelloRequest {
    const view = this.self.view();
    return { self: OrcaNode.describing(view), busy: view.busy, digest: this.digest() };
  }

  /** The roster fields a panel renders; two rosters with the same signature need no event. */
  private static signatureOf(peers: PeerView[]): string {
    return peers
      .map((peer) => {
        const model = peer.default_model ? `${peer.default_model.provider}/${peer.default_model.model}` : "";
        return (
          `${peer.orca_node_id}:${peer.state}:${peer.busy?.task_id ?? ""}:${peer.endpoints.join(",")}` +
          `:${peer.models?.length ?? 0}:${model}:${peer.default_reasoning_effort ?? ""}`
        );
      })
      .sort()
      .join("|");
  }
}
