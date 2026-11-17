/** Task tables and the task detail dialog. */

import React, { type ReactNode } from "react";
import { t } from "./i18n.ts";
import type { PodTaskDetail, PodTasksResponse, PodTaskRow } from "./types.ts";
import { ArtifactLinks, Button, Fact, Modal, Row, Table, modelText, stop } from "./primitives.tsx";
import { store, useApi, useStore } from "./store.ts";
import { CELL, DANGER, ERROR, H2, MONO_FONT, MUTED, age, short, stateLabel } from "./styles.ts";

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
              <ArtifactLinks artifacts={row.artifacts} />
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
/** What the detail dialog shows once the task is loaded. */
function TaskFacts({ data }: { data: PodTaskDetail }) {
  const { task, origin, dispatch, artifacts, inputs } = data;
  const pod = task.metadata?.pod ?? {};
  const message = (task.status.message?.parts ?? [])
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <Fact label={t("colState")}>{stateLabel(task.status.state)}</Fact>
      <Fact label={t("dtOrigin")}>{origin}</Fact>
      <Fact label={t("dtContext")}>{task.contextId}</Fact>
      <Fact label={t("dtUpdated")}>{task.status.timestamp}</Fact>
      {task.status.reason ? <Fact label={t("dtReason")}>{task.status.reason}</Fact> : null}
      {pod.model ? <Fact label={t("dtModel")}>{modelText(pod.model)}</Fact> : null}
      {pod.hop === undefined ? null : (
        <Fact label={t("dtTimeline")}>{`hop ${pod.hop}${pod.root ? ` · root ${short(pod.root)}` : ""}`}</Fact>
      )}
      {message ? <Fact label={t("dtMessage")}>{message}</Fact> : null}
      <div style={{ ...H2, marginTop: 16 }}>{t("dtDispatch")}</div>
      {dispatch === null ? (
        <div style={MUTED}>{t("dtDispatchNone")}</div>
      ) : (
        <>
          <Fact label={t("dtPeer")}>{dispatch.peer}</Fact>
          <Fact label={t("colState")}>{stateLabel(dispatch.state)}</Fact>
          <Fact label={t("dtCreated")}>{dispatch.created_at}</Fact>
          <Fact label={t("dtUpdated")}>{dispatch.updated_at}</Fact>
          {dispatch.parent_local_task_id ? (
            <Fact label={t("dtTimeline")}>{short(dispatch.parent_local_task_id)}</Fact>
          ) : null}
          {dispatch.last_error ? <Fact label={t("dtLastError")}>{dispatch.last_error}</Fact> : null}
        </>
      )}
      <div style={{ ...H2, marginTop: 16 }}>{t("dtArtifacts")}</div>
      <div style={{ marginTop: 6 }}>
        {artifacts.length === 0 ? (
          <span style={MUTED}>{t("dtArtifactsNone")}</span>
        ) : (
          <ArtifactLinks artifacts={artifacts} block={true} />
        )}
      </div>
      <div style={{ ...H2, marginTop: 16 }}>{t("dtInputs")}</div>
      <div style={{ marginTop: 6 }}>
        {inputs.length === 0 ? (
          <span style={MUTED}>{t("dtInputsNone")}</span>
        ) : (
          inputs.map((name) => (
            <span key={name} style={{ ...MUTED, marginRight: 10, fontFamily: MONO_FONT }}>
              {name}
            </span>
          ))
        )}
      </div>
    </>
  );
}

/** A view fetched from the host: loading text, the failure, or what `render` makes of the data. */
function Loaded<T>({
  result,
  render,
}: {
  result: { data: T | null; error: string | null };
  render: (data: T) => ReactNode;
}) {
  if (result.error !== null) return <div style={ERROR}>{t("dtLoadFailed") + result.error}</div>;
  if (result.data === null) return <div style={MUTED}>{t("tasksLoading")}</div>;
  return render(result.data);
}

/** Task detail: one `/task` call returns the task, its dispatch record, artifacts and inputs. */
export function TaskDetail({ peer, taskId, onClose }: { peer: string; taskId: string; onClose: () => void }) {
  const result = useApi<PodTaskDetail>(`task?peer=${encodeURIComponent(peer)}&task=${encodeURIComponent(taskId)}`);
  return (
    <Modal label={t("dtTitle")} width={"min(680px, calc(100vw - 40px))"} onClose={onClose}>
      <div style={{ ...H2, marginBottom: 6 }}>{t("dtTitle")}</div>
      <div style={{ ...MUTED, fontFamily: MONO_FONT, wordBreak: "break-all", marginBottom: 8 }}>{taskId}</div>
      <Loaded result={result} render={(data) => <TaskFacts data={data} />} />
    </Modal>
  );
}

export function AllTasks({ onOpen, onClose }: { onOpen: (row: PodTaskRow) => void; onClose: () => void }) {
  const { busy } = useStore();
  const [version, setVersion] = React.useState(0);
  const result = useApi<PodTasksResponse>("tasks?limit=500", version);
  async function cancel(row: PodTaskRow) {
    if (await store.act("cancel", { peer: row.peer, task_id: row.id })) setVersion(version + 1);
  }
  return (
    <Modal label={t("allTasks")} width={"min(1040px, calc(100vw - 40px))"} onClose={onClose}>
      <div style={{ ...H2, marginBottom: 10 }}>{t("allTasks")}</div>
      <Loaded
        result={result}
        render={({ recent }) => (
          <TaskTable rows={recent} showArtifacts={true} busy={busy} onOpen={onOpen} onCancel={cancel} />
        )}
      />
    </Modal>
  );
}
