# 04 传输与接口

> 本章描述节点对外暴露的唯一 HTTP 入口：监听形态、路由表、反向代理、A2A 方法面与任务状态机。

## 4. 传输与接口

### 4.1 监听形态

- 默认 `HTTP/1.1` 明文监听，端口 `41241`（可配）。默认绑 `127.0.0.1`，需要直连时显式改 `0.0.0.0` 或具体私网地址。
- 不开 HTTP/2：peer 调用都是短请求，HTTP/1.1 keep-alive 足够；TLS 由前置代理负责，代理到上游也走 HTTP/1.1。
- 不监听 UNIX socket：跨机没有意义，跨用户也没必要。
- 端口冲突：启动时检测并给出下一个可用端口的建议，写回配置，不静默改。

### 4.2 路由表

| Method | Path | 用途 | 鉴权 |
|---|---|---|---|
| GET | `/.well-known/agent-card.json` | A2A Agent Card（不含敏感信息） | 公开 |
| POST | `/a2a` | A2A JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel`、`message/stream` | workgroup 签名 |
| GET | `/health` | 进程存活探针（给代理/监控用） | 无鉴权，仅返回极小 JSON |
| POST | `/blobs` | 上传文件（内容寻址，流式） | workgroup 签名 |
| GET | `/blobs/{blob_id}` | 下载文件 | workgroup 签名（受 ACL 约束）或 `/link` 换来的短期 token |
| POST | `/cluster/join` | 引导：返回自述 + 全量目录 | workgroup 签名 |
| POST | `/cluster/heartbeat` | 心跳 + 摘要 + hints（+ 首次的 full self） | workgroup 签名 |
| GET | `/cluster/members` | 全量目录（自述记录数组，含忙闲） | workgroup 签名 |
| POST | `/cluster/leave` | 主动离开（best-effort，不是安全操作） | workgroup 签名 |

约定：

- `/health` 返回 `{"status":"ok","version":"0.1.0"}` 这类极小 JSON。不暴露节点 id、成员数、工作区、忙闲、错误栈。
- **Agent Card 公开可读，但不含敏感信息**：名字、端点、skills、协议版本。runtime、忙闲、配额、成员数只在签名的 `/cluster/members` 里。公开一张卡不暴露拓扑——拓扑在成员表里，而成员表是签名接口。
- 不提供 WebSocket。需要实时性时：
  - 任务进度 → `/a2a` 的 `message/stream`（SSE，同一 endpoint）；
  - 成员变化 → 心跳周期（2s）已足够；UI 需要更实时就等下一次心跳。
- Agent Card 的 `url` 指向 `/a2a`，不是根路径。
- 请求体上限（默认 8 MiB，artifact 走独立通道/引用）、读超时、连接数上限都要显式配置，别吃 Node 默认值。

### 4.3 反向代理注意事项

| 事项 | 要求 |
|---|---|
| SSE | 关闭响应缓冲（Caddy 默认 `flush_interval -1`；nginx `proxy_buffering off`、`X-Accel-Buffering: no`）；读超时 ≥ 心跳间隔 × 3 |
| 心跳路径 | 不要给 `/cluster/heartbeat` 加缓存；代理层保持 keep-alive 到上游 |
| 转发头 | 只有来自回环代理的 `X-Forwarded-For/Proto` 才可信；节点默认不读这些头做鉴权 |
| 健康检查 | 代理 `health_uri /health`，上游不需要鉴权 |
| 请求大小 | 代理与节点两侧都要限；两侧取更小的 |
| TLS 端口 | 公网只开 443；节点端口只对代理或私网开放 |

### 4.4 公网暴露清单

在把节点挂到公网之前，必须逐条确认：

1. workgroup 密码是生成的强密码（不是 `123456`，不是用户名）；
2. 监听绑 `127.0.0.1`，公网入口只有代理；
3. `/health` 不泄漏拓扑、主机名、工作区；
4. `/cluster/*` 有速率限制与失败计数；
5. 审计日志已开启；
6. 已接受“同 workgroup 的任一节点可凭密码向本节点派任务”这一事实（[§7.5](07-security.md#75-远程任务是不可信输入)）。

### 4.5 A2A 角色

每个节点同时是 A2A server 和 A2A client。“对等”是逻辑对等：双方都能调用对方；不提供持久 socket，每次调用是 HTTP 请求。

### 4.6 Agent Card

```json
{
  "name": "pod-N7K3QM",
  "description": "DSH node in workgroup whale-pod",
  "url": "http://192.168.1.11:41241/a2a",
  "version": "0.1.0",
  "protocolVersion": "0.x",
  "capabilities": { "streaming": true, "pushNotifications": false },
  "defaultInputModes": ["text/plain", "application/json"],
  "defaultOutputModes": ["text/plain", "application/json"],
  "skills": [
    { "id": "ping", "name": "ping", "description": "Return node identity and health" },
    { "id": "run", "name": "run", "description": "Execute a task on this node" }
  ],
  "securitySchemes": { "pod": { "type": "http", "scheme": "pod" } }
}
```

要求：

- Card 里不放密码、主机名、忙闲状态、内部拓扑、runtime。读取它不需要签名；敏感信息只在签名的 `/cluster/members`（[§2.5](02-model.md#25-节点自述记录selfrecord)）。
- `skills` 是能力声明，不是实现；执行由 LocalExecutor + 继承的权限模式决定。
- SDK 与 `protocolVersion` 必须 pin；不匹配 fail closed，并在日志里写清双方版本。

### 4.7 方法与异步语义

- `message/send`：提交消息；返回 `Task`（通常是 `submitted`/`working`）或直接 `Message`。
- `tasks/get`：按 task id 取状态/artifact。
- `tasks/cancel`：请求取消。
- 接续（C 接着在 B 上干）不单独设方法：就是一次带 `continuation_of` 的 `message/send`（[§5.7](05-tasks.md#57-任务接续c-接着在-b-上干)）。
- `message/stream`：SSE 流式接收状态/artifact 事件（可选）。
- `tasks/resubscribe`：断线后重连到已有流（可选）。
- push notification：后置，需要 webhook 鉴权、重试、SSRF 防护。

**关键语义：**

> A2A 的传输是同步 HTTP，任务语义是异步的。

不要在集群里让 `message/send` 的 HTTP 连接挂到任务结束。跨节点默认“建 task 即返回”，完成靠轮询或 SSE。某些 SDK 的 `blocking` 只用于本机测试。

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
- `input-required`：需要发起节点补输入或**补授权**（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。载荷在 task 的 `status.message` 里，不依赖推送。载荷有两种：`permission_request`（补授权）和 `blocked`（要决策：`{reason, question, options?}`）。
- `input-required` **不占用执行槽**：网关把槽释放；A 的后续 message 到达时重新竞争槽位，不预留、不排队。槽被别人占了就回 `429 node_busy`，由 A 决定重试还是放弃。
- 恢复执行时优先 `session/resume(context_id)` 续上原 session；session 已随进程退出而丢失时新开一个，并在 task 上记 `resume=degraded`（[§5.7](05-tasks.md#57-任务接续c-接着在-b-上干)）。
- 远程 agent 卡住时**不允许反向调用**祖先节点（[§5.1](05-tasks.md#51-任务标识与元数据)），只能把问题写进 `blocked` 并结束本轮；这既是防环，也是“异步任务”的正确表达。
- `completed` / `failed` / `canceled`：终态。
- 终态不可逆；重试要产生新的 task（带 `retry_of`），不复活旧 task。

---
