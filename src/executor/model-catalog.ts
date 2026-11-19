import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { ReasoningEffortId } from "@deepseek-ai/dsh-llm";
import { z } from "zod";

import { ChangeSignal, type NodeLogger } from "../core/events.ts";
import { ReasoningEffortSchema, type ModelDefaults, type ModelOffer } from "./model.ts";

/**
 * What the node settings may set about models (§6.15): only the default
 * reasoning effort. The routes and the default model are the DSH host's; the
 * node advertises what the host can serve. Part of the node's settings
 * (`node/settings.ts` spreads it in), declared here, where it is read.
 */
export const ModelSettingsSchema = z.object({
  /** Default reasoning effort when a task names none; unset means the host's (§6.15). */
  default_reasoning_effort: ReasoningEffortSchema.optional(),
});
export type ModelSettings = z.output<typeof ModelSettingsSchema>;

/**
 * The model routes this node offers and the default a task gets when it names
 * none (§6.15). Both come from the DSH host after start-up (`update`); empty
 * until then. Only the reasoning effort may be set in the settings. The node
 * advertises the catalog to peers, and an ACP session reads its default from
 * here, so both depend on this object and not on each other.
 */
export class ModelCatalog {
  /** Fires after `update`; the node re-announces itself. */
  readonly changes: ChangeSignal;

  private offered: ModelOffer[] = [];
  private readonly pinnedEffort: ReasoningEffortId | null;
  private defaultModel: ModelSelection | null = null;
  private defaultEffort: ReasoningEffortId | null;

  constructor(settings: ModelSettings = {}, logger?: NodeLogger) {
    this.changes = new ChangeSignal(logger);
    this.pinnedEffort = settings.default_reasoning_effort ?? null;
    this.defaultEffort = this.pinnedEffort;
  }

  /**
   * Replace the routes and the default the host reports. The effort set in the
   * settings wins over `reasoningEffort`; a route offered twice is kept once.
   */
  update(models: ModelOffer[], defaultModel: ModelSelection | null, reasoningEffort?: ReasoningEffortId | null): void {
    const routeOf = (offer: ModelOffer): string => `${offer.provider}/${offer.id}`;
    this.offered = models.filter(
      (offer, index) => models.findIndex((other) => routeOf(other) === routeOf(offer)) === index,
    );
    this.defaultEffort = this.pinnedEffort ?? reasoningEffort ?? defaultModel?.reasoningEffort ?? null;
    this.defaultModel =
      defaultModel !== null && this.defaultEffort !== null
        ? { ...defaultModel, reasoningEffort: this.defaultEffort }
        : defaultModel;
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
