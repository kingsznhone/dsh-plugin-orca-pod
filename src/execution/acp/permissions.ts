/** Permission requests from the ACP child: parsing, the auto-answer policy and the reply shape. */

import { isRecord, type PermissionMode } from "../../protocol/index.ts";

type PermissionOption = { optionId: string; kind: string };

export type PermissionRequest = {
  toolCallId: string | undefined;
  title: string;
  kind: string | undefined;
  options: PermissionOption[];
};

export const CANCELLED = { outcome: { outcome: "cancelled" } };

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function parsePermissionRequest(params: Record<string, unknown>): PermissionRequest {
  const call = isRecord(params.toolCall) ? params.toolCall : {};
  const options = Array.isArray(params.options) ? params.options : [];
  return {
    toolCallId: text(call.toolCallId),
    title: text(call.title) ?? "tool",
    kind: text(call.kind),
    options: options.flatMap((option) =>
      isRecord(option) && typeof option.optionId === "string" && typeof option.kind === "string"
        ? [{ optionId: option.optionId, kind: option.kind }]
        : [],
    ),
  };
}

/**
 * Auto-answer a permission request the inherited mode already covers (§7.10).
 * `null` means the request is outside the mode and must go to the origin.
 */
export function autoDecision(mode: PermissionMode, kind: string | undefined): "allow" | "reject" | null {
  if (mode === "danger-full-access") return "allow";
  const readable = kind === "read" || kind === "search" || kind === "think";
  if (mode === "read-only") return readable ? "allow" : "reject";
  const writable = kind === "edit" || kind === "delete" || kind === "move" || kind === "execute";
  return readable || writable ? "allow" : null;
}

/** The ACP outcome for a decision; cancelled when the child offered no option of that kind. */
export function outcomeFor(options: PermissionOption[], decision: "allow" | "reject"): unknown {
  const chosen =
    options.find((option) => option.kind === `${decision}_once`) ??
    options.find((option) => option.kind.startsWith(decision));
  return chosen === undefined ? CANCELLED : { outcome: { outcome: "selected", optionId: chosen.optionId } };
}
