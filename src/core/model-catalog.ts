import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";

import { ChangeSignal } from "./events.ts";
import type { ModelDefaults, ModelOffer } from "./wire/model.ts";

/** What `config.json` may pin about models (§6.15). */
export type ModelPins = {
  models?: ModelOffer[];
  default_model?: ModelSelection;
  default_reasoning_effort?: ReasoningEffortId;
};

/**
 * The model routes this node offers and the default a task gets when it names
 * none (§6.15). The DSH host reports the list after start-up (`update`); a pin
 * in `config.json` keeps the per-node default reproducible across UI changes.
 * The node advertises the catalog to peers, and an ACP session reads its default
 * from here, so both depend on this object and not on each other.
 */
export class ModelCatalog {
  /** Fires after `update`; the node re-announces itself. */
  readonly changes = new ChangeSignal();

  private offered: ModelOffer[];
  private readonly pinnedModel: ModelSelection | null;
  private readonly pinnedEffort: ReasoningEffortId | null;
  private defaultModel: ModelSelection | null;
  private defaultEffort: ReasoningEffortId | null;

  constructor(pins: ModelPins = {}) {
    this.offered = [...(pins.models ?? [])];
    this.pinnedModel = pins.default_model ?? null;
    this.pinnedEffort = pins.default_reasoning_effort ?? pins.default_model?.reasoningEffort ?? null;
    this.defaultModel = this.pinnedModel;
    this.defaultEffort = this.pinnedEffort;
  }

  /**
   * Replace the routes and the default the host reports. A pin in `config.json`
   * wins over `defaultModel` and `reasoningEffort`; a route offered twice is kept once.
   */
  update(models: ModelOffer[], defaultModel: ModelSelection | null, reasoningEffort?: ReasoningEffortId | null): void {
    const routeOf = (offer: ModelOffer): string => `${offer.provider}/${offer.id}`;
    this.offered = models.filter(
      (offer, index) => models.findIndex((other) => routeOf(other) === routeOf(offer)) === index,
    );
    this.defaultEffort = this.pinnedEffort ?? reasoningEffort ?? defaultModel?.reasoningEffort ?? null;
    const fallback = this.pinnedModel ?? defaultModel;
    this.defaultModel =
      fallback !== null && this.defaultEffort !== null
        ? { ...fallback, reasoningEffort: this.defaultEffort }
        : fallback;
    this.changes.notify();
  }

  /** The routes a session can be switched to; empty until the host reported some. */
  offers(): ModelOffer[] {
    return [...this.offered];
  }

  /** What a local ACP session uses when a task names no model. */
  defaults(): ModelDefaults {
    return { model: this.defaultModel, reasoningEffort: this.defaultEffort };
  }
}
