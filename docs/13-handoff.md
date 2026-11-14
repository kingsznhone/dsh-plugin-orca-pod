# 13 交接

> 关注：新工作区/新 agent 接手时的阅读顺序、第一条 prompt、交接规则与建议的下一步拆分。
>
> 章节编号沿用全局编号。

## 19. 新工作区交接

### 19.1 阅读顺序

1. 本文件 `DESIGN.md`（宏观基线）。
2. 之后拆分出的 `AGENTS.md`（硬约束）。
3. `docs/design/00-overview.md`、`01-a2a-task-plane.md`、`02-control-plane.md`、`03-permissions.md`、`04-workspace.md`、`05-security.md`。
4. ADR：关键决策及理由。

### 19.2 第一条 prompt 建议

```text
Read DESIGN.md first.

Hard constraints that must not be undone:
- Topology is full mesh only. There is no ring, no gossip, no coordinator.
- There is no epoch, no incarnation, no global membership table.
  A node's table contains only peers it directly heard from; hints are endpoint
  candidates, never liveness claims.
- Listener is plain HTTP/1.1 with keep-alive. TLS is terminated by Caddy/nginx.
- node_id is a 6-char Crockford base32 label generated at install, editable,
  persisted in plugin config. It is NOT a security principal.
- Auth = workgroup_id + non-empty password -> HKDF key -> per-request HMAC.
  No session token, no TTL, no empty password.
- Agent Card is public but carries no runtime, paths, or topology; runtime and
  busy state sit behind signed endpoints only.
- File exchange goes through a content-addressed blob channel. Task conclusions
  come back inline as text; artifacts are pulled explicitly by blob id.
- Approval happens on the ORIGIN node and follows the origin session's
  permission mode. The target never opens a local approval dialog.
- Execution dir is the persistent per-workgroup workspace; there is no
  published-root concept. One task at a time per node (single slot), otherwise
  429 node_busy with retry_after and holder; the calling model decides whether
  to retry, switch node, or report back to the user. No server-side queue.
  One endpoint per node. Absolute paths from origin are rejected.
- Tasks are single-hop by default: no forwarding, no callbacks. The gateway, not
  the agent, decides hop/chain/root. Multi-hop and fan-out exist as opt-in
  capabilities (max_hop/max_fanout default 0); when enabled, the gateway injects
  hop+1, appends the node to chain, keeps root stable, and rejects over-budget
  children. Nodes never wake each other except by an origin-issued request.
- A child task may never target a node already in its chain: the gateway returns
  403 ancestor_call_forbidden, regardless of max_hop. A blocked sub-agent reports
  via input-required with a `blocked` payload and releases its slot; the origin
  decides and continues the task with a follow-up message. No reverse calls.
- Polling lives in the Host plugin, not in the agent's shell: pod_send returns a
  task_id immediately; a background tracker polls tasks/get (or holds an SSE
  stream), and completion reaches the session through agent.inject() as a compact
  inbox notice that does not wake the agent. Default notify is "auto": if the
  dispatching turn ended before the task reached a terminal state, a completion
  wakes the agent once (batch completions within 2s, cap 3 consecutive background
  turns, drop to inbox beyond that). Only must-act-now events (a permission_request,
  a blocked sub-agent, a hard failure) also use followup(). Never implement waiting
  with bash sleep loops, and provide no blocking wait tool at all: dispatch returns
  immediately, completion arrives by inject/wake, and a busy target answers 429
  node_busy (with holder and retry_after_s) which the agent reports to the user
  before ending the turn or doing unrelated work.
- Task and blob ids are the only access handles: any workgroup member holding a
  task_id or blob_id can read it; there is no per-task/per-blob ACL and no
  listing. Id leakage is the exposure boundary. One shared key means node-level
  checks are policy, not cryptographic isolation.
- Continuation is a new task with `continuation_of` pointing at a terminal task;
  it reuses the same context and workspace and never mutates the old task.
- Password rotation rebuilds the whole group. There is no per-node revocation
  and no transition window with two passwords.
- Task storage is single-node SQLite (WAL). Node loss fails the task; do not
  re-dispatch and do not invent a resume.
```

### 19.3 交接规则

1. 新 agent 的第一件事是读本文与 ADR，不是写代码。
2. 任何与本文冲突的实现选择，要么改文档（并写 ADR），要么改实现；不允许“代码里先这么写，文档以后补”。
3. 新增依赖、放宽权限、改变传输层，必须显式提出，不能夹带在功能 PR 里。
4. 每个 Phase 结束时更新 [§17](10-roadmap.md#17-验收标准摘要) 的勾选项与 [§18](12-open-questions.md#18-未决问题) 的未决问题。

### 19.4 建议的下一步拆分

- `docs/design/00-overview.md`：[§0](README.md)–[§4](02-architecture.md#4-总体架构) 的展开。
- `01-a2a-task-plane.md`：[§7](03-protocol.md#7-a2a-任务面)–[§8](05-executor.md#8-localexecutor)。
- `02-control-plane.md`：[§10](10-roadmap.md#10-节点)（含 hints/墓碑的测试用例）。
- `03-permissions.md`：[§9](07-permissions.md#9-权限与审批跟随发起节点) + [§12.5](08-security.md#125-远程任务是不可信输入)，附威胁模型。
- `04-workspace.md`：[§11](06-workspace.md#11-工作区单槽执行与-workgroup-工作区)，附目录布局图与清理策略。
- `05-security.md`：[§12](08-security.md#12-安全与授权)，附密码分发与轮换 runbook。
- ADR：`0001-full-mesh-no-ring.md`、`0002-node-id-as-label.md`、`0003-password-derived-hmac.md`、`0004-approval-on-origin.md`、`0005-group-workspace.md`、`0006-fail-fast-on-node-loss.md`、`0007-hints-are-not-liveness.md`、`0008-plain-http-behind-proxy.md`、`0009-sqlite-task-store.md`。

---
