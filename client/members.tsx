/** Mesh members, the node detail dialog and the workspace summary. */

import { GIB } from "./constants.ts";
import type { ModelSelection, PodPeer, WorkspaceView } from "./types.ts";
import { t } from "./i18n.ts";
import { Button, Fact, Modal, Row, Table, stop } from "./primitives.tsx";
import { CELL, H2, MONO_FONT, MUTED, STATE_COLOR, age, short, stateLabel } from "./styles.ts";

export function Members({ members, onOpen }: { members: PodPeer[]; onOpen: (member: PodPeer) => void }) {
  if (members.length === 0) return <div style={MUTED}>{t("noPeers")}</div>;
  return (
    <Table columns={[t("colNode"), t("colBusy"), t("colModel"), ""]}>
      {members.map((member) => (
        <Row key={member.orca_node_id} onClick={() => onOpen(member)}>
          <td
            style={{
              ...CELL,
              color: member.state === "suspect" ? STATE_COLOR[member.state] : undefined,
            }}
            title={`${member.orca_node_id} · ${stateLabel(member.state)}`}
          >
            {member.display_name}
          </td>
          <td style={CELL} title={member.busy ? `${member.busy.task_id} · ${member.busy_from}` : undefined}>
            {member.busy ? short(member.busy.task_id) : "-"}
          </td>
          <td style={MUTED}>
            {member.default_model ? `${member.default_model.provider}/${member.default_model.model}` : "-"}
          </td>
          <td style={{ ...CELL, textAlign: "right" }}>
            <Button onClick={stop(() => onOpen(member))}>{t("ndOpen")}</Button>
          </td>
        </Row>
      ))}
    </Table>
  );
}
export const modelText = (model: ModelSelection): string =>
  `${model.provider}/${model.model}${model.reasoning_effort ? ` · ${model.reasoning_effort}` : ""}`;
export function NodeDetail({ member, onClose }: { member: PodPeer; onClose: () => void }) {
  const { runtime } = member;
  const models = member.models ?? [];
  return (
    <Modal label={t("ndTitle")} width={"min(620px, calc(100vw - 40px))"} onClose={onClose}>
      <div style={{ ...H2, marginBottom: 6 }}>{t("ndTitle")}</div>
      <Fact label={t("colNode")}>{member.display_name}</Fact>
      <Fact label={t("ndId")}>{member.orca_node_id}</Fact>
      <Fact label={t("colState")}>{stateLabel(member.state)}</Fact>
      <Fact label={t("colBusy")}>
        {member.busy ? `${short(member.busy.task_id)} · ${t("busyOrigin")}${member.busy_from}` : t("idle")}
      </Fact>
      <Fact label={t("ndLastSeen")}>{member.last_recv_at ? age(member.last_recv_at) + t("updatedSuffix") : "-"}</Fact>
      <Fact label={t("ndBudget")}>{member.max_task_ttl_s ? `${member.max_task_ttl_s} s` : "-"}</Fact>
      <div style={{ ...H2, marginTop: 16 }}>{t("ndRuntime")}</div>
      {runtime === null ? (
        <div style={MUTED}>{"-"}</div>
      ) : (
        [
          <Fact
            key={"os"}
            label={t("colOs")}
          >{`${[runtime.os.name, runtime.os.version].join(" ")} · ${runtime.os.family}`}</Fact>,
          <Fact
            key={"cpu"}
            label={"cpu"}
          >{`${runtime.cpu.model} · ${runtime.cpu.logical_cores} ${t("ndCores")}`}</Fact>,
          <Fact key={"memory"} label={t("ndMemory")}>{`${(runtime.memory.total_bytes / GIB).toFixed(1)} GiB`}</Fact>,
          <Fact key={"node"} label={"node"}>{`node ${runtime.node.version} · ${runtime.arch}`}</Fact>,
        ]
      )}
      <div style={{ ...H2, marginTop: 16 }}>{t("ndModels")}</div>
      <Fact label={t("ndDefaultModel")}>{member.default_model ? modelText(member.default_model) : "-"}</Fact>
      {models.length === 0 ? (
        <div style={MUTED}>{t("ndNoModels")}</div>
      ) : (
        models.map((model) => (
          <div key={`${model.provider}/${model.model}`} style={{ marginTop: 6 }}>
            <div style={{ fontFamily: MONO_FONT }}>{`${model.provider}/${model.model}`}</div>
            {model.name || model.description ? (
              <div style={{ ...MUTED, fontSize: 12 }}>
                {[model.name, model.description].filter(Boolean).join(" · ")}
              </div>
            ) : null}
          </div>
        ))
      )}
      <div style={{ ...H2, marginTop: 16 }}>{t("colEndpoints")}</div>
      {member.endpoints.map((url) => (
        <div key={url} style={{ fontFamily: MONO_FONT, wordBreak: "break-all", marginTop: 4, fontSize: 12 }}>
          {url}
        </div>
      ))}
    </Modal>
  );
}
export function Workspace({ workspace }: { workspace: WorkspaceView | null }) {
  if (workspace === null) return <div style={MUTED}>{t("workspaceUnavailable")}</div>;
  const inputs = workspace.inputs_dirs.map((dir) => `${short(dir.task_id)} (${dir.files})`);
  return (
    <div style={{ fontSize: 12, color: "var(--dsw-alias-label-secondary)" }}>
      <div style={{ fontFamily: MONO_FONT, wordBreak: "break-all" }}>{workspace.root}</div>
      <div style={{ marginTop: 4 }}>{t("notes") + (workspace.notes_files.join(", ") || t("empty"))}</div>
      <div style={{ marginTop: 4 }}>{t("inputs") + (inputs.join(", ") || t("empty"))}</div>
    </div>
  );
}
