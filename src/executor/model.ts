/**
 * Model routes a node offers and a task selects (§6.15). The shapes are DSH's:
 * a selection is `ModelSelection` (`@deepseek-ai/dsh-agent`), an offer is the
 * part of `LlmModelInfo` (`@deepseek-ai/dsh-llm`) a peer needs, and an effort
 * is the adapter-owned `ReasoningEffortId`. Only the wire schemas are ours.
 */

import { z } from "zod";

import type { ModelSelection } from "@deepseek-ai/dsh-agent";
import { ReasoningEffortId, type LlmModelInfo } from "@deepseek-ai/dsh-llm";

export const MAX_MODEL_OFFERS = 128;

const NonEmptyString = z.string().min(1);

/** One model route an orca node advertises: what a peer needs of the host's `LlmModelInfo`. */
export type ModelOffer = Pick<LlmModelInfo, "provider" | "id" | "name" | "description">;

/**
 * One advertised model route (§6.15). Unknown keys are dropped: a peer's
 * catalog is stored and re-broadcast, so they are not carried along.
 */
const ModelOfferSchema = z.object({
  provider: NonEmptyString,
  id: NonEmptyString,
  name: z.string(),
  description: z.string().optional(),
}) satisfies z.ZodType<ModelOffer>;

/** The catalog a node advertises, at most `MAX_MODEL_OFFERS` routes. */
export const ModelOffersSchema = z.array(ModelOfferSchema).max(MAX_MODEL_OFFERS);

/**
 * A reasoning effort as the wire carries it: an adapter-owned id, opaque to
 * the node, that must hold something other than whitespace.
 */
export const ReasoningEffortSchema = z.string().trim().min(1, "must not be blank").transform(ReasoningEffortId);

/** A provider/model route, optionally pinned to one reasoning effort: DSH's `ModelSelection`. */
export const ModelSelectionSchema = z.object({
  provider: NonEmptyString,
  model: NonEmptyString,
  reasoningEffort: ReasoningEffortSchema.optional(),
}) satisfies z.ZodType<ModelSelection>;

/** What a node uses when a task names no model: the route and, separately, the reasoning effort (§6.15). */
export type ModelDefaults = { model: ModelSelection | null; reasoningEffort: ReasoningEffortId | null };

/** "model p/m and reasoning effort "e"": how an executor names what a task asked for in its failure text. */
export function describeModelRequest(
  model: ModelSelection | undefined,
  reasoningEffort: ReasoningEffortId | undefined,
): string {
  return [
    model === undefined ? "" : `model ${model.provider}/${model.model}`,
    reasoningEffort === undefined ? "" : `reasoning effort "${reasoningEffort}"`,
  ]
    .filter(Boolean)
    .join(" and ");
}

/** Parse a `provider/model` spec, optionally with a reasoning effort (§6.15). */
export function parseModelSpec(spec: string, reasoningEffort?: string): ModelSelection | null {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) return null;
  const provider = spec.slice(0, slash).trim();
  const model = spec.slice(slash + 1).trim();
  if (provider.length === 0 || model.length === 0) return null;
  const reasoning = reasoningEffort?.trim();
  return {
    provider,
    model,
    ...(reasoning !== undefined && reasoning.length > 0 ? { reasoningEffort: ReasoningEffortId(reasoning) } : {}),
  };
}
