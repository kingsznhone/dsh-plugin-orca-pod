/** The panel: status page, first-run wizard or settings, the sidebar light and the overlay. */

import React, { type ReactNode } from "react";
import { ApprovalList } from "./approvals.tsx";
import { t, useLocale } from "./i18n.ts";
import { Members, NodeDetail, Workspace } from "./members.tsx";
import { Button, Field, Modal, Section, Updated } from "./primitives.tsx";
import { ConfigForm } from "./settings.tsx";
import { type Snapshot, store, useStore } from "./store.ts";
import { ERROR, FOOTER_ACTION, H2, ICON_BUTTON, INPUT, MUTED, PRIMARY, SECTION, TITLE, short } from "./styles.ts";
import { AllTasks, TaskDetail, TaskTable } from "./tasks.tsx";
import type { PodPeer, PodState, PodTaskRow } from "./types.ts";

export function StatusPage({
  snap,
  state,
  onOpenSettings,
}: {
  snap: Snapshot;
  state: PodState;
  onOpenSettings: () => void;
}) {
  const { busy } = snap;
  const { self, config, members, mesh, approvals, recent, workspace } = state;
  const [connectOpen, setConnectOpen] = React.useState(false);
  const [host, setHost] = React.useState("");
  const [task, setTask] = React.useState<PodTaskRow | null>(null);
  const [node, setNode] = React.useState<PodPeer | null>(null);
  const [allOpen, setAllOpen] = React.useState(false);
  // The header button reflects the live mesh, not the remembered peer list.
  const joined = mesh.reachable > 0;
  const error = snap.error ?? snap.actionError ?? config.error;
  const cancel = (row: PodTaskRow) => store.act("cancel", { peer: row.peer, task_id: row.id });
  async function connect() {
    if (await store.act("connect", { peer: host.trim() })) {
      setConnectOpen(false);
      setHost("");
    }
  }
  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, paddingRight: 26 }}>
        <div style={TITLE}>{t("nav")}</div>
        <div style={{ flex: 1 }} />
        {joined ? (
          <Button disabled={busy} onClick={() => store.act("disconnect", {})}>
            {t("disconnect")}
          </Button>
        ) : (
          <Button style={PRIMARY} disabled={busy} onClick={() => setConnectOpen(!connectOpen)}>
            {connectOpen ? t("cancel") : t("connect")}
          </Button>
        )}
        <Button style={ICON_BUTTON} title={t("settings")} aria-label={t("settings")} onClick={onOpenSettings}>
          {"⚙"}
        </Button>
      </div>
      <div
        style={{ ...MUTED, marginTop: 2 }}
        title={self ? self.orca_node_id : undefined}
      >{`${self ? self.display_name : t("nodeNotRunning")} @ ${config.workgroup_id || "-"}`}</div>
      {self?.busy ? (
        <div
          style={{ ...MUTED, marginTop: 2, color: "var(--dsw-alias-brand-primary)" }}
          title={self.busy.task_id}
        >{`${t("busy")} · ${short(self.busy.task_id)} · ${t("busyOrigin")}${self.busy_from}`}</div>
      ) : null}
      {error ? <div style={{ ...ERROR, marginTop: 8 }}>{error}</div> : null}
      {joined ? null : <div style={{ ...MUTED, marginTop: 6 }}>{t("notJoined")}</div>}
      {!joined && connectOpen ? (
        <div style={SECTION}>
          <div style={H2}>{t("connectPeer")}</div>
          <Field label={t("host")}>
            <input
              style={INPUT}
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder={"192.168.1.12 / peer.example.com / http://host:11811"}
            />
          </Field>
          <div style={{ display: "flex", gap: 8 }}>
            <Button style={PRIMARY} disabled={busy || host.trim() === ""} onClick={connect}>
              {t("connect")}
            </Button>
            <Button disabled={busy} onClick={() => setConnectOpen(false)}>
              {t("cancel")}
            </Button>
          </div>
        </div>
      ) : null}
      <Section title={t("pendingApprovals")}>
        <ApprovalList approvals={approvals} busy={busy} />
      </Section>
      <Section title={t("recentTasks")} action={<Button onClick={() => setAllOpen(true)}>{t("allTasks")}</Button>}>
        <TaskTable rows={recent} showArtifacts={false} busy={busy} onOpen={setTask} onCancel={cancel} />
      </Section>
      <Section title={t("members")}>
        <Members members={members} onOpen={setNode} />
      </Section>
      <Section title={t("workspace")}>
        <Workspace workspace={workspace} />
      </Section>
      <Updated />
      {allOpen ? <AllTasks onOpen={setTask} onClose={() => setAllOpen(false)} /> : null}
      {task ? <TaskDetail peer={task.peer} taskId={task.id} onClose={() => setTask(null)} /> : null}
      {node ? <NodeDetail member={node} onClose={() => setNode(null)} /> : null}
    </div>
  );
}
/** The panel body: first-run wizard, status page or settings form. */
export function Panel() {
  useLocale();
  const snap = useStore();
  const [view, setView] = React.useState<"status" | "settings">("status");
  if (snap.state === null)
    return <div style={{ padding: "4px 0", ...MUTED }}>{snap.error ? `orca-pod: ${snap.error}` : t("connecting")}</div>;
  const { config } = snap.state;
  const toStatus = () => setView("status");
  let content: ReactNode = <StatusPage snap={snap} state={snap.state} onOpenSettings={() => setView("settings")} />;
  if (!config.configured) content = <ConfigForm key={"wizard"} config={config} wizard={true} onDone={toStatus} />;
  else if (view === "settings")
    content = <ConfigForm key={"settings"} config={config} wizard={false} onDone={toStatus} />;
  return <div style={{ minWidth: 0 }}>{content}</div>;
}
/** Sidebar-foot status light: green with reachable peers, amber while a decision waits. */
export function SidebarAction({ wide }: { wide?: boolean }) {
  useLocale();
  const { state, panelOpen } = useStore();
  const pending = state === null ? 0 : state.approval_count;
  const reachable = state === null ? 0 : state.mesh.reachable;
  const color =
    pending > 0
      ? "var(--dsw-alias-state-warn-primary)"
      : reachable > 0
        ? "var(--dsw-alias-state-success-primary)"
        : "var(--dsw-alias-label-secondary)";
  return (
    <Button
      style={{ ...FOOTER_ACTION, color }}
      title={pending > 0 ? `${t("nav")} · ${pending} ${t("pendingApprovals")}` : t("nav")}
      onClick={() => store.setPanelOpen(!panelOpen)}
    >
      <span style={{ fontSize: 16, lineHeight: 1 }}>{"◈"}</span>
      {wide === false ? null : <span>{t("nav")}</span>}
    </Button>
  );
}
export function OverlayPanel() {
  useLocale();
  const { panelOpen } = useStore();
  return panelOpen ? (
    <Modal label={t("nav")} onClose={() => store.setPanelOpen(false)}>
      <Panel />
    </Modal>
  ) : null;
}
