# 04 传输与接口

> 本章描述 orca node 对外暴露的唯一 HTTP 入口：监听形态、路由表、反向代理、A2A 方法面与任务状态机。

## 4. 传输与接口

### 4.1 监听形态

- 默认 `HTTP/1.1` 明文监听，端口 `11811`（可配；选在 10000–20000 之间，避开 Windows 上 Hyper-V/WSL 会预留的 40000–41890 段）。默认绑 `127.0.0.1`，需要直连时显式改 `0.0.0.0` 或具体私网地址。
- 不开 HTTP/2：peer 调用都是短请求，HTTP/1.1 keep-alive 足够；TLS 由前置代理负责，代理到上游也走 HTTP/1.1。
- 不监听 UNIX socket：跨机没有意义，跨用户也没必要。
- 端口冲突：启动时检测并给出下一个可用端口的建议，写回配置，不静默改。Windows 上 Hyper-V / WSL 会预留大段端口（实测 40000–41890 全部 bind 失败，`netstat` 也看不到持有者），所以 11811 只是默认值，不是可假设的常量：启动必须探测、失败就回退，并把实际 endpoint 写进日志与成员表。
- TLS 不内建：证书轮换不该成为集群协议的一部分，交给成熟的代理（[§7.4](07-security.md#74-tls-部署矩阵)）。

### 4.2 路由表

| Method | Path | 用途 | 鉴权 | 现状 |
|---|---|---|---|---|
| GET | `/.well-known/agent-card.json` | A2A Agent Card（不含敏感信息） | 公开 | 已实现（最小字段，见 §4.6） |
| POST | `/a2a` | A2A JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel`（当前实现子集，见 §4.7） | workgroup 签名 | 已实现 |
| GET | `/health` | 进程存活探针（给代理/监控用） | 无鉴权，仅返回极小 JSON | 已实现 |
| POST | `/blobs` | 上传文件（内容寻址） | workgroup 签名 | 已实现（内存存储；见 §5.6） |
| GET | `/blobs/{blob_id}` | 下载文件 | workgroup 签名（凭 `blob_id` 即可取）或 `/link` 直链 | 已实现 |
| POST | `/blobs/{blob_id}/link` | 换一条短期直链（`?exp=&sig=`） | workgroup 签名 | 已实现 |
| POST | `/cluster/join` | 引导：返回自述 + 全量目录 | workgroup 签名 | 已实现 |
| POST | `/cluster/heartbeat` | 心跳 + 摘要；摘要不一致时响应回目录（候选端点）；可带首次 self | workgroup 签名 | 已实现（含周期发送与看门狗） |
| GET | `/cluster/members` | 全量目录（自述记录数组，含忙闲） | workgroup 签名 | 已实现 |
| POST | `/cluster/leave` | 主动离开（best-effort，不是安全操作） | workgroup 签名 | 已实现 |

`/blobs` 已实现内存版（内容寻址、去重、256 MiB 上限、直链 TTL 300s）；配额、GC、`Content-Disposition` 见 §5.6 的未实现部分。

约定：

- `/health` 返回 `{"status":"ok","version":"0.1.0"}` 这类极小 JSON。不暴露 orca node id、成员数、工作区、忙闲、错误栈。
- **Agent Card 公开可读，但不含敏感信息**：目标字段是名字、端点、skills、协议版本；Phase 0 的卡只有名字、端点、协议版本（见 §4.6）。runtime、忙闲、配额、成员数只在签名的 `/cluster/members` 里。公开一张卡不暴露拓扑——拓扑在成员表里，而成员表是签名接口。
- 不提供 WebSocket：一条连接一种语义，WS 会变成第二套状态机。需要实时性时：
  - 任务进度 → `/a2a` 的 `message/stream`（SSE，同一 endpoint）；
  - 成员变化 → 心跳周期（2s）已足够；UI 需要更实时就等下一次心跳。
- Agent Card 的 `url` 指向 `/a2a`，不是根路径。
- 请求体上限（默认 8 MiB，artifact 走独立通道/引用）、读超时、连接数上限都要显式配置，别吃 Node 默认值。Phase 0 为了 blob 上传把全局 `bodyLimit` 放到 256 MiB，JSON 路由也一起放宽；后续应改成 blob 路由单独限额、JSON 回落到 8 MiB。

### 4.3 反向代理注意事项

| 事项 | 要求 |
|---|---|
| SSE | 关闭响应缓冲（Caddy 默认 `flush_interval -1`；nginx `proxy_buffering off`、`X-Accel-Buffering: no`）；读超时 ≥ 心跳间隔 × 3 |
| 心跳路径 | 不要给 `/cluster/heartbeat` 加缓存；代理层保持 keep-alive 到上游 |
| 转发头 | 只有来自回环代理的 `X-Forwarded-For/Proto` 才可信；orca node 默认不读这些头做鉴权 |
| 健康检查 | 代理 `health_uri /health`，上游不需要鉴权 |
| 请求大小 | 代理与 orca node 两侧都要限；两侧取更小的 |
| TLS 端口 | 公网只开 443；orca node 端口只对代理或私网开放 |

### 4.4 公网暴露清单

在把 orca node 挂到公网之前，必须逐条确认：

1. workgroup 密码是生成的强密码（不是 `123456`，不是用户名）；
2. 监听绑 `127.0.0.1`，公网入口只有代理；
3. `/health` 不泄漏拓扑、主机名、工作区；
4. `/cluster/*` 有速率限制与失败计数；
5. 审计日志已开启；
6. 已接受“同 workgroup 的任一 orca node 可凭密码向本 orca node 派任务”这一事实（[§7.5](07-security.md#75-远程任务是不可信输入)）。

### 4.5 A2A 角色

每个 orca node 同时是 A2A server 和 A2A client。“对等”是逻辑对等：双方都能调用对方；不提供持久 socket，每次调用是 HTTP 请求。

### 4.6 Agent Card

```json
{
  "name": "pod-N7K3QM",
  "description": "DSH orca node in workgroup orca-dev",
  "url": "http://192.168.1.11:11811/a2a",
  "version": "0.1.0",
  "protocolVersion": "0.x",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    { "id": "ping", "name": "ping", "description": "Return orca node identity and health" },
    { "id": "run", "name": "run", "description": "Execute a task on this orca node" }
  ],
  "securitySchemes": { "pod": { "type": "http", "scheme": "pod" } }
}
```

**Phase 0 实现**：当前 `url` 已指向 `<endpoint>/a2a`；网关只返回 `name`、`protocol_version`、`url` 三个字段（实现用 snake_case `protocol_version`，值为 `0.1.0`），其余字段尚未实现。完整 Card 字段与 A2A schema 的对齐是后续里程碑。

要求：

- Card 里不放密码、主机名、忙闲状态、内部拓扑、runtime。读取它不需要签名；敏感信息只在签名的 `/cluster/members`（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。
- `skills` 是能力声明，不是实现；执行由 LocalExecutor + 继承的权限模式决定。
- SDK 与 `protocolVersion` 必须 pin；不匹配 fail closed（半兼容的 SDK 比不兼容更难查），并在日志里写清双方版本。

### 4.7 方法与异步语义

当前已实现的方法子集（Phase 0）：

- `message/send`（已实现）：提交消息，始终返回 `Task`（`submitted`/`working`）。`message.taskId` 为空时新建 task；非空时只接受处于 `input-required` 的 task，视为对挂起任务的恢复，其他状态返回 `bad_request`。
- `tasks/get`（已实现）：按 task id 取状态与 artifact；未知 id 返回 `task_not_found`。
- `tasks/cancel`（已实现）：请求取消；对终态 task 原样返回，不报错；`hang` 任务只能被取消或 TTL 结束。

设计与尚未实现的方法：

- 接续（C 接着在 B 上干）不单独设方法：就是一次带 `continuation_of` 的 `message/send`（[§5.7](05-tasks.md#57-任务接续c-接着在-b-上干)）。当前实现未处理 `continuation_of` 元数据。
- `message/stream`：SSE 流式接收状态/artifact 事件（可选，**未实现**）。
- `tasks/resubscribe`：断线后重连到已有流（可选，**未实现**）。
- push notification：后置，需要 webhook 鉴权、重试、SSRF 防护（**未实现**）。

**Phase 0 错误形态**：gateway 统一用 JSON-RPC error `code: -32000`，`message` 为业务错误码（`orca_node_busy`、`bad_echo_script`、`task_not_found`、`bad_request`、`unsupported`），HTTP 状态码依次为 429/400/404/400/400；尚未使用 A2A 规范里的细分错误码。

用 A2A 而不是自造 RPC：有规范、有 SDK，task 生命周期与失败模式都被规范讨论过；自造只会把同样的坑再走一遍。

**关键语义：**

> A2A 的传输是同步 HTTP，任务语义是异步的。

不要在集群里让 `message/send` 的 HTTP 连接挂到任务结束。跨 orca node 默认“建 task 即返回”，完成靠轮询或 SSE。某些 SDK 的 `blocking` 只用于本机测试。

> `input-required` 的授权请求是**任务状态**，不是推送消息：origin 停轮询、断 SSE 后恢复，`tasks/get` 仍能拿到同一份 `permission_request`。

### 4.8 任务状态机

```text
submitted ──► working ──► input-required ──► working
                 │
                 ├──► completed
                 ├──► failed
                 └──► canceled
```

- `submitted`：已接收，未开始。
- `working`：LocalExecutor 正在执行。
- `input-required`：需要发起 orca node 补输入或**补授权**（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。载荷在 task 的 `status.message` 里，不依赖推送。载荷有两种：`permission_request`（补授权）和 `blocked`（要决策：`{reason, question, options?}`）。
- `input-required` **不占用执行槽**：网关把槽释放；A 的后续 message 到达时重新竞争槽位，不预留、不排队。槽被别人占了就回 `429 orca_node_busy`，由 A 决定重试还是放弃。
- 恢复执行时优先 `session/resume(context_id)` 续上原 session；session 已随进程退出而丢失时新开一个，并在 task 上记 `resume=degraded`（[§5.7](05-tasks.md#57-任务接续c-接着在-b-上干)）。
- 远程 agent 卡住时**不允许反向调用**祖先 orca node（[§5.1](05-tasks.md#51-任务标识与元数据)），只能把问题写进 `blocked` 并结束本轮；这既是防环，也是“异步任务”的正确表达。
- `completed` / `failed` / `canceled`：终态。
- 终态不可逆；重试要产生新的 task（带 `retry_of`），不复活旧 task。

**Phase 0 实现**：六种状态与 `input-required`/取消/恢复路径已在 `tasks.ts` 的 TaskRunner 中实现；`input-required` 载荷位于 `status.message.parts[0]`，data part 形如 `{"blocked":{...}}` 或 `{"permission_request":{...}}`；进入 `input-required` 时释放单槽，恢复时重新竞争。尚未实现 `session/resume` 续接与 `resume=degraded` 标记，`retry_of` 也未接入。任务状态存在进程内存里（[§5.5](05-tasks.md#55-任务存储)），进程退出即丢失。

---
