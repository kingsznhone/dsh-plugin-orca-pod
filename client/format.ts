/** Display helpers: state labels and dots, short ids, ages. Styling lives in the `*.module.css` files. */

import { relativeTime, type RelativeTimeUnit, type StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import { t } from "./i18n.ts";
import type { PeerState, TaskState } from "./types.ts";

/** Every state a member, a task or a dispatch can be in; `unknown` is both a peer's and a dispatch's. */
export type ShownState = PeerState | TaskState;

export const STATE_KEY: Record<ShownState, string> = {
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
const STATE_DOT: Record<ShownState, StateDotState> = {
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

export const stateLabel = (value: ShownState): string => t(STATE_KEY[value]);
export const stateDot = (value: ShownState): StateDotState => STATE_DOT[value];
export const short = (id: string): string => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);

/** Seconds since a moment, for the "updated Ns ago" ticker (DSH's buckets start at minutes). */
export function ageOf(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

const AGE_KEY: Record<RelativeTimeUnit, string> = {
  now: "ageNow",
  minutes: "ageMinutes",
  hours: "ageHours",
  days: "ageDays",
  months: "ageMonths",
  years: "ageYears",
};

/** How long ago a moment was, in DSH's shared buckets (so every surface dates the same way). */
export function age(iso: string): string {
  const { unit, n } = relativeTime(Date.parse(iso), Date.now());
  return t(AGE_KEY[unit]).replace("{n}", String(n));
}
