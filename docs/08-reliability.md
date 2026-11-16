# 08 可靠性与可观测性

> 本章描述失败与过载下的行为，以及如何观测它们。

## 8. 可靠性与可观测性

### 8.1 任务语义

- **at-least-once + 幂等**，不是 exactly-once；
- **失败立即、终止明确**：orca node 失联 → `failed`，不重发、不自动恢复（[§8.2](08-reliability.md#82-orca-node-失联-任务失败不重发)）；
- **副作用可见**：`failed` 带 `effects_unknown`，提示“目标侧可能已经改了文件”；
- **状态诚实**：宁可说“失败/未知”，不假装成功。

### 8.2 orca node 失联 = 任务失败，不重发

```text
origin 轮询 tasks/get
  → 连续连接失败达到 offline_after（自适应，约 3 拍）
  → task = failed(reason=node_unreachable, effects_unknown=true)
  → 停止轮询；不再派同一任务
```

为什么不做重发 / 不做 unknown 挂起：

- 跨 orca node 无法知道“执行到哪一步”：重发可能重复写文件、重复调 API、重复产生副作用；
- 挂 `unknown` 等于把问题留给用户，而用户没有信息去判断——不如直接失败并标清不确定性；
- 目标恢复后如果它自己完成了，origin 已经 failed：**不处理、不召回**，也没有 `late_result` 状态。要不要保留现场由人看工作区 diff 决定；没有被引用的 blob 按 7 天 GC。

目标侧的处理：

- 目标 orca node 继续跑（如果还活着），任务结果留在本地 SQLite；origin 已失败时不再回调；
- 目标重启后 `working` 的任务按 [§8.3](08-reliability.md#83-目标重启) 处理。

### 8.3 目标重启

- `submitted`：未开始，标 `failed(node_restart)`；
- `working`：标 `failed(node_restart, effects_unknown=true)`，**不尝试 resume**；提示用户检查工作区 diff；
- `input-required`：标 `failed(node_restart)`（授权请求已失效）；
- 重启后不允许把旧 task 悄悄“接着跑”——那会让 origin 的状态和实际再次分叉。

**origin 重启（origin 侧任务日志）**：target 的 task 有 SQLite 兜底，origin 自己也需要一份“派给了谁、最后知道什么”的日志，否则进程一退就失忆。实现为 `<data_root>/tasks.db` 里的 `dispatches` 表（`task_id`、`peer`、`context_id`、`state`、`last_error`、`parent_local_task_id`、`created_at`、`updated_at`），`sendTask`/`getTask`/`cancelTask`/`approveTask`/`denyTask` 每次成功都 upsert；启动时把仍非终态的条目标成 `state=unknown, last_error=origin_restart`（[§8.3](#83-目标重启) 的规则：不把“看不见”写成“失败”），之后重新轮询到真实状态再覆盖。人可以 `orca-node log [--json]` 直接看这张表；`parent_local_task_id` 同时供自动上升轮询使用（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。子任务终态后条目保留（TTL 由后续的清理任务负责），不随 task 删除。派发时 tracker 会把发起会话的 id 写进 `agent_id`；DSH 重启后从这张表恢复“非终态、且宿主仍运行该会话”的任务（未被恢复的任务靠 `status` 查看，不静默丢失）。后台轮询改成 setTimeout 链（上一轮结束才排下一轮，不重叠），瞬时错误按 1s 起、翻倍、上限 30s 退避重试，默认 5 次后停止跟踪并通知 agent `tracking of task … was interrupted`（提示改用 `status` 再查）；404/401/403 属确定性失败，立即停止。

### 8.4 幂等键

- 作用域 `(workgroup_id, origin_orca_node, idempotency_key)`，窗口 24h；
- 重复提交（同键）返回已有 task，不新建；
- 不承担重试语义：重试必须显式，且产生新 task（带 `retry_of`），由人决定。

### 8.5 超时与背压

- `task_ttl_s` 默认 3600；超时 → `failed(timeout)` + 尽力 `tasks/cancel`；
- orca node 单槽：同一时间只跑 1 个任务（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）；忙时 `429 orca_node_busy` + `Retry-After`，不排队；
- origin 侧轮询退避到 2s 后不再增长（避免“等太久以为挂了”）。

### 8.6 放大、扇出与唤醒

一句话：**环由祖先禁调与单槽封顶，不靠深度上限**；多跳可以发生（agent 显式用 CLI/工具派发子任务），链条靠 `chain` 检测回环，靠每跳超时与 task TTL 收尾。orca node 不会因为心跳互相唤醒——唤醒只来自任务请求。

构造上就没有环：

1. **任务不转发**：orca node 只执行 origin 给它的任务，不把任务转给第三个 orca node；子任务必须由目标 orca node 上的 agent 显式新建（CLI/插件工具），executor 默认没有 pod 远程工具（[§6.4](06-execution.md#64-acp-的位置)）。
2. **没有回调**：target 从不反连 origin（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）；完成靠 origin 轮询/SSE。不存在“B 做完叫醒 A、A 又叫醒 B”。
3. **没有广播**：心跳自适应（`N` 秒）、单向；成员变化靠 digest 拉取（[§3.1](03-membership.md#31-成员状态的判定)）；没有 gossip、没有事件订阅、没有 completion webhook。

多跳发生时的约束：

- **注入而非自填**：网关把 `hop+1`、`chain+[self]`、`root` 写进子任务；agent 改不了。目标 orca node 已在 `chain` 中 → `403 ancestor_call_forbidden`。
- **无深度上限**：`hop` 只是记账；允许链任意长，靠祖先禁调与超时收尾，不排队。
- **单槽仍在**：每个 target 同一时间只跑 1 个任务；多余的请求在**建 task 之前**就 429，不创建进程——唤醒成本 = 一个 429 响应。
- **祖先禁调（硬限制）**：子任务不能指向 `chain` 里的任何 orca node 或自身；网关直接 `403 ancestor_call_forbidden`。A→B→A 在第一跳就断。
- **兄弟互调不会僵死**：单槽下先占槽的一方还在跑自己的任务，另一方调它时直接 `429 orca_node_busy`——不会出现“两边都等着对方把活干完”。拿到 429 的一方把这个事实写进 `blocked` 回报 A，由 A 协调（换顺序、拆任务，或回报用户）。TTL 只兜底极端情况（两边恰好都在 `input-required` 被同时唤醒），到期 `failed(timeout)`。
- **重试**：服务端从不自动重试；模型重试必须退避 + 抖动。幂等键只防重复建 task，不制造重试。
- **熔断**：连续失败 → peer 进 suspect/unreachable，发送停止并退避（[§3.3](03-membership.md#33-心跳与双向看门狗)）；不会“越连不上越猛试”。
- **总闸**：本机总开关一次性取消所有远程任务（[§7.13](07-security.md#713-目标侧硬拒绝清单)），不依赖网络。

数量级：

| 场景 | 10 个 orca node 时的量 |
|---|---|
| 空闲 | 心跳 45 req/s，~200 B/req ≈ 9 KB/s，与任务数无关 |
| 全部在跑 | 最多 10 个 agent 进程（每 orca node 1 个槽），不是 10² |
| 被打爆 | 每个 target 1 个任务 + 其余 429；429 < 1 KB 且不创建进程 |
| 链式 | 无深度上限；靠祖先禁调、单槽与每跳超时兜底，不排队 |

真正会失控的只有一种情况：**target 上的 agent 自己不停地再调其他 orca node**。那是指数扇出的来源；现在没有深度上限，兜底靠祖先禁调（回环立刻 403）、单槽（同一 orca node 同时只跑一个任务）与请求超时。编排能力保留，但要让 agent 显式发起（CLI/工具），不存在隐式转发。

### 8.7 可观测性

指标：

- `pod_peer_state{peer,state}` gauge（online/suspect/unreachable/offline/unknown）
- `pod_peer_last_recv_age_seconds{peer}`、`pod_peer_last_ok_age_seconds{peer}`
- `pod_members_known`、`pod_members_digest_changes_total`
- `pod_candidate_accepted_total`、`pod_candidate_rejected_total{reason}`、`pod_tombstones_active`
- `pod_join_total{result}`、`pod_join_failures_total{reason}`
- `pod_auth_failures_total{reason}`
- `pod_tasks_submitted_total{target,workspace_kind}`
- `pod_tasks_terminal_total{state,reason}`
- `pod_task_duration_seconds{skill}`
- `pod_grants_issued_total{mode}`、`pod_grants_denied_total{reason}`
- `pod_approvals_total{result}`、`pod_approval_latency_seconds`
- `pod_workspace_bytes{workgroup}`、`pod_orca_node_busy`、`pod_orca_node_busy_seconds_total`、`pod_orca_node_busy_rejected_total{reason}`
- `pod_blob_uploads_total{result}`、`pod_blob_downloads_total`、`pod_blob_bytes{workgroup}`、`pod_blob_gc_total{reason}`
- `pod_heartbeat_rtt_seconds{peer}`
- `pod_executor_errors_total{type}`

日志：JSON；必带 `trace_id`、`task_id`、`origin_orca_node`、`target_node`、`grant_id`；不记录密码、签名、密钥；错误带类型与可重试标记。

UI（orca node 卡片）至少展示：`display_name (orca_node_id)`、OS 与版本、CPU/内存、DSH 版本、在线状态与延迟、group workspace 用量与配额、忙闲（正在跑哪个任务、已跑多久）、最近一次任务、当前会话权限模式。

---
