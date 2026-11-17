import { z } from "zod";

import { PERMISSION_MODES, type PermissionMode } from "./vocabulary.ts";

export type { PermissionMode };

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
