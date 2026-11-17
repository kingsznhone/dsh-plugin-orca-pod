/** Small building blocks every view uses: buttons, dialogs, tables, labelled fields. */

import React, { type ReactNode } from "react";
import { t } from "./i18n.ts";
import { store } from "./store.ts";
import type { ModelOffer, ModelSelection, PodArtifact } from "./types.ts";
import {
  BUTTON,
  CARD,
  CLOSE_BUTTON,
  FACT,
  FIELD,
  H2,
  HINT,
  LABEL,
  LINK,
  MUTED,
  OVERLAY,
  SECTION,
  ageOf,
} from "./styles.ts";

/** `provider/model`: how a model route is written everywhere in the panel. */
export const modelId = (model: ModelSelection | ModelOffer): string => `${model.provider}/${model.model}`;

/** A model route with its reasoning effort, when it carries one. */
export const modelText = (model: ModelSelection): string =>
  `${modelId(model)}${model.reasoning_effort ? ` · ${model.reasoning_effort}` : ""}`;

export const Button = ({ style = BUTTON, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
  <button type={"button"} style={style} {...props} />
);
/** Centered dialog: role, Escape, backdrop click, initial focus and focus return. */
export function Modal({
  label,
  width = "min(720px, calc(100vw - 48px))",
  onClose,
  children,
}: {
  label: string;
  width?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  const card = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    card.current?.focus();
    return () => opener?.focus?.();
  }, []);
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes; the dialog itself handles Escape.
    <div style={OVERLAY} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        ref={card}
        role={"dialog"}
        aria-modal={"true"}
        aria-label={label}
        tabIndex={-1}
        style={{ ...CARD, width, outline: "none" }}
        onKeyDown={(event) => event.key === "Escape" && onClose()}
      >
        <Button style={CLOSE_BUTTON} title={t("close")} aria-label={t("close")} onClick={onClose}>
          {"×"}
        </Button>
        {children}
      </div>
    </div>
  );
}
export function Table({ columns, children }: { columns: string[]; children?: ReactNode }) {
  return (
    <table style={{ borderCollapse: "collapse", width: "100%" }}>
      <thead>
        <tr>
          {columns.map((title, index) => (
            <th key={index} scope={"col"} style={{ ...MUTED, textAlign: "left", fontWeight: 500 }}>
              {title}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}
/** Clickable table row; buttons inside stop the click from reaching it. */
export const Row = ({ onClick, children }: { onClick?: () => void; children?: ReactNode }) => (
  <tr onClick={onClick} style={onClick ? { cursor: "pointer" } : undefined}>
    {children}
  </tr>
);
export const stop = (handler: () => void) => (event: React.SyntheticEvent) => {
  event.stopPropagation();
  handler();
};
/** One label/value line of a detail dialog. */
export const Fact = ({ label, children }: { label: string; children?: ReactNode }) => (
  <div style={FACT}>
    <div style={{ ...MUTED, minWidth: 72 }}>{label}</div>
    <div style={{ flex: 1, minWidth: 0, wordBreak: "break-word" }}>{children}</div>
  </div>
);
/** One labelled form control (a `<label>` unless it holds several controls). */
export function Field({
  label,
  hint,
  group,
  children,
}: {
  label: string;
  hint?: string | null;
  group?: boolean;
  children?: ReactNode;
}) {
  const Tag = group ? "div" : "label";
  return (
    <Tag style={FIELD}>
      <span style={LABEL}>{label}</span>
      {children}
      {hint ? <div style={HINT}>{hint}</div> : null}
    </Tag>
  );
}
export const Section = ({ title, action, children }: { title: string; action?: ReactNode; children?: ReactNode }) => (
  <div style={SECTION}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <div style={H2}>{title}</div>
      <div style={{ flex: 1 }} />
      {action}
    </div>
    {children}
  </div>
);
/** "updated Ns ago", measured from the last successful poll and ticking every second. */
export function Updated() {
  const [, tick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return <div style={{ ...HINT, marginTop: 22 }}>{t("updated") + ageOf(store.polledAt()) + t("updatedSuffix")}</div>;
}

/** Links to a task's artifacts; one this node cannot sign for is shown as plain text. */
export function ArtifactLinks({ artifacts, block }: { artifacts: PodArtifact[]; block?: boolean }) {
  return artifacts.map((link) =>
    link.url ? (
      <a key={link.blob_id} href={link.url} target={"_blank"} rel={"noreferrer"} style={LINK}>
        {link.name}
      </a>
    ) : (
      <span key={link.blob_id} style={{ ...MUTED, marginRight: 10, ...(block ? { display: "inline-block" } : {}) }}>
        {link.name}
      </span>
    ),
  );
}
