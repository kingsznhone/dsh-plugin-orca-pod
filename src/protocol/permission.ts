import { WIDER_MODES, type SandboxMode } from "@deepseek-ai/dsh-sandbox";
import { SANDBOX_MODES } from "@deepseek-ai/dsh-sandbox-policy";
import { z } from "zod";

/** The permission modes this DSH accepts, read from DSH's own sandbox policy. */
export const SandboxModeSchema = z.enum(SANDBOX_MODES as readonly [SandboxMode, ...SandboxMode[]]);

/** The modes strictly wider than `mode`, narrowest first: DSH's escalation ladder (`WIDER_MODES`). */
export function widerModes(mode: SandboxMode): readonly SandboxMode[] {
  return WIDER_MODES[mode] ?? [];
}

/** The narrower of two modes: an inherited or requested mode can only lower `ceiling`. */
export function narrowPermissionMode(ceiling: SandboxMode, mode: SandboxMode): SandboxMode {
  return widerModes(mode).includes(ceiling) ? mode : ceiling;
}
