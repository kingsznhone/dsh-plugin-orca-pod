/** Model routes a node offers and a task selects (§6.15). */

import { isRecord } from "../kernel/index.ts";

/** One model route an orca node advertises for tasks (§6.15). */
export type ModelOffer = {
  provider: string;
  model: string;
  /** Human-readable model name, when the provider catalog publishes one. */
  name?: string;
  description?: string;
};

/** A provider/model route, optionally pinned to one reasoning effort. */
export type ModelSelection = {
  provider: string;
  model: string;
  reasoning_effort?: string;
};

/**
 * One reasoning-effort value a provider offers (`off`, `low`, `high`, `max`
 * today; treated as an opaque string so a provider can add values).
 */
export type ReasoningEffort = string;

/** True when `value` names a provider/model route with optional reasoning effort. */
export function isModelSelection(value: unknown): value is ModelSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || record.provider.length === 0) return false;
  if (typeof record.model !== "string" || record.model.length === 0) return false;
  const effort = record.reasoning_effort;
  return effort === undefined || (typeof effort === "string" && effort.length > 0);
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
  return typeof value === "string" && value.trim().length > 0;
}

export const MAX_MODEL_OFFERS = 128;

function fail(message: string): never {
  throw new Error(message);
}

/** Validate the advertised model catalog (§6.15). */
export function validateModelOffers(raw: unknown): ModelOffer[] {
  if (!Array.isArray(raw)) fail("must be an array");
  if (raw.length > MAX_MODEL_OFFERS) fail(`must have at most ${MAX_MODEL_OFFERS} entries`);
  return raw.map((entry, index) => {
    if (!isRecord(entry)) fail(`[${index}] must be an object`);
    const { provider, model, name, description } = entry;
    if (typeof provider !== "string" || provider.length === 0) fail(`[${index}].provider must be a non-empty string`);
    if (typeof model !== "string" || model.length === 0) fail(`[${index}].model must be a non-empty string`);
    if (name !== undefined && typeof name !== "string") fail(`[${index}].name must be a string`);
    if (description !== undefined && typeof description !== "string") fail(`[${index}].description must be a string`);
    return { provider, model, name, description };
  });
}

/** Validate one provider/model route, optionally pinned to a reasoning effort. */
export function validateModelSelection(raw: unknown): ModelSelection {
  return isModelSelection(raw) ? raw : fail("must name a provider, model and optional reasoning_effort");
}
