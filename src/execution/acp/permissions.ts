/** Permission requests from the ACP child: the fields a task needs, the auto-answer policy and the reply. */

import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { SandboxMode } from "@deepseek-ai/dsh-sandbox";

/** What an ACP child asks permission for, as the executor reads it (not the protocol's `PermissionRequest`). */
export type AcpPermissionAsk = {
  toolCallId: string;
  title: string;
  kind: ToolKind | undefined;
  options: PermissionOption[];
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

/**
 * Auto-answer a permission request the inherited mode already covers (§7.10).
 * `null` means the request is outside the mode and must go to the origin.
 */
export function autoDecision(mode: SandboxMode, kind: ToolKind | undefined): PermissionDecision | null {
  if (mode === "danger-full-access") return "allow";
  const readable = kind === "read" || kind === "search" || kind === "think";
  if (mode === "read-only") return readable ? "allow" : "reject";
  const writable = kind === "edit" || kind === "delete" || kind === "move" || kind === "execute";
  return readable || writable ? "allow" : null;
}

/** The ACP outcome for a decision; cancelled when the child offered no option of that kind. */
export function outcomeFor(options: PermissionOption[], decision: PermissionDecision): RequestPermissionResponse {
  const chosen =
    options.find((option) => option.kind === `${decision}_once`) ??
    options.find((option) => option.kind.startsWith(decision));
  return chosen === undefined ? CANCELLED : { outcome: { outcome: "selected", optionId: chosen.optionId } };
}
