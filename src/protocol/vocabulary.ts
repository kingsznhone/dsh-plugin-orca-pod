/**
 * Value lists the protocol fixes and the panel offers as choices.
 *
 * This module imports nothing, so the client bundle can take these lists from
 * here without pulling in zod; the schemas build on them (`permission.ts`,
 * `model.ts`).
 */

/** Permission modes in rank order: a later mode lets the agent do more (§7.10). */
export const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/** How much an agent may do on the orca node running its task. */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * Reasoning efforts DSH's providers offer today. The protocol treats an effort
 * as an opaque string so a provider can add values; this list is what the
 * panel offers as a node default.
 */
export const KNOWN_REASONING_EFFORTS = ["off", "low", "high", "max"] as const;
