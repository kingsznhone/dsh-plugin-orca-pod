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
import { MAX_MODEL_OFFERS, type ModelOffer } from "../core/wire/model.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import { OptionalService } from "./services.ts";

export type HostModelCatalog = {
  models: ModelOffer[];
  defaultModel: ModelSelection | null;
  /** The efforts the default model offers, least to most; the panel picks the node default from them. */
  reasoningEfforts: readonly LlmReasoningEffortInfo[];
};

/** What the feed needs to know about the pod: the node it runs, and when its startup is over. */
export type CatalogHost = { readonly node: OrcaNode | null; readonly ready: Promise<void> };

/**
 * Feeds the host's model catalog to whichever node the pod runs. The host owns
 * the real catalog, the node only advertises it: the catalog is read once the
 * node is up and installed on the running node (and on every later panel
 * restart, before its first join).
 */
export class ModelCatalogFeed {
  private readonly catalog: HostModelCatalog = { models: [], defaultModel: null, reasoningEfforts: [] };
  /** The host's `llm` service, while it offers one; absent on CLI-only hosts. */
  private llm?: LlmRuntime;
  /** The host's `agent-default-model` service, while it offers one. */
  private defaultModel?: AgentDefaultModelConfig;
  private host: CatalogHost | null = null;
  /** Bumped per refresh; a slower, older refresh must not overwrite a newer catalog. */
  private generation = 0;

  constructor(
    private readonly ctx: Pick<Context, "inject">,
    private readonly logger: Logger,
  ) {}

  /**
   * Install the current catalog on a node. The lifecycle calls it for every
   * start, before the first `join`, so the self record peers receive already
   * advertises it.
   */
  advertise(orcaNode: OrcaNode): void {
    const { models, defaultModel } = this.catalog;
    orcaNode.models.update(models, defaultModel);
  }

  /** The efforts the host's default model offers, for the panel's node-default choice. */
  reasoningEfforts(): readonly LlmReasoningEffortInfo[] {
    return this.catalog.reasoningEfforts;
  }

  /** Follow the host's catalog services for this pod and re-advertise on change. */
  watch(host: CatalogHost): void {
    this.host = host;
    // The two catalog services are optional and independent: follow each one
    // separately, so a host that offers only one still advertises what it has;
    // the catalog is rebuilt when either appears, is replaced or goes away.
    new OptionalService(this.ctx, "llm", "orca-pod.catalog-llm", (llm) => {
      this.llm = llm;
      void this.refresh();
    });
    new OptionalService(this.ctx, "agentDefaultModel", "orca-pod.catalog-default-model", (defaultModel) => {
      this.defaultModel = defaultModel;
      void this.refresh();
    });
    void host.ready.then(() => this.refresh());
  }

  private async refresh(): Promise<void> {
    const current = ++this.generation;
    const next = await this.discover();
    if (current !== this.generation) return;
    Object.assign(this.catalog, next);
    const orcaNode = this.host?.node ?? null;
    if (orcaNode !== null) this.advertise(orcaNode);
    if (this.catalog.models.length > 0) this.logger.info(`orca-pod: advertising ${this.catalog.models.length} models`);
  }

  /**
   * Read the catalog from the host. Failures per provider stay local: one broken
   * adapter must not hide the models that other providers report.
   */
  private async discover(): Promise<HostModelCatalog> {
    const models = this.llm === undefined ? [] : await this.discoverOffers(this.llm);
    const defaultModel = this.defaultSelection();
    return { models, defaultModel, reasoningEfforts: await this.defaultEfforts(defaultModel) };
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
