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

import { isRecord, errorMessage } from "../kernel/index.ts";
import type { ModelOffer, ModelSelection } from "../protocol/index.ts";
import { MAX_MODEL_OFFERS } from "../protocol/index.ts";
import type { OrcaNode } from "../node/index.ts";
import type { AgentDefaultModelService, HostContext, HostLogger, LlmCatalogService } from "./dsh.ts";
import type { PodHandle } from "./lifecycle.ts";

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

function selectionOf(raw: unknown): ModelSelection | null {
  if (!isRecord(raw)) return null;
  const provider = nonEmpty(raw.provider);
  const model = nonEmpty(raw.model);
  if (provider === undefined || model === undefined) return null;
  return { provider, model, reasoning_effort: nonEmpty(raw.reasoning_effort ?? raw.reasoningEffort) };
}

/**
 * Read the catalog from the host. Failures per provider stay local: one broken
 * adapter must not hide the models that other providers report.
 */
export async function discoverModelCatalog(services: CatalogServices, logger: HostLogger): Promise<ModelCatalog> {
  const models: ModelOffer[] = [];
  const seen = new Set<string>();

  const llm = services.llm;
  if (llm !== undefined) {
    let providers: Awaited<ReturnType<LlmCatalogService["listProviders"]>> = [];
    try {
      providers = await Promise.resolve(llm.listProviders());
    } catch (error) {
      logger.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`);
    }
    for (const entry of providers) {
      const provider = nonEmpty(entry.id);
      if (provider === undefined) continue;
      let available: Awaited<ReturnType<LlmCatalogService["listModels"]>> = [];
      try {
        available = await llm.listModels(provider);
      } catch (error) {
        logger.warn(`orca-pod: could not list models for ${provider}: ${errorMessage(error)}`);
        continue;
      }
      for (const entryModel of available) {
        const model = nonEmpty(entryModel.id);
        if (model === undefined) continue;
        const key = `${provider}/${model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        models.push({
          provider,
          model,
          name: nonEmpty(entryModel.name),
          description: nonEmpty(entryModel.description),
        });
        if (models.length >= MAX_MODEL_OFFERS) break;
      }
      if (models.length >= MAX_MODEL_OFFERS) break;
    }
  }

  let defaultModel: ModelSelection | null = null;
  try {
    const raw = services.agentDefaultModel?.currentSelection();
    if (raw !== undefined) defaultModel = selectionOf(raw);
  } catch (error) {
    logger.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`);
  }

  return { models, defaultModel };
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
      // The two catalog services are optional and independent: fence on each one
      // separately, so a host that offers only one still advertises what it has.
      // A scope's cleanup runs when its service goes away, and the catalog is
      // rebuilt without it.
      ctx.inject(["llm"], (scope) => {
        services = { ...services, llm: scope.llm };
        void refresh();
        scope.effect(
          () => () => {
            services = { ...services, llm: undefined };
            void refresh();
          },
          "orca-pod.catalog-llm",
        );
      });
      ctx.inject(["agentDefaultModel"], (scope) => {
        services = { ...services, agentDefaultModel: scope.agentDefaultModel };
        void refresh();
        scope.effect(
          () => () => {
            services = { ...services, agentDefaultModel: undefined };
            void refresh();
          },
          "orca-pod.catalog-default-model",
        );
      });
      void handle.ready.then(refresh);
    },
  };
}
