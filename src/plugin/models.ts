/**
 * Build the node's model catalog (§6.15).
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
import type { AgentDefaultModelService, HostLogger, LlmCatalogService } from "./dsh.ts";

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
