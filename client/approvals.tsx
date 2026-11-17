/** Permission requests: chain badge, prompt cards, the chat dock, the popup and the panel list. */

import React, { type CSSProperties } from "react";
import { t, useLocale } from "./i18n.ts";
import type { PodApproval, PodChainEntry } from "./types.ts";
import { Button, stop } from "./primitives.tsx";
import { store, useStore } from "./store.ts";
import {
  BORDER,
  CELL,
  CHAIN_TAG,
  DANGER,
  DOCK_CARD,
  DOCK_GROUP,
  ERROR,
  FONT_FAMILY,
  MONO_FONT,
  MUTED,
  POPUP_CARD,
  POPUP_GROUP,
  PRIMARY,
  short,
} from "./styles.ts";

/** Root-to-leaf approval path as a vertical stack. */
export function ChainFlow({ chain }: { chain: PodChainEntry[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 4 }}>
      {chain.map((entry, index) => {
        const last = index === chain.length - 1;
        return (
          <div key={index} style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                flex: "0 0 auto",
                background: last ? "var(--dsw-alias-state-warn-primary)" : "var(--dsw-alias-label-secondary)",
              }}
            />
            <span style={{ fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "18px", fontWeight: last ? 600 : 400 }}>
              {entry.name}
            </span>
            {entry.self ? <span style={{ ...MUTED, padding: 0, fontSize: 11 }}>{t("apSelf")}</span> : null}
            {!last ? (
              <span aria-hidden={"true"} style={{ color: "var(--dsw-alias-label-secondary)", fontSize: 11 }}>
                {"↓"}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
/** Compact tag for the approval path; hover or click opens the hops. */
export function ChainBadge({ chain }: { chain: PodChainEntry[] }) {
  const [hover, setHover] = React.useState(false);
  const [pinned, setPinned] = React.useState(false);
  if (chain.length < 2) return null;
  const open = hover || pinned;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: hover is a shortcut; the button pins the list for keyboard users.
    <span
      style={{ position: "relative", display: "inline-flex", minWidth: 0 }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <Button style={CHAIN_TAG} title={t("apChainHint")} aria-expanded={open} onClick={stop(() => setPinned(!pinned))}>
        {t("apChainTag")}
        <span style={{ fontSize: 10, lineHeight: "10px" }}>{"▾"}</span>
      </Button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: only keeps clicks inside the popover from reaching the row.
        <div
          style={{ position: "absolute", top: "100%", left: 0, paddingTop: 6, zIndex: 2 }}
          onClick={(event) => event.stopPropagation()}
        >
          <div
            style={{
              minWidth: 200,
              padding: "10px 12px",
              background: "var(--dsw-alias-bg-layer-1)",
              border: BORDER,
              borderRadius: "var(--dsw-radius-md, 10px)",
            }}
          >
            <div style={{ ...MUTED, padding: 0, fontSize: 11, marginBottom: 6 }}>{t("apChain")}</div>
            <ChainFlow chain={chain} />
          </div>
        </div>
      ) : null}
    </span>
  );
}
export const answer = (kind: "approve" | "deny", approval: PodApproval) =>
  store.act(kind, { peer: approval.peer, task_id: approval.task_id });
/** One waiting permission request as a card; the dock and the popup share it. */
export function PromptCard({
  approval,
  background,
  busy,
}: {
  approval: PodApproval;
  background?: boolean;
  busy: boolean;
}) {
  const title = background ? t("apBackground") : t("apTitleTask").replace("{task}", short(approval.task_id));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a card, not a form; <fieldset> would bring form semantics and borders.
    <div role={"group"} aria-label={title} style={background ? POPUP_CARD : DOCK_CARD}>
      <div style={{ fontFamily: FONT_FAMILY, fontSize: 14, fontWeight: 600, lineHeight: "22px" }}>{title}</div>
      <div
        style={{
          ...MUTED,
          padding: 0,
          whiteSpace: "normal",
          display: "flex",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {t("from") + approval.from}
        <ChainBadge chain={approval.chain} />
      </div>
      <div style={{ fontFamily: FONT_FAMILY, fontSize: 13, lineHeight: "20px", marginTop: 4, whiteSpace: "normal" }}>
        {`${t("apWants")} ${t("tool")} ${approval.tool}`}
        {approval.requested ? (
          <div
            style={{
              ...MUTED,
              padding: 0,
              whiteSpace: "normal",
              fontFamily: MONO_FONT,
              fontSize: 12,
              lineHeight: "18px",
            }}
          >
            {approval.requested}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
        <Button style={PRIMARY} disabled={busy} onClick={() => answer("approve", approval)}>
          {t("apAllow")}
        </Button>
        <Button style={DANGER} disabled={busy} onClick={() => answer("deny", approval)}>
          {t("apDeny")}
        </Button>
        <Button onClick={() => store.setPanelOpen(true)}>{t("apInPanel")}</Button>
      </div>
    </div>
  );
}
/** Approvals the human can answer from chat: one card each, plus the last action error. */
export function PromptGroup({
  approvals,
  background,
  style,
}: {
  approvals: PodApproval[];
  background?: boolean;
  style: CSSProperties;
}) {
  const { busy, actionError } = useStore();
  if (approvals.length === 0) return null;
  return (
    <div style={style}>
      {approvals.map((approval) => (
        <PromptCard key={approval.id} approval={approval} background={background} busy={busy} />
      ))}
      {actionError ? <div style={ERROR}>{actionError}</div> : null}
    </div>
  );
}
/** Chat card: the prompts of the session this dock sits in. */
export function ApprovalDock({ sessionId }: { sessionId: string }) {
  useLocale();
  const { state } = useStore();
  React.useEffect(() => store.dock(sessionId), [sessionId]);
  const mine = state === null ? [] : state.approvals.filter((approval) => approval.agent_id === sessionId);
  return <PromptGroup approvals={mine} style={DOCK_GROUP} />;
}
/** Frame-wide popup: prompts of sessions that are not on screen. */
export function ApprovalPopup() {
  useLocale();
  const { state, docked } = useStore();
  const away =
    state === null
      ? []
      : state.approvals.filter((approval) => approval.agent_id !== null && !docked.includes(approval.agent_id));
  return <PromptGroup approvals={away} background={true} style={POPUP_GROUP} />;
}
/** Panel list of the same requests, answerable in place. */
export function ApprovalList({ approvals, busy }: { approvals: PodApproval[]; busy: boolean }) {
  if (approvals.length === 0) return <div style={MUTED}>{t("nothingWaiting")}</div>;
  return approvals.map((approval) => (
    <div key={approval.id} style={{ display: "flex", gap: 8, alignItems: "center", margin: "4px 0" }}>
      <span style={CELL}>{short(approval.task_id)}</span>
      <span style={MUTED}>{approval.tool}</span>
      <span style={{ ...MUTED, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        {t("from") + approval.from}
        <ChainBadge chain={approval.chain} />
      </span>
      <Button disabled={busy} onClick={() => answer("approve", approval)}>
        {t("approve")}
      </Button>
      <Button style={DANGER} disabled={busy} onClick={() => answer("deny", approval)}>
        {t("deny")}
      </Button>
    </div>
  ));
}
