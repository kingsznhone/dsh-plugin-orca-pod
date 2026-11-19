/**
 * The node's model catalog (§6.15).
 *
 * The catalog lives in the DSH host, not in the orca node: `llm` knows which
 * providers and models the running harness can actually serve, and
 * `agent-default-model` owns the model a fresh session starts with. The plugin
 * copies both into the node's self record so peers can see what this node can
 * offer before dispatching a task that asks for a specific model.
 *
 * Both services are optional: CLI-only nodes and smoke hosts start without
 * them, in which case the catalog stays empty and every task runs with the
 * executor's own default. The caller fences on them with `ctx.inject` and
 * passes whatever appeared.
 */

import type { Context, Logger } from "@deepseek-ai/cordis";
import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import type { AgentDefaultModelConfig } from "@deepseek-ai/dsh-agent-default-model";
import type { LlmModelInfo, LlmProviderInfo, LlmReasoningEffortInfo, LlmRuntime } from "@deepseek-ai/dsh-llm";

import { errorMessage } from "../core/errors.ts";
import { ChangeSignal } from "../core/events.ts";
import { MAX_MODEL_OFFERS, type ModelOffer } from "../executor/model.ts";
import { OptionalService } from "./services.ts";

type HostModelCatalog = {
  models: ModelOffer[];
  defaultModel: ModelSelection | null;
  /** The efforts the default model offers, least to most; the panel picks the node default from them. */
  reasoningEfforts: readonly LlmReasoningEffortInfo[];
};

/**
 * Reads the host's model catalog. The host owns the real catalog and the pod
 * installs it on its node; the feed only reads it and says when it changed.
 * The catalog is empty until the first `refresh` finishes.
 */
export class ModelCatalogFeed {
  /** Fires when a refresh produced a catalog; the pod installs it on its node. */
  readonly changes = new ChangeSignal();
  private catalog: HostModelCatalog = { models: [], defaultModel: null, reasoningEfforts: [] };
  /** The host's `llm` service, while it offers one; absent on CLI-only hosts. */
  private llm?: LlmRuntime;
  /** The host's `agent-default-model` service, while it offers one. */
  private defaultModel?: AgentDefaultModelConfig;
  /** Bumped per refresh; a slower, older refresh must not overwrite a newer catalog. */
  private generation = 0;

  /**
   * Follows the host's catalog services from construction on (a documented
   * exception to "constructors touch nothing outside").
   */
  constructor(
    ctx: Pick<Context, "inject">,
    private readonly logger: Logger,
  ) {
    // The two catalog services are optional and independent: follow each one
    // separately, so a host that offers only one still advertises what it has;
    // the catalog is rebuilt when either appears, is replaced or goes away.
    new OptionalService(ctx, "llm", "orca-pod.catalog-llm", (llm) => {
      this.llm = llm;
      void this.refresh();
    });
    new OptionalService(ctx, "agentDefaultModel", "orca-pod.catalog-default-model", (defaultModel) => {
      this.defaultModel = defaultModel;
      void this.refresh();
    });
  }

  /** The catalog as the last refresh read it: the routes, the default and the efforts the panel may pick from. */
  current(): HostModelCatalog {
    return this.catalog;
  }

  /** Read the catalog from the host again; a slower, older read never overwrites a newer one. */
  async refresh(): Promise<void> {
    const generation = ++this.generation;
    // Failures per provider stay local: one broken adapter must not hide the models that other providers report.
    const models = this.llm === undefined ? [] : await this.discoverOffers(this.llm);
    const defaultModel = this.defaultSelection();
    const next = { models, defaultModel, reasoningEfforts: await this.defaultEfforts(defaultModel) };
    if (generation !== this.generation) return;
    this.catalog = next;
    if (next.models.length > 0) this.logger.info(`orca-pod: advertising ${next.models.length} models`);
    this.changes.notify();
  }

  private listProviders(llm: LlmRuntime): LlmProviderInfo[] {
    try {
      return llm.listProviders();
    } catch (error) {
      this.logger.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`);
      return [];
    }
  }

  private async listModels(llm: LlmRuntime, provider: string): Promise<LlmModelInfo[]> {
    try {
      return await llm.listModels(provider);
    } catch (error) {
      this.logger.warn(`orca-pod: could not list models for ${provider}: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Every provider/model route the host's `llm` service offers, deduplicated and capped. */
  private async discoverOffers(llm: LlmRuntime): Promise<ModelOffer[]> {
    const models: ModelOffer[] = [];
    const seen = new Set<string>();
    for (const entry of this.listProviders(llm)) {
      if (models.length >= MAX_MODEL_OFFERS) break;
      const provider = entry.id;
      for (const { id, name, description } of await this.listModels(llm, provider)) {
        if (models.length >= MAX_MODEL_OFFERS) break;
        if (seen.has(`${provider}/${id}`)) continue;
        seen.add(`${provider}/${id}`);
        models.push({ provider, id, name, ...(description === undefined ? {} : { description }) });
      }
    }
    return models;
  }

  /** What a fresh session starts with, when the host says. */
  private defaultSelection(): ModelSelection | null {
    try {
      return this.defaultModel?.currentSelection() ?? null;
    } catch (error) {
      this.logger.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`);
      return null;
    }
  }

  /** The efforts the default model offers; empty when the host has no `llm` or the adapter exposes none. */
  private async defaultEfforts(selection: ModelSelection | null): Promise<readonly LlmReasoningEffortInfo[]> {
    if (this.llm === undefined || selection === null) return [];
    try {
      return (await this.llm.resolveModelInfo(selection.provider, selection.model)).reasoning?.efforts ?? [];
    } catch (error) {
      this.logger.warn(
        `orca-pod: could not read the efforts of ${selection.provider}/${selection.model}: ${errorMessage(error)}`,
      );
      return [];
    }
  }
}
