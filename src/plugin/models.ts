/**
 * Build the node's model catalog (§6.16).
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

import type { ModelOffer, ModelSelection } from "../protocol.ts"
import type { HostContext, HostLogger } from "./dsh.ts"
import { errorMessage } from "./util.ts"

/** Hard cap mirrored from `config.ts`; duplicated here to avoid a cycle. */
const MAX_MODEL_OFFERS = 128

type LlmProvider = { id?: unknown; name?: unknown }
type LlmModel = { id?: unknown; name?: unknown; description?: unknown }

/** Subset of the DSH `llm` service used to enumerate the model catalog. */
export interface LlmCatalogService {
  listProviders(): LlmProvider[] | Promise<LlmProvider[]>
  listModels(provider: string): Promise<LlmModel[]>
}

/** Subset of the DSH `agent-default-model` service. */
export interface AgentDefaultModelService {
  currentSelection(): {
    provider?: unknown
    model?: unknown
    reasoningEffort?: unknown
    reasoning_effort?: unknown
  }
}

export type ModelCatalog = {
  models: ModelOffer[]
  defaultModel: ModelSelection | null
}

export const EMPTY_MODEL_CATALOG: ModelCatalog = { models: [], defaultModel: null }

function optionalService<T>(ctx: HostContext, name: string): T | undefined {
  const getter = ctx.get
  if (typeof getter !== "function") return undefined
  try {
    return getter.call(ctx, name) as T | undefined
  } catch {
    return undefined
  }
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}

function selectionOf(raw: unknown): ModelSelection | null {
  if (typeof raw !== "object" || raw === null) return null
  const record = raw as Record<string, unknown>
  const provider = nonEmpty(record["provider"])
  const model = nonEmpty(record["model"])
  if (provider === null || model === null) return null
  const reasoning = nonEmpty(record["reasoning_effort"] ?? record["reasoningEffort"])
  return { provider, model, ...(reasoning !== null ? { reasoning_effort: reasoning } : {}) }
}

/**
 * Read the catalog from the host. Failures per provider stay local: one broken
 * adapter must not hide the models that other providers report.
 */
export async function discoverModelCatalog(
  ctx: HostContext,
  logger?: HostLogger,
): Promise<ModelCatalog> {
  const models: ModelOffer[] = []
  const seen = new Set<string>()

  const llm = optionalService<LlmCatalogService>(ctx, "llm")
  if (llm !== undefined) {
    let providers: LlmProvider[] = []
    try {
      providers = await Promise.resolve(llm.listProviders())
    } catch (error) {
      logger?.warn(`orca-pod: could not list llm providers: ${errorMessage(error)}`)
    }
    for (const entry of Array.isArray(providers) ? providers : []) {
      const provider = nonEmpty(entry.id)
      if (provider === null) continue
      let available: LlmModel[] = []
      try {
        available = await llm.listModels(provider)
      } catch (error) {
        logger?.warn(`orca-pod: could not list models for ${provider}: ${errorMessage(error)}`)
        continue
      }
      for (const entryModel of Array.isArray(available) ? available : []) {
        const model = nonEmpty(entryModel.id)
        if (model === null) continue
        const key = `${provider}/${model}`
        if (seen.has(key)) continue
        seen.add(key)
        const name = nonEmpty(entryModel.name)
        const description = nonEmpty(entryModel.description)
        models.push({
          provider,
          model,
          ...(name !== null ? { name } : {}),
          ...(description !== null ? { description } : {}),
        })
        if (models.length >= MAX_MODEL_OFFERS) break
      }
      if (models.length >= MAX_MODEL_OFFERS) break
    }
  }

  let defaultModel: ModelSelection | null = null
  const agentDefaultModel = optionalService<AgentDefaultModelService>(ctx, "agentDefaultModel")
  try {
    const raw = agentDefaultModel?.currentSelection()
    if (raw !== undefined) defaultModel = selectionOf(raw)
  } catch (error) {
    logger?.warn(`orca-pod: could not read the default model: ${errorMessage(error)}`)
  }

  return { models, defaultModel }
}
