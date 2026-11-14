# 12 交接

> 给接手实现的新工作区：读什么、先做什么、哪些约束不能推翻。

## 12. 交接

### 12.1 阅读顺序

1. [docs/README.md](README.md)（文档地图与编号约定）。
2. [01-overview.md](01-overview.md)（为什么做、做什么、不做什么、术语）。
3. [02-model.md](02-model.md) → [03-membership.md](03-membership.md) → [04-transport.md](04-transport.md)（系统模型与协议骨架）。
4. [05-tasks.md](05-tasks.md) → [06-execution.md](06-execution.md)（任务与执行）。
5. [07-security.md](07-security.md) → [08-reliability.md](08-reliability.md)（安全与运维）。
6. [09-implementation.md](09-implementation.md) → [10-roadmap.md](10-roadmap.md)（落地与验收）。
7. [11-open-questions.md](11-open-questions.md) → 本文件（未决与交接）。
8. [DECISIONS.md](DECISIONS.md)（关键决策及理由）。

### 12.2 第一条 prompt 建议

```text
Read docs/README.md and docs/01-overview.md first, then 02 → 03 → 04 as needed.

Hard constraints that must not be undone:
- Topology is full mesh only. There is no ring, no gossip, no coordinator.
- There is no epoch, no incarnation, no global membership table.
  An orca node's table contains only peers it directly heard from; roster entries
  carried by heartbeat are candidate endpoints, never liveness claims.
- Listener is plain HTTP/1.1 with keep-alive. TLS is terminated by Caddy/nginx.
- orca_node_id is a 6-char Crockford base32 label generated at install, editable,
  persisted in plugin config. It is NOT a security principal.
- Auth = workgroup_id + non-empty password -> HKDF key -> per-request HMAC.
  No session token, no TTL, no empty password.
- Agent Card is public but carries no runtime, paths, or topology; runtime and
  busy state sit behind signed endpoints only.
- File exchange goes through a content-addressed blob channel. Task conclusions
  come back inline as text; artifacts are pulled explicitly by blob id.
- Approval happens on the ORIGIN orca node and follows the origin session's
  permission mode. The target never opens a local approval dialog.
- Execution dir is the persistent per-workgroup workspace; there is no
  published-root concept. One task at a time per orca node (single slot), otherwise
  429 orca_node_busy with retry_after and holder; the calling model decides whether
  to retry, switch orca node, or report back to the user. No server-side queue.
  One endpoint per orca node. Absolute paths from origin are rejected.
- Tasks are never forwarded: a child task is a new task an agent creates
  explicitly (CLI or plugin tool). The gateway, not the agent, decides
  hop/chain/root; there is no depth limit (a workgroup is a few machines) and the
  loop guard is the ancestor chain. Nodes never wake each other except by an
  origin-issued request.
- A child task may never target an orca node already in its chain: the gateway returns
  403 ancestor_call_forbidden. A blocked sub-agent reports
  via input-required with a `blocked` payload and releases its slot; the origin
  decides and continues the task with a follow-up message. No reverse calls.
- Polling lives in the Host plugin, not in the agent's shell: pod_send returns a
  task_id immediately; a background tracker polls tasks/get (or holds an SSE
  stream), and completion reaches the session through agent.inject() as a compact
  inbox notice that does not wake the agent. There is no notify flag: if the
  session is still running that turn, inject(); if it is idle, followup() wakes it
  once (batch completions within 2s, cap 3 consecutive background turns, drop to
  inbox beyond that). Only must-act-now events (a permission_request,
  a blocked sub-agent, a hard failure) also use followup(). Never implement waiting
  with bash sleep loops, and provide no blocking wait tool at all: dispatch returns
  immediately, completion arrives by inject/wake, and a busy target answers 429
  orca_node_busy (with holder and retry_after_s) which the agent reports to the user
  before ending the turn or doing unrelated work.
- Task and blob ids are the only access handles: any workgroup member holding a
  task_id or blob_id can read it; there is no per-task/per-blob ACL and no
  listing. Id leakage is the exposure boundary. One shared key means orca-node-level
  checks are policy, not cryptographic isolation.
- Handoff uses the shared group workspace: a later task reads the workgroup root
  (the agent's cwd) and `notes/` left by earlier ones. There is no protocol-level
  continuation flag;
  whether to continue, and from where, is the agent's call.
- Password rotation rebuilds the whole group. There is no per-orca-node revocation
  and no transition window with two passwords.
- Task storage is single-orca-node SQLite (WAL). Orca node loss fails the task; do not
  re-dispatch and do not invent a resume.
```

### 12.3 交接规则

1. 新 agent 的第一件事是读本文与 ADR，不是写代码。
2. 任何与本文冲突的实现选择，要么改文档（并写 ADR），要么改实现；不允许“代码里先这么写，文档以后补”。
3. 新增依赖、放宽权限、改变传输层，必须显式提出，不能夹带在功能 PR 里。
4. 每个 Phase 结束时更新 [§10.6](10-roadmap.md#106-验收标准) 的勾选项与 [§11](11-open-questions.md#11-未决问题) 的未决问题。

### 12.4 后续可拆的专题

当前 12 篇是稳定骨架；以下内容适合作为附录或独立文件，等对应章节长大后再说：

- 威胁模型与攻击面清单：07 的附录。
- 密码分发与轮换 runbook：07.3（[§7.3](07-security.md#73-密钥与密码的分发)）的附录。
- Windows 路径 / 保留名 / 长路径测试矩阵：[10.6](10-roadmap.md#106-验收标准) 的展开。
- EchoExecutor 场景脚本样例集：[06.3](06-execution.md#63-echoexecutor用脚本模拟任务) 的附录。
- ADR：`0001-full-mesh-no-ring.md`、`0002-orca-node-id-as-label.md`、`0003-password-derived-hmac.md`、`0004-approval-on-origin.md`、`0005-group-workspace.md`、`0006-fail-fast-on-orca-node-loss.md`、`0007-candidate-lists-are-not-liveness.md`、`0008-plain-http-behind-proxy.md`、`0009-sqlite-task-store.md`。

---
