/** Theme-token style objects and small display helpers (state labels, ids, ages). */

import type { CSSProperties } from "react";
import { t } from "./i18n.ts";

/** DSH design-platform typography: 14/22 body, 13/20 secondary, 12/18 hint. */
export const FONT_FAMILY = "var(--dsw-font-family)";
export const MONO_FONT = "var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, monospace)";
export const BORDER = "1px solid var(--dsw-alias-border-l1)";
export const FIELD_BORDER = "1px solid var(--dsw-alias-border-l2)";
export const RADIUS = "var(--dsw-radius-sm, 8px)";
export const Z_MODAL = 1000;
export const Z_POPUP = 1001;
export const CELL: CSSProperties = {
  padding: "6px 14px 6px 0",
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  lineHeight: "22px",
  verticalAlign: "top",
  color: "var(--dsw-alias-label-primary)",
  whiteSpace: "nowrap",
};
export const MUTED: CSSProperties = { ...CELL, color: "var(--dsw-alias-label-secondary)" };
export const ERROR: CSSProperties = { ...MUTED, color: "var(--dsw-alias-state-error-primary)", whiteSpace: "normal" };
export const SECTION: CSSProperties = { marginTop: 22 };
export const TITLE: CSSProperties = { fontFamily: FONT_FAMILY, fontSize: 18, fontWeight: 600, lineHeight: "26px" };
export const H2 = {
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: "22px",
  margin: "0 0 8px",
  color: "var(--dsw-alias-label-primary)",
};
export const BUTTON: CSSProperties = {
  cursor: "pointer",
  boxSizing: "border-box",
  height: 34,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  borderRadius: RADIUS,
  padding: "0 14px",
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  lineHeight: "22px",
  border: FIELD_BORDER,
  background: "transparent",
  color: "var(--dsw-alias-label-primary)",
};
export const DANGER: CSSProperties = {
  ...BUTTON,
  borderColor: "var(--dsw-alias-state-error-primary)",
  color: "var(--dsw-alias-state-error-primary)",
};
export const PRIMARY: CSSProperties = {
  ...BUTTON,
  borderColor: "transparent",
  background: "var(--dsw-alias-brand-primary)",
  color: "var(--dsw-alias-bg-base)",
};
export const ICON_BUTTON: CSSProperties = { ...BUTTON, width: 32, padding: 0, fontSize: 16, lineHeight: 1 };
export const INPUT: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  minHeight: 34,
  padding: "6px 10px",
  borderRadius: RADIUS,
  border: FIELD_BORDER,
  background: "var(--dsw-specific-input-major, var(--dsw-alias-bg-base))",
  color: "var(--dsw-alias-label-primary)",
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  lineHeight: "22px",
};
export const FIELD: CSSProperties = { display: "block", marginBottom: 14 };
export const LABEL: CSSProperties = {
  display: "block",
  fontFamily: FONT_FAMILY,
  fontSize: 13,
  lineHeight: "20px",
  marginBottom: 4,
  color: "var(--dsw-alias-label-secondary)",
};
export const HINT: CSSProperties = {
  fontFamily: FONT_FAMILY,
  fontSize: 12,
  lineHeight: "18px",
  color: "var(--dsw-alias-label-secondary)",
  marginTop: 4,
};
export const FACT: CSSProperties = { display: "flex", gap: 10, marginTop: 6, alignItems: "baseline" };
export const LINK: CSSProperties = {
  display: "inline-block",
  marginRight: 10,
  color: "var(--dsw-alias-brand-primary)",
};
export const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 24,
  zIndex: Z_MODAL,
  pointerEvents: "auto",
  background: "var(--dsw-alias-bg-mask-1)",
};
export const CARD: CSSProperties = {
  position: "relative",
  boxSizing: "border-box",
  maxHeight: "min(84vh, 880px)",
  overflow: "auto",
  padding: "24px 26px 22px",
  borderRadius: "var(--dsw-radius-lg, 16px)",
  border: BORDER,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
};
export const CLOSE_BUTTON: CSSProperties = {
  position: "absolute",
  top: 14,
  right: 14,
  width: 28,
  height: 28,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  cursor: "pointer",
  border: "none",
  borderRadius: RADIUS,
  background: "transparent",
  color: "var(--dsw-alias-label-secondary)",
  fontFamily: FONT_FAMILY,
  fontSize: 18,
  lineHeight: 1,
};
export const PROMPT_CARD: CSSProperties = {
  pointerEvents: "auto",
  boxSizing: "border-box",
  padding: "12px 16px",
  borderRadius: "var(--dsw-radius-panel, 16px)",
  border: FIELD_BORDER,
  background: "var(--dsw-alias-bg-layer-1)",
  color: "var(--dsw-alias-label-primary)",
};
/* The dock card sits inline above the composer, on the composer's width axis. */
export const DOCK_CARD: CSSProperties = {
  ...PROMPT_CARD,
  width: "100%",
  maxWidth: "var(--dsh-composer-card-max-width, 952px)",
  margin: "0 auto",
};
export const POPUP_CARD: CSSProperties = { ...PROMPT_CARD, width: "min(380px, calc(100vw - 32px))" };
export const GROUP: CSSProperties = { display: "flex", flexDirection: "column", gap: 8 };
export const DOCK_GROUP: CSSProperties = {
  ...GROUP,
  boxSizing: "border-box",
  width: "100%",
  padding: "0 var(--dsh-composer-side-clearance, 16px)",
};
export const POPUP_GROUP: CSSProperties = {
  ...GROUP,
  position: "fixed",
  right: 16,
  bottom: 56,
  zIndex: Z_POPUP,
  pointerEvents: "none",
};
export const FOOTER_ACTION: CSSProperties = {
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: 8,
  width: "100%",
  padding: "8px 10px",
  borderRadius: RADIUS,
  border: "1px solid transparent",
  background: "transparent",
  fontFamily: FONT_FAMILY,
  fontSize: 14,
  lineHeight: "22px",
  textAlign: "left",
};
export const CHAIN_TAG: CSSProperties = {
  ...MUTED,
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "1px 8px",
  border: BORDER,
  borderRadius: 999,
  background: "var(--dsw-alias-bg-layer-1)",
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: 12,
  lineHeight: "18px",
};
export const STATE_COLOR: Record<string, string> = {
  online: "var(--dsw-alias-state-success-primary)",
  suspect: "var(--dsw-alias-state-warn-primary)",
  offline: "var(--dsw-alias-state-error-primary)",
  unknown: "var(--dsw-alias-state-idle-primary)",
};
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
export const stateLabel = (value: string): string => t(STATE_KEY[value] ?? value);
export const short = (id: string): string => (id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id);
export function ageOf(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}
export const age = (iso: string): string => ageOf(Date.parse(iso));
