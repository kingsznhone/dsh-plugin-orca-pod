import type { ModelCatalog } from "../core/model-catalog.ts";
import {
  runtimeDigest,
  type BusyState,
  type OrcaNodeId,
  type PeerView,
  type RuntimeInfo,
  type SelfRecord,
  type WorkgroupId,
} from "../core/wire/peer.ts";
import type { SelfDescription } from "./wire.ts";

/** The part of the node config a profile reads. */
export type SelfProfileConfig = {
  orca_node_id: OrcaNodeId;
  workgroup_id: WorkgroupId;
  display_name: string;
};

/**
 * What this node says about itself (§2.5, §3.3): who it is, where it can be
 * dialed, what it runs on, which models it offers and whether it is busy. The
 * node writes the parts that change (`setEndpoints` once the listener is bound,
 * `setBusy` as tasks start and end); the mesh only reads it. The profile does
 * not know about tasks: whoever runs them tells it.
 */
export class SelfProfile {
  private urls: readonly string[] = [];
  private holder: BusyState | null = null;

  constructor(
    private readonly config: SelfProfileConfig,
    private readonly runtime: RuntimeInfo,
    private readonly models: ModelCatalog,
    /** Advertised per-task budget, the cap the task runner enforces (§6.9). */
    private readonly maxTaskTtlS: number,
  ) {}

  get orcaNodeId(): OrcaNodeId {
    return this.config.orca_node_id;
  }

  get workgroupId(): WorkgroupId {
    return this.config.workgroup_id;
  }

  /** Advertised dial URLs, best first; they change once the listener is bound. */
  get endpoints(): readonly string[] {
    return this.urls;
  }

  setEndpoints(endpoints: readonly string[]): void {
    this.urls = [...endpoints];
  }

  /** The task holding the single slot, or null (§6.9). */
  get busy(): BusyState | null {
    return this.holder;
  }

  setBusy(busy: BusyState | null): void {
    this.holder = busy;
  }

  /** This node as a member record, the way peers list it. */
  peer(): PeerView {
    const offers = this.models.offers();
    const defaults = this.models.defaults();
    const id = this.config.orca_node_id;
    return {
      orca_node_id: id,
      // A fresh node with no display name shows its generated id (§9.2 wizard default).
      display_name: this.config.display_name.length > 0 ? this.config.display_name : id,
      endpoints: [...this.urls],
      runtime: this.runtime,
      runtime_digest: runtimeDigest(this.runtime),
      state: "online",
      busy: this.holder,
      last_recv_at: new Date().toISOString(),
      max_task_ttl_s: this.maxTaskTtlS,
      models: offers.length > 0 ? offers : undefined,
      default_model: defaults.model,
      default_reasoning_effort: defaults.reasoningEffort,
    };
  }

  record(): SelfRecord {
    return { ...this.peer(), workgroup_id: this.config.workgroup_id };
  }

  /**
   * What this node says about itself in a join and in every heartbeat (§3.3).
   * The request signature covers it, so a peer can take it as this node's word.
   */
  description(): SelfDescription {
    const self = this.peer();
    return {
      display_name: self.display_name,
      endpoints: self.endpoints,
      runtime: self.runtime,
      max_task_ttl_s: self.max_task_ttl_s,
      models: self.models,
      default_model: self.default_model,
      default_reasoning_effort: self.default_reasoning_effort,
    };
  }
}
