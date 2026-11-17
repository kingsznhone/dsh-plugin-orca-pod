/** Permission requests: approval path badge, prompt cards, the chat dock, the popup and the panel list. */

import { Button, IconChevronDownOutlineRegular, StateDot, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";
import css from "./approvals.module.css";
import { short } from "./format.ts";
import { t, useLocale } from "./i18n.ts";
import { Empty, stop } from "./primitives.tsx";
import { store, useStore } from "./store.ts";
import type { PodApproval, PodChainEntry } from "./types.ts";
import ui from "./ui.module.css";

/** Root-to-leaf approval path as a vertical list. */
export function ChainFlow({ chain }: { chain: PodChainEntry[] }) {
  return (
    <ol className={css.chainList}>
      {chain.map((entry, index) => (
        <li key={index} className={css.hop} data-last={index === chain.length - 1 ? "" : undefined}>
          <span className={css.hopDot} />
          {entry.name}
          {entry.self ? <span className={css.hopSelf}>{t("apSelf")}</span> : null}
        </li>
      ))}
    </ol>
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
    <span className={css.chainAnchor} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <button
        type={"button"}
        className={css.chainTag}
        title={t("apChainHint")}
        aria-expanded={open}
        onClick={stop(() => setPinned(!pinned))}
      >
        {t("apChainTag")}
        <IconChevronDownOutlineRegular size={12} />
      </button>
      {open ? (
        // biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useKeyWithClickEvents: only keeps clicks inside the popover from reaching the row.
        <div className={css.chainPopover} onClick={(event) => event.stopPropagation()}>
          <div className={css.chainCard}>
            <div className={css.chainHeading}>{t("apChain")}</div>
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
    <div role={"group"} aria-label={title} className={`${css.card} ${background ? css.popup : css.dock}`}>
      <div className={css.title}>
        <StateDot state={"warning"} />
        {title}
      </div>
      <div className={css.meta}>
        {t("from") + approval.from}
        <ChainBadge chain={approval.chain} />
      </div>
      <div className={css.request}>
        {`${t("apWants")} ${t("tool")} `}
        <span className={`${css.tool} ${ui.mono}`}>{approval.tool}</span>
        {approval.requested ? <div className={`${css.requested} ${ui.mono}`}>{approval.requested}</div> : null}
      </div>
      <div className={css.actions}>
        <Button variant={"primary"} size={"sm"} disabled={busy} onClick={() => answer("approve", approval)}>
          {t("apAllow")}
        </Button>
        <Button
          variant={"outline"}
          size={"sm"}
          className={ui.danger}
          disabled={busy}
          onClick={() => answer("deny", approval)}
        >
          {t("apDeny")}
        </Button>
        <span className={css.spacer} />
        <Button variant={"ghost"} size={"sm"} onClick={() => store.setPanelOpen(true)}>
          {t("apInPanel")}
        </Button>
      </div>
    </div>
  );
}

/** Approvals the human can answer from chat: one card each, plus the last action error. */
export function PromptGroup({
  approvals,
  background,
  className,
}: {
  approvals: PodApproval[];
  background?: boolean;
  className?: string;
}) {
  const { busy, actionError } = useStore();
  if (approvals.length === 0) return null;
  return (
    <div className={className}>
      {approvals.map((approval) => (
        <PromptCard key={approval.id} approval={approval} background={background} busy={busy} />
      ))}
      {actionError ? <p className={css.error}>{actionError}</p> : null}
    </div>
  );
}

/** Chat card: the prompts of the session this dock sits in. */
export function ApprovalDock({ sessionId }: { sessionId: string }) {
  useLocale();
  const { state } = useStore();
  React.useEffect(() => store.dock(sessionId), [sessionId]);
  const mine = state === null ? [] : state.approvals.filter((approval) => approval.agent_id === sessionId);
  return <PromptGroup approvals={mine} className={css.dockGroup} />;
}

/** Frame-wide popup: prompts of sessions that are not on screen. */
export function ApprovalPopup() {
  useLocale();
  const { state, docked } = useStore();
  const away =
    state === null
      ? []
      : state.approvals.filter((approval) => approval.agent_id !== null && !docked.includes(approval.agent_id));
  return <PromptGroup approvals={away} background={true} className={css.popupGroup} />;
}

/** Panel list of the same requests, answerable in place. */
export function ApprovalList({ approvals, busy }: { approvals: PodApproval[]; busy: boolean }) {
  if (approvals.length === 0) return <Empty>{t("nothingWaiting")}</Empty>;
  return (
    <ul className={css.list}>
      {approvals.map((approval) => (
        <li key={approval.id} className={css.item}>
          <div className={css.itemMain}>
            <div className={css.itemTitle}>
              <span className={`${css.tool} ${ui.mono}`}>{approval.tool}</span>
              <Tag tone={"outline"}>{short(approval.task_id)}</Tag>
            </div>
            <div className={css.meta}>
              {t("from") + approval.from}
              <ChainBadge chain={approval.chain} />
            </div>
          </div>
          <div className={css.itemActions}>
            <Button variant={"primary"} size={"sm"} disabled={busy} onClick={() => answer("approve", approval)}>
              {t("approve")}
            </Button>
            <Button
              variant={"outline"}
              size={"sm"}
              className={ui.danger}
              disabled={busy}
              onClick={() => answer("deny", approval)}
            >
              {t("deny")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
