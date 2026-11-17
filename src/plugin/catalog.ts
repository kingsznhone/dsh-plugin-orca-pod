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

import { isRecord } from "../kernel/schema.ts";
import { errorMessage } from "../kernel/errors.ts";
import type { ModelOffer, ModelSelection } from "../protocol/model.ts";
import { MAX_MODEL_OFFERS, parseModelSelection } from "../protocol/model.ts";
import type { OrcaNode } from "../node/orca-node.ts";
import type { AgentDefaultModelService, HostContext, HostLogger, LlmCatalogService } from "./dsh.ts";
import type { PodHandle } from "./lifecycle.ts";
import { optionalService } from "./services.ts";

/** The host services the catalog reads; either may be absent. */
export interface CatalogServices {
  llm?: LlmCatalogService;
  agentDefaultModel?: AgentDefaultModelService;
}

export type ModelCatalog = {
  models: ModelOffer[];
  defaultModel: ModelSelection | null;
};

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

/** The host reports its default route in either casing; blank parts count as absent. */
function selectionOf(raw: unknown): ModelSelection | null {
  if (!isRecord(raw)) return null;
  return parseModelSelection({
    provider: nonEmpty(raw.provider),
    model: nonEmpty(raw.model),
    reasoning_effort: nonEmpty(raw.reasoning_effort ?? raw.reasoningEffort),
  });
}

type LlmProvider = Awaited<ReturnType<LlmCatalogService["listProviders"]>>[number];
type LlmModel = Awaited<ReturnType<LlmCatalogService["listModels"]>>[number];

async function listProviders(llm: LlmCatalogService, logger: HostLogger): Promise<LlmProvider[]> {
  try {
    return await Promise.resolve(llm.listProviders());
  } catch (error) {
    logger.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`);
    return [];
  }
}

async function listModels(llm: LlmCatalogService, provider: string, logger: HostLogger): Promise<LlmModel[]> {
  try {
    return await llm.listModels(provider);
  } catch (error) {
    logger.warn(`orca-pod: could not list models for ${provider}: ${errorMessage(error)}`);
    return [];
  }
}

/** Every provider/model route the host's `llm` service offers, deduplicated and capped. */
async function discoverOffers(llm: LlmCatalogService, logger: HostLogger): Promise<ModelOffer[]> {
  const models: ModelOffer[] = [];
  const seen = new Set<string>();
  for (const entry of await listProviders(llm, logger)) {
    if (models.length >= MAX_MODEL_OFFERS) break;
    const provider = nonEmpty(entry.id);
    if (provider === undefined) continue;
    for (const entryModel of await listModels(llm, provider, logger)) {
      if (models.length >= MAX_MODEL_OFFERS) break;
      const model = nonEmpty(entryModel.id);
      if (model === undefined || seen.has(`${provider}/${model}`)) continue;
      seen.add(`${provider}/${model}`);
      models.push({
        provider,
        model,
        name: nonEmpty(entryModel.name),
        description: nonEmpty(entryModel.description),
      });
    }
  }
  return models;
}

/** What a fresh session starts with, when the host says. */
function defaultSelection(service: AgentDefaultModelService | undefined, logger: HostLogger): ModelSelection | null {
  try {
    const raw = service?.currentSelection();
    return raw === undefined ? null : selectionOf(raw);
  } catch (error) {
    logger.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * Read the catalog from the host. Failures per provider stay local: one broken
 * adapter must not hide the models that other providers report.
 */
export async function discoverModelCatalog(services: CatalogServices, logger: HostLogger): Promise<ModelCatalog> {
  const models = services.llm === undefined ? [] : await discoverOffers(services.llm, logger);
  return { models, defaultModel: defaultSelection(services.agentDefaultModel, logger) };
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
}

/**
 * The host owns the real model catalog, the node only advertises it: the
 * catalog is read once the node is up and installed on the running node (and
 * on every later panel restart, before its first join).
 */
export function createModelCatalogFeed(ctx: Pick<HostContext, "inject" | "logger">): ModelCatalogFeed {
  const catalog: ModelCatalog = { models: [], defaultModel: null };
  /** Whatever `llm`/`agent-default-model` the host exposes; empty on CLI-only hosts. */
  let services: CatalogServices = {};
  let pod: PodHandle | null = null;
  const advertise = (orcaNode: OrcaNode): void =>
    orcaNode.setModelCatalog(catalog.models, catalog.defaultModel, catalog.defaultModel?.reasoning_effort ?? null);
  /** Bumped per refresh; a slower, older refresh must not overwrite a newer catalog. */
  let generation = 0;
  const refresh = async (): Promise<void> => {
    const current = ++generation;
    const next = await discoverModelCatalog(services, ctx.logger);
    if (current !== generation) return;
    Object.assign(catalog, next);
    const orcaNode = pod?.runtime.orcaNode ?? null;
    if (orcaNode !== null) advertise(orcaNode);
    if (catalog.models.length > 0) ctx.logger.info(`orca-pod: advertising ${catalog.models.length} models`);
  };
  return {
    advertise,
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
