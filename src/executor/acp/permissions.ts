/** Permission requests from the ACP child: the auto-answer policy and the reply. */

import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

import { narrowPermissionMode, widerModes } from "../permission.ts";

export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/** The answer to an ask: let the tool run, or refuse it. */
type PermissionDecision = "allow" | "reject";

/** Whether `mode` lets a tool call of `kind` run without asking (design.md 6.4); a call of no kind only under full access. */
export function modeAllows(mode: SandboxMode, kind: ToolKind | null | undefined): boolean {
  if (mode === "danger-full-access") return true;
  const readable = kind === "read" || kind === "search" || kind === "think";
  if (mode === "read-only") return readable;
  return readable || kind === "edit" || kind === "delete" || kind === "move" || kind === "execute";
}

/**
 * The mode to ask the origin for when `mode` does not allow a tool call: the
 * narrowest wider mode on DSH's ladder that does, within this node's ceiling.
 * `null` means no mode the node accepts would allow it, so the call is refused
 * without asking anyone.
 */
export function escalationFor(
  mode: SandboxMode,
  ceiling: SandboxMode | undefined,
  kind: ToolKind | null | undefined,
): SandboxMode | null {
  for (const wider of widerModes(mode)) {
    if (ceiling !== undefined && narrowPermissionMode(ceiling, wider) !== wider) return null;
    if (modeAllows(wider, kind)) return wider;
  }
  return null;
}

/** The ACP option kinds that carry each decision, the single-use one preferred. */
const OPTION_KINDS = {
  allow: ["allow_once", "allow_always"],
  reject: ["reject_once", "reject_always"],
} as const satisfies Record<PermissionDecision, readonly PermissionOptionKind[]>;

/** The ACP outcome for a decision; cancelled when the child offered no option of that kind. */
export function outcomeFor(options: PermissionOption[], decision: PermissionDecision): RequestPermissionResponse {
  for (const kind of OPTION_KINDS[decision]) {
    const chosen = options.find((option) => option.kind === kind);
    if (chosen !== undefined) return { outcome: { outcome: "selected", optionId: chosen.optionId } };
  }
  return CANCELLED;
}
