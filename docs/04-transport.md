# 04 传输与接口

> 本章描述 orca node 对外暴露的唯一 HTTP 入口：监听形态、路由表、反向代理、A2A 方法面与任务状态机。

## 4. 传输与接口

### 4.1 监听形态

- 默认 `HTTP/1.1` 明文监听，端口 `11811`（可配；选在 10000–20000 之间，避开 Windows 上 Hyper-V/WSL 会预留的 40000–41890 段）。核心库与 DSH 插件都默认绑 `127.0.0.1`：插件首次启动要在面板向导里显式选择 LAN 地址（或 `::`）才对外监听，否则局域网 peer 拨不进来；`orca-pod install` 装的 systemd 服务默认绑 `::`。
- advertised endpoints 为空时按监听地址推导（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。
- 不开 HTTP/2：peer 调用都是短请求，HTTP/1.1 keep-alive 足够；TLS 由前置代理负责，代理到上游也走 HTTP/1.1。
- 不监听 UNIX socket：跨机没有意义，跨用户也没必要。
- 端口冲突：固定端口被占就启动失败并报错，不静默改端口。Windows 上 Hyper-V / WSL 会预留大段端口（`netstat` 也看不到持有者），所以 11811 只是默认值，不是可假设的常量。
- 端口 0：进程自己挑一个空闲端口，但会避开 WHATWG fetch 规定的禁用端口（`6000`、`6665–6669` 等，见 `src/transport/net.ts`）——这些端口内核能 bind，对端 `fetch` 却直接 `bad port`，等于节点永久 offline。显式配置到禁用端口时启动直接拒绝。`orca-node serve` 会把学到的实际地址与端口写回 `config.json`（已有的显式 `endpoints` 不覆盖）。
- TLS 不内建：证书轮换不该成为集群协议的一部分，交给成熟的代理（[§7.4](07-security.md#74-tls-部署矩阵)）。

### 4.2 路由表

每条路由都在注册时声明 `config.access`，缺了启动即失败；一个 `preValidation` 钩子统一做“验签 → 授权”，所有错误由同一个错误处理器输出。`access` 有五类：

| access   | 谁能调用                                                                                  |
| -------- | ----------------------------------------------------------------------------------------- |
| `public` | 任何人                                                                                    |
| `join`   | 任何持有 Ed25519 密钥的人（签名可以不带接收方 id，因为首次 join 还不知道它）              |
| `member` | 本机，或成员表里的 peer。验签只证明“持有私钥”，陌生人也能生成密钥，所以还要过成员闸门     |
| `link`   | `member`，或带本节点签发的 `?exp=&sig=` 的无签名直链                                      |
| `local`  | 仅本机：回环 socket、无转发头，且签名身份就是本机自己                                     |

| Method | Path                           | 用途                                                       | access                          |
| ------ | ------------------------------ | ---------------------------------------------------------- | ------------------------------- |
| GET    | `/health`                      | 进程存活探针，返回 `{status:"ok", orca_node_id}`           | public                          |
| GET    | `/.well-known/agent-card.json` | A2A Agent Card（见 §4.6）                                  | public                          |
| POST   | `/a2a`                         | A2A JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel`、`tasks/escalate`（§4.7） | member                          |
| POST   | `/blobs`                       | 上传文件（内容寻址，流式）                                 | member                          |
| GET    | `/blobs/{blob_id}`             | 下载文件                                                   | link                            |
| POST   | `/blobs/{blob_id}/link`        | 换一条直链（`?exp=&sig=`）                                 | member                          |
| POST   | `/cluster/join`                | 引导/准入：返回自述 + 目录                                 | join + 密码证明                 |
| POST   | `/cluster/heartbeat`           | 心跳 + 摘要 + 准入证明；摘要不一致时响应回目录             | member + 密码证明               |
| GET    | `/cluster/members`             | 全量目录（自述记录数组，含忙闲）                           | member                          |
| POST   | `/cluster/leave`               | 主动离开（不是安全操作）                                   | member                          |
| POST   | `/cluster/child-link`          | 本机 task 登记子任务，供自动上升（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)） | local                           |
| GET    | `/cluster/task?task=`          | 读本机任务视图，CLI 建子任务时据此继承 `hop/chain/root`    | local                           |

`/blobs` 是 fs 内容寻址存储（去重、单 blob 256 MiB、直链 7 天；配额与 GC 见 [§5.6](05-tasks.md#56-文件交换blob-通道)）；本机文件的登记没有 HTTP 路由，由 `orca-node publish` 直写本机 SQLite。

约定：

- `/health` 不暴露成员数、工作区、忙闲、错误栈；`orca_node_id` 是公开信息，用来让脚本在首次接触前确认接收方身份。
- **Agent Card 公开可读，但不含敏感信息**：只有名字、端点 URL、单任务预算（§4.6）。runtime、忙闲、模型目录、成员数只在签名的 `/cluster/members` 里。公开一张卡不暴露拓扑——拓扑在成员表里，而成员表是签名接口。
- 不提供 WebSocket、SSE：一条连接一种语义。任务进度靠 `tasks/get` 轮询，成员变化靠心跳周期（自适应 `N` 秒，[§3.3](03-membership.md#33-心跳与双向看门狗)）。
- 请求体上限：全局 `bodyLimit` **1 MiB**（签名需要 body 字节，认证发生在 body 解析之后、schema 校验之前，所以未认证请求能缓冲的上限必须小）；只有 `POST /blobs` 单独放宽到 **256 MiB**，且流式落盘、签名覆盖 `X-Pod-Body-SHA256`。读超时与连接数上限没有显式配置。

**错误形态**统一为 `{ "code", "message" }`，HTTP 状态来自 `src/kernel/errors.ts` 里的 `code → 状态` 表（一个错误码不在表里就编译不过）：

| 状态 | 错误码                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 401  | `missing_auth`、`malformed_auth`、`clock_skew`、`nonce_replay`、`bad_signature`、`wrong_target`、`stale_request`、`bad_proof` |
| 403  | `not_a_member`、`local_only`、`link_invalid`、`not_task_origin`、`ancestor_call_forbidden`                                  |
| 400  | `bad_request`、`bad_echo_script`、`unsupported`、`workgroup_mismatch`、`blob_digest_mismatch`、`input_blob_missing`、`too_many_inputs`、`inputs_too_large`、`endpoint_refused` |
| 404  | `task_not_found`、`blob_not_found`、`unknown_orca_node`                                                                     |
| 409  | `permission_denied`、`grant_invalid`、`grant_expired`、`escalation_required`、`duplicate_input_name`                        |
| 410  | `link_expired`、`blob_expired`、`blob_file_missing`                                                                         |
| 413  | `blob_too_large`、`body_too_large`                                                                                          |
| 429  | `orca_node_busy`（带 `retry_after_s: 30`、`holder`，并设 `Retry-After` 头）                                                 |
| 507  | `quota_exceeded`（工作区或 blob 存储超配额，[§6.13](06-execution.md#613-配额清理跨平台)）                                   |
| 500  | `internal`                                                                                                                  |

`/a2a` 上同样的错误包成 JSON-RPC 错误：`{ jsonrpc, id, error: { code: -32000, message: <错误码>, data: { code, message, … } } }`。出站调用在本机抛出的 `unknown_peer`（404）、`peer_not_online`（503）、`peer_error`（502）不会出现在线上（§4.7）。

### 4.3 反向代理注意事项

| 事项     | 要求                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 心跳路径 | 不要给 `/cluster/heartbeat` 加缓存；代理层保持 keep-alive 到上游                                                                                                                                                                                  |
| 转发头   | 不读 `X-Forwarded-*` 做鉴权或判定“本机”：客户端地址只用 socket；`local` 路由带任何转发头直接 `403 local_only`，所以代理不要转发 `/cluster/child-link` 与 `/cluster/task`                                                                           |
| 对端地址 | 节点互通靠 **join 请求体里自报的 `endpoints`**（有序列表，可含 IPv6/IPv4、局域网与公网地址），不靠来源 IP：反代部署必须把公网 URL 配进 `endpoints`，否则对端会记下 loopback 地址、心跳发不过来；对端按顺序逐个尝试，一个地址不可达不代表 orca node 离线 |
| 健康检查 | 代理 `health_uri /health`，上游不需要鉴权                                                                                                                                                                                                         |
| 请求大小 | 代理与 orca node 两侧都要限；两侧取更小的（blob 上传需要放宽到 256 MiB）                                                                                                                                                                          |
| TLS 端口 | 公网只开 443；orca node 端口只对代理或私网开放                                                                                                                                                                                                    |

`endpoints` 是 1–8 个 URL 的有序列表，顺序即拨号优先级，第一项是 primary（Agent Card `url`、blob 直链、CLI 展示都用它）。典型用法是同时宣告 IPv6 与 IPv4，或“局域网直连 + 公网反代”两条路：

```json
{
  "endpoints": ["http://[fd00::11]:11811", "http://192.168.1.11:11811", "https://desk.example.com"]
}
```

对端 join 时拿到整张列表，此后每次心跳按顺序逐个尝试：任何一跳成功即视为可达，并记住成功的地址下一轮排到最前；全部失败才计一次心跳失败。监听地址由 `bind_host` 决定，`endpoints` 只回答“别人怎么拨我”。

### 4.4 公网暴露清单

在把 orca node 挂到公网之前，必须逐条确认：

1. workgroup 密码是生成的强密码（不是 `123456`，不是用户名）；
2. 监听绑 `127.0.0.1`，公网入口只有代理；
3. `/health` 不泄漏拓扑、主机名、工作区；
4. `/cluster/*` 在代理层做速率限制与失败计数（插件自身不做限流）；
5. 访问日志由前置代理留档（插件不做审计落盘，[§7.8](07-security.md#78-审计)）；
6. 已接受“同 workgroup 的任一 orca node 可凭密码向本 orca node 派任务”这一事实（[§7.5](07-security.md#75-远程任务是不可信输入)）。

### 4.5 A2A 角色

每个 orca node 同时是 A2A server 和 A2A client。“对等”是逻辑对等：双方都能调用对方；不提供持久 socket，每次调用是 HTTP 请求。

### 4.6 Agent Card

`GET /.well-known/agent-card.json` 只返回三个字段：

```json
{
  "name": "书房台式机",
  "url": "http://192.168.1.11:11811/a2a",
  "max_task_ttl_s": 3600
}
```

- `name` 是 `display_name`；`url` 是 `<primary endpoint>/a2a`；`max_task_ttl_s` 是公开的调度预算，让 origin 在派任务前就能拆解。
- Card 里不放密码、主机名、忙闲状态、内部拓扑、runtime、模型目录；这些只在签名的 `/cluster/members` 里（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。
- 它不是完整的 A2A Agent Card schema：没有 skills、capabilities、securitySchemes。执行什么由 LocalExecutor + 继承的权限模式决定，不由 Card 声明。

### 4.7 方法与异步语义

`/a2a` 是 JSON-RPC 2.0，方法集：

- `message/send`：提交消息，始终返回 `Task`。`message.taskId` 为空时新建 task（`submitted` → `working`）；非空时是对挂起任务的恢复：task 必须处于 `input-required`（否则 `400 bad_request`），调用者必须是 task 的 origin（否则 `403 not_task_origin`），恢复时要重新拿到执行槽——槽被别的任务占着就回 `429 orca_node_busy`，**由上游自己决定什么时候重试**，不预留、不排队（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- `tasks/get`：按 task id 取状态与 artifact；未知 id 返回 `404 task_not_found`。任何成员都可读。
- `tasks/cancel`：只有 origin（或本机自己）可取消，否则 `403 not_task_origin`；对终态 task 原样返回，不报错。
- `tasks/escalate`：本机控制接口，CLI 用它把本机某个运行中的 task 挂起并上交子任务的权限请求（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）；非本机签名一律 `400 bad_request`。

用 A2A 而不是自造 RPC：有规范、有 SDK，task 生命周期与失败模式都被规范讨论过；自造只会把同样的坑再走一遍。方法面只取其中必要的子集。

**出站调用只有一个客户端**（`src/transport/peer-client.ts`），CLI、心跳、tracker、child-link 轮询都走它：

- 每次调用带 `AbortSignal.timeout`：默认 30s（`request_timeout_ms` 可调），心跳用 interval 的一半，CLI 上传放宽到 10 分钟；响应必须是 `application/json`，且读到 4 MiB 即取消流并按协议错误处理——对端挂起或返回垃圾不会无限卡住工具调用与 tracker。
- 签名绑定接收方 `orca_node_id` 与 `path+query`（[§7.2](07-security.md#72-请求签名没有-session-token)）。接收方 id 来自：本机自己、本机拨过的 URL 记录、或成员表里自述了该 URL 的成员。
- **不做隐式 join**：URL 不认识就是本机抛 `unknown_peer`，请求根本不发出。只有显式的 join/connect（插件 `connect`、CLI `serve --peer`、面板“连接”）才会向陌生地址发出准入证明。陌生地址是否可信，是调用者在 join 前该想清楚的事。
- 只有 `sendTask` 会新建 origin 派发日志；`tasks/get`、`tasks/cancel`、审批等读写只刷新已存在的条目，避免面板和轮询把别人的任务记成本机派发。目标不是 `online` 时 `sendTask` 直接 `peer_not_online`。
- 交接（C 接着在 B 上干）不单独设方法：就是一次普通的 `message/send`；C 从共享工作区里读现场，自己决定接着干什么（[§5.7](05-tasks.md#57-交接工作区即态势)）。

**关键语义：**

> A2A 的传输是同步 HTTP，任务语义是异步的。

不要在集群里让 `message/send` 的 HTTP 连接挂到任务结束。跨 orca node 默认“建 task 即返回”，完成靠轮询。

> `input-required` 的授权请求是**任务状态**，不是推送消息：origin 停轮询后恢复，`tasks/get` 仍能拿到同一份 `permission_request`。

### 4.8 任务状态机

```text
submitted ──► working ──► input-required ──► working
                 │
                 ├──► completed
                 ├──► failed
                 └──► canceled
```

- `submitted`：已接收，未开始（准备素材）。
- `working`：LocalExecutor 正在执行。
- `input-required`：需要发起 orca node **补授权**（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。载荷是 task 的 `status.message.parts` 里 data part 的 `permission_request`，不依赖推送；恢复消息必须是签名 grant 或拒绝。没有“补输入”的挂起：任务不能继续时以 `completed` 结束，结论首行写 `BLOCKED: …`（[§6.14](06-execution.md#614-acpexecutor)）。
- `input-required` **不占用执行槽**：任务挂起时槽位释放，恢复时重新竞争，不预留、不排队。槽被占就回 `429 orca_node_busy`，由 origin 决定重试还是放弃。
- 恢复 ACP 任务时复用同一个 ACP session（它没有退出），不是新开会话。
- 远程 agent 不能回调祖先 orca node：子任务的 `pod.chain` 含目标自己、或 `pod.root_origin` 就是目标时 `403 ancestor_call_forbidden`（[§5.1](05-tasks.md#51-任务标识与元数据)）。
- `completed` / `failed` / `canceled`：终态。终态不可逆；重试就是显式再派一个新 task，不复活旧 task。
- 任务状态每次变迁都写 SQLite（[§5.5](05-tasks.md#55-任务存储)）；进程重启时所有非终态 task 标 `failed(node_restart)`（[§8.3](08-reliability.md#83-目标重启)）。

---
