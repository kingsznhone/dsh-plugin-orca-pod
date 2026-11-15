# 06 执行与工作区

> 本章描述任务在目标 orca node 上如何执行：执行器接口、Echo 脚本、ACP 的位置、单槽调度，以及工作区的目录约定。

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

  // 权限回调：目标 orca node 策略层的唯一入口（§7.14）
  onPermissionRequest?(
    taskId: string,
    req: PermissionRequest
  ): Promise<"allow" | "deny" | "escalate">;
}
```

`permissionMode` 必须来自 origin 会话，由 A2A 请求携带并签名；target 不得上调它，只能按它执行或在越界时 escalate。

**Phase 3 实现**：origin 把会话模式写进 `metadata.pod.permission_mode`；target 的 `tasks.ts` 计算生效模式 = 较窄者（本机 `config.permission_mode` 上限 vs 继承值），再传给执行器。`ACP` 把它作 `--permission-mode`；`AcpExecutor` 按模式自动回答 `session/request_permission`（`read-only` 拒绝写类工具、`workspace-write` 允许工作区内编辑/执行、`danger-full-access` 全允许），没有继承模式时仍挂起走 origin 审批（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

**Phase 0 实现**：`src/executor.ts` 当前的 `LocalExecutor` 是事件流接口——`run(input: { taskId, contextId?, metadata? }, signal: AbortSignal): AsyncGenerator<ExecutorEvent>`，事件为 `suspend | artifact | completed | failed`；上面的 `submit/get/cancel/subscribe/onPermissionRequest` 是目标接口，尚未实现。

### 6.2 实现

| 实现 | 适用 | 优点 | 缺点 | 现状 |
|---|---|---|---|---|
| `EchoExecutor` | Phase 0 协议验证 | 无 DSH 依赖、确定性 | 不执行真实任务 | 已实现 |
| `AcpExecutor` | 长任务/进度/取消/多轮 | 流式、取消、session resume、权限钩子 | 本地仍是 client→agent | 已实现（[§6.14](06-execution.md#614-acpexecutorphase-23-长任务执行器)） |
| `InProcessExecutor` | 深度集成 | 无子进程协议、性能好 | 与 DSH 内部 API 耦合，升级易碎 | 未实现 |

推荐顺序：Echo → ACP，两者已齐。

**谁选执行器**：由**被调用 orca node 自己的配置**决定（`config.executor: "echo" | "acp"`，插件默认 `acp`），origin 不参与，也不能在任务里指定。executor 是本机实现细节，A2A 线协议完全相同；任务 manifest 里回报的 `executor` 字段只是“这台机器实际用了哪个”的观测事实，不是调用方可以要求的东西。要区分“能不能干这个活”，看 Agent Card / runtime 能力，而不是看执行器类型。

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

**Phase 0 实现**：`EchoExecutor` 已按本节实现；它从 `params.metadata.echo` 取脚本，在建立 task 之前校验，执行结果通过 `AsyncGenerator<ExecutorEvent>` 交给 TaskRunner；artifact 写入 `BlobStore`（orca node 用 fs 实现，单测用内存实现）。

规则（与实现一致）：

- `steps` 最多 8 个；每个 `at_ms` 必须是非负整数、严格递增、且 ≤ 60000（最后一步不会超过 60s）。`at_ms` 从任务开始计，**挂起等待的时间不计入**（恢复后从上次位置继续），断言不依赖机器速度。
- `suspend.kind` 只有 `blocked` 与 `permission` 两种：`blocked` 需要 `reason`、`question`（可选 `options: string[]`），`permission` 需要 `tool` 与 `requested` 对象；分别生成 [§4.8](04-transport.md#48-任务状态机) 的 `blocked` 和 [§7.12](07-security.md#712-升级回路任务状态不是反向调用) 的 `permission_request`。恢复需要 origin 发一条带 `message.taskId` 的 `message/send`，且 task 必须处于 `input-required`。
- `final.state` ∈ `completed | failed | hang`；`failed` 时 `text` 作为 `status.message`；`hang` 表示永不完成，用于测 TTL、失联与 `tasks/cancel`（只能被取消或 TTL 收掉）。`text` ≤ 8 KiB（按 UTF-8 字节），**原样返回**，不做模板替换，便于逐字节断言。
- `final.text` 缺省为空串；`echo` 缺省（或 `null`）等价于 `{ "steps": [], "final": { "state": "completed", "text": "echo" } }`，用于纯连通性探测。
- `artifacts` ≤ 4 个、每个 `content` ≤ 4 KiB（UTF-8）；`name` 必须是非空纯文件名（不得含 `/`、`\`），只作提示。executor 真的写 blob 存储，返回的 `artifactId` = `sha256(content)` 的 hex（即 `blob_id`）；当前 `media_type` 固定为 `text/plain`。**artifact 事件先于终态事件产出**，因此 `completed`/`failed`/`hang` 都可能带 artifact。
- 非法脚本（未知字段、`at_ms` 不递增/越界、`suspend` 类型或必填字段错误、`final.state` 非法、`text`/`content` 超限、artifact 超过 4 个、文件名含路径分隔符）在**建 task 之前**返回 `400 bad_echo_script`，不会执行到一半才炸；orca node 忙时先回 `429 orca_node_busy`，脚本校验在忙检查之后、建 task 之前。
- 真 executor 收到 `echo` 字段直接忽略（当前尚无真 executor），避免脚本泄漏到生产路径。

### 6.4 ACP 的位置

```text
Pod gateway (local)
  → AcpExecutor
    → spawn dsh --profile orca（cwd = 本 orca node 工作区）
      → stdio JSON-RPC
```

禁止：把 ACP 端口暴露给 peer；让 peer 直接发 ACP 请求；把 ACP sessionId 当 A2A taskId；原样转发 thought。

建议为集群任务使用**专属 profile**（如 `orca`），与用户日常 GUI profile 隔离；ACP 子进程的 `cwd` 必须是本 orca node 工作区，不允许是用户家目录或 DSH profile 目录。

**executor 默认不启用 pod 远程工具**：ACP 会话要么通过 CLI、要么通过插件工具去派发子任务，没有隐式转发。多跳本身不受限制——网关强制注入 `hop` / `chain` / `root`（[§5.1](05-tasks.md#51-任务标识与元数据)），agent 不能自己填；唯一的构造性约束是祖先禁调，环靠 `chain` 检测而不是深度上限。

### 6.5 ACP 映射

| A2A | ACP | 说明 |
|---|---|---|
| `context_id` | session | 首次 `session/new`，cwd = 本 orca node 工作区 |
| 一个 task | 一次 `session/prompt` | 同 context 串行；不同 context 也串行（orca node 单槽，[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)） |
| `session/update` | task status/artifact 事件 | 过滤 thought |
| prompt 返回 | 终态 | 按 `stopReason` 映射 |
| `tasks/cancel` | `session/cancel` | 超时后杀进程树 |
| 网关重启 | 新 session | 不猜旧 session；开新 session，cwd 不变（[§6.10](06-execution.md#610-session-context-workspace-的绑定)） |
| `session/request_permission` | 策略层裁决 | 见 [§7.14](07-security.md#714-acp-request_permission-映射)，**不弹本地窗** |

### 6.6 三个概念必须分开

| 概念 | 是什么 | 归谁管 | 本文叫法 |
|---|---|---|---|
| 命名空间 | 一组互信设备的 scope + 凭证 | 用户/配置 | `workgroup_id` |
| 执行目录 | agent 在目标机上读写的地方 | 目标 orca node | `workspace` |
| 会话状态 | DSH session / ACP session | 目标 orca node | `session` |

协议层只允许出现 `workgroup_id`、`workspace.kind`（只有 `"group"`）、`context_id`，**永不出现路径**：绝对路径是跨机器最不可移植、最不可审计的接口。

### 6.7 工作区：一份，持久

```text
<data_root>/
   ├─ workgroups/<workgroup_id>/     ← agent 的 cwd，DSH sandbox 的写根
   │     ├─ notes/                   ← 跨 session 的态势感知（STATUS.md、决策、待办）
   │     └─ inputs/<task_id>/        ← 本任务的素材，网关在任务开始前写入、终态删除
   └─ state/<workgroup_id>/          ← 网关状态，agent 不可见、不可写
         ├─ sessions.json            ← (origin, context) → ACP session
         └─ tasks/<task_id>/         ← 每任务私有状态
```

- 加入 workgroup 时创建一次，之后所有任务共用；跨任务、跨 session 持久，任务结束不删，orca node 重启不删。
- **cwd 就是 workgroup 根**：`inputs/<task_id>/` 与 `notes/STATUS.md` 都是 cwd 相对路径，agent 用普通相对路径就能读写，不需要知道 `<data_root>` 在哪。
- **为什么持久**：长程任务靠上下文。今天改一个模块、明天接着改，每次都给新目录的话 agent 既看不到昨天的改动，也读不到昨天的结论。
- **多 origin 共享同一份工作区**：允许，但串行（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。A 和 C 的交接靠 `notes/`，而不是互相看不见。
- origin 不能指定目录、不能传路径（[§6.12](06-execution.md#612-明确不做)）。

**任务素材（inputs）**：origin 先把文件上传成 blob（[§5.6](05-tasks.md#56-文件交换blob-通道)），再在 `metadata.pod.inputs` 里给出 `[{blob_id, name}]`。

- target 在**建 task 之前**物化到 `inputs/<task_id>/`，任何失败（blob 缺失、超限、重名）直接拒绝，不建任务；
- 任务书末尾追加 cwd 相对清单（`- inputs/<task_id>/name`），agent 打开即见；
- task 进入终态时删除该目录；进程重启时 `purgeInputs()` 清掉上次残留（那时任务都已被恢复逻辑标成 `failed`）；
- 上限默认 32 个文件、512 MiB，本地 `max_input_files` / `max_input_bytes` 可调；重名直接 `409 duplicate_input_name`。

**跨任务交接（notes/）**：`notes/` 是给**下一个任务/下一个 session** 的现场记录，不是协议字段。节点的做法不是强制格式，而是“把现场摆在任务书里”：

- 建任务时列出 `notes/` 顶层文件（最多 20 个）追加到任务书附录，agent 打开就知道有哪些前情（`notes/STATUS.md`、决策、待办）；
- ACP 的 preamble 里说明 cwd 是共享 workgroup 根、开工先读 `notes/STATUS.md`、收尾更新它；
- 同一 workgroup 多 origin 交替派任务时，靠的也是这份笔记而不是互相看不见（[§6.7](#67-工作区一份持久)）。

**实现状态**：`src/workspace.ts` 的 `createWorkspaceManager({dataRoot, workgroupId})` 负责这份布局；orca node `start()` 时 `ensure()` 一次建齐并 `purgeInputs()`。任务执行时把 workgroup 根作为 `ExecuteInput.workspaceDir`（executor 的 cwd），把 `state/<workgroup_id>/` 作为 `podDir`。物化、附录（inputs 清单 + notes 清单）与清理在 `src/tasks.ts`（`materializeInputs`、`promptWithAttachments`、`finish`）；notes 提示在 `src/preamble.ts`。

### 6.8 目录边界

- workgroup 根是 agent 的写根；`notes/`、`inputs/` 都可写。**网关状态在 cwd 之外**（`state/<workgroup_id>/`），agent 删不到 session 绑定和任务状态。
- 所有路径进入 agent 前做规范化（大小写、分隔符、`..`、符号链接、Windows 8.3 短名），且必须在 workgroup 根之下；越界一律 `deny`。
- Windows 长路径：启用 `\\?\` 前缀或 `LongPathsEnabled`；超过 260 字符在创建时即报错，不静默截断。
- 不跟随 junction/symlink 出工作区；符号链接指向外部时，访问被拒并记 warning。

### 6.9 单槽执行：一个 orca node 同一时间只做一件事

- 网关维护一个槽位：`busy = null | { task_id, origin_orca_node, since }`。
- 槽位被占时，新的 `message/send` 直接回 `429 orca_node_busy`，**不排队、服务端不自动重试**。
- **决策交给调用方的模型**，网关只报事实：
  1. 重试一次（响应会带 `retry_after_s`，读类任务通常够用）；
  2. 换另一个能跑这个任务的 orca node；
  3. 直接向用户回报“X 正忙，已跑 N 分钟”——尤其当**整个 mesh 只有这一台能执行该任务**时，这就是正确结局：把决策交还给人。

```json
// 429 的 error.data（Phase 0 已实现，另带 HTTP 头 Retry-After: 30）
{ "code": "orca_node_busy",
  "retry_after_s": 30,
  "holder": { "task_id": "t_01JABD", "origin_orca_node": "N7K3QM", "since": "2026-11-14T05:10:00Z" } }
```

**Phase 0 实现**：忙时返回 HTTP 429 + `Retry-After: 30`，JSON-RPC `error.code=-32000`、`error.message="orca_node_busy"`，`error.data={code:"orca_node_busy",retry_after_s:30,holder:{...}}`。`busy` 状态由 TaskRunner 内部维护；self record 与心跳里的 `busy` 仍固定为 `null`，UI 暂时看不到持有者（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。

- 忙时拒绝发生在**建 task 之前**：不产生 task、不消耗幂等键；模型重试就是一次新的 `message/send`。
- `busy` 写进 self record（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)），随心跳刷新；origin 的 UI 显示“B 正在跑 X，已 3 分钟”，和模型的判断互相印证（Phase 0 未实现，见上）。
- **本地硬预算**：`task_timeout_s`（默认 3600s）是本机对单个任务的硬上限，实际 TTL 取 `min(pod.task_ttl_s, task_timeout_s)`；到点先置终态、再 abort 执行器，语义是 `failed("task ttl exceeded", reason="timeout")`，不依赖任务自己配合。这个上限随 Agent Card、self record 与成员记录里的 `max_task_ttl_s` 对外公布，origin 据此决定拆多细的任务。
- **为什么单槽**：两个 agent 同改一棵树的冲突是语义层的（一个删了函数、另一个还在调），工程约束拦不住；而“同一 orca node 上跑多件事”争的是同一台机器的 CPU、磁盘和 DSH 状态，不是换个目录就能隔离的。
- 槽位在任务终态/取消/失败时释放；`input-required` 也释放（任务在等 A 回话时不占槽，[§4.8](04-transport.md#48-任务状态机)），恢复时重新竞争，不预留。orca node 进程崩溃或重启时，SQLite 里所有非终态 task 在下次启动时标成 `failed(node_restart)`（[§6.10](06-execution.md#610-session-context-workspace-的绑定)、[§8.3](08-reliability.md#83-目标重启)），不自动续跑。

### 6.10 session / context / workspace 的绑定

```text
(workgroup_id, origin_orca_node, context_id) → session_id
session_id → workspace（本 orca node 唯一的那份）
```

- 同一个 context 的后续任务复用同一 session（同 cwd、同对话历史）。
- 不同 context 各自新 session，但**共用同一份工作区**，所以文件上下文不断。
- 网关重启 / session 丢失：**不猜旧 session**，直接开新 session、cwd 不变；第一条 prompt 里带一句“先读 `notes/STATUS.md`”。会话可丢，工作区不丢。
- 目标 orca node 重启后：task 状态保留在 SQLite 里，`tasks/get` 仍可查；`submitted/working/input-required` 一律按 [§8.3](08-reliability.md#83-目标重启) 标 `failed(node_restart)`，`working` 带 `effects_unknown=true`，不尝试 resume。工作区目录不删，cwd 不变。

### 6.11 任务结果与产物

任务结果分三层，不要混在一起：结论是给人看的，`notes/` 是给下一个 session 看的；混在一起会出现多份状态副本，谁也不知道哪份对。

| 层 | 走哪 | 说明 |
|---|---|---|
| 结论文本 | `tasks/get` 的 `status.message`，内联 | agent 最后一轮说的话，按本地 `result_max_bytes`（默认 32 KiB）截断，末尾带 `…[summary truncated at N bytes]` |
| 产物文件 | blob 通道（[§5.6](05-tasks.md#56-文件交换blob-通道)） | manifest 给 `{blob_id, name, media_type, bytes}`；origin 按需拉 |
| 工作区状态 | 本机 `notes/` | **不离开目标机**；要让 origin 知道进展，由 agent 在结论文本里摘要 |

**超长文本下载后的文件名**：blob 本身不存名字（`blob_id` 是内容哈希，同内容不同名会冲突），名字只存在任务 manifest 的 `name` 字段里。origin 按 manifest 落盘；直接走 URL 的场景用 `GET /blobs/<id>?name=<name>` 传提示名，服务端只用它生成 `Content-Disposition`，校验无路径分隔符、无 CRLF、长度 ≤ 200 字符，不合法就忽略、回落到 `blob_id`。

任务终态时 manifest 形如：

```json
{
  "task_id": "t_01JABD",
  "result_text_chars": 1200,
  "changed": ["src/main.ts", "README.md"],
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

- `changed` 一律**相对 workgroup 根**；出现绝对路径或 `..` 直接判 manifest 非法。
- `patch` 是可选 artifact（`git diff` 产物）；有 git 时建议给，便于 review 与回滚。
- artifact **不内联**，只给 blob 引用；origin 取不取、什么时候取，由人决定。
- 结论文本超过 `result_max_bytes`：截断并加标记；不额外写 `result.txt` blob。要传大文件，由子节点在结论文本附录里贴一个 `publish` 出来的 blob URL（[§5.6](05-tasks.md#56-文件交换blob-通道)）。
- `usage`（input/output/cache_read tokens）记录在 `tasks/get` 的 `usage` 字段，供 origin 估算成本；没有执行器用量时省略该字段。
- 凭据类内容按 [§7.15](07-security.md#715-凭据回传与注入防护) 的策略处理，不因为“在 artifact 里”就绕过。

### 6.12 明确不做

- **不做发布式目录**：`label`、`fingerprint`、`containment` 检查全部不实现。origin 只能在目标 orca node 自动分配的工作区里跑。单槽 + 自动分配已经够用；发布真实目录会额外引入隔离、配额、清理三层复杂度。
- **不做多任务并发 / task-subdir 隔离**：orca node 单槽（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- 不做反向挂载 / SMB / NFS / 9p / 分布式 FS：网络文件系统会把锁、延迟、大小写语义带进 agent 的失败模式；
- 不做跨 orca node 共享同一个 session（session 是本地的）；
- 不做“origin 直接编辑 target 上的文件”（只能通过任务）；
- 不做自动 git push/pull（网络与凭据是另一个问题域）；
- 不把工作区同步到其它 orca node（每个 orca node 各自一份，靠 notes/artifact 交接）。

### 6.13 配额、清理、跨平台

- 配额：`max_disk_bytes`（默认 5 GiB）、`max_files`（默认 50k）；超限时任务 `failed(quota_exceeded)`，不静默丢文件。
- 清理：工作区不按 TTL 删；只在配额压力下按“最久未使用”驱逐，并提前在 UI 标黄；`purge` 是显式动作，要求二次确认。
- 跨平台：目录分隔符、大小写不敏感（Windows）、保留名（`CON`、`NUL`、`aux`）、尾随点/空格都要处理；路径比较统一用规范化后的形式。
- 记录：每个任务记录 `workgroup_id`、实际 cwd（相对路径）、写入了哪些文件。

### 6.14 AcpExecutor（Phase 2/3 长任务执行器）

Phase 2 的第二个真实执行器，也是唯一能承接**权限挂起**的那种：任务交给 `dsh --profile acp`（stdio 上的 Agent Client Protocol，JSON-RPC 换行分隔），executor 把 `session/update` 与 `session/request_permission` 翻译成 `LocalExecutor` 事件。

配置：

```
"executor": "acp",
"acp": { "command": "dsh", "profile": "acp", "extra_args": [] }
```

cwd = workgroup 根；每次任务一条 in-flight prompt（ACP 服务端本身也限制一条）。

| ACP | executor |
|---|---|
| `initialize` → `{protocolVersion: 1, ...}` | 连接就绪；`clientCapabilities` 只声明空 fs/terminal 能力 |
| `session/new {cwd, mcpServers: []}` | 开工前建会话；`sessionId` 写 `<data_root>/state/<workgroup_id>/sessions.json` |
| `session/resume {sessionId, cwd}` | 重启或第二次任务优先复用；失败回落 `session/new` |
| `session/prompt {sessionId, prompt: [{type:"text", text}]}` | 发送任务文本 |
| `session/update` → `agent_message_chunk` | 累积结论文本 |
| `session/update` → `agent_thought_chunk` / `tool_call` / `usage_update` | 忽略（不映射成事件） |
| `session/request_permission` | `yield suspend {kind:"permission", tool: toolCall.title, requested: options}` |
| resume 带 grant | 回 `{outcome:{outcome:"selected", optionId:"allow-once"}}` |
| resume 为拒绝/取消 | 回 `{outcome:{outcome:"cancelled"}}`（服务端按 rejected 处理） |
| `stopReason: "end_turn"` | `completed(累积文本)` |
| `stopReason: "max_tokens"` / `"refusal"` | `failed(原因文本)` |
| 取消 | 发 `session/cancel`，`KILL_GRACE_MS`（2s）后关连接/杀进程树 |

**grant 与 ACP 的对齐**：[§7.11](07-security.md#711-grant) 的 grant 第一版就是 `allow_once`，与 ACP 的 `session/request_permission`（one-shot allow/reject）语义一一对应；target 侧不需要理解 grant 的具体工具参数，只把“允许/拒绝”翻译成 optionId。

**会话复用**：`state/<workgroup_id>/sessions.json` 的键是 `acp|<origin_orca_node>|<context_id>`；同一 origin+context 的重试与重启都复用同一 ACP session（重启时 `session/resume`）。

**给 ACP 会话加工具：CLI 优先（Phase 3）**：ACP agent 自带 shell（实测可执行命令），所以不需要把工具 schema 常驻进上下文。`AcpExecutor` 在每条 prompt 前加一段 preamble——`[orca-pod] You are executing task <id> as orca node <id>`、`orca-node` CLI 的绝对路径、`send`/`wait`/`escalate` 用法与退出码——agent 用 shell 调 CLI 即可派任务、查状态、等结果，子任务需要权限时用 `escalate` 把决定权交还 origin（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。CLI 读本机 `config.json` 派生密钥，对 loopback `/a2a` 按本 orca node 身份签名，走的仍是 [§4.8](04-transport.md#48-任务状态机) 的 A2A 路径；CLI 不是节点，没有独立身份。`send --local-task <此 task>` 建子任务时向本机登记 child-link（子进程自动带父任务 id），本节点每 1s 轮询子任务、遇到权限请求就把父任务挂起为 `input-required`，由 origin 一处决定（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)），agent 不必再单独调 `escalate`；`wait --local-task` 保留手动上升路径（同一 `request_id` 只上升一次）。同一套用法也随包发布为标准 skill bundle（`skills/orca-node/`，随包发布），并可经 `skill_injection` 复制到 user 根（默认关）；executor 还会给 ACP 子进程注入 `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT`，技能与 preamble 互为兜底。MCP（`acp.mcp_servers`）保留为可选透传：需要结构化 schema 的第三方工具仍可挂，但 orca-pod 自己的 `orca_pod` 工具 不再依赖它。

**不做**：把 `message/stream` 的进度透传到 A2A 流（结论仍走 `tasks/get` 轮询）、`tool_call` 事件透传、ACP 的 client filesystem/terminal 能力、多 in-flight prompt。

**真实冒烟**（需要模型凭据，不进 `npm test`）：

```
DEEPSEEK_API_KEY=... node scripts/e2e-acp.mjs
```

本机实测（2026-11-14，Windows）：`Reply with exactly the word pong` → `completed`、结论文本 `pong`、约 2.6s；`state/<workgroup_id>/sessions.json` 写入 `acp|<origin_orca_node>|ctx-e2e-acp` 的绑定。

**测试**：`test/acp.test.ts` + `test/fixtures/fake-acp.mjs`（模式 `ok | permission | hang | resume-fail | model-reject`）。覆盖：完成与 cwd、权限挂起→`approveTask`→继续、取消发 `session/cancel`、同 context 复用 session（`session/new` 一次）、重启后 `session/resume`、命令不存在直接 `failed`，以及按任务选模型（`session/set_config_option` 先于 `session/prompt`；目标拒绝时 `failed(model_unavailable)`）。

### 6.15 按任务选择模型

orca node 的默认模型由本机 profile 决定（`agent-default-model` 插件），但同一 mesh 里的机器可能装着不同 provider/模型。协议为此只加两样东西：**节点自述目录**与**任务里的可选选择**，不发明跨节点配置通道。

**自述**：`PeerView`（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）带 `models`（`[{provider, model, name?, description?}]`，上限 128 条，去重）、`default_model`（`{provider, model, reasoning_effort?}` 或 `null`）与 `default_reasoning_effort`（字符串或 `null`）。它们随 join 请求、self record、心跳目录与 `/cluster/members` 传播，也参与 `members_digest`（目录变化会让对端重新拉一次成员表）；**不进**公开的 Agent Card，模型清单只对同组成员可见。插件启动后通过 DSH Host 的 `llm` 服务枚举 `${provider}×listModels`（单 provider 失败只记日志），默认模型取 `agentDefaultModel.currentSelection()`；纯 CLI 节点没有 Host 服务，可在 `config.json` 手填 `models`/`default_model`/`default_reasoning_effort`，不填就是空目录。

**选择**：任务书 `metadata.pod.model` 可选 `{provider, model, reasoning_effort?}`，`metadata.pod.reasoning_effort` 可单独给；与 `pod.permission_mode` 同级校验（`validatePodMetadata`，非法直接 `bad_request`）。CLI `orca-node send --model <provider/model> [--reasoning-effort <effort>]`（effort 可单独给）与工具 `orca_pod` 的 `send` 方法的同名参数都落到这两个字段。**优先级**：任务显式值 > 节点本地默认（`config.default_model`/`config.default_reasoning_effort`，面板高级设置可配）> ACP/provider 默认；缺省本地值由 DSH 目录的 `agentDefaultModel` 提供，插件配置的 pin 优先于它。

**目标侧执行**：只有 ACP 执行器支持按任务选模型。它在 `session/new`/`session/resume` 拿到 `sessionId` 后、发 `session/prompt` 之前，按 ACP 的 `session/set_config_option` 选择 `configId="model"`、`value=JSON.stringify([provider, model])`（仅当本次有模型值时）；随后仅在本次有效 effort 存在时再选一次 `configId="reasoning_effort"`；没有就保持 provider 默认（DeepSeek 模型自带默认挡位，`dsh-acp` 会拒绝这类模型的空串 provider-default 值）。有效模型/effort = 任务请求值 ?? 节点本地默认。选择失败（值不在该会话的 configuration options 里、或 ACP 拒绝）→ 任务直接 `failed(model_unavailable)`，不会用默认模型偷偷跑。其他执行器（Echo）收到按任务模型或 effort 时不猜测，直接 `failed(model_unsupported)`。选择是**提示、不是授权**：目标机仍按本机 `permission_mode`、审批与工作区规则执行；模型目录也不泄露凭据或 provider 配置。

**测试**：`test/model-selection.test.ts` 覆盖配置校验边界（含 `default_reasoning_effort`）、join 目录双向可见（含 effort）、非 ACP 执行器 `model_unsupported`/effort `model_unsupported`、Host 服务目录采集（坏 provider 跳过）；ACP 选模顺序、节点默认 effort、任务覆盖 effort、无值清空与拒绝路径在 `test/acp.test.ts`，工具参数校验在 `test/plugin.test.ts`。

---

