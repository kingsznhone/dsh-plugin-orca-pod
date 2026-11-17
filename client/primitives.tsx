/** Panel building blocks on top of DSH's shared primitives: cards, tables, fact lists, dialogs. */

import { Modal, StateDot, Tag } from "@deepseek-ai/dsh-client-ui-primitives";
import React, { type ReactNode } from "react";
import { ageOf, stateDot, stateLabel } from "./format.ts";
import { t } from "./i18n.ts";
import { store } from "./store.ts";
import type { ModelOffer, ModelSelection, PodArtifact } from "./types.ts";
import ui from "./ui.module.css";

/** `provider/model`: how a model route is written everywhere in the panel. */
export const modelId = (model: ModelSelection | ModelOffer): string => `${model.provider}/${model.model}`;

/** A model route with its reasoning effort, when it carries one. */
export const modelText = (model: ModelSelection): string =>
  `${modelId(model)}${model.reasoning_effort ? ` · ${model.reasoning_effort}` : ""}`;

export const stop = (handler: () => void) => (event: React.SyntheticEvent) => {
  event.stopPropagation();
  handler();
};

/** A DSH dialog sized for detail views; its body scrolls, the header stays put. */
export function Dialog({
  title,
  wide,
  footer,
  onClose,
  children,
}: {
  title: string;
  wide?: boolean;
  footer?: ReactNode;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <Modal
      open={true}
      title={title}
      closeLabel={t("close")}
      onClose={onClose}
      className={wide ? ui.dialogWide : ui.dialog}
      contentClassName={ui.dialogContent}
      footer={footer}
    >
      {children}
    </Modal>
  );
}

/** A titled card; `count` shows as a badge after the title, `action` sits on the right. */
export function Section({
  title,
  count,
  action,
  children,
}: {
  title: string;
  count?: number;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section className={ui.card}>
      <div className={ui.cardHead}>
        <h3 className={ui.cardTitle}>
          <span className={ui.inline}>
            {title}
            {count ? <Tag tone={"neutral"}>{count}</Tag> : null}
          </span>
        </h3>
        {action ? <div className={ui.cardAction}>{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** Placeholder line for a card with nothing to show. */
export const Empty = ({ children }: { children?: ReactNode }) => <p className={ui.empty}>{children}</p>;

/** A state as a DSH status dot and its label. */
export const StateText = ({ state }: { state: string }) => (
  <span className={ui.inline}>
    <StateDot state={stateDot(state)} size={stateDot(state) === "ongoing" ? 12 : 10} />
    {stateLabel(state)}
  </span>
);

export function Table({ columns, children }: { columns: string[]; children?: ReactNode }) {
  return (
    <div className={ui.tableWrap}>
      <table className={ui.table}>
        <thead>
          <tr>
            {columns.map((title, index) => (
              <th key={index} scope={"col"}>
                {title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

/** Clickable table row; buttons and links inside stop the click from reaching it. */
export const Row = ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => (
  <tr onClick={onClick} className={onClick ? ui.clickable : undefined}>
    {children}
  </tr>
);

/** Label/value pairs of a detail dialog; `null` values are skipped. */
export function Facts({ rows }: { rows: Array<[string, ReactNode] | null | false> }) {
  return (
    <dl className={ui.facts}>
      {rows.map((row) =>
        row ? (
          <React.Fragment key={row[0]}>
            <dt>{row[0]}</dt>
            <dd>{row[1]}</dd>
          </React.Fragment>
        ) : null,
      )}
    </dl>
  );
}

export const SubTitle = ({ children }: { children?: ReactNode }) => <h4 className={ui.subTitle}>{children}</h4>;

/** "updated Ns ago", measured from the last successful poll and ticking every second. */
export function Updated() {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <span className={ui.caption}>{t("updated") + ageOf(store.polledAt()) + t("updatedSuffix")}</span>;
}

/** Links to a task's artifacts; one this node cannot sign for is shown as plain text. */
export function ArtifactLinks({ artifacts }: { artifacts: PodArtifact[] }) {
  return artifacts.map((link) =>
    link.url ? (
      <a key={link.blob_id} href={link.url} target={"_blank"} rel={"noreferrer"} className={ui.link}>
        {link.name}
      </a>
    ) : (
      <span key={link.blob_id} className={ui.tertiary}>
        {link.name}
      </span>
    ),
  );
}
