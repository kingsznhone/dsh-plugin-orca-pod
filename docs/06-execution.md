# 06 执行与工作区

> 本章描述任务在目标节点上如何执行：执行器接口、Echo 脚本、ACP 的位置、单槽调度，以及工作区的目录约定。

## 6. 执行与工作区

### 6.1 LocalExecutor 接口

```ts
interface LocalExecutor {
  submit(input: {
    taskId: string;
    contextId: string;
    prompt: string;
    workspaceId: string;
    permissionMode: "read-only" | "workspace-write" | "danger-full-access";
    grant?: Grant;
    metadata?: Record<string, unknown>;
  }): Promise<{ status: "submitted" | "working" }>;

  get(taskId: string): Promise<TaskSnapshot>;

  cancel(taskId: string): Promise<void>;

  subscribe?(taskId: string, onEvent: (e: TaskEvent) => void): () => void;

  // 权限回调：目标节点策略层的唯一入口（§7.14）
  onPermissionRequest?(
    taskId: string,
    req: PermissionRequest
  ): Promise<"allow" | "deny" | "escalate">;
}
```

`permissionMode` 必须来自 origin 会话，由 A2A 请求携带并签名；target 不得上调它，只能按它执行或在越界时 escalate。

**Phase 0 实现**：`src/executor.ts` 当前的 `LocalExecutor` 是事件流接口——`run(input: { taskId, contextId?, metadata? }, signal: AbortSignal): AsyncGenerator<ExecutorEvent>`，事件为 `suspend | artifact | completed | failed`；上面的 `submit/get/cancel/subscribe/onPermissionRequest` 是目标接口，尚未实现。

### 6.2 实现

| 实现 | 适用 | 优点 | 缺点 | 现状 |
|---|---|---|---|---|
| `EchoExecutor` | Phase 0 协议验证 | 无 DSH 依赖、确定性 | 不执行真实任务 | 已实现 |
| `HeadlessExecutor` | 一次性任务 | 最简单，`dsh headless "..."` | 无流式、无协作取消、无多轮 | 未实现 |
| `AcpExecutor` | 长任务/进度/取消/多轮 | 流式、取消、session resume、权限钩子 | 本地仍是 client→agent | 未实现 |
| `InProcessExecutor` | 深度集成 | 无子进程协议、性能好 | 与 DSH 内部 API 耦合，升级易碎 | 未实现 |

推荐顺序：Echo → Headless → ACP。不要一开始就耦合 ACP。

### 6.3 EchoExecutor：用脚本模拟任务

Phase 0/1 的联调不需要真实 agent：用一个**声明式脚本**把“耗时、何时挂起、要什么权限、最终返回什么”写清楚，executor 照着演。它验证的是网络、状态机、审批回路和 blob 回传，不是模型能力。

脚本放在任务元数据里（origin 签名，target 只读）：

```json
{
  "echo": {
    "steps": [
      { "at_ms": 200, "suspend": { "kind": "blocked", "reason": "need_decision", "question": "继续吗？", "options": ["yes", "no"] } },
      { "at_ms": 600, "suspend": { "kind": "permission", "tool": "write_file", "requested": { "permission_mode": "workspace-write" } } }
    ],
    "final": { "state": "completed", "text": "echo: done" },
    "artifacts": [{ "name": "echo.txt", "content": "hello pod\n" }]
  }
}
```

**Phase 0 实现**：`EchoExecutor` 已按本节实现；它从 `params.metadata.echo` 取脚本，在建立 task 之前校验，执行结果通过 `AsyncGenerator<ExecutorEvent>` 交给 TaskRunner；artifact 写入 `BlobStore`（节点用 fs 实现，单测用内存实现）。

规则（与实现一致）：

- `steps` 最多 8 个；每个 `at_ms` 必须是非负整数、严格递增、且 ≤ 60000（最后一步不会超过 60s）。`at_ms` 从任务开始计，**挂起等待的时间不计入**（恢复后从上次位置继续），断言不依赖机器速度。
- `suspend.kind` 只有 `blocked` 与 `permission` 两种：`blocked` 需要 `reason`、`question`（可选 `options: string[]`），`permission` 需要 `tool` 与 `requested` 对象；分别生成 [§4.8](04-transport.md#48-任务状态机) 的 `blocked` 和 [§7.12](07-security.md#712-升级回路任务状态不是反向调用) 的 `permission_request`。恢复需要 origin 发一条带 `message.taskId` 的 `message/send`，且 task 必须处于 `input-required`。
- `final.state` ∈ `completed | failed | hang`；`failed` 时 `text` 作为 `status.message`；`hang` 表示永不完成，用于测 TTL、失联与 `tasks/cancel`（只能被取消或 TTL 收掉）。`text` ≤ 8 KiB（按 UTF-8 字节），**原样返回**，不做模板替换，便于逐字节断言。
- `final.text` 缺省为空串；`echo` 缺省（或 `null`）等价于 `{ "steps": [], "final": { "state": "completed", "text": "echo" } }`，用于纯连通性探测。
- `artifacts` ≤ 4 个、每个 `content` ≤ 4 KiB（UTF-8）；`name` 必须是非空纯文件名（不得含 `/`、`\`），只作提示。executor 真的写 blob 存储，返回的 `artifactId` = `sha256(content)` 的 hex（即 `blob_id`）；当前 `media_type` 固定为 `text/plain`。**artifact 事件先于终态事件产出**，因此 `completed`/`failed`/`hang` 都可能带 artifact。
- 非法脚本（未知字段、`at_ms` 不递增/越界、`suspend` 类型或必填字段错误、`final.state` 非法、`text`/`content` 超限、artifact 超过 4 个、文件名含路径分隔符）在**建 task 之前**返回 `400 bad_echo_script`，不会执行到一半才炸；节点忙时先回 `429 node_busy`，脚本校验在忙检查之后、建 task 之前。
- 真 executor 收到 `echo` 字段直接忽略（当前尚无真 executor），避免脚本泄漏到生产路径。

### 6.4 ACP 的位置

```text
Pod gateway (local)
  → AcpExecutor
    → spawn dsh --profile orca（cwd = 本节点工作区）
      → stdio JSON-RPC
```

禁止：把 ACP 端口暴露给 peer；让 peer 直接发 ACP 请求；把 ACP sessionId 当 A2A taskId；原样转发 thought。

建议为集群任务使用**专属 profile**（如 `orca`），与用户日常 GUI profile 隔离；ACP 子进程的 `cwd` 必须是本节点工作区，不允许是用户家目录或 DSH profile 目录。

**默认不启用 pod 远程工具**；多跳与扇出是可选能力，配置 `delegation` 打开后才生效。理由不是“安全”，而是“一个会自己跑起来的集群很难调试”：默认行为应当是可预测的单跳。打开后网关会强制注入 `hop` / `chain` / `root`（[§5.1](05-tasks.md#51-任务标识与元数据)），并按 `max_hop` / `max_fanout` 拒绝超限；agent 不能自己填这些字段。

### 6.5 ACP 映射

| A2A | ACP | 说明 |
|---|---|---|
| `context_id` | session | 首次 `session/new`，cwd = 本节点工作区 |
| 一个 task | 一次 `session/prompt` | 同 context 串行；不同 context 也串行（节点单槽，[§6.9](06-execution.md#69-单槽执行一个节点同一时间只做一件事)） |
| `session/update` | task status/artifact 事件 | 过滤 thought |
| prompt 返回 | 终态 | 按 `stopReason` 映射 |
| `tasks/cancel` | `session/cancel` | 超时后杀进程树 |
| 网关重启 | 新 session | 不猜旧 session；开新 session，cwd 不变（[§6.10](06-execution.md#610-session-context-workspace-的绑定)） |
| `session/request_permission` | 策略层裁决 | 见 [§7.14](07-security.md#714-acp-request_permission-映射)，**不弹本地窗** |

### 6.6 三个概念必须分开

| 概念 | 是什么 | 归谁管 | 本文叫法 |
|---|---|---|---|
| 命名空间 | 一组互信设备的 scope + 凭证 | 用户/配置 | `workgroup_id` |
| 执行目录 | agent 在目标机上读写的地方 | 目标节点 | `workspace` |
| 会话状态 | DSH session / ACP session | 目标节点 | `session` |

协议层只允许出现 `workgroup_id`、`workspace.kind`（只有 `"group"`）、`context_id`，**永不出现路径**：绝对路径是跨机器最不可移植、最不可审计的接口。

### 6.7 工作区：一份，持久

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
- **多 origin 共享同一份工作区**：允许，但串行（[§6.9](06-execution.md#69-单槽执行一个节点同一时间只做一件事)）。A 和 C 的交接靠 `notes/`，而不是互相看不见。
- origin 不能指定目录、不能传路径（[§6.12](06-execution.md#612-明确不做)）。

**实现状态**：`src/workspace.ts` 的 `createWorkspaceManager({dataRoot, workgroupId})` 负责这份布局；节点 `start()` 时 `ensure()` 一次建齐 `work/notes/inputs/.pod/tasks`，任务执行时把 `work/` 作为 `ExecuteInput.workspaceDir` 交给 executor（`pwd` 的落点）。`inputs/`、`.pod/index.json` 的写入流程尚未接（按 [§5.6](05-tasks.md#56-文件交换blob-通道) 由 origin 上传、executor 拉取）。

### 6.8 目录边界

- `work/` 是唯一写根；`notes/` 可写；`inputs/` 只由回传流程写；`.pod/` 归网关，agent 不可写（sandbox 规则挡）。
- 所有路径进入 agent 前做规范化（大小写、分隔符、`..`、符号链接、Windows 8.3 短名），且必须在 `work/` 之下；越界一律 `deny`。
- Windows 长路径：启用 `\\?\` 前缀或 `LongPathsEnabled`；超过 260 字符在创建时即报错，不静默截断。
- 不跟随 junction/symlink 出工作区；符号链接指向外部时，访问被拒并记审计。

### 6.9 单槽执行：一个节点同一时间只做一件事

- 网关维护一个槽位：`busy = null | { task_id, origin_node, since }`。
- 槽位被占时，新的 `message/send` 直接回 `429 node_busy`，**不排队、服务端不自动重试**。
- **决策交给调用方的模型**，网关只报事实：
  1. 重试一次（响应会带 `retry_after_s`，读类任务通常够用）；
  2. 换另一个能跑这个任务的节点；
  3. 直接向用户回报“X 正忙，已跑 N 分钟”——尤其当**整个 mesh 只有这一台能执行该任务**时，这就是正确结局：把决策交还给人。

```json
// 429 的 error.data（Phase 0 已实现，另带 HTTP 头 Retry-After: 30）
{ "code": "node_busy",
  "retry_after_s": 30,
  "holder": { "task_id": "t_01JABD", "origin_node": "N7K3QM", "since": "2026-11-14T05:10:00Z" } }
```

**Phase 0 实现**：忙时返回 HTTP 429 + `Retry-After: 30`，JSON-RPC `error.code=-32000`、`error.message="node_busy"`，`error.data={code:"node_busy",retry_after_s:30,holder:{...}}`。`busy` 状态由 TaskRunner 内部维护；self record 与心跳里的 `busy` 仍固定为 `null`，UI 暂时看不到持有者（[§2.5](02-model.md#25-节点自述记录selfrecord)）。

- 忙时拒绝发生在**建 task 之前**：不产生 task、不消耗幂等键；模型重试就是一次新的 `message/send`。
- `busy` 写进 self record（[§2.5](02-model.md#25-节点自述记录selfrecord)），随心跳刷新；origin 的 UI 显示“B 正在跑 X，已 3 分钟”，和模型的判断互相印证（Phase 0 未实现，见上）。
- **为什么单槽**：两个 agent 同改一棵树的冲突是语义层的（一个删了函数、另一个还在调），工程约束拦不住；而“同一节点上跑多件事”争的是同一台机器的 CPU、磁盘和 DSH 状态，不是换个目录就能隔离的。
- 槽位在任务终态/取消/失败时释放；`input-required` 也释放（任务在等 A 回话时不占槽，[§4.8](04-transport.md#48-任务状态机)），恢复时重新竞争，不预留。节点进程崩溃或重启时，SQLite 里所有非终态 task 在下次启动时标成 `failed(node_restart)`（[§6.10](06-execution.md#610-session-context-workspace-的绑定)、[§8.3](08-reliability.md#83-目标重启)），不自动续跑。

### 6.10 session / context / workspace 的绑定

```text
(workgroup_id, origin_node, context_id) → session_id
session_id → workspace（本节点唯一的那份）
```

- 同一个 context 的后续任务复用同一 session（同 cwd、同对话历史）。
- 不同 context 各自新 session，但**共用同一份工作区**，所以文件上下文不断。
- 网关重启 / session 丢失：**不猜旧 session**，直接开新 session、cwd 不变；第一条 prompt 里带一句“先读 `notes/STATUS.md`”。会话可丢，工作区不丢。
- 目标节点重启后：task 状态保留在 SQLite 里，`tasks/get` 仍可查；`submitted/working/input-required` 一律按 [§8.3](08-reliability.md#83-目标重启) 标 `failed(node_restart)`，`working` 带 `effects_unknown=true`，不尝试 resume。工作区目录不删，cwd 不变。

### 6.11 任务结果与产物

任务结果分三层，不要混在一起：结论是给人看的，`notes/` 是给下一个 session 看的；混在一起会出现多份状态副本，谁也不知道哪份对。

| 层 | 走哪 | 说明 |
|---|---|---|
| 结论文本 | `tasks/get` 的 `status.message`，内联 | agent 最后一轮说的话，截断到 32 KiB；超长部分写 `result.txt` blob，消息里带摘要与引用 |
| 产物文件 | blob 通道（[§5.6](05-tasks.md#56-文件交换blob-通道)） | manifest 给 `{blob_id, name, media_type, bytes}`；origin 按需拉 |
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
- 凭据类内容按 [§7.15](07-security.md#715-凭据回传与注入防护) 的策略处理，不因为“在 artifact 里”就绕过。

### 6.12 明确不做

- **不做发布式目录**：`label`、`fingerprint`、`containment` 检查全部不实现。origin 只能在目标节点自动分配的工作区里跑。单槽 + 自动分配已经够用；发布真实目录会额外引入隔离、配额、清理三层复杂度。
- **不做多任务并发 / task-subdir 隔离**：节点单槽（[§6.9](06-execution.md#69-单槽执行一个节点同一时间只做一件事)）。
- 不做反向挂载 / SMB / NFS / 9p / 分布式 FS：网络文件系统会把锁、延迟、大小写语义带进 agent 的失败模式；
- 不做跨节点共享同一个 session（session 是本地的）；
- 不做“origin 直接编辑 target 上的文件”（只能通过任务）；
- 不做自动 git push/pull（网络与凭据是另一个问题域）；
- 不把工作区同步到其它节点（每个节点各自一份，靠 notes/artifact 交接）。

### 6.13 配额、清理、跨平台

- 配额：`max_disk_bytes`（默认 5 GiB）、`max_files`（默认 50k）；超限时任务 `failed(quota_exceeded)`，不静默丢文件。
- 清理：工作区不按 TTL 删；只在配额压力下按“最久未使用”驱逐，并提前在 UI 标黄；`purge` 是显式动作，要求二次确认。
- 跨平台：目录分隔符、大小写不敏感（Windows）、保留名（`CON`、`NUL`、`aux`）、尾随点/空格都要处理；路径比较统一用规范化后的形式。
- 审计：每个任务记录 `workgroup_id`、实际 cwd（相对路径）、写入了哪些文件。

---
