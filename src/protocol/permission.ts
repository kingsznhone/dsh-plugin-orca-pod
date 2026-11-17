import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import { z } from "zod";

/** The permission modes this DSH accepts and their rank, read from DSH's own sandbox policy. */
export const SandboxModeSchema = z.enum(SANDBOX_MODES as readonly [SandboxMode, ...SandboxMode[]]);

/** Rank of a mode; a higher rank lets the agent do more. */
export function permissionModeRank(mode: SandboxMode): number {
  return SANDBOX_MODES.indexOf(mode);
}

/** The narrower of two modes: an inherited mode can only lower the local ceiling. */
export function narrowPermissionMode(local: SandboxMode, inherited: SandboxMode): SandboxMode {
  return permissionModeRank(inherited) < permissionModeRank(local) ? inherited : local;
}
