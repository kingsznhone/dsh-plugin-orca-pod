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
import type { PodHandle } from "./lifecycle.ts";
import { optionalService } from "./services.ts";

/** The host services the catalog reads; either may be absent. */
export interface CatalogServices {
  llm?: LlmRuntime;
  agentDefaultModel?: AgentDefaultModelConfig;
}

export type ModelCatalog = {
  models: ModelOffer[];
  defaultModel: ModelSelection | null;
  /** The efforts the default model offers, least to most; the panel picks the node default from them. */
  reasoningEfforts: readonly LlmReasoningEffortInfo[];
};

async function listProviders(llm: LlmRuntime, logger: Logger): Promise<LlmProviderInfo[]> {
  try {
    return llm.listProviders();
  } catch (error) {
    logger.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`);
    return [];
  }
}

async function listModels(llm: LlmRuntime, provider: string, logger: Logger): Promise<LlmModelInfo[]> {
  try {
    return await llm.listModels(provider);
  } catch (error) {
    logger.warn(`orca-pod: could not list models for ${provider}: ${errorMessage(error)}`);
    return [];
  }
}

/** Every provider/model route the host's `llm` service offers, deduplicated and capped. */
async function discoverOffers(llm: LlmRuntime, logger: Logger): Promise<ModelOffer[]> {
  const models: ModelOffer[] = [];
  const seen = new Set<string>();
  for (const entry of await listProviders(llm, logger)) {
    if (models.length >= MAX_MODEL_OFFERS) break;
    const provider = entry.id;
    for (const { id, name, description } of await listModels(llm, provider, logger)) {
      if (models.length >= MAX_MODEL_OFFERS) break;
      if (seen.has(`${provider}/${id}`)) continue;
      seen.add(`${provider}/${id}`);
      models.push({ provider, id, name, ...(description === undefined ? {} : { description }) });
    }
  }
  return models;
}

/** What a fresh session starts with, when the host says. */
function defaultSelection(service: AgentDefaultModelConfig | undefined, logger: Logger): ModelSelection | null {
  try {
    return service?.currentSelection() ?? null;
  } catch (error) {
    logger.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`);
    return null;
  }
}

/** The efforts the default model offers; empty when the host has no `llm` or the adapter exposes none. */
async function defaultEfforts(
  llm: LlmRuntime | undefined,
  selection: ModelSelection | null,
  logger: Logger,
): Promise<readonly LlmReasoningEffortInfo[]> {
  if (llm === undefined || selection === null) return [];
  try {
    return (await llm.resolveModelInfo(selection.provider, selection.model)).reasoning?.efforts ?? [];
  } catch (error) {
    logger.warn(
      `orca-pod: could not read the efforts of ${selection.provider}/${selection.model}: ${errorMessage(error)}`,
    );
    return [];
  }
}

/**
 * Read the catalog from the host. Failures per provider stay local: one broken
 * adapter must not hide the models that other providers report.
 */
export async function discoverModelCatalog(services: CatalogServices, logger: Logger): Promise<ModelCatalog> {
  const models = services.llm === undefined ? [] : await discoverOffers(services.llm, logger);
  const defaultModel = defaultSelection(services.agentDefaultModel, logger);
  return { models, defaultModel, reasoningEfforts: await defaultEfforts(services.llm, defaultModel, logger) };
}

/** Feeds the host's model catalog to whichever node the pod runs. */
export interface ModelCatalogFeed {
  /**
   * Install the current catalog on a node. Pass it as the `onNodeStarted` hook
   * so every start advertises it before the first `join`.
   */
  advertise(orcaNode: OrcaNode): void;
  /** Follow the host's catalog services for this pod and re-advertise on change. */
  watch(handle: PodHandle): void;
  /** The efforts the host's default model offers, for the panel's node-default choice. */
  reasoningEfforts(): readonly LlmReasoningEffortInfo[];
}

/**
 * The host owns the real model catalog, the node only advertises it: the
 * catalog is read once the node is up and installed on the running node (and
 * on every later panel restart, before its first join).
 */
export function createModelCatalogFeed(ctx: Pick<Context, "inject">, logger: Logger): ModelCatalogFeed {
  const catalog: ModelCatalog = { models: [], defaultModel: null, reasoningEfforts: [] };
  /** Whatever `llm`/`agent-default-model` the host exposes; empty on CLI-only hosts. */
  let services: CatalogServices = {};
  let pod: PodHandle | null = null;
  const advertise = (orcaNode: OrcaNode): void =>
    orcaNode.setModelCatalog(catalog.models, catalog.defaultModel, catalog.defaultModel?.reasoningEffort ?? null);
  /** Bumped per refresh; a slower, older refresh must not overwrite a newer catalog. */
  let generation = 0;
  const refresh = async (): Promise<void> => {
    const current = ++generation;
    const next = await discoverModelCatalog(services, logger);
    if (current !== generation) return;
    Object.assign(catalog, next);
    const orcaNode = pod?.runtime.orcaNode ?? null;
    if (orcaNode !== null) advertise(orcaNode);
    if (catalog.models.length > 0) logger.info(`orca-pod: advertising ${catalog.models.length} models`);
  };
  return {
    advertise,
    reasoningEfforts: () => catalog.reasoningEfforts,
    watch(handle) {
      pod = handle;
      // The two catalog services are optional and independent: follow each one
      // separately, so a host that offers only one still advertises what it has;
      // the catalog is rebuilt when either appears, is replaced or goes away.
      optionalService(ctx, "llm", "orca-pod.catalog-llm", (llm) => {
        services = { ...services, llm };
        void refresh();
      });
      optionalService(ctx, "agentDefaultModel", "orca-pod.catalog-default-model", (agentDefaultModel) => {
        services = { ...services, agentDefaultModel };
        void refresh();
      });
      void handle.ready.then(refresh);
    },
  };
}
