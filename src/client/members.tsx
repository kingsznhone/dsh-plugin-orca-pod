/** Mesh members, the node detail dialog and the workspace summary. */

import {
  IconChevronRightOutlineRegular,
  IconWarningOutlineRegular,
  StateDot,
  Tag,
  fileSizeText,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { age, short, stateDot, stateLabel } from "./format.ts";
import { t } from "./i18n.ts";
import panel from "./panel.module.css";
import { Dialog, Empty, Facts, StateText, SubTitle, modelId, modelText } from "./primitives.tsx";
import type { PodPeer, RuntimeInfo } from "./types.ts";
import ui from "./ui.module.css";

export function Members({ members, onOpen }: { members: PodPeer[]; onOpen: (member: PodPeer) => void }) {
  if (members.length === 0) return <Empty>{t("noPeers")}</Empty>;
  return (
    <ul className={panel.members}>
      {members.map((member) => (
        <li key={member.orca_node_id}>
          <button
            type={"button"}
            className={panel.member}
            title={[member.orca_node_id, stateLabel(member.state), member.unreachable ? t("blocked") : null]
              .filter(Boolean)
              .join(" · ")}
            onClick={() => onOpen(member)}
          >
            <StateDot state={stateDot(member.state)} />
            <span className={panel.memberMain}>
              <span className={panel.memberName}>{member.display_name}</span>
              <span className={panel.memberSub}>
                {member.default_model ? modelId(member.default_model) : stateLabel(member.state)}
              </span>
            </span>
            {member.unreachable ? <Tag tone={"warning"}>{t("blocked")}</Tag> : null}
            {member.busy ? <Tag tone={"info"}>{t("busy")}</Tag> : null}
            <IconChevronRightOutlineRegular size={14} className={panel.chevron} />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The host facts a node advertised at join. */
const runtimeRows = (runtime: RuntimeInfo): Array<[string, string]> => [
  [t("colOs"), `${[runtime.os.name, runtime.os.version].join(" ")} · ${runtime.os.family}`],
  ["cpu", `${runtime.cpu.model} · ${runtime.cpu.logical_cores} ${t("ndCores")}`],
  [t("ndMemory"), fileSizeText(runtime.memory.total_bytes)],
  ["node", `node ${runtime.node.version} · ${runtime.arch}`],
];

/** The default route, then every model route a node offers with the names the provider catalog gave them. */
function ModelList({ member }: { member: PodPeer }) {
  const models = member.models ?? [];
  return (
    <>
      <Facts
        rows={[
          [t("ndDefaultModel"), member.default_model ? modelText(member.default_model) : "-"],
          ...models.map((model): [string, string] => [
            modelId(model),
            [model.name, model.description].filter(Boolean).join(" · ") || "-",
          ]),
        ]}
      />
      {models.length === 0 ? <Empty>{t("ndNoModels")}</Empty> : null}
    </>
  );
}

export function NodeDetail({ member, onClose }: { member: PodPeer; onClose: () => void }) {
  const { runtime } = member;
  return (
    <Dialog title={t("ndTitle")} onClose={onClose}>
      <p className={`${ui.idLine} ${ui.mono}`}>{member.orca_node_id}</p>
      {member.unreachable ? (
        <p className={panel.alert} data-tone={"warning"}>
          <IconWarningOutlineRegular size={14} />
          {t("blockedHint")}
        </p>
      ) : null}
      <Facts
        rows={[
          [t("colNode"), member.display_name],
          [
            t("colState"),
            <span key={"state"} className={ui.inline}>
              <StateText state={member.state} />
              {member.unreachable ? ` · ${t("blocked")}` : null}
            </span>,
          ],
          [
            t("colBusy"),
            member.busy ? `${short(member.busy.task_id)} · ${t("busyOrigin")}${member.busy_from}` : t("idle"),
          ],
          [t("ndLastSeen"), member.last_recv_at ? age(member.last_recv_at) : "-"],
          [t("ndBudget"), member.max_task_ttl_s ? `${member.max_task_ttl_s} s` : "-"],
        ]}
      />
      <SubTitle>{t("ndRuntime")}</SubTitle>
      {runtime === null ? <Empty>{"-"}</Empty> : <Facts rows={runtimeRows(runtime)} />}
      <SubTitle>{t("ndModels")}</SubTitle>
      <ModelList member={member} />
      <SubTitle>{t("colEndpoints")}</SubTitle>
      <div className={`${ui.chips} ${ui.mono} ${ui.muted}`}>
        {member.endpoints.map((url) => (
          <span key={url}>{url}</span>
        ))}
      </div>
    </Dialog>
  );
}

export function Workspace({ root }: { root: string | null }) {
  if (root === null) return <Empty>{t("workspaceUnavailable")}</Empty>;
  return (
    <div className={panel.workspace}>
      <div className={`${panel.path} ${ui.mono}`} title={root}>
        {root}
      </div>
    </div>
  );
}
