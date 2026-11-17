/** Display helpers: state labels and dots, short ids, ages. Styling lives in the `*.module.css` files. */

import type { DotState } from "@deepseek-ai/dsh-client-ui-primitives";
import { t } from "./i18n.ts";

export const STATE_KEY: Record<string, string> = {
  online: "stateOnline",
  suspect: "stateSuspect",
  offline: "stateOffline",
  unknown: "stateUnknown",
  submitted: "taskSubmitted",
  working: "taskWorking",
  "input-required": "taskInputRequired",
  completed: "taskCompleted",
  failed: "taskFailed",
  canceled: "taskCanceled",
};

/** Member and task states as DSH status dots. */
const STATE_DOT: Record<string, DotState> = {
  online: "done",
  suspect: "warning",
  offline: "error",
  unknown: "idle",
  submitted: "ongoing",
  working: "ongoing",
  "input-required": "warning",
  completed: "done",
  failed: "error",
  canceled: "idle",
};

/** Task states that still hold a slot. */
export const ACTIVE_STATES = ["submitted", "working", "input-required"];

export const stateLabel = (value: string): string => t(STATE_KEY[value] ?? value);
export const stateDot = (value: string): DotState => STATE_DOT[value] ?? "idle";
export const short = (id: string): string => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
export function ageOf(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
export const age = (iso: string): string => ageOf(Date.parse(iso));
