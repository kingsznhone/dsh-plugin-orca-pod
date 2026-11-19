/** Task tables and the task detail dialog. */

import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import React, { type ReactNode } from "react";
import { age, short } from "./format.ts";
import { t } from "./i18n.ts";
import { Dialog, Empty, Facts, Row, StateText, SubTitle, Table, modelText, stop } from "./primitives.tsx";
import { store, useRead, useStore } from "./store.ts";
import type { PodTaskDetail, PodTaskRow } from "./types.ts";
import ui from "./ui.module.css";

/** Recent or all tasks: rows arrive merged, sorted and labelled by the host. */
export function TaskTable({
  rows,
  busy,
  onOpen,
  onCancel,
}: {
  rows: PodTaskRow[];
  busy: boolean;
  onOpen: (row: PodTaskRow) => void;
  onCancel: (row: PodTaskRow) => void;
}) {
  if (rows.length === 0) return <Empty>{t("noTasks")}</Empty>;
  const columns = [t("colTask"), t("colState"), t("colOrigin"), t("colAge"), ""];
  return (
    <Table columns={columns}>
      {rows.map((row) => (
        <Row key={row.id} onClick={() => onOpen(row)}>
          <td>
            <button
              type={"button"}
              className={`${ui.rowLink} ${ui.mono}`}
              title={`${t("details")} · ${row.id}`}
              onClick={stop(() => onOpen(row))}
            >
              {short(row.id)}
            </button>
          </td>
          <td>
            <StateText state={row.state} />
          </td>
          <td className={ui.muted} title={row.who_title}>
            {row.who}
          </td>
          <td className={ui.tertiary}>{age(row.at)}</td>
          <td className={ui.end}>
            {row.cancellable ? (
              <Button
                variant={"outline"}
                size={"sm"}
                className={ui.danger}
                disabled={busy}
                onClick={stop(() => onCancel(row))}
              >
                {t("cancel")}
              </Button>
            ) : null}
          </td>
        </Row>
      ))}
    </Table>
  );
}

/** What the detail dialog shows once the task is loaded. */
function TaskFacts({ data }: { data: PodTaskDetail }) {
  const { task, origin, dispatch } = data;
  const pod = task.metadata?.pod ?? {};
  const message = (task.status.message?.parts ?? [])
    .map((part) => (part.kind === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
  return (
    <>
      <Facts
        rows={[
          [t("colState"), <StateText key={"state"} state={task.status.state} />],
          [t("dtOrigin"), origin],
          [t("dtContext"), <span className={ui.mono}>{task.contextId}</span>],
          [t("dtUpdated"), task.status.timestamp],
          !!task.status.reason && [t("dtReason"), task.status.reason],
          !!pod.model && [t("dtModel"), modelText(pod.model)],
          !!message && [t("dtMessage"), message],
        ]}
      />
      <SubTitle>{t("dtDispatch")}</SubTitle>
      {dispatch === null ? (
        <Empty>{t("dtDispatchNone")}</Empty>
      ) : (
        <Facts
          rows={[
            [
              t("dtPeer"),
              <span key={"peer"} className={ui.mono} title={dispatch.node}>
                {short(dispatch.node)}
              </span>,
            ],
            [t("colState"), <StateText key={"state"} state={dispatch.state} />],
            [t("dtCreated"), dispatch.created_at],
            [t("dtUpdated"), dispatch.updated_at],
            !!dispatch.last_error && [t("dtLastError"), <span className={ui.error}>{dispatch.last_error}</span>],
          ]}
        />
      )}
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
  if (result.error !== null) return <p className={ui.error}>{t("dtLoadFailed") + result.error}</p>;
  if (result.data === null) return <Empty>{t("tasksLoading")}</Empty>;
  return render(result.data);
}

/** Task detail: one `/task` call returns the task and its dispatch record. */
export function TaskDetail({ peer, taskId, onClose }: { peer: string; taskId: string; onClose: () => void }) {
  const result = useRead("task", { peer, task: taskId });
  return (
    <Dialog title={t("dtTitle")} onClose={onClose}>
      <p className={`${ui.idLine} ${ui.mono}`}>{taskId}</p>
      <Loaded result={result} render={(data) => <TaskFacts data={data} />} />
    </Dialog>
  );
}

export function AllTasks({ onOpen, onClose }: { onOpen: (row: PodTaskRow) => void; onClose: () => void }) {
  const { busy } = useStore();
  const [version, setVersion] = React.useState(0);
  const result = useRead("tasks", {}, version);
  async function cancel(row: PodTaskRow) {
    if (await store.act("cancel", { peer: row.peer, task_id: row.id })) setVersion(version + 1);
  }
  return (
    <Dialog title={t("allTasks")} wide={true} onClose={onClose}>
      <Loaded
        result={result}
        render={(rows) => <TaskTable rows={rows} busy={busy} onOpen={onOpen} onCancel={cancel} />}
      />
    </Dialog>
  );
}
