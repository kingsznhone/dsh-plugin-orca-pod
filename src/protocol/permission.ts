import { z } from "zod";

/** Modes in rank order: a later mode lets the agent do more. */
const PERMISSION_MODES = ["read-only", "workspace-write", "danger-full-access"] as const;

/** How much an agent may do on the orca node running its task (§7.10). */
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const PermissionModeSchema = z.enum(PERMISSION_MODES);

export function isPermissionMode(value: unknown): value is PermissionMode {
  return PermissionModeSchema.safeParse(value).success;
}

/** Rank of a mode; a higher rank lets the agent do more. */
export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODES.indexOf(mode);
}

/** The narrower of two modes: an inherited mode can only lower the local ceiling. */
export function narrowPermissionMode(local: PermissionMode, inherited: PermissionMode): PermissionMode {
  return permissionModeRank(inherited) < permissionModeRank(local) ? inherited : local;
}
