/** How much an agent may do on the orca node running its task (§7.10). */
export type PermissionMode = "read-only" | "workspace-write" | "danger-full-access";

const PERMISSION_MODES: readonly PermissionMode[] = ["read-only", "workspace-write", "danger-full-access"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

/** Rank of a mode; a higher rank lets the agent do more. */
export function permissionModeRank(mode: PermissionMode): number {
  return PERMISSION_MODES.indexOf(mode);
}

/** The narrower of two modes: an inherited mode can only lower the local ceiling. */
export function narrowPermissionMode(local: PermissionMode, inherited: PermissionMode): PermissionMode {
  return permissionModeRank(inherited) < permissionModeRank(local) ? inherited : local;
}
