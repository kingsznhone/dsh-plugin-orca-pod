# 05 执行器

> 关注：任务真正怎么被跑起来——LocalExecutor 接口、ACP 的位置与映射、用脚本模拟任务的 EchoExecutor。
>
> 章节编号沿用全局编号；工作区与单槽在 06-workspace.md。

## 8. LocalExecutor

### 8.1 接口

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

  // 权限回调：目标节点策略层的唯一入口（§9.6）
  onPermissionRequest?(
    taskId: string,
    req: PermissionRequest
  ): Promise<"allow" | "deny" | "escalate">;
}
```

`permissionMode` 必须来自 origin 会话，由 A2A 请求携带并签名；target 不得上调它，只能按它执行或在越界时 escalate。

### 8.2 实现

| 实现 | 适用 | 优点 | 缺点 |
|---|---|---|---|
| `EchoExecutor` | Phase 0 协议验证 | 无 DSH 依赖、确定性 | 不执行真实任务 |
| `HeadlessExecutor` | 一次性任务 | 最简单，`dsh headless "..."` | 无流式、无协作取消、无多轮 |
| `AcpExecutor` | 长任务/进度/取消/多轮 | 流式、取消、session resume、权限钩子 | 本地仍是 client→agent |
| `InProcessExecutor` | 深度集成 | 无子进程协议、性能好 | 与 DSH 内部 API 耦合，升级易碎 |

推荐顺序：Echo → Headless → ACP。不要一开始就耦合 ACP。

### 8.3 ACP 的位置

```text
Pod gateway (local)
  → AcpExecutor
    → spawn dsh --profile orca（cwd = 本节点工作区）
      → stdio JSON-RPC
```

禁止：把 ACP 端口暴露给 peer；让 peer 直接发 ACP 请求；把 ACP sessionId 当 A2A taskId；原样转发 thought。

建议为集群任务使用**专属 profile**（如 `orca`），与用户日常 GUI profile 隔离；ACP 子进程的 `cwd` 必须是本节点工作区，不允许是用户家目录或 DSH profile 目录。

**默认不启用 pod 远程工具**；多跳与扇出是可选能力，配置 `delegation` 打开后才生效。理由不是“安全”，而是“一个会自己跑起来的集群很难调试”：默认行为应当是可预测的单跳。打开后网关会强制注入 `hop` / `chain` / `root`（[§7.5](04-tasks.md#75-任务标识与元数据)），并按 `max_hop` / `max_fanout` 拒绝超限；agent 不能自己填这些字段。

### 8.4 ACP 映射

| A2A | ACP | 说明 |
|---|---|---|
| `context_id` | session | 首次 `session/new`，cwd = 本节点工作区 |
| 一个 task | 一次 `session/prompt` | 同 context 串行；不同 context 也串行（节点单槽，[§11.4](06-workspace.md#114-单槽执行一个节点同一时间只做一件事)） |
| `session/update` | task status/artifact 事件 | 过滤 thought |
| prompt 返回 | 终态 | 按 `stopReason` 映射 |
| `tasks/cancel` | `session/cancel` | 超时后杀进程树 |
| 网关重启 | 新 session | 不猜旧 session；开新 session，cwd 不变（[§11.5](06-workspace.md#115-session-context-workspace-的绑定)） |
| `session/request_permission` | 策略层裁决 | 见 [§9.6](07-permissions.md#96-acp-requestpermission-映射)，**不弹本地窗** |

### 8.5 并发与串行

- 一个 context 同时只有一个 prompt（ACP 限制）；
- **整个节点同一时间只跑一个任务**（单槽，[§11.4](06-workspace.md#114-单槽执行一个节点同一时间只做一件事)）；忙时 `429 node_busy`，不排队；
- 过载一律 429，不排队、不等到超时；节点对外只有单槽（[§11.4](06-workspace.md#114-单槽执行一个节点同一时间只做一件事)）。

### 8.6 EchoExecutor：用脚本模拟任务

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

规则：

- `steps` 最多 8 个，`at_ms` 严格递增，总和 ≤ 60s；`at_ms` 从任务开始计，**挂起等待的时间不计入**（恢复后从上次位置继续），断言不依赖机器速度。
- `suspend.kind` 只有 `blocked` 与 `permission` 两种，分别生成 [§7.4](03-protocol.md#74-任务状态机) 的 `blocked` 和 [§9.4](07-permissions.md#94-升级回路任务状态不是反向调用) 的 `permission_request`；恢复需要 origin 发后续 message。
- `final.state` ∈ `completed | failed | hang`；`failed` 时 `text` 作为 `status.message`；`hang` 表示永不完成，用于测 TTL、失联与 `tasks/cancel`（只能被取消或 TTL 收掉）。`text` ≤ 8 KiB，**原样返回**，不做模板替换，便于逐字节断言。
- `artifacts` ≤ 4 个、每个 `content` ≤ 4 KiB：executor 真的写 blob 存储，返回的 `blob_id` 必须等于 `sha256(content)`。
- 脚本缺省等价于 `{ steps: [], final: { state: "completed", text: "echo" } }`，用于纯连通性探测。
- 非法脚本（未知字段、`at_ms` 不递增、`state` 非法）在**建 task 之前**就 `400 bad_echo_script`，不要执行到一半才炸。
- 真 executor 收到 `echo` 字段直接忽略，避免脚本泄漏到生产路径。

---
