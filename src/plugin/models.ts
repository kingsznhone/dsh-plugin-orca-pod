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
 * executor's own default.
 */

import { isRecord, type ModelOffer, type ModelSelection } from "../protocol.ts";
import type { HostContext, HostLogger } from "./dsh.ts";
import { errorMessage } from "../errors.ts";
import { service } from "./util.ts";

/** Hard cap mirrored from `config.ts`; duplicated here to avoid a cycle. */
const MAX_MODEL_OFFERS = 128;

type LlmProvider = { id?: unknown; name?: unknown };
type LlmModel = { id?: unknown; name?: unknown; description?: unknown };

/** Subset of the DSH `llm` service used to enumerate the model catalog. */
interface LlmCatalogService {
  listProviders(): LlmProvider[] | Promise<LlmProvider[]>;
  listModels(provider: string): Promise<LlmModel[]>;
}

/** Subset of the DSH `agent-default-model` service. */
interface AgentDefaultModelService {
  currentSelection(): {
    provider?: unknown;
    model?: unknown;
    reasoningEffort?: unknown;
    reasoning_effort?: unknown;
  };
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
export async function discoverModelCatalog(ctx: HostContext, logger: HostLogger): Promise<ModelCatalog> {
  const models: ModelOffer[] = [];
  const seen = new Set<string>();

  const llm = service<LlmCatalogService>(ctx, "llm");
  if (llm !== undefined) {
    let providers: LlmProvider[] = [];
    try {
      providers = await Promise.resolve(llm.listProviders());
    } catch (error) {
      logger.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`);
    }
    for (const entry of providers) {
      const provider = nonEmpty(entry.id);
      if (provider === undefined) continue;
      let available: LlmModel[] = [];
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
  const agentDefaultModel = service<AgentDefaultModelService>(ctx, "agentDefaultModel");
  try {
    const raw = agentDefaultModel?.currentSelection();
    if (raw !== undefined) defaultModel = selectionOf(raw);
  } catch (error) {
    logger.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`);
  }

  return { models, defaultModel };
}
