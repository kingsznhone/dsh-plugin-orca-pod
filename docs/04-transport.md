# 04 传输与接口

> 本章描述 orca node 对外暴露的唯一 HTTP 入口：监听形态、路由表、反向代理、A2A 方法面与任务状态机。

## 4. 传输与接口

### 4.1 监听形态

- 只监听 **HTTPS**（TLS 1.3 上的 `HTTP/1.1`），端口 `11811`（可配；选在 10000–20000 之间，避开 Windows 上 Hyper-V/WSL 会预留的 40000–41890 段）。节点只以 DSH 插件的形态运行（[§2.3](02-model.md#23-部署形态)），默认绑 `127.0.0.1`：要在面板向导里显式选择 LAN 地址（或 `::`）才对外监听，否则局域网 peer 拨不进来。
- advertised endpoints 为空时按监听地址推导（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。
- 不开 HTTP/2：peer 调用都是短请求，HTTP/1.1 keep-alive 足够；出站按节点复用 TLS 连接。
- 不监听 UNIX socket：跨机没有意义，跨用户也没必要。
- 端口冲突：固定端口被占就启动失败并报错，不静默改端口。Windows 上 Hyper-V / WSL 会预留大段端口（`netstat` 也看不到持有者），所以 11811 只是默认值，不是可假设的常量。
- 端口 0：进程自己挑一个空闲端口，但会避开 WHATWG fetch 规定的禁用端口（`6000`、`6665–6669` 等，见 `src/api/gateway.ts` 的 `isBlockedFetchPort`）——这些端口内核能 bind，对端 `fetch` 却直接 `bad port`，等于节点永久 offline。显式配置到禁用端口时启动直接拒绝。实际监听端口只用来推导自述里的 `endpoints`，不回写 `settings.json`。
- **TLS 内建，没有 CA**（D63，[§7.4](07-security.md#74-tls)）：证书是节点用自己的 Ed25519 身份密钥自签的，每次启动现签、不落盘，所以没有证书轮换；拨号方按节点 id 钉住证书的公钥。没有明文端口，本机进程（任务会话访问 `/local/*`）也走 HTTPS。`http://` 的地址（旧设置文件、旧版本写下的 peers）一律按 `https://` 读。

### 4.2 路由表

每条路由都在注册时声明 `config.access`，缺了启动即失败；一个 `preValidation` 钩子统一验证请求头里的两样证明（**Ed25519 签名 + workgroup HMAC 证明**，[§7.1](07-security.md#71-workgroup-与密码)），所有错误由同一个错误处理器输出，所有给签名请求的答复也由同一个钩子签名（见下）。`access` 有四类：

| access   | 谁能调用                                                                                                |
| -------- | ------------------------------------------------------------------------------------------------------- |
| `public` | 任何人                                                                                                  |
| `hello`  | 两样证明都对的节点；签名可以不带接收方 id，因为首次接触还不知道它                                       |
| `member` | 两样证明都对、且签名绑定的接收方就是本节点。**不查成员表**：成员表只决定谁在线、往哪里拨，不管准入       |
| `local`  | 本机持有节点本地令牌的进程：任务会话由执行器拿到令牌（`X-Orca-Local` 头），不验签名，令牌随节点存续；连接必须来自本机（回环，或本机连自己所绑的地址），带代理头的不算，否则 `403 not_local` |

**请求与答复的头**（所有节点间路由都一样）：

```text
请求  Authorization: Pod id=<发起方>; wg=<workgroup_id>; target=<接收方|空>; ts=…; nonce=…;
                        sig=<Ed25519(输入)>; proof=<HMAC-SHA256(workgroup key, 输入)>
      输入 = "orca-pod/request" | 方法 | target | 路径+查询 | sha256(body) | ts | nonce | workgroup_id

答复  Pod-Reply: id=<应答方>; sig=<Ed25519("orca-pod/reply" | 请求 nonce | status | sha256(body))>
```

- 发起方在 `HttpPeerClient` 里统一验答复：已知节点的答复必须由它签名，首次接触时答复里的 `id` 就是 TOFU 记下的身份；答复签名绑定请求的 nonce，所以一个答复不能被挪去冒充另一个请求的答复。验不过按 `peer_error`。
- **文件下载**的答复是流，事先算不出 sha256，所以签名只覆盖 status 与 `blob_id`（`subject = blob:<blob_id>`）；收完后按内容的 sha256 校验——文件本来就按 sha256 命名。
- 保密由 TLS 负责（[§7.4](07-security.md#74-tls)），签名负责完整性与来源。两者分工：签名绑在每个请求上，经过反向代理（TLS 在代理处终结）也照样有效；TLS 只保护这一跳连接。

`/orca-api`（面板）不是网关路由，也没有 access 级：它由 DSH web server 上的同源桥承接，准入与 DSH 自己的 `/api` 相同：`ctx.connection.admit` 验 `Host`/`Origin` 信任与浏览器会话 cookie（`401 unauthorized` / `403 forbidden`），只放行 owner；另要 `X-Orca-Pod` 请求头（`403 cross_origin`），非 GET 且无 JSON `Content-Type` 时为 `403 json_required`。不验节点签名（[§7.1](07-security.md#71-workgroup-与密码)）。

| Method | Path                           | 用途                                                       | access                          |
| ------ | ------------------------------ | ---------------------------------------------------------- | ------------------------------- |
| GET    | `/health`                      | 进程存活探针，返回 `{status:"ok", orca_node_id}`           | public                          |
| POST   | `/a2a`                         | A2A JSON-RPC：`message/send`、`tasks/get`、`tasks/cancel`（§4.7） | member                          |
| GET    | `/blobs/{blob_id}`             | 下载本节点发布的文件                                       | member                          |
| POST   | `/local/blobs`                 | 任务会话登记本机文件（[§5.6](05-tasks.md#56-文件交换blob-通道)） | local                           |
| GET    | `/local/blobs/{node}/{blob_id}`| 任务会话取本机节点登记的文件                               | local                           |
| POST   | `/cluster/hello`               | 接触与心跳：自述 + 忙闲 + 摘要；答复自己的记录，摘要不一致时回目录（[§3.3](03-membership.md#33-心跳与双向看门狗)） | hello                           |

文件按 `<orca_node_id>/<sha256>` 命名，不按 URL（[§5.6](05-tasks.md#56-文件交换blob-通道)）：`/blobs/{blob_id}` 只读本节点登记的文件；取别的成员的文件由本机节点对象（`mesh.get(id).fetchBlob`）按对方宣告的地址去拨，所以发布方在反代后面也照样取得到。登记没有成员可用的路由，只在本机发生：宿主的 `orca_pod` 在进程内登记，任务里的 `orca_pod` 走只认本节点令牌的本地路由 `/local/blobs`（[§5.6](05-tasks.md#56-文件交换blob-通道)）；节点之间不推送文件。

约定：

- `/health` 不暴露成员数、工作区、忙闲、错误栈；`orca_node_id` 是公开信息，用来让脚本在首次接触前确认接收方身份。
- **没有公开的 Agent Card 或匿名目录**：`display_name`、`endpoints`、`max_task_ttl_s`、runtime、忙闲、模型目录只出现在签名的 `hello` 交换与成员记录里（§4.6）。
- 不提供 WebSocket、SSE：一条连接一种语义。任务进度靠 `tasks/get` 轮询，成员变化靠心跳周期（自适应 `N` 秒，[§3.3](03-membership.md#33-心跳与双向看门狗)）。
- 请求体上限：全局 `bodyLimit` **1 MiB**（签名需要 body 字节，认证发生在 body 解析之后、schema 校验之前，所以未认证请求能缓冲的上限必须小），没有任何路由放宽；文件只经 `GET` 流式下发。读超时与连接数上限没有显式配置。

**错误形态**统一为 `{ "code", "message" }`，HTTP 状态来自 `src/core/errors.ts` 里的 `code → 状态` 表（一个错误码不在表里就编译不过）：

| 状态 | 错误码                                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------- |
| 401  | `missing_auth`、`malformed_auth`、`clock_skew`、`nonce_replay`、`bad_signature`、`wrong_target`、`stale_request`、`bad_proof` |
| 403  | `not_task_origin`                                                                                                           |
| 400  | `bad_request`、`unsupported`、`workgroup_mismatch`、`endpoint_refused`                                                       |
| 404  | `task_not_found`、`blob_not_found`、`unknown_orca_node`                                                                     |
| 409  | `permission_denied`                                                                                                          |
| 410  | `blob_expired`、`blob_file_missing`                                                                                         |
| 413  | `body_too_large`                                                                                                            |
| 429  | `orca_node_busy`（带 `retry_after_s: 30`、`holder`，并设 `Retry-After` 头）                                                 |
| 500  | `internal`                                                                                                                  |
| 502  | `peer_error`                                                                                                                 |
| 507  | `quota_exceeded`（工作区超配额，[§6.13](06-execution.md#613-配额清理跨平台)）                                                |

`/a2a` 上同样的错误包成 JSON-RPC 错误：`{ jsonrpc, id, error: { code: -32000, message: <错误码>, data: { code, message, … } } }`。出站调用在本机抛出的 `unknown_peer`（404）、`peer_not_online`（503）、`peer_error`（502）、`peer_timeout`（504，DSH 的 `deadline` 到点）不会出现在线上（§4.7）。

### 4.3 反向代理注意事项

反向代理是可选的：节点自己就加密。挂在代理后面（例如 VPS 上用 Caddy 给一个域名）时，拨号方见到的是代理的 CA 证书，它按域名校验接受（[§7.4](07-security.md#74-tls)）。

| 事项     | 要求                                                                                                                                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 上游协议 | 上游是 HTTPS，证书自签（Ed25519）：Caddy 写 `reverse_proxy https://127.0.0.1:11811 { transport http { tls_insecure_skip_verify } }`。跳过校验只影响本机这一跳，请求与答复的签名仍端到端校验。Go 的 TLS 默认支持 Ed25519 证书（未在 Caddy 上实测） |
| 心跳路径 | 不要给 `/cluster/hello` 加缓存；代理层保持 keep-alive 到上游                                                                                                                                                                                  |
| 转发头   | 不读 `X-Forwarded-*` 做鉴权或判定“本机”：客户端地址只用 socket；面板入口不看转发头，靠 DSH 的会话 cookie 认人                                                                           |
| 对端地址 | 节点互通靠 **`hello` 请求体里自报的 `endpoints`**（有序列表，可含 IPv6/IPv4、局域网与公网地址），不靠来源 IP：反代部署必须把公网 URL 配进 `endpoints`，否则对端会记下 loopback 地址、心跳发不过来；对端按顺序逐个尝试，一个地址不可达不代表 orca node 离线 |
| 健康检查 | 代理 `health_uri /health`，上游不需要鉴权                                                                                                                                                                                                         |
| 请求大小 | 代理与 orca node 两侧都要限；两侧取更小的（orca node 一侧是 1 MiB，没有更大的请求体）                                                                                                                                                              |
| TLS 端口 | 公网只开 443；orca node 端口只对代理或私网开放                                                                                                                                                                                                    |

`endpoints` 是 1–8 个 URL 的有序列表，顺序即拨号优先级，第一项是 primary（面板展示用它）。典型用法是同时宣告 IPv6 与 IPv4，或“局域网直连 + 公网反代”两条路：

```json
{
  "endpoints": ["https://[fd00::11]:11811", "https://192.168.1.11:11811", "https://desk.example.com"]
}
```

对端收到 `hello` 时拿到整张列表，此后每次心跳按顺序逐个尝试：任何一跳成功即视为可达，并记住成功的地址下一轮排到最前；全部失败才计一次心跳失败。监听地址由 `bind_host` 决定，`endpoints` 只回答“别人怎么拨我”。

### 4.4 公网暴露清单

在把 orca node 挂到公网之前，必须逐条确认：

1. workgroup 密码是生成的强密码（不是 `123456`，不是用户名）；
2. 设好本机权限上限（`permission_mode`）：别的节点派来的任务，权限由发起方批准；
3. 直接暴露（公网 IPv6、端口转发）时节点自己加密；挂代理时监听绑 `127.0.0.1`，公网入口只有代理；
4. `/health` 不泄漏拓扑、主机名、工作区；
5. 需要速率限制、失败计数或访问日志时放到代理层（插件自身不限流、不做审计落盘，[§7.8](07-security.md#78-审计)）；
6. 已接受“同 workgroup 的任一 orca node 可凭密码向本 orca node 派任务”这一事实（[§7.5](07-security.md#75-远程任务是不可信输入)）。

### 4.5 A2A 角色

每个 orca node 同时是 A2A server 和 A2A client。“对等”是逻辑对等：双方都能调用对方；不提供持久 socket，每次调用是 HTTP 请求。

### 4.6 公开面

匿名可读的只有 `GET /health`，它只回答 `{status:"ok", orca_node_id}`。

- `orca_node_id` 是公开信息，用来让脚本在首次接触前确认接收方身份。
- 没有 A2A Agent Card，也没有匿名目录：`display_name`、`endpoints`、`max_task_ttl_s`、runtime、忙闲、模型目录都只出现在签名的 `hello` 交换与成员记录里（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）；公开面不暴露拓扑。
- 执行什么由执行器与继承的权限模式决定，不由任何公开元数据声明（[§6](06-execution.md#6-执行与工作区)）。

### 4.7 方法与异步语义

`/a2a` 是 JSON-RPC 2.0，方法集：

- `message/send`：提交消息，始终返回 `Task`。`message.taskId` 为空时新建 task（`submitted` → `working`）；非空时是对挂起任务的恢复：task 必须处于 `input-required`（否则 `400 bad_request`），调用者必须是 task 的 origin（否则 `403 not_task_origin`），恢复时要重新拿到执行槽——槽被别的任务占着就回 `429 orca_node_busy`，**由上游自己决定什么时候重试**，不预留、不排队（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- `tasks/get`：按 task id 取状态与结论；未知 id 返回 `404 task_not_found`。任何成员都可读。
- `tasks/cancel`：只有 origin（或本机自己）可取消，否则 `403 not_task_origin`；对终态 task 原样返回，不报错。

用 A2A 而不是自造 RPC：有规范、有 SDK，task 生命周期与失败模式都被规范讨论过；自造只会把同样的坑再走一遍。方法面只取其中必要的子集。

**出站调用只有一个客户端**（`src/mesh/peer-client.ts`），它只负责签名、截止时间与读取上限，不知道有哪些节点；谁是对端、拨哪个地址是节点对象（`mesh/orca-node.ts`）的事。心跳、`sendTask`、tracker 都经节点对象走它：

- 每次调用带 DSH `deadline` 截止时间：默认 30s（`request_timeout_ms` 可调），心跳用 interval 的一半；响应必须是 `application/json`，且读到 4 MiB 即取消流并按协议错误处理——对端挂起或返回垃圾不会无限卡住工具调用与 tracker。
- 每个请求带两样证明，签名绑定接收方 `orca_node_id` 与 `path+query`（[§7.2](07-security.md#72-请求签名没有-session-token)）。接收方 id 就是调用的那个节点对象的 id，不再按 URL 反查。
- **按节点寻址，不做隐式接触**：工具与面板的 `peer` 参数是节点 id、唯一的显示名或该节点的 URL，统一走 `mesh.resolve`；不认识就是本机抛 `unknown_peer`，请求根本不发出。只有种子地址（设置里的 `peers`、记住的 peers、`connect` 工具、面板“连接”）才会向陌生地址发出 `hello`。陌生地址是否可信，是调用者在连接前该想清楚的事。
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

- `submitted`：已接收，未开始（组装任务书）。
- `working`：LocalExecutor 正在执行。
- `input-required`：需要发起 orca node **补授权**（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。载荷是 task 的 `status.message.parts` 里 data part 的 `permission_request`，不依赖推送；恢复消息必须是批准或拒绝（[§7.11](07-security.md#711-批准与拒绝)）。没有“补输入”的挂起：任务不能继续时以 `completed` 结束，结论首行写 `BLOCKED: …`（[§6.14](06-execution.md#614-acpexecutor)）。
- `input-required` **不占用执行槽**：任务挂起时槽位释放，恢复时重新竞争，不预留、不排队。槽被占就回 `429 orca_node_busy`，由 origin 决定重试还是放弃。
- 恢复 ACP 任务时复用同一个 ACP session（它没有退出），不是新开会话。
- 任务只有一跳：执行任务的 agent 不能再派任务（[§7.9](07-security.md#79-权限跟随发起-orca-node)），所以没有调用链，也没有回调祖先的问题。
- `completed` / `failed` / `canceled`：终态。终态不可逆；重试就是显式再派一个新 task，不复活旧 task。
- 任务状态每次变迁都写 SQLite（[§5.5](05-tasks.md#55-任务存储)）；进程重启时所有非终态 task 标 `failed(node_restart)`（[§8.3](08-reliability.md#83-目标重启)）。

---
