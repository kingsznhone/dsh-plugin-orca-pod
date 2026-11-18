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
8. [DECISIONS.md](DECISIONS.md)（跨模块决策及理由）。

### 12.2 第一条 prompt 建议

```text
Read docs/README.md and docs/01-overview.md first, then 02 → 03 → 04 as needed.

Hard constraints that must not be undone:
- Topology is full mesh only. There is no ring, no gossip, no coordinator.
- There is no epoch, no incarnation, no global membership table.
  An orca node's table contains only peers it directly heard from or explicitly
  greeted; roster entries carried by hello answers are candidate endpoints,
  never liveness claims, and never rewrite an existing record.
- Listener is plain HTTP/1.1 with keep-alive. TLS is terminated by Caddy/nginx.
- orca_node_id is the node's Ed25519 public key (43-char base64url) generated at
  first start into the DSH credential store (record orca-pod/node, base58 seed).
  It IS the security principal. One node per machine, shared by every DSH profile.
- Auth = every node-to-node request carries two proofs in its Authorization
  header, over the same input: an Ed25519 signature (who sent it, unchanged) and
  an HMAC with the key derived from the workgroup password (in the group NOW).
  The member table gates nothing. Replies are signed by the answering node over
  the request nonce, status and body. No session token, no TTL, no empty
  password. Every route declares config.access (public/hello/member); one hook
  authenticates; one error handler answers. A node is an OrcaNode object in
  Mesh's table (this node included); callers resolve it (id, unique name or URL)
  and call its methods. Only seed addresses (settings, remembered peers, the
  connect tool, the panel) may reach a stranger; an unknown ref is unknown_peer.
- There are no version numbers: no protocol versions, no key-derivation markers, no migrations, no
  compatibility branches. Domain separators are plain tags ("orca-pod/request").
- Agent Card is public but carries only name, url and max_task_ttl_s; runtime,
  busy state and the model catalog sit behind signed endpoints only.
- Files are named `<orca node id>/<sha256>`, never by URL. Task conclusions come
  back inline as text; large outputs are published by the child and fetched
  explicitly (the orca_pod fetch method), the fetching node dialing the publisher
  itself. Inside a task the executor moves files: inputs into inbox/<task_id>/
  before the agent starts, outbox/<task_id>/ published as artifacts when it ends.
- Approval happens on the ORIGIN orca node. A task inherits the dispatching
  session's permission mode (none inherited => read-only); the local
  permission_mode only narrows it. The target auto-answers ACP permission
  requests by mode and parks the rest as input-required for the origin; it never
  opens a local approval dialog. There is one ApprovalBroker and the UI (chat
  card, popup, panel) is the only answer channel: the orca_pod tool has no
  approve method, and a permission request produces no chat notice.
- Execution dir is the persistent per-workgroup workspace; there is no
  published-root concept. One task at a time per orca node (single slot), otherwise
  429 orca_node_busy with retry_after_s and holder; resuming a parked task while
  another task holds the slot is also 429 and the origin decides when to retry.
  The calling model decides whether to retry, switch orca node, or report back to
  the user. No server-side queue. Endpoints are an ordered list (1-8, primary
  first); peers dial them in order. The protocol never carries
  paths; the task text refers to shared files by their
  `<orca node id>/<sha256>` name.
- Tasks are single-hop: a task is never forwarded, and the agent running it
  cannot dispatch another one (the executor sets ORCA_POD_IN_TASK=1; the
  plugin's send refuses and the plugin starts no node there). A task it cannot finish ends with a BLOCKED:
  report. This is a non-adversarial guard, not key isolation. Nodes never wake
  each other except by an origin-issued request.
- Polling lives in the Host plugin, not in the agent's shell: orca_pod's send
  method returns a task_id immediately; a background tracker polls tasks/get every
  second with backoff, and completion reaches the session as a compact
  source.kind "orca-pod" notice: inject() if the agent is running, followup() if
  it is idle (batch completions within 2s, cap 3 consecutive background turns,
  then inject only; a user message resets the budget). When transient failures
  persist the tracker gives up and tells the agent that tracking was interrupted.
  Never implement waiting with bash sleep loops, and provide no blocking wait tool
  at all: dispatch returns immediately, completion arrives by inject/wake, and a
  busy target answers 429 orca_node_busy which the agent reports to the user
  before ending the turn or doing unrelated work.
- Task and blob ids are the only access handles: any workgroup member holding a
  task_id or blob_id can read it; there is no per-task/per-blob ACL and no
  listing. Only the origin may cancel or resume a task. Id leakage is the exposure
  boundary. One shared password means orca-node-level checks are policy, not
  cryptographic isolation.
- Handoff uses the shared group workspace: a later task reads the workgroup root
  (the agent's cwd) and `notes/` left by earlier ones. There is no protocol-level
  continuation flag; whether to continue, and from where, is the agent's call.
- Password rotation rebuilds the whole group: a node whose password changed is refused on its very next request. There is no per-orca-node revocation
  and no transition window with two passwords.
- Task storage is single-orca-node SQLite (WAL). A restart fails every non-terminal
  task as failed(node_restart); do not re-dispatch and do not invent a resume.
  The origin's dispatch log marks tasks it can no longer see as unknown, never
  as failed.
- Quotas are settings (max_workspace_bytes, max_workspace_files); over quota
  is 507 quota_exceeded.
- Files move by name only: a node publishes its own files (orca_pod send, task outbox)
  and whoever needs one has its own node pull it; there is no upload route and
  no unsigned download link.
- `npm run check` (biome + tsc + vitest) is the single acceptance command.
```

### 12.3 交接规则

1. 新 agent 的第一件事是读本文与 [DECISIONS](DECISIONS.md)，不是写代码。
2. 任何与本文冲突的实现选择，要么改文档，要么改实现；不允许“代码里先这么写，文档以后补”。
3. 新增依赖、放宽权限、改变传输层，必须显式提出，不能夹带在功能 PR 里。
4. 每个 Phase 结束时更新 [§10.6](10-roadmap.md#106-验收标准) 的勾选项与 [§11](11-open-questions.md#11-未决问题) 的未决问题。

### 12.4 后续可拆的专题

当前 12 篇是稳定骨架；以下内容适合作为附录或独立文件，等对应章节长大后再说：

- 威胁模型与攻击面清单：07 的附录。
- 密码分发与轮换 runbook：07.3（[§7.3](07-security.md#73-密钥与密码的分发)）的附录。
- Windows 路径 / 保留名 / 长路径测试矩阵：[§11](11-open-questions.md#11-未决问题) 第 5 项的展开。
- EchoExecutor 场景脚本样例集：[§6.3](06-execution.md#63-echoexecutor用脚本模拟任务) 的附录。

---
