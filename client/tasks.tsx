/** Task tables and the task detail dialog. */

import React, { type ReactNode } from "react";
import { t } from "./i18n.ts";
import type { PodTaskMetadata } from "../src/protocol.ts";
import type { PodTaskDetail, PodTaskRow } from "./types.ts";
import { Button, Fact, Modal, Row, Table, stop } from "./primitives.tsx";
import { store, useApi, useStore } from "./store.ts";
import { CELL, DANGER, ERROR, H2, LINK, MONO_FONT, MUTED, age, short, stateLabel } from "./styles.ts";

/** Recent or all tasks: rows arrive merged, sorted and labelled by the host. */
export function TaskTable({
  rows,
  showArtifacts,
  busy,
  onOpen,
  onCancel,
}: {
  rows: PodTaskRow[];
  showArtifacts?: boolean;
  busy: boolean;
  onOpen: (row: PodTaskRow) => void;
  onCancel: (row: PodTaskRow) => void;
}) {
  if (rows.length === 0) return <div style={MUTED}>{t("noTasks")}</div>;
  const columns = [
    t("colTask"),
    t("colState"),
    t("colOrigin"),
    t("colAge"),
    ...(showArtifacts ? [t("colArtifacts")] : []),
    "",
  ];
  return (
    <Table columns={columns}>
      {rows.map((row) => (
        <Row key={row.id} onClick={() => onOpen(row)}>
          <td style={{ ...CELL, fontFamily: MONO_FONT }}>{short(row.id)}</td>
          <td style={CELL}>{stateLabel(row.state)}</td>
          <td style={MUTED} title={row.who_title}>
            {row.who}
          </td>
          <td style={MUTED}>{age(row.at)}</td>
          {showArtifacts ? (
            // biome-ignore lint/a11y/useKeyWithClickEvents: only keeps a link click from also opening the row.
            <td style={CELL} onClick={(event) => event.stopPropagation()}>
              {row.artifacts.map((link) =>
                link.url ? (
                  <a key={link.blob_id} href={link.url} target={"_blank"} rel={"noreferrer"} style={LINK}>
                    {link.name}
                  </a>
                ) : (
                  <span key={link.blob_id} style={{ ...MUTED, marginRight: 10 }}>
                    {link.name}
                  </span>
                ),
              )}
            </td>
          ) : null}
          <td style={CELL}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <Button onClick={stop(() => onOpen(row))}>{t("details")}</Button>
              {row.cancellable ? (
                <Button style={DANGER} disabled={busy} onClick={stop(() => onCancel(row))}>
                  {t("cancel")}
                </Button>
              ) : null}
            </div>
          </td>
        </Row>
      ))}
    </Table>
  );
}
/** Task detail: one `/task` call returns the task, its dispatch record, artifacts and inputs. */
export function TaskDetail({ peer, taskId, onClose }: { peer: string; taskId: string; onClose: () => void }) {
  const { data, error } = useApi<PodTaskDetail>(
    `task?peer=${encodeURIComponent(peer)}&task=${encodeURIComponent(taskId)}`,
  );
  let body: ReactNode = <div style={MUTED}>{t("tasksLoading")}</div>;
  if (error !== null) body = <div style={ERROR}>{t("dtLoadFailed") + error}</div>;
  if (data !== null) {
    const { task, origin, dispatch, artifacts, inputs } = data;
    const pod = (task.metadata?.pod ?? {}) as PodTaskMetadata;
    const message = (task.status.message?.parts ?? [])
      .map((part) => (part.kind === "text" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
    body = [
      <Fact key={"state"} label={t("colState")}>
        {stateLabel(task.status.state)}
      </Fact>,
      <Fact key={"origin"} label={t("dtOrigin")}>
        {origin}
      </Fact>,
      <Fact key={"context"} label={t("dtContext")}>
        {task.contextId}
      </Fact>,
      <Fact key={"updated"} label={t("dtUpdated")}>
        {task.status.timestamp}
      </Fact>,
      task.status.reason ? (
        <Fact key={"reason"} label={t("dtReason")}>
          {task.status.reason}
        </Fact>
      ) : null,
      pod.model ? (
        <Fact key={"model"} label={t("dtModel")}>
          {pod.model.provider +
            "/" +
            pod.model.model +
            (pod.model.reasoning_effort ? ` · ${pod.model.reasoning_effort}` : "")}
        </Fact>
      ) : null,
      pod.hop === undefined ? null : (
        <Fact
          key={"hop"}
          label={t("dtTimeline")}
        >{`hop ${pod.hop}${pod.root ? ` · root ${short(pod.root)}` : ""}`}</Fact>
      ),
      message ? (
        <Fact key={"message"} label={t("dtMessage")}>
          {message}
        </Fact>
      ) : null,
      <div key={"dispatch-title"} style={{ ...H2, marginTop: 16 }}>
        {t("dtDispatch")}
      </div>,
      dispatch === null ? (
        <div key={"dispatch"} style={MUTED}>
          {t("dtDispatchNone")}
        </div>
      ) : (
        <React.Fragment key={"dispatch"}>
          <Fact label={t("dtPeer")}>{dispatch.peer}</Fact>
          <Fact label={t("colState")}>{stateLabel(dispatch.state)}</Fact>
          <Fact label={t("dtCreated")}>{dispatch.created_at}</Fact>
          <Fact label={t("dtUpdated")}>{dispatch.updated_at}</Fact>
          {dispatch.parent_local_task_id ? (
            <Fact label={t("dtTimeline")}>{short(dispatch.parent_local_task_id)}</Fact>
          ) : null}
          {dispatch.last_error ? <Fact label={t("dtLastError")}>{dispatch.last_error}</Fact> : null}
        </React.Fragment>
      ),
      <div key={"artifacts-title"} style={{ ...H2, marginTop: 16 }}>
        {t("dtArtifacts")}
      </div>,
      <div key={"artifacts"} style={{ marginTop: 6 }}>
        {artifacts.length === 0 ? (
          <span style={MUTED}>{t("dtArtifactsNone")}</span>
        ) : (
          artifacts.map((link) =>
            link.url ? (
              <a key={link.blob_id} href={link.url} target={"_blank"} rel={"noreferrer"} style={LINK}>
                {link.name}
              </a>
            ) : (
              <span key={link.blob_id} style={{ ...MUTED, display: "inline-block", marginRight: 10 }}>
                {link.name}
              </span>
            ),
          )
        )}
      </div>,
      <div key={"inputs-title"} style={{ ...H2, marginTop: 16 }}>
        {t("dtInputs")}
      </div>,
      <div key={"inputs"} style={{ marginTop: 6 }}>
        {inputs.length === 0 ? (
          <span style={MUTED}>{t("dtInputsNone")}</span>
        ) : (
          inputs.map((name) => (
            <span key={name} style={{ ...MUTED, marginRight: 10, fontFamily: MONO_FONT }}>
              {name}
            </span>
          ))
        )}
      </div>,
    ];
  }
  return (
    <Modal label={t("dtTitle")} width={"min(680px, calc(100vw - 40px))"} onClose={onClose}>
      <div style={{ ...H2, marginBottom: 6 }}>{t("dtTitle")}</div>
      <div style={{ ...MUTED, fontFamily: MONO_FONT, wordBreak: "break-all", marginBottom: 8 }}>{taskId}</div>
      {body}
    </Modal>
  );
}
export function AllTasks({ onOpen, onClose }: { onOpen: (row: PodTaskRow) => void; onClose: () => void }) {
  const { busy } = useStore();
  const [version, setVersion] = React.useState(0);
  const { data, error } = useApi<{ recent: PodTaskRow[] }>("tasks?limit=500", version);
  async function cancel(row: PodTaskRow) {
    if (await store.act("cancel", { peer: row.peer, task_id: row.id })) setVersion(version + 1);
  }
  let body: ReactNode = <div style={MUTED}>{t("tasksLoading")}</div>;
  if (error !== null) body = <div style={ERROR}>{t("dtLoadFailed") + error}</div>;
  if (data !== null)
    body = <TaskTable rows={data.recent} showArtifacts={true} busy={busy} onOpen={onOpen} onCancel={cancel} />;
  return (
    <Modal label={t("allTasks")} width={"min(1040px, calc(100vw - 40px))"} onClose={onClose}>
      <div style={{ ...H2, marginBottom: 10 }}>{t("allTasks")}</div>
      {body}
    </Modal>
  );
}
