# 08 可靠性与可观测性

> 本章描述失败与过载下的行为，以及如何观测它们。

## 8. 可靠性与可观测性

### 8.1 任务语义

- **不重发、不自动恢复**，也不做 exactly-once：失败就是失败，要不要重来由人或 agent 显式再派一次（新 task）；
- **失败立即、终止明确**：target 重启 → `failed(node_restart)`；TTL 到点 → `failed(timeout)`；
- **状态诚实**：宁可说“失败/未知”，不假装成功；origin 看不到的任务标 `unknown`，不写成 `failed`；
- 没有“副作用未知”标记：`failed` 不表示目标侧没改过文件，要不要保留现场由人看工作区 diff 决定。

### 8.2 orca node 失联：任务不重发，origin 不替它判死

```text
origin 的 tracker 轮询 tasks/get
  → 瞬时失败（超时/网络错误/5xx）：按 1s 起翻倍、上限 30s 退避重试
  → 连续 5 次仍失败：停止跟踪，告诉发起会话
      "tracking of task … was interrupted: …; the task may still be running — call orca_pod with method "status" to check it"
  → 404 / 401 / 403：确定性失败，立即停止并同样告知
```

要点：

- origin 的“放弃跟踪”不是任务状态：origin 不会把任务记成 `failed`，不补发 `tasks/cancel`，也没有 `node_unreachable`、`task_lost` 这类状态——它只知道自己看不到了；
- 为什么不做重发 / 不做自动判死：跨 orca node 无法知道“执行到哪一步”，重发可能重复写文件、重复调 API；判死又可能冤枉一个只是网络抖动的任务。把事实交给 agent 与人：任务可能仍在跑，用 `status` 再查；
- 目标恢复后如果它自己完成了：**不处理、不召回**，也没有 `late_result` 状态。它发布的文件按登记的有效期（默认 7 天）可下载；
- 目标侧：目标 orca node 继续跑（如果还活着），结果留在本地 SQLite，不回调 origin；
- 成员层面的失联（心跳断）只影响**新任务的路由**（只有 `online` 接新任务，[§3.3](03-membership.md#33-心跳与双向看门狗)），不改变已派任务的状态。

### 8.3 目标重启

orca node 启动时（`recover()`），SQLite 里所有非终态 task（`submitted` / `working` / `input-required`）一律标成 `failed`，`reason=node_restart`，消息 “task was interrupted by an orca node restart”：

- 不区分“是否已开始”，也不尝试 resume 那个任务——那会让 origin 的状态和实际再次分叉；
- 授权请求随之失效；origin 下一次轮询看到 `failed(node_restart)`，卡片随之收回；
- 工作区目录不删，cwd 不变；ACP session 绑定保留，下一个任务会 `session/resume`。

**origin 重启（origin 侧派发日志）**：target 的 task 有 SQLite 兜底，origin 自己也需要一份“派给了谁、最后知道什么”的日志，否则进程一退就失忆。实现为 `<data_root>/tasks.db` 里的 `dispatches` 表（表只有 `task_id`、`payload`、`updated_at` 三列；条目 JSON 里才是 `peer`、`context_id`、`state`、`last_error`、`agent_id`、`created_at`）：

- 只有 `sendTask` 新建条目；`getTask`/`cancelTask`/审批只刷新已存在的条目；
- 节点启动时把仍非终态的条目标成 `state=unknown, last_error=origin_restart`——**不把“看不见”写成“失败”**；之后重新轮询到真实状态再覆盖；
- 人可以 `orca-node log [--json]` 直接看这张表（节点没跑也行）；
- 派发时 tracker 把发起会话的 id 写进 `agent_id`；宿主重启后，对仍在宿主里的会话恢复跟踪（[§5.2](05-tasks.md#52-任务回报)），其余任务靠 `status` 或面板查看，不静默丢失。

### 8.4 重复提交

不做幂等去重，协议里也没有幂等键：同一条 `message/send` 提交两次就是两个 task。要避免重复，靠调用方（agent 不自动重试；tracker 只读不写）。

### 8.5 超时与背压

- 任务寿命：`pod.task_ttl_s` 与本机 `task_timeout_s`（默认 3600）取较小者；到点 `failed(timeout)`；`input-required` 期间暂停；
- orca node 单槽：同一时间只跑 1 个任务（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）；忙时 `429 orca_node_busy` + `Retry-After: 30`，不排队；挂起任务的恢复遇到槽被占也是 429，由 origin 重试；
- 配额：工作区超额时新任务 `507 quota_exceeded`（[§6.13](06-execution.md#613-配额清理跨平台)）；
- 出站调用都有截止时间与响应上限（[§4.7](04-transport.md#47-方法与异步语义)）；
- origin 侧 tracker 轮询固定 1s、失败退避到 30s，见 §8.2。

### 8.6 放大、扇出与唤醒

一句话：**任务只有一跳，构造上就没有链、没有环**。orca node 不会因为心跳互相唤醒——唤醒只来自任务请求。

1. **任务不转发，也不派生**：orca node 只执行 origin 给它的任务；执行任务的 agent 不能再派新任务（执行器会话里 CLI 与插件的 `send` 拒绝，[§7.9](07-security.md#79-权限跟随发起-orca-node)）。扇出只能发生在有人坐着的根会话里，由那个会话一次次显式派发。
2. **没有回调**：target 从不反连 origin（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）；完成靠 origin 轮询。不存在“B 做完叫醒 A、A 又叫醒 B”。
3. **没有广播**：心跳自适应（`N` 秒）、单向；成员变化靠 digest 拉取（[§3.1](03-membership.md#31-成员状态的判定)）；没有 gossip、没有事件订阅、没有 completion webhook。

其他约束：

- **单槽**：每个 target 同一时间只跑 1 个任务；多余的请求在**建 task 之前**就 429，不创建进程——唤醒成本 = 一个 429 响应。
- **重试**：服务端从不自动重试；模型重试必须退避 + 抖动。
- **熔断**：心跳连续失败 → peer 进 suspect/offline，不再派新任务（`peer_not_online`），探测按 15s→30s 退避（[§3.3](03-membership.md#33-心跳与双向看门狗)）；不会“越连不上越猛试”。
- **唤醒预算**：后台通知连续叫醒同一会话最多 3 次，用户说话后重置（[§5.2](05-tasks.md#52-任务回报)）。
- 没有总开关：想拒绝所有远程任务，停掉节点或把本机 `permission_mode` 设成 `read-only`。

数量级：

| 场景     | 10 个 orca node 时的量                                         |
| -------- | -------------------------------------------------------------- |
| 空闲     | 心跳约 10 req/s（自适应间隔下 `N-1`），每个请求不到 1 KB，与任务数无关 |
| 全部在跑 | 最多 10 个 agent 进程（每 orca node 1 个槽），不是 10²         |
| 被打爆   | 每个 target 1 个任务 + 其余 429；429 < 1 KB 且不创建进程       |

“任务里不能再派任务”是非对抗性约束（[§7.9](07-security.md#79-权限跟随发起-orca-node)）：存心绕过的 agent 仍能自己签请求，那时兜底的还是单槽与请求超时。

### 8.7 可观测性

目前没有指标导出，也没有结构化 JSON 日志（指标的设想见 [§11](11-open-questions.md#11-未决问题)“指标”）。能观测的有：

- **任务记录**：target 侧 `tasks/get`（状态、`reason`、结论、artifacts）；origin 侧 `dispatches` 派发日志与 `orca-node log`；
- **成员状态**：`/cluster/members` 与 `orca-node members`——每个 peer 的 `state`（`online`/`suspect`/`offline`/`unknown`）、`last_recv_at`、`busy`、`max_task_ttl_s`、runtime、模型目录；
- **面板**：`/orca-api/state` 一次轮询拿到自己、成员、待审批、最近任务、工作区（[§9.2](09-implementation.md#92-面板)）；
- **日志**：节点通过注入的 logger 记 warning（拒绝的候选端点、被丢弃的 peer、落盘失败、blob 清理失败等），插件里是 DSH 的 logger，CLI 里是 console。

UI 的成员详情展示：显示名与 id、在线状态、忙闲（正在跑哪个任务）、最近心跳、单任务预算、运行环境（OS、CPU、内存、Node 版本）、默认/可用模型、自报地址；工作区配额在设置页的高级项里配置，面板不显示当前用量。

---
