/** Permission requests from the ACP child: the fields a task needs, the auto-answer policy and the reply. */

import type {
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

import { narrowPermissionMode, widerModes } from "../../protocol/permission.ts";

/**
 * What an ACP child asks permission for, as the executor reads it (not the
 * protocol's `PermissionRequest`): the SDK's tool call with its optional
 * fields settled, plus the options it offers.
 */
export type AcpPermissionAsk = Pick<ToolCallUpdate, "toolCallId"> & {
  title: string;
  kind: ToolKind | undefined;
  options: RequestPermissionRequest["options"];
};

export const CANCELLED: RequestPermissionResponse = { outcome: { outcome: "cancelled" } };

/** The answer to an ask: let the tool run, or refuse it. */
export type PermissionDecision = "allow" | "reject";

export function parsePermissionRequest(params: RequestPermissionRequest): AcpPermissionAsk {
  const call = params.toolCall;
  return {
    toolCallId: call.toolCallId,
    title: call.title ?? "tool",
    kind: call.kind ?? undefined,
    options: params.options,
  };
}

/** Whether `mode` lets a tool call of `kind` run without asking (§7.14). */
export function modeAllows(mode: SandboxMode, kind: ToolKind | undefined): boolean {
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
  kind: ToolKind | undefined,
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
