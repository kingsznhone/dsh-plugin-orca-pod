/** Model routes a node offers and a task selects (§6.15). */

import { z } from "zod";

import { parseSchema } from "../kernel/schema.ts";

export const MAX_MODEL_OFFERS = 128;

const NonEmptyString = z.string().min(1);

/**
 * One model route an orca node advertises for tasks (§6.15). Unknown keys are
 * dropped: a peer's catalog is stored and re-broadcast, so they are not carried along.
 */
export const ModelOfferSchema = z.object({
  provider: NonEmptyString,
  model: NonEmptyString,
  /** Human-readable model name, when the provider catalog publishes one. */
  name: z.string().optional(),
  description: z.string().optional(),
});
export type ModelOffer = z.infer<typeof ModelOfferSchema>;

/** The catalog a node advertises, at most `MAX_MODEL_OFFERS` routes. */
export const ModelOffersSchema = z.array(ModelOfferSchema).max(MAX_MODEL_OFFERS);

/**
 * One reasoning-effort value a provider offers (`off`, `low`, `high`, `max`
 * today; treated as an opaque string so a provider can add values). It must
 * hold something other than whitespace.
 */
export const ReasoningEffortSchema = z.string().regex(/\S/, "must not be blank");
export type ReasoningEffort = string;

/** A provider/model route, optionally pinned to one reasoning effort. */
export const ModelSelectionSchema = z.object({
  provider: NonEmptyString,
  model: NonEmptyString,
  reasoning_effort: ReasoningEffortSchema.optional(),
});
export type ModelSelection = z.infer<typeof ModelSelectionSchema>;

/** What a node uses when a task names no model: the route and, separately, the reasoning effort (§6.15). */
export type ModelDefaults = { model: ModelSelection | null; reasoningEffort: ReasoningEffort | null };

/** "model p/m and reasoning effort "e"": how an executor names what a task asked for in its failure text. */
export function describeModelRequest(
  model: ModelSelection | undefined,
  reasoningEffort: ReasoningEffort | undefined,
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
    ...(reasoning !== undefined && reasoning.length > 0 ? { reasoning_effort: reasoning } : {}),
  };
}

/** True when `value` is a usable reasoning-effort selector (§6.15). */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return ReasoningEffortSchema.safeParse(value).success;
}

/**
 * A model route from untrusted input (task metadata, config): unknown keys are
 * dropped, as the gateway drops them from a joining node's catalog. Null when
 * it does not name a provider and model.
 */
export function parseModelSelection(raw: unknown): ModelSelection | null {
  const result = parseSchema(ModelSelectionSchema, raw);
  return result.ok ? result.value : null;
}
