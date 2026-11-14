# 06 工作区

> 关注：任务在目标机的哪个目录里跑、一个节点如何保证不被并发打爆、结果与产物怎么回传、配额与清理。
>
> 章节编号沿用全局编号；执行器接口在 05-executor.md。

## 11. 工作区：单槽执行与 workgroup 工作区

> 一个任务在别人的机器上跑，它到底在哪个目录里跑？这一节回答这个问题。

先说结论：**节点是单槽的**——同一时间只跑一个任务；目录是加入时自动分配的一份持久工作区，不可发布、不可指定路径。

### 11.1 三个概念必须分开

| 概念 | 是什么 | 归谁管 | 本文叫法 |
|---|---|---|---|
| 命名空间 | 一组互信设备的 scope + 凭证 | 用户/配置 | `workgroup_id` |
| 执行目录 | agent 在目标机上读写的地方 | 目标节点 | `workspace` |
| 会话状态 | DSH session / ACP session | 目标节点 | `session` |

协议层只允许出现 `workgroup_id`、`workspace.kind`（只有 `"group"`）、`context_id`，**永不出现路径**。

### 11.2 工作区：一份，持久

```text
<data_root>/workgroups/<workgroup_id>/
   ├─ work/        ← agent 的 cwd，DSH sandbox 的写根
   ├─ notes/       ← 跨 session 的态势感知（STATUS.md、决策、待办）
   ├─ inputs/      ← 本任务从 blob 拉下来的素材（任务结束清空）
   └─ .pod/
       ├─ index.json      ← 产物索引（相对路径 + sha256）
       └─ tasks/<task_id>/
```

- 加入 workgroup 时创建一次，之后所有任务共用；跨任务、跨 session 持久，任务结束不删，节点重启不删。
- **为什么持久**：长程任务靠上下文。今天改一个模块、明天接着改，每次都给新目录的话 agent 既看不到昨天的改动，也读不到昨天的结论。
- **多 origin 共享同一份工作区**：允许，但串行（[§11.4](06-workspace.md#114-单槽执行一个节点同一时间只做一件事)）。A 和 C 的交接靠 `notes/`，而不是互相看不见。
- origin 不能指定目录、不能传路径（[§11.7](06-workspace.md#117-明确不做)）。

### 11.3 目录边界

- `work/` 是唯一写根；`notes/` 可写；`inputs/` 只由回传流程写；`.pod/` 归网关，agent 不可写（sandbox 规则挡）。
- 所有路径进入 agent 前做规范化（大小写、分隔符、`..`、符号链接、Windows 8.3 短名），且必须在 `work/` 之下；越界一律 `deny`。
- Windows 长路径：启用 `\\?\` 前缀或 `LongPathsEnabled`；超过 260 字符在创建时即报错，不静默截断。
- 不跟随 junction/symlink 出工作区；符号链接指向外部时，访问被拒并记审计。

### 11.4 单槽执行：一个节点同一时间只做一件事

- 网关维护一个槽位：`busy = null | { task_id, origin_node, since }`。
- 槽位被占时，新的 `message/send` 直接回 `429 node_busy` + `Retry-After`（默认 30s）+ 当前持有者，**不排队、服务端不自动重试**。
- **决策交给调用方的模型**，网关只报事实：
  1. 等 `retry_after_s` 再试一次（读类任务通常够用）；
  2. 换另一个能跑这个任务的节点；
  3. 直接向用户回报“X 正忙，已跑 N 分钟”——尤其当**整个 mesh 只有这一台能执行该任务**时，这就是正确结局：把决策交还给人。

```json
{ "code": "node_busy",
  "retry_after_s": 30,
  "holder": { "task_id": "t_01JABD", "origin_node": "N7K3QM", "since": "2026-11-14T05:10:00Z" } }
```

- 忙时拒绝发生在**建 task 之前**：不产生 task、不消耗幂等键；模型重试就是一次新的 `message/send`。
- `busy` 写进 self record（[§6.2](02-architecture.md#62-节点自述记录selfrecord)），随心跳刷新；origin 的 UI 显示“B 正在跑 X，已 3 分钟”，和模型的判断互相印证。
- **为什么单槽**：两个 agent 同改一棵树的冲突是语义层的（一个删了函数、另一个还在调），工程约束拦不住；而“同一节点上跑多件事”争的是同一台机器的 CPU、磁盘和 DSH 状态，不是换个目录就能隔离的。
- 槽位在任务终态/取消/失败时释放；`input-required` 也释放（任务在等 A 回话时不占槽，[§7.4](03-protocol.md#74-任务状态机)），恢复时重新竞争，不预留。网关崩溃后按 `task_ttl_s` 过期，重启时清空并按下文对账。

### 11.5 session / context / workspace 的绑定

```text
(workgroup_id, origin_node, context_id) → session_id
session_id → workspace（本节点唯一的那份）
```

- 同一个 context 的后续任务复用同一 session（同 cwd、同对话历史）。
- 不同 context 各自新 session，但**共用同一份工作区**，所以文件上下文不断。
- 网关重启 / session 丢失：**不猜旧 session**，直接开新 session、cwd 不变；第一条 prompt 里带一句“先读 `notes/STATUS.md`”。会话可丢，工作区不丢。
- 目标节点重启后 task 状态在 SQLite 里，`working` 的按 [§13.3](09-reliability.md#133-目标重启) 处理。

### 11.6 任务结果与产物

任务结果分三层，不要混在一起：

| 层 | 走哪 | 说明 |
|---|---|---|
| 结论文本 | `tasks/get` 的 `status.message`，内联 | agent 最后一轮说的话，截断到 32 KiB；超长部分写 `result.txt` blob，消息里带摘要与引用 |
| 产物文件 | blob 通道（[§7.10](04-tasks.md#710-文件交换blob-通道)） | manifest 给 `{blob_id, name, media_type, bytes}`；origin 按需拉 |
| 工作区状态 | 本机 `notes/` | **不离开目标机**；要让 origin 知道进展，由 agent 在结论文本里摘要 |

**超长文本下载后的文件名**：blob 本身不存名字（`blob_id` 是内容哈希，同内容不同名会冲突），名字只存在任务 manifest 的 `name` 字段里。origin 按 manifest 落盘；直接走 URL 的场景用 `GET /blobs/<id>?name=<name>` 传提示名，服务端只用它生成 `Content-Disposition`，校验无路径分隔符、无 CRLF、长度 ≤ 200 字符，不合法就忽略、回落到 `blob_id`。

任务终态时 manifest 形如：

```json
{
  "task_id": "t_01JABD",
  "result_text_chars": 1200,
  "changed": ["work/src/main.ts", "work/README.md"],
  "artifacts": [
    { "blob_id": "sha256:...", "name": "build.zip", "media_type": "application/zip", "bytes": 1048576 },
    { "blob_id": "sha256:...", "name": "change.patch", "media_type": "text/x-diff", "bytes": 8192 }
  ],
  "duration_ms": 18342,
  "executor": "acp",
  "permission_mode": "workspace-write"
}
```

规则：

- `changed` 一律**相对 `work/`**；出现绝对路径或 `..` 直接判 manifest 非法。
- `patch` 是可选 artifact（`git diff` 产物）；有 git 时建议给，便于 review 与回滚。
- artifact **不内联**，只给 blob 引用；origin 取不取、什么时候取，由人决定。
- 结论文本超过 32 KiB：截断 + 写一个 `result.txt` blob，消息里只留摘要与引用。
- 凭据类内容按 [§9.7](07-permissions.md#97-凭据回传与注入防护) 的策略处理，不因为“在 artifact 里”就绕过。

### 11.7 明确不做

- **不做发布式目录**：`label`、`fingerprint`、`containment` 检查全部不实现。origin 只能在目标节点自动分配的工作区里跑。
- **不做多任务并发 / task-subdir 隔离**：节点单槽（[§11.4](06-workspace.md#114-单槽执行一个节点同一时间只做一件事)）。
- 不做反向挂载 / SMB / NFS / 9p / 分布式 FS；
- 不做跨节点共享同一个 session（session 是本地的）；
- 不做“origin 直接编辑 target 上的文件”（只能通过任务）；
- 不做自动 git push/pull（网络与凭据是另一个问题域）；
- 不把工作区同步到其它节点（每个节点各自一份，靠 notes/artifact 交接）。

### 11.8 配额、清理、跨平台

- 配额：`max_disk_bytes`（默认 5 GiB）、`max_files`（默认 50k）；超限时任务 `failed(quota_exceeded)`，不静默丢文件。
- 清理：工作区不按 TTL 删；只在配额压力下按“最久未使用”驱逐，并提前在 UI 标黄；`purge` 是显式动作，要求二次确认。
- 跨平台：目录分隔符、大小写不敏感（Windows）、保留名（`CON`、`NUL`、`aux`）、尾随点/空格都要处理；路径比较统一用规范化后的形式。
- 审计：每个任务记录 `workgroup_id`、实际 cwd（相对路径）、写入了哪些文件。

---
