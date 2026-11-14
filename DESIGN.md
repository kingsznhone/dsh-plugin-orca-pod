# Whale Pod：分布式 DSH 对等集群宏观设计

> Status: Draft / handoff baseline  
> Revision: 2026-11-14  
> Scope: 2–10 台安装了 DSH 的机器，跨 Windows/Linux，对等任务调用与结果回报  
> Audience: 接手实现的新工作区 agent / 工程师  
> Rule: 本文是宏观基线。实现细节可以改，但“关键决策”不要无意中推翻；要改先写 ADR。

**术语警告（先读这条）：** 本文的 `workgroup_id` 是**集群命名空间 + 凭证作用域**（例如 `whale-pod`），不是 DSH 的 GUI 工作区，也不是文件系统路径。节点上真正干活的目录统一叫 `workspace`。协议里禁止传输绝对路径。

## 0. 一页摘要

Whale Pod 是一个小规模、对等的 DSH 集群：

- 每台机器上跑一个 **DSH 插件**（Pod 网关）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 本地执行由 **LocalExecutor** 驱动，ACP 只走本地 stdio，绝不跨网络。
- 节点之间是 **full mesh**，10 台以内不做 ring、不做 gossip、不做中心调度器。
- **默认单跳**：origin → target，不转发、不回调、不广播；多跳与扇出是可选能力，默认关闭（§13.6）。节点只被任务请求唤醒，忙时 429 而不是排队。
- **没有全局成员表，也没有成员版本号。** 每个节点的表里只放“我直接收到过它心跳”的节点；别人的表只能提供**候选端点**，不能替谁声明在线。
- 节点身份 = 安装时自动生成的 **6 字符短 id**（`N7K3QM`），可手改、持久化；它只是标签，不是安全主体。
- 认证 = `workgroup_id` + **非空密码**；密钥由密码直接派生，**每个请求现签现验，没有 session token、没有 TTL**。密码一致就能调，密码一改所有旧凭证立刻作废。
- 监听是**明文 HTTP/1.1 + keep-alive**；TLS 由 Caddy / nginx 终止，节点本身不必管证书。
- 任务面用 **A2A**：`message/send` 异步建 task，`tasks/get` 轮询，SSE 可选。
- 文件交换走**内容寻址 blob 通道**：素材先传后引用，产物按需拉取；结论文本内联返回，`notes/` 不出本机。
- **任务与产物凭 id 交接**：同 workgroup 任意节点知道 `task_id` / `blob_id` 就能读；没有列表接口，也没有 per-task ACL——id 就是句柄。
- **任务可以接续**：C 拿 A 的 `task_id`，用 `continuation_of` 在同一 context 与工作区开新任务接着干；旧 task 不可变。
- **权限跟着发起节点的会话走**：origin 的会话是只读，target 就只能读；是 workspace-write，target 就只能写工作区；超出的操作回到 origin 弹审批卡片，target 永不本地弹窗。
- 目标侧执行目录 = **workgroup 工作区**：加入 workgroup 时自动分配、跨任务持久、跨 session 保留上下文。**节点是单槽的**：同一时间只跑一个任务，忙时明确拒绝（不排队），忙闲状态对其他节点可见；**遇到忙时由调用方模型决定**重试、换节点还是回报用户。
- 任务状态落**单机 SQLite**；节点失联即任务失败，不重发、不猜、不复活。
- 一致性目标是 at-least-once + 幂等；`failed` 会明确标注“目标侧可能已产生副作用”。

---

## 1. 目标与非目标

### 1.1 目标

1. 任一节点都能向任一其他节点发起任务，并拿回状态和结果。
2. 节点对等：没有永久中心调度器；每个节点既是 A2A server，也是 A2A client。
3. 支持 2–10 个节点；10 个节点时 full mesh 仍然可控。
4. 新节点能用「任意一个已知节点的 host:port + workgroup 密码」加入，并在几个心跳周期内自动补全成 mesh。
5. 任务异步执行：提交后返回 task id，进度和结果通过 task 状态取回。
6. 节点上下线可被观测；某个节点掉线后，其余节点不再给它派任务。
7. 跨 workgroup 隔离；不同 workgroup 的节点互不可见、互不可调。
8. 本地执行器可替换：Echo / headless / ACP / in-process 不改变集群协议。
9. 设计可跨 Windows/Linux 移植；不依赖某台机器的本地路径或 DSH profile。
10. 节点信息可发现：OS 与版本、CPU、内存、GPU、DSH 版本，以及当前是否忙。
11. 长程协作连贯：同一个 workgroup 里，后续任务能在同一工作区接着上次的上下文继续，而不是每次从零开始。

### 1.2 非目标

1. **不做分布式共享会话/共享上下文**。每个任务在目标节点本地 DSH 里执行；A2A 只传任务和结果。
2. **不做 exactly-once**。采用 at-least-once + 幂等；需要强一致的场景另加外部协调。
3. **不做跨 workgroup 联邦**。不同 workgroup 默认互不可见。
4. **不做 ring。** 连接拓扑只有 full mesh，不保留“后续可选环”的设计位。
5. **不做全局成员表版本号（epoch）和节点代数（incarnation）。** 见 §10.1。
6. **不做被调用节点阻塞式人工审批。** 无人值守机器上弹窗等人是设计错误；审批只在发起节点做（§9）。
7. **不做 target-local-approval。** 目标侧本地弹窗没有意义：人不在那台机器前，弹了也没人点。
8. **不做共享文件系统 / 反向挂载。** 不引入 SMB/NFS/9p/分布式 FS；跨节点只传 artifact（§11.7）。
9. **不做空密码 workgroup。** 没有密码就没有认证，不存在“先跑起来再补”的中间态。
10. **不做 session token / 短期令牌。** 密码派生密钥直接做请求签名，少一层状态和一层失效语义。
11. **不把 ACP 或 MCP 当集群协议。** ACP 只允许本地 stdio；MCP 是 agent→tool，不是对等任务协议。
12. **不把 DSH 内部 Web API（`/api/*`、`/api/remote.mux`）当公开协议。** 它是单 Host 的内部 BFF，版本耦合。
13. **不做节点内建 TLS 作为默认部署。** 默认明文监听 + 前置代理；节点内建 mTLS 是 Phase 4 的可选项。
14. **不做公网裸奔。** 公网暴露必须经 TLS 代理或 VPN。

---

## 2. 关键决策

| # | 决策 | 理由 |
|---|---|---|
| D1 | 监听明文 HTTP/1.1 + keep-alive，端口 41241，默认绑回环；TLS 由 Caddy/nginx 终止 | 证书轮换不该是集群协议的一部分；代理是成熟解 |
| D2 | 任务面用 A2A，不用自造 RPC | 有规范、有 SDK、task 生命周期现成；失败模式也被规范讨论过 |
| D3 | A2A SDK 与 `protocolVersion` pin 死，不匹配 fail closed | 半兼容的 SDK 比不兼容更难查 |
| D4 | 不提供 WebSocket；实时性用 SSE + 心跳周期 | 一条连接一种语义；WS 会变成第二套状态机 |
| D5 | 拓扑只有 full mesh，10 节点上限 | 10 节点 = 45 条链路、45 心跳/s，完全可控；ring 解决的是不存在的问题 |
| D6 | 无 epoch、无 incarnation、无全局成员表 | 成员状态是每个节点的本地观测；引入版本号就需要共识，而这里不需要共识 |
| D7 | `node_id` = 6 字符 Crockford Base32 标签，装插件时生成，可改，非安全主体 | 短、可读、可在日志里念出来；安全性完全由密码承担 |
| D8 | 认证 = `workgroup_id` + 非空密码，密码经 HKDF 派生签名密钥，每个请求现签现验 | 无状态、无 TTL、无吊销列表；改密码 = 全局立即失效 |
| D9 | 禁止空密码 | 空密码在局域网上等于“任何人可派任务”；没有安全的默认 |
| D10 | 审批在 origin，且**继承 origin 会话的权限模式** | 人只坐在 origin 前；target 的权限不该比发起它的会话更宽 |
| D11 | 不做 target-local-approval | 无人值守机器上弹窗 = 任务永久挂起 |
| D12 | 默认执行目录 = workgroup 工作区（自动分配、持久、跨任务跨 session） | 临时目录让长程任务上下文断裂；协作需要“同一个办公室” |
| D13 | 不提供发布式目录；所有任务都在自动分配的 workgroup 工作区里跑 | 单槽 + 自动分配已经够用；发布真实目录会额外引入隔离、配额、清理三层复杂度 |
| D14 | 协议禁止绝对路径，任务只引用“本节点工作区” | 绝对路径是跨机器最不可移植、最不可审计的接口 |
| D15 | 任务存储用单机 SQLite（WAL），每个节点自己的库 | 2–10 节点不需要数据库服务；一个文件、一个进程、可备份 |
| D16 | 节点失联 → 任务直接 `failed`，不重发、不自动恢复 | 跨节点无法确认“执行到哪一步”，重发等于重复副作用；诚实失败胜过猜测 |
| D17 | 成员发现 = 惰性扩散：新节点按返回的目录逐个 join（幂等；签名心跳同样能完成首次登记） | 不需要广播协议；心跳本身就是“我在这里”的证明 |
| D18 | 心跳里的 `hints` 只是**端点候选**，不是在线声明 | 一旦允许转述“谁在线”，就会互相刷活，死节点永远删不掉（§10.5） |
| D19 | 不共享文件系统，只传 artifact + manifest | 网络文件系统会把锁/延迟/大小写语义带进 agent 的失败模式 |
| D20 | 集群逻辑只放插件，不改 DSH 核心 | 内核保持单机语义；集群是可选扩展 |
| D21 | 节点自述包含 runtime（OS/CPU/内存/GPU/DSH 版本） | 派任务前必须知道“那台机器能不能干这个活” |
| D22 | 凭据回传默认 `ask`，可配 `allow`/`deny` | 开发中确实要从远端取 key；但不能默认允许，也不能一刀切禁止 |
| D23 | 文件交换走独立 blob 通道（内容寻址、签名上传、短期下载 URL） | JSON 内联 base64 膨胀且不能流式；大产物不能塞进 A2A 消息 |
| D24 | 任务结论文本在 `tasks/get` 内联返回；`notes/` 只留在目标机 | 结论是给人看的，notes 是给下一个 session 看的；混在一起会导致状态复制多份、谁都不知道哪份对 |
| D25 | 节点单槽：同一时间只跑一个任务；忙时 `429` + `Retry-After`；忙闲写进 self record | 两个 agent 同改一棵树的冲突是语义层的，串行是唯一诚实的默认；单槽让“忙”可观测，而不是变成隐藏队列。**忙时怎么应对由调用方模型决定**（等、换节点、回报用户），网关不替它选 |
| D26 | Agent Card 公开可读；敏感信息只在签名接口 | 卡片里没有拓扑；拓扑在成员表里，锁成员表就够了 |
| D27 | 换密码 = 旧 mesh 解散；各节点用新密码重新 join 组成新 group | 没有“过渡期双密码”：密码是唯一凭证，混用会让信任边界模糊 |
| D28 | 失联节点的迟到结果不处理、不召回 | 副作用可能已发生，假装成功或事后缝合都会让人误判；诚实记 `failed` 更安全 |
| D29 | 每个节点只有一个 endpoint | 多端点会引入选路、切换、指纹不一致；NAT 穿透交给代理或 VPN |
| D30 | 10 节点是建议上限，不是硬限制；超过时 UI 提示心跳 O(n²) 负荷 | 10 节点 ≈45 req/s 尚可，20 节点 ≈190 req/s 就该告警而不是静默劣化 |
| D31 | `task_id` 与 `blob_id` 就是句柄：同 workgroup 任何成员凭 id 可读；不做 per-task / per-blob ACL，也没有列表接口 | 同组密钥已经共享，再加节点级 ACL 只是自我安慰；真正控制暴露面的是“id 不外传”和审计，不是多一层检查 |
| D32 | 任务接续：C 用 `continuation_of` 新建 task，复用 A 的 context 与工作区，旧 task 不可变 | 想把活交给另一台机器继续干，但 task 必须不可变；接续是“新任务 + 旧上下文”，不是复活旧 task |
| D33 | 多跳与扇出是能力，默认关闭（`max_hop=0`、`max_fanout=0`）；打开后网关注入 `hop`/`chain`/`root` 并限预算 | 默认单跳保证可预测；需要自组织编排时再开，而不是一开始就允许节点互相调用 |
| D34 | 子任务禁调祖先（硬限制，`403 ancestor_call_forbidden`），不受 `max_hop` 影响；阻塞只能写 `input-required` + `blocked` 回报，不能反向调用 | A→B→A 是最常见的环，靠深度限制要几跳才断，祖先禁调第一跳就断；同时逼出“异步回报 + 父节点决策”的正确用法 |
| D35 | 轮询归 Host 插件：`pod_send` 立即返回，后台 tracker 拉 `tasks/get`/SSE；状态回会话用 `agent.inject()`，只有必须立刻处理的事件才 `agent.followup()` 唤醒 | 让 agent 用 bash `sleep` 长轮询，每次 sleep 都是一轮上下文、超时还留孤儿进程；插件有单调时钟、可取消，也能把完成通知写进 inbox |
| D36 | 完成唤醒默认 `auto`：派发它的那一轮结束时任务仍未终态，就在终态到达时 `followup()` 唤醒；多个完成合并成一次，连续后台唤醒 ≤3 轮 | “派出去然后结束对话”是最常见的用法，不唤醒任务结果就没人看；但唤醒要合并、要限额，否则并发完成或 A→B→A 会把 token 烧光 |

---

## 3. 术语与命名约定

| 术语 | 含义 |
|---|---|
| **workgroup_id** | 集群命名空间 + 凭证作用域，如 `whale-pod`。正则 `[a-z0-9][a-z0-9-]{1,31}`。 |
| **node_id** | 6 字符短 id，节点的显示标签；同一 workgroup 内唯一，非安全主体。 |
| **Peer** | 同一 workgroup 内、本节点已知的另一个节点。 |
| **SelfRecord** | 节点对自己的描述（endpoint、runtime、工作区用量、忙闲），只能由本人写。 |
| **members_digest** | 排序后的成员记录摘要，用于“我落后了没有”的比对，不表达在线状态。 |
| **hint** | 心跳里捎带的 `(node_id, endpoint)` 候选，**不是**在线声明，见 §10.5。 |
| **candidate** | 由 hint 引入、尚未直接收到其心跳的节点，不进正式成员表。 |
| **tombstone** | 本地的“别再试它”标记，带过期时间；不传播。 |
| **workspace** | 节点上自动分配的持久目录，跨任务、跨 session 保留上下文。 |
| **group workspace** | 就是上面那个 `workspace`；本文有时强调“单节点一份”时这么叫。 |
| **session** | DSH / ACP 的会话状态，绑定 `(workgroup_id, origin_node, context_id)`。 |
| **context_id** | A2A 的逻辑会话 id，把多个 task 归到同一串工作里。 |
| **grant** | origin 签发的单任务授权，绑定 origin/target/task/nonce，随任务结束失效。 |

**命名注意：** `workgroup_id`、`workspace`、`session` 三者不能混用。DSH GUI 里把项目目录叫“工作区”，本文的 `workspace` 指的是被调用节点上自动分配的那份执行目录；代码与日志里不允许用裸的 `workspace` 表示命名空间。

**图里的调用关系：**

```text
Workgroup: whale-pod
Full mesh (<= 10 nodes), 唯一拓扑
```

---

## 4. 总体架构

```text
                     Workgroup: whale-pod
                     Full mesh (<= 10 nodes), 唯一拓扑

   ┌──────────── Caddy / nginx (TLS, 可选) ────────────┐
   │                    :443                           │
   └──────────┬───────────────────────────┬────────────┘
              │ reverse_proxy             │
              ▼                           ▼
        Node A  :41241               Node B  :41241
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Pod 插件（DSH 内）            │  │ Pod 插件（DSH 内）            │
│  ├ A2A server   /a2a         │  │  ├ A2A server   /a2a         │
│  ├ Agent Card   /.well-known │◄─┼─►├ Agent Card   /.well-known │
│  ├ 控制面       /cluster/*   │  │  ├ 控制面       /cluster/*   │
│  ├ 任务存储 (SQLite)          │  │  ├ 任务存储 (SQLite)          │
│  ├ LocalExecutor             │  │  ├ LocalExecutor             │
│  │   └ ACP client (stdio)    │  │  │   └ ACP client (stdio)    │
│  │      └ dsh --profile orca │  │  │      └ dsh --profile orca │
│  └ workgroup 工作区            │  │  └ workgroup 工作区            │
│ DSH: model + tools + sandbox │  │ DSH: model + tools + sandbox │
└──────────────────────────────┘  └──────────────────────────────┘

        Node C  ──────────────────────────────────────────  Node D
                          ... full mesh ...
```

### 4.1 两条独立平面

**任务面（A2A）**

```text
Origin
  → POST target /a2a  message/send          （带 grant + 继承的权限模式）
  → target task store (SQLite): submitted → working
  → origin 轮询 tasks/get（或 SSE）
  → completed + artifacts
  → origin 展示工作区状态与 run manifest
```

**控制面（cluster）**

```text
join（一次，凭 workgroup_id + 密码）→ 拿到 target 自述 + 全量目录
  → 向目录里每个 peer 发第一拍心跳（带 full self）
  → 对方收到 → 登记本节点 → 回心跳（双向计时开始）
  → 双向心跳 + 本地看门狗
  → 在线集变化 → 任务路由候选集变化
  → 漏掉的成员靠 members_digest 变化拉全量，≤2 个心跳周期收敛
```

任务面不负责成员发现；控制面不负责执行任务。两者共用一个 HTTP server，鉴权方式相同（同一把派生密钥），但权限与状态严格分开。

### 4.2 每个节点的职责

- 对外：A2A server（接收任务）、A2A client（发起任务）、控制面端点。
- 对内：成员观测、任务存储、LocalExecutor、工作区管理、DSH 生命周期。
- 安全：密码派生密钥、请求签名校验、grant 执行、硬拒绝清单、审计。
- 可观测：`trace_id`、`task_id`、peer 状态、工作区用量、审批记录。

### 4.3 部署形态

| 形态 | 监听 | TLS | 适用 | 备注 |
|---|---|---|---|---|
| 单机开发 | `127.0.0.1:41241` | 无 | 本机两进程、联调 | 仍然要密码，只是短一点 |
| 局域网直连 | `0.0.0.0:41241` 或私网 IP | 无（明文） | 家庭/办公室可信网络、VPN | 密码必须够强；跨网段建议走代理 |
| 反代 + 域名 | `127.0.0.1:41241` | Caddy / nginx | 公网、跨网段、多网卡 | 证书与 HSTS 归代理 |
| 内建 mTLS（后续） | 任意 | 节点自己 | Phase 4+ | 需要 CA 分发与轮换 |

---

## 5. 监听、端口与单入口路由

### 5.1 监听形态

- 默认 `HTTP/1.1` 明文监听，端口 `41241`（可配）。默认绑 `127.0.0.1`，需要直连时显式改 `0.0.0.0` 或具体私网地址。
- 不开 HTTP/2：peer 调用都是短请求，HTTP/1.1 keep-alive 足够；TLS 由前置代理负责，代理到上游也走 HTTP/1.1。
- 不监听 UNIX socket：跨机没有意义，跨用户也没必要。
- 端口冲突：启动时检测并给出下一个可用端口的建议，写回配置，不静默改。

### 5.2 路由表

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

### 5.3 反向代理注意事项

| 事项 | 要求 |
|---|---|
| SSE | 关闭响应缓冲（Caddy 默认 `flush_interval -1`；nginx `proxy_buffering off`、`X-Accel-Buffering: no`）；读超时 ≥ 心跳间隔 × 3 |
| 心跳路径 | 不要给 `/cluster/heartbeat` 加缓存；代理层保持 keep-alive 到上游 |
| 转发头 | 只有来自回环代理的 `X-Forwarded-For/Proto` 才可信；节点默认不读这些头做鉴权 |
| 健康检查 | 代理 `health_uri /health`，上游不需要鉴权 |
| 请求大小 | 代理与节点两侧都要限；两侧取更小的 |
| TLS 端口 | 公网只开 443；节点端口只对代理或私网开放 |

### 5.4 公网暴露清单

在把节点挂到公网之前，必须逐条确认：

1. workgroup 密码是生成的强密码（不是 `123456`，不是用户名）；
2. 监听绑 `127.0.0.1`，公网入口只有代理；
3. `/health` 不泄漏拓扑、主机名、工作区；
4. `/cluster/*` 有速率限制与失败计数；
5. 审计日志已开启；
6. 已接受“同 workgroup 的任一节点可凭密码向本节点派任务”这一事实（§12.5）。

---

## 6. 节点身份与节点信息

### 6.1 短 id（node_id）

- **生成时机**：插件安装/首次启用时生成一次，写入插件配置并持久化（随 profile 存放，不进 git 仓库）。
- **格式**：6 字符，Crockford Base32 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（无 I/L/O/U，避免 1/0 混淆）。展示为 `N7K3QM`。
- **可改**：UI/配置可手改成任意合法短 id（也允许小写，落库统一大写）。改完必须重启监听并向各 peer 重新发心跳（§10.8）。
- **持久化**：写在插件配置（如 `<profile>/plugins/pod/config.json`），含 `node_id`、`display_name`、`endpoint`、`workgroup_id`、密码引用。
- **不是安全主体**：认证靠 workgroup 密码；短 id 只用于日志、指标、UI、任务元数据。任何人可把 id 改成 `AAAAAA`，安全性不因此变化。
- **改名语义**：改 id 等价于“离开 + 重新加入”。旧 id 在别人的表里会成为一条逐渐过期的记录；推荐 UI 在改名时提示“其余节点会自己清掉旧记录”。
- **冲突**：join 时若目标 workgroup 已有同 id 且端点不同 → `409 node_id_conflict`，UI 建议 `N7K3QM-2`。若端点相同（同一节点重复 join）→ 幂等成功。

### 6.2 节点自述记录（SelfRecord）

`GET /cluster/members` 的元素，也是 join 响应里 `self` 的内容：

```json
{
  "node_id": "N7K3QM",
  "display_name": "书房台式机",
  "endpoint": "http://192.168.1.11:41241",
  "workgroup_id": "whale-pod",
  "runtime": {
    "os": { "family": "windows", "name": "Windows 11 Pro", "version": "24H2", "build": "26100.2314" },
    "arch": "x86_64",
    "cpu": { "model": "AMD Ryzen 9 7950X 16-Core Processor", "physical_cores": 16, "logical_cores": 32 },
    "memory": { "total_bytes": 68719476736, "available_bytes": 41234567168 },
    "gpus": [{ "name": "NVIDIA GeForce RTX 4090", "memory_bytes": 25757220864 }],
    "dsh": { "version": "0.9.0", "profile": "orca" },
    "plugin": { "version": "0.1.0" },
    "caps": ["shell:pwsh", "gpu:cuda"],
    "captured_at": "2026-11-14T04:36:33Z"
  },
  "runtime_digest": "sha256:1f0c9a...",
  "roles": ["exec"],
  "workspace": { "used_bytes": 12345678, "quota_bytes": 5368709120 },
  "busy": null,
  "joined_at": "2026-11-14T04:01:02Z",
  "server_version": "0.1.0"
}
```

Linux 节点的 `os` 形如：

```json
{ "family": "linux", "name": "Ubuntu", "version": "24.04.1 LTS", "kernel": "6.8.0-45-generic", "libc": "glibc 2.39" }
```

字段规则：

- `runtime` 与整个记录只出现在需要签名的接口里，公网匿名不可读。
- `available_bytes` 是采集瞬间值，会变；它不进 `runtime_digest`（否则心跳每次都要拉全量）。`digest` 只覆盖稳定字段：os/cpu/memory.total/gpus/dsh/plugin/caps。
- `workspace` 只报**用量与配额**，不含路径；真实目录由目标节点自己解析。忙闲是动态字段：`busy` 为 `null` 或 `{ "task_id", "origin_node", "since" }`，由本人写、心跳刷新；origin 的 UI 据此显示“B 正在跑 X”。
- `endpoint` 只有一个。跨网段、公网、NAT 穿透都靠代理或 VPN 把这个地址变得可达，不靠节点自报第二个地址（§5.3）。
- 采集失败不阻塞启动：缺字段就省略，并在 `runtime.error` 里写原因。

### 6.3 runtime 采集

| 字段 | Windows | Linux |
|---|---|---|
| os.name/version | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 `ProductName` / `DisplayVersion`，build 用 `CurrentBuild` + `UBR` | `/etc/os-release` 的 `NAME` / `VERSION` |
| kernel | `CurrentBuild.UBR` | `uname -r` |
| arch | `process.arch` / `PROCESSOR_ARCHITECTURE` | `process.arch` |
| cpu | `os.cpus()` 型号；物理核用 `Win32_Processor.NumberOfCores` 求和 | `os.cpus()`；物理核读 `lscpu` 或 `/sys/devices/system/cpu/cpu*/topology/core_id` |
| memory | `os.totalmem()/freemem()` | 同左（`MemAvailable` 更准，可选读 `/proc/meminfo`） |
| gpu | `Win32_VideoController` | `nvidia-smi -L` 或 `/sys/class/drm` |
| dsh/plugin | 插件自报版本 | 同左 |

注意：

- Windows 上别用 `Get-ComputerInfo`（慢、依赖 PowerShell 策略）；直接读注册表。
- 采集一次缓存 5 分钟，心跳只带 digest，不重复跑。
- `caps` 是人工/自动声明的能力标签（`shell:pwsh`、`gpu:cuda`、`docker`），用于 origin 侧“这个任务该发给谁”的筛选；不要靠它做安全决策。

### 6.4 刷新与一致性

- 心跳只带 `runtime_digest` 与 `members_digest`。
- 收到 digest 与本地缓存不一致 → `GET /cluster/members` 拉全量（缓存 30s，避免风暴）。
- 目录里每条记录的“新鲜度”由本地的 `last_recv_at`/`last_ok_at` 体现，不由记录内的字段体现。
- 记录只有本人能写：**其他节点绝不改写某条记录的内容**，也不替它声明在线。这条规则是不需要版本号的基石（§10.1）。

---

## 7. A2A 任务面

### 7.1 角色

每个节点同时是 A2A server 和 A2A client。“对等”是逻辑对等：双方都能调用对方；不提供持久 socket，每次调用是 HTTP 请求。

### 7.2 Agent Card

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

- Card 里不放密码、主机名、忙闲状态、内部拓扑、runtime。读取它不需要签名；敏感信息只在签名的 `/cluster/members`（§6.2）。
- `skills` 是能力声明，不是实现；执行由 LocalExecutor + 继承的权限模式决定。
- SDK 与 `protocolVersion` 必须 pin；不匹配 fail closed，并在日志里写清双方版本。

### 7.3 方法与异步语义

- `message/send`：提交消息；返回 `Task`（通常是 `submitted`/`working`）或直接 `Message`。
- `tasks/get`：按 task id 取状态/artifact。
- `tasks/cancel`：请求取消。
- 接续（C 接着在 B 上干）不单独设方法：就是一次带 `continuation_of` 的 `message/send`（§7.11）。
- `message/stream`：SSE 流式接收状态/artifact 事件（可选）。
- `tasks/resubscribe`：断线后重连到已有流（可选）。
- push notification：后置，需要 webhook 鉴权、重试、SSRF 防护。

**关键语义：**

> A2A 的传输是同步 HTTP，任务语义是异步的。

不要在集群里让 `message/send` 的 HTTP 连接挂到任务结束。跨节点默认“建 task 即返回”，完成靠轮询或 SSE。某些 SDK 的 `blocking` 只用于本机测试。

> `input-required` 的授权请求是**任务状态**，不是推送消息：origin 停轮询、断 SSE 后恢复，`tasks/get` 仍能拿到同一份 `permission_request`。

### 7.4 任务状态机

```text
submitted ──► working ──► input-required ──► working
                 │
                 ├──► completed
                 ├──► failed
                 └──► canceled
```

- `submitted`：已接收，未开始。
- `working`：LocalExecutor 正在执行。
- `input-required`：需要发起节点补输入或**补授权**（§9.4）。载荷在 task 的 `status.message` 里，不依赖推送。载荷有两种：`permission_request`（补授权）和 `blocked`（要决策：`{reason, question, options?}`）。
- `input-required` **不占用执行槽**：网关把槽释放；A 的后续 message 到达时重新竞争槽位，不预留、不排队。槽被别人占了就回 `429 node_busy`，由 A 决定重试还是放弃。
- 恢复执行时优先 `session/resume(context_id)` 续上原 session；session 已随进程退出而丢失时新开一个，并在 task 上记 `resume=degraded`（§7.11）。
- 远程 agent 卡住时**不允许反向调用**祖先节点（§7.5），只能把问题写进 `blocked` 并结束本轮；这既是防环，也是“异步任务”的正确表达。
- `completed` / `failed` / `canceled`：终态。
- 终态不可逆；重试要产生新的 task（带 `retry_of`），不复活旧 task。

### 7.5 任务标识与元数据

```json
{
  "workgroup_id": "whale-pod",
  "origin_node": "N7K3QM",
  "target_node": "P2W8XA",
  "trace_id": "01J...",
  "idempotency_key": "N7K3QM:ctx-42:1",
  "task_ttl_s": 3600,
  "grant_id": "g_01JABC",
  "workspace": { "kind": "group" },
  "continuation_of": null,
  "pod": { "hop": 0, "chain": ["N7K3QM"], "root": "t_01JABD", "notify": "auto" }
}
```

规则：

- `task_id` 由 A2A server（目标节点）生成；origin 保存 `(target_node, task_id)` 映射。
- `context_id` 把多个 task 归到同一逻辑会话；目标节点把它映射到本地 DSH session，cwd 固定为本节点的工作区（§11.2）。
- `idempotency_key` 作用域 = 同一 workgroup 内；目标节点去重窗口默认 24h。它只防重复提交，不承担重发。
- `trace_id` 跨节点传递；`task_ttl_s` 是任务寿命，不是转发跳数（本设计无转发）。
- `pod.hop`：任务已经跨了几跳。origin 建 task 时为 0。target 是否接受 `hop > 0` 由 `delegation.max_hop` 决定（默认 **0** → `400 hop_limit`；可配 1–3）。target 上的 agent 新建子任务时，由网关注入 `hop+1` 与 `chain + [self]`，agent 不能自己写。
- `pod.chain`：经过的 node_id 列表（祖先路径），只用于环检测，不做路由；target 若发现自己已在链中 → `403 ancestor_call_forbidden`（`chain` 由网关注入，正常不会出现重复）。
- `pod.root`：这条调用树的根 task id，扇出预算按它计（`max_fanout`）。origin 建 task 时等于自己的 task id。
- 任务本身不转发：多跳是 target 上的 agent **新建**子任务，不是把原任务转出去；原任务仍只属于它的 origin。
- **祖先禁调（硬限制）**：子任务的目标集合必须排除 `pod.chain` 里的所有节点和自身。尝试调用 → `403 ancestor_call_forbidden`。这条不受 `max_hop` 影响，开了多跳也一样——A→B→A 在第一次就被拒绝，而不是等到第 N 跳才断。
- 被祖先禁调挡住时，正确动作是把问题写进 `input-required` + `blocked`（§7.4），让 A 看到后决定下一步；不是换条路再调回去。
- 这两个字段都进签名；target 只读不写。
- `grant_id` 指向 origin 签发的 grant；目标节点校验其绑定关系（§9.3）。
- `workspace.kind` 当前只有 `"group"` 一个合法值，显式声明“在本节点工作区执行”；没有发布式目录（§11.7）。
- `continuation_of`：接续的来源 task id。非空时表示“这是 C 接着 A 的活”，target 校验来源 task 已终态且同 workgroup（§7.11）。旧 task 本身不改。
- `pod.notify`：`"auto" | "inbox" | "wake"`，默认 `"auto"`。决定任务终态时怎么回 origin 的会话；`auto` 的判定规则见 §7.6「完成唤醒」。它只是 origin 本地的投递策略，target 不关心，也不进 target 的授权判断。

### 7.6 任务回报

```text
origin: POST message/send（带 grant）→ { task_id }
origin: 本地任务日志落库（state=dispatched）
origin: 轮询 tasks/get，500ms 起，指数退避到 2s
target: task store (SQLite) 推进 submitted/working/completed
origin: 终态 → 落结果 + 展示工作区状态 → 停止轮询
```

轮询规则：

- 初始 500ms，退避到 2s，加 ±20% 抖动；
- 终态立即停；连续 `404` 说明目标重启丢了 task → 记 `failed(reason=task_lost)`；
- 连续连接失败达到 `offline_after`（≈12s）→ origin 直接记 `failed(reason=node_unreachable, effects_unknown=true)`，**不重发**（§13.2）；
- 总时长受 `task_ttl_s` 约束，超时记 `failed(reason=timeout)` 并发 `tasks/cancel`（若还能连上）。

#### 轮询归 Host，不归 agent

轮询是插件的后台行为，不是 agent 的一条命令：

- `pod_send` 建完 task 立刻返回 `task_id`，不挂着连接等结果；
- 插件里的 tracker 按上面的参数拉 `tasks/get`（target 开了 `message/stream` 就改成持有一条 SSE），状态写进内存与本地任务日志；
- agent 只看到薄工具，没有一个会阻塞：`pod_send`（建完 task 立刻返回 `task_id`）、`pod_status(task_id)`（读缓存/任务存储，立即返回）、`pod_cancel(task_id)`、`pod_members()`。**没有 `pod_wait`**——等待不是 agent 的职责。

派发即返回，所以 agent 的循环里没有“等”：任务在跑就继续干别的，或者干脆结束本轮、把控制权还给用户；完成会按 `notify` 注入或唤醒（§7.6 完成唤醒）。target 忙（`429 node_busy`）时也没有可等的东西——把持有者与 `retry_after_s` 回报用户、结束本轮，或先做不依赖它的活；要不要重试、什么时候重试，由模型判断（§11.4），不由协议层排队。

**为什么不让模型用 bash 长轮询**：`sleep 2 && pod_status` 每跑一次就是一次工具调用、一轮上下文；`timeout` 杀掉的是 shell 不是等待语义，容易留孤儿；退避策略交给模型，token 花在等待上而不是决策上。Host 有单调时钟、可取消、能挂 SSE，也知道任务该等多久。

状态怎么回到会话——不塞 user 消息，也不让 agent 猜：

| 事件 | 手段 | 效果 |
|---|---|---|
| 任务完成 / 失败（普通） | `agent.inject()` 写一条紧凑 notice（`pod task <id> completed: <一句话>`） | 落 `agent/inbox/spliced`，下一次 admitted step 自动进上下文；**不唤醒** agent，等下一次交互看到 |
| `input-required` 的 `permission_request`、祖先禁调的 `blocked`、需要人立刻决定 | `agent.followup()` | 唤醒 agent 开新一轮，走审批卡片/回报流程（§9.4） |
| 任何时刻用户主动问 | `pod_status` | 从任务存储/缓存读，与会话历史无关 |

只有“必须现在处理”的事件才 `followup()`——唤醒是有代价的（新一轮模型调用、可能打断用户）。普通完成一律 `inject()`，让它在下次交互时自然出现。

`followup()` 的语义与边界：

- 它只对**仍然活着**的 session 有效：DSH 进程里还有这个 `Agent` 实例，插件才有对象可唤醒。会话已关闭/归档时没有对象，任务结果留在任务存储里，等会话下次恢复时再由 `inject()` 进入上下文——不存在“插件把 DSH 会话从磁盘拉起来”。
- 被唤醒的 turn 不是用户消息：上下文从注入的 notice 开始，UI 里表现为同一会话里新的一轮 assistant 回复，不会伪造一个 user 气泡。
- 它继承该 session 的审批策略：唤醒后若需要权限，仍然弹 DSH 卡片；用户不在电脑前就会超时。
- 因此“完成即唤醒”按任务声明：`pod.notify` 为 `auto`（默认）、`inbox` 或 `wake`；想做“用户离开时提醒”，也可以由客户端插件做徽标/桌面通知，而不是让模型空转一轮。

会话日志仍是唯一事实源：`inject()` 的内容以 `agent/inbox/spliced` 落日志；任务状态本体在任务存储里，`pod_status` 随时可重放，插件内存只是缓存。

CLI 的 `orca-node wait <task_id>` 只给人和测试用（harness、脚本、没装插件的机器），不作为 agent 工具暴露——那是 §16.4 里 harness 入口的一部分。

#### 完成唤醒（notify: auto）

典型场景：A 把“编译验证”派给 B，A 结束这一轮；十几分钟后 B 完成，A 需要被叫醒、看结果、继续修。默认的 `inbox` 做不到这件事——用户不回来就没人看。所以默认是 `auto`：

`auto` 的判定只在 origin 侧：

- 任务是在**哪一轮**派发的，插件记着；
- 那一轮结束时（`turn/end`）任务仍未终态 → 这个 task 标记 `wake_pending`；
- 若同一轮内就拿到终态（agent 还在、`pod_status` 已经能读到），只 `inject()`，不唤醒。

真正 `followup()` 需要同时满足：

| 条件 | 不满足时 |
|---|---|
| `wake_pending` 为真 | 按 `inbox` 处理 |
| session 仍活着（有 Agent 实例） | 结果留在任务存储，会话恢复时 `inject()` |
| 当前 idle（没有 turn 在跑） | 等这一轮结束后再判断，不打断 |
| 派发后用户没有发过新消息 | 用户在场，结果进 inbox 等下一轮 |

其余细节：

- **合并**：2s 窗口内到达的多个终态合成一条 notice、一次 `followup()`；五个任务同时完成不该叫醒五次。
- **唤醒后的指令**：注入的 notice 带一句明确要求——“这是后台任务完成，接着干：检查结果，修/继续/汇报；只有被阻塞才问用户；结束时一句话总结”。避免唤醒后模型又去问“你想让我做什么”。
- **预算**：连续后台唤醒轮次 ≤3（中间没有用户输入）；超了就不再唤醒，结果标未读并留在 inbox。用户下一次说话重置。这是防 A→B→A 自动循环烧 token 的闸，不是防正常续跑。
- **不反向**：唤醒是 origin 自己对自己做的，不涉及任何 target→origin 的连接；B 那边只是任务变终态。

例子：A 的 `pod_send` 带 `notify: "auto"`，随后 `turn/end`；B 在 12 分钟后 `completed`；插件看到 `wake_pending` + idle + 用户没回来 → `inject()` notice + `followup()`；A 开新一轮，读到 `status.message`，发现编译报错，继续改代码。若编译通过，A 一句话总结并停。

### 7.7 取消

`tasks/cancel` 必须传到 LocalExecutor：

- ACP：`session/cancel`，等待确认，超时后终止子进程；
- headless：终止进程树（Windows 用 Job Object，Linux 用 process group）；
- in-process：调取消钩子。

取消后 task 置 `canceled`；若执行器已完成，返回 `completed` 并说明“取消未生效”。取消同时**吊销该 task 的 grant**（§9.3）。

### 7.8 流式与隐私

- ACP `session/update` 可能含 assistant message、thought、tool call、usage。
- 只把**已提交助手消息、工具状态、最终 artifact**映射给 A2A。
- 不转发原始 thought / chain-of-thought。
- 不暴露本地绝对路径、环境变量、凭据；artifact 用相对路径 + manifest（§11.6）。
- artifact 有类型与大小上限；超限改引用或拒绝。

### 7.9 任务存储

每个节点的 task store 是它自己产生的 task 状态的唯一事实来源。

```text
task_id, context_id, origin_node, target_node,
state, created_at, updated_at,
idempotency_key, trace_id, grant_id,
workgroup_id, session_id, artifacts, error, reason
```

持久化：

- **单机 SQLite**：`<data_root>/tasks.db`，WAL 模式，`synchronous=NORMAL`；
- 表：`tasks`（状态与元数据）、`task_events`（状态变迁与错误）、`blobs`（blob_id + size + name + refs + expires_at）；
- 一个进程独占写；不做连接池、不做服务、不共享库；
- 备份 = 拷贝 db（WAL 下先 checkpoint）；损坏时允许丢未落盘的最近事件，不允许静默重建；
- 内存 store 只用于协议单测。

发起节点另有**本地任务日志**（同一张表的 `role=origin` 行或独立表），只记录“我派过什么、最后一次看到什么”，不与目标库对账（§13.2）。

**可见性**

- 同 workgroup 的任意节点凭 `task_id` 可 `tasks/get`；没有列表接口，`task_id` 就是句柄（ULID，不可枚举）。
- origin 额外拥有交互权：`input-required` 后补发消息、`tasks/cancel`；其他节点只读（不能取消、看不到 live 事件）。
- 因此**`task_id` 泄露 = 结果泄露**。它只该出现在任务消息、审计和给人看的日志里，不要贴到公开 issue 或截图里。
- 同组是信任域：密钥共享、节点身份可伪造，所以“谁能读”是约定与审计问题，不是密码学保证（§12.1）。

### 7.10 文件交换（blob 通道）

任务素材与产物不走 JSON 内联：base64 会膨胀 33%，而且没法流式、没法续传、没法去重。单独一条内容寻址通道：

```http
POST /blobs
Authorization: Pod node_id=N7K3QM; ts=...; nonce=...; proof=...
X-Pod-Body-SHA256: <hex>
Content-Type: application/octet-stream
Content-Length: 1048576

<bytes>

201 { "blob_id": "<sha256>", "size": 1048576, "name": "input.zip", "expires_at": "2026-11-21T..." }
```

```http
GET /blobs/<blob_id>
Authorization: Pod ...

200 <stream>
```

```http
POST /blobs/<blob_id>/link
Authorization: Pod ...

200 { "url": "https://host.example/blobs/<id>?exp=...&sig=...", "expires_at": "..." }
```

规则：

- `blob_id = sha256(bytes)`，内容寻址 → 天然去重；同内容重复上传返回 `200` 且不占新空间，首次返回 `201`。
- 上传必须带 `X-Pod-Body-SHA256` 并被签名覆盖；服务端边收边算，落盘后不一致 → `400 blob_digest_mismatch` 并删除。签名不覆盖 body 本身，避免为 1 GiB 文件算两遍哈希。
- 上限：单文件默认 256 MiB，每 workgroup 默认 5 GiB；超限 `413`。
- 文件名只作提示（`name`），不参与寻址；存储路径由 blob_id 决定，元数据里出现 `../`、绝对路径、驱动器号一律拒绝。
- 生命周期：默认 7 天未被任务引用即 GC；被任务引用则延长到任务终态 + 24h。GC 是本地行为，不传播；下载方拿不到就是被清了，按 `410 blob_expired` 处理。**GC 全自动，不依赖用户到子节点手动清理**——没人会去 B 的机器上清 blob；要保住某个产物，就在 7 天内下载它，或让它继续被任务引用。
- 下载支持短期直链：任意同组节点调 `POST /blobs/{id}/link` 拿 TTL 5 分钟的 URL，方便 `curl` / 浏览器 / 前端直链，不必把长期密钥给第三方。直链只是省掉签名头，不改变可读范围。
- **不做 per-blob ACL**：同 workgroup 的任意节点知道 `blob_id` 就能 `GET`。跨节点直取（C 去 B 拿 A 的产物）是设计目标，不要加一层“看起来更安全”的检查。
- **blob 不可枚举**：知道 `blob_id` 才能取，没有列表接口；id 是内容哈希，不泄露目录结构。跨节点交接产物就是传一个 id；id 泄露 = 内容泄露，按这个标准管理它。
- 不做目录树、不做 rename、不做覆盖：要改内容就是新 blob。

**输入**：origin 先把素材 `POST /blobs` 到 target，任务消息里带 `inputs: [{blob_id, name, media_type}]`；target 直接读本地已落盘的 blob（上传即到达），不需要回源。小于 64 KiB 的可以直接内联 `bytes`（A2A file part），省一次往返。

**输出**：任务终态时 manifest 给 `artifacts: [{blob_id, name, media_type, bytes}]`；origin 按需 `GET /blobs/{id}`。**不自动全量回传**：大产物由人或 agent 显式取，避免把网络当同步盘。

方向始终是 origin → target 的请求（上传素材、下载产物），target 从不反向连 origin。NAT 下只需要 target 可达，与 §10.2 的单向出站原则一致。

### 7.11 任务接续（C 接着在 B 上干）

A 在 B 上跑完一段，想把后续交给 C（另一台机器、另一个模型，或者只是 A 要关机）。协议不复活旧 task，而是**在同一 context 上开一个新 task**：

```json
// C → B: message/send
{
  "context_id": "<A 用过的 context_id>",
  "message": { "parts": [{ "kind": "text", "text": "接着 A 的进度继续" }] },
  "metadata": { "pod": { "continuation_of": "t_01JABD" } }
}
```

规则：

- `continuation_of` 指向的 task 必须**已终态**且同 workgroup；还在跑就 `409 task_not_terminal`——先等它结束或 `tasks/cancel`，不允许两个节点同时写一个工作区（§11.4 单槽）。
- 工作区原地复用：C 的新任务和 A 的旧任务落在同一个 `<data_root>/workgroups/<id>/`，文件、`notes/`、产物都在，不需要拷贝。
- 上下文恢复尽力而为：target 优先 `session/resume(context_id)`；失败则以新 session 启动，把 `notes/` 与旧 task 结论注入首条 prompt，并在结果里记 `resume=degraded`。降级不是错误，但必须可见。
- 旧 task 不变：状态、artifact、`updated_at` 都不动；新 task 元数据里记 `continuation_of`，审计能还原“A 干的前半段、C 干的后半段”。
- C 先要拿到 `task_id`（A 告诉它，或 `tasks/get` 里看到 `context_id`）；没有列表接口，所以接续也是“凭 id 交接”。
- 不推送、不回调：B 不会通知 C“A 停了”，C 必须自己发起（单向出站）。

一句话：**接续 = 新任务 + 旧上下文 + 原地工作区**；task 的不可变性不破，工作区的连续性也不破。

---

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

**默认不启用 pod 远程工具**；多跳与扇出是可选能力，配置 `delegation` 打开后才生效。理由不是“安全”，而是“一个会自己跑起来的集群很难调试”：默认行为应当是可预测的单跳。打开后网关会强制注入 `hop` / `chain` / `root`（§7.5），并按 `max_hop` / `max_fanout` 拒绝超限；agent 不能自己填这些字段。

### 8.4 ACP 映射

| A2A | ACP | 说明 |
|---|---|---|
| `context_id` | session | 首次 `session/new`，cwd = 本节点工作区 |
| 一个 task | 一次 `session/prompt` | 同 context 串行；不同 context 也串行（节点单槽，§11.4） |
| `session/update` | task status/artifact 事件 | 过滤 thought |
| prompt 返回 | 终态 | 按 `stopReason` 映射 |
| `tasks/cancel` | `session/cancel` | 超时后杀进程树 |
| 网关重启 | 新 session | 不猜旧 session；开新 session，cwd 不变（§11.5） |
| `session/request_permission` | 策略层裁决 | 见 §9.6，**不弹本地窗** |

### 8.5 并发与串行

- 一个 context 同时只有一个 prompt（ACP 限制）；
- **整个节点同一时间只跑一个任务**（单槽，§11.4）；忙时 `429 node_busy`，不排队；
- 过载一律 429，不排队、不等到超时；节点对外只有单槽（§11.4）。

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
- `suspend.kind` 只有 `blocked` 与 `permission` 两种，分别生成 §7.4 的 `blocked` 和 §9.4 的 `permission_request`；恢复需要 origin 发后续 message。
- `final.state` ∈ `completed | failed | hang`；`failed` 时 `text` 作为 `status.message`；`hang` 表示永不完成，用于测 TTL、失联与 `tasks/cancel`（只能被取消或 TTL 收掉）。`text` ≤ 8 KiB，**原样返回**，不做模板替换，便于逐字节断言。
- `artifacts` ≤ 4 个、每个 `content` ≤ 4 KiB：executor 真的写 blob 存储，返回的 `blob_id` 必须等于 `sha256(content)`。
- 脚本缺省等价于 `{ steps: [], final: { state: "completed", text: "echo" } }`，用于纯连通性探测。
- 非法脚本（未知字段、`at_ms` 不递增、`state` 非法）在**建 task 之前**就 `400 bad_echo_script`，不要执行到一半才炸。
- 真 executor 收到 `echo` 字段直接忽略，避免脚本泄漏到生产路径。

---

## 9. 权限与审批：跟随发起节点

### 9.1 前提

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；会话能写工作区，远端就只能写工作区；
- 需要更多权限时，target 通过 A2A 把请求送回 origin，由人在 origin 的卡片上决定。

这条前提排除了两种设计：target 本地审批（无人应答、任务挂死）和 target 自由裁量（origin 无法预期远端能做什么）。

### 9.2 权限模式继承

origin 发起任务时携带会话的 permission mode，target 原样执行：

| origin 会话模式 | target 上的含义 |
|---|---|
| `read-only` | 只读：可读工作区内文件、可跑只读命令；写文件/改状态一律 escalate 或 deny |
| `workspace-write` | 只在工作区内写；出界（家目录、系统目录、其它项目）一律 escalate |
| `danger-full-access` | 全机可用，但 §9.5 的硬拒绝清单仍然生效 |

三条规则：

- **mode 只能降不能升**：target 可以把 `danger-full-access` 降为 `workspace-write`（配置更严），不能反向；
- mode 随任务签名一起传，target 校验签名后再执行，防止中间人改宽；
- mode 不写进 grant 之外的任何持久状态；任务结束即失效。

### 9.3 Grant

grant 是 origin 对“这一次任务”的授权凭证，随 A2A 请求下发：

```json
{
  "grant_id": "g_01JABC",
  "workgroup_id": "whale-pod",
  "origin_node": "N7K3QM",
  "target_node": "P2W8XA",
  "task_id": "t_01JABD",
  "permission_mode": "workspace-write",
  "workspace": { "kind": "group" },
  "limits": { "max_runtime_s": 3600, "max_write_bytes": 536870912 },
  "nonce": "9f2c...",
  "issued_at": "2026-11-14T04:40:00Z",
  "expires_at": "2026-11-14T05:40:00Z"
}
```

校验：

- 绑定 `(workgroup_id, origin_node, target_node, task_id, nonce)`，五者任一不符即拒；
- 只能**收窄**：target 拿到的 mode 不能高于 origin 会话当时的 mode；
- `expires_at` 到点即失效；任务 cancel / 完成即吊销（target 本地删记录，不需要广播）；
- 无 grant 的请求直接 `deny(missing_grant)`，不接受“老客户端”兼容。

### 9.4 升级回路：任务状态，不是反向调用

```text
target: 工具调用超出继承的 mode
  → 网关（不是 agent）把 task 置为 input-required
  → 把结构化 permission_request 写进 task 的 status.message（data part）
  → 连接结束。target 不拨 origin，不新建任何到 origin 的请求：

    {
      "request_id": "pr_01J",
      "task_id": "t_01JABD",
      "tool": "write_file",
      "target": "workspace:group/src/main.ts",
      "reason": "需要修改入口文件",
      "requested": { "permission_mode": "workspace-write", "paths.write": ["workspace:group"] },
      "expires_in_s": 120
    }

origin: 下一次 tasks/get（或已挂着的 SSE）看到 input-required
  → 用 DSH 现有审批卡片弹（复用 Host 的 approval 机制，人点）
  → 批准：生成新 grant（新 nonce、同 task、窄于等于请求范围），发一条 A2A 后续 message
  → 拒绝：发 message 明确 deny，target 把 task 置 failed(reason=permission_denied)
  → 超时无人应答：origin 自动 deny + tasks/cancel，target 清理任务临时物
```

要点：

- **这不是反向调用。** 全设计只有 origin → target 一个方向；target 没有 origin 的地址，也不需要。所谓“送回 origin”只是把请求写进 task 状态，等 origin 来读。
- **任务记录是唯一权威载体**：`permission_request` 必须能只靠 `tasks/get` 拿到；SSE 只是把同一份数据更早推过去，流断了也不丢。
- **SSE 也不是反向连接**：它是 origin 自己发起的那条 HTTP 请求保持打开，target 在响应里继续写字节。origin 从不监听、也不接受 target 的入站连接。
- 轮询看到 `input-required` 后，origin 的 UI 立刻弹卡片并把 task 标黄；不要等下一次轮询才提示。
- 补发的授权是**同一 task 的后续 message**（带 `taskId` + 新 grant），不是第二个任务，也不是独立的 grant 端点。
- **origin 是唯一能产生“用户同意”的地方**；`decided_by` 必须来自 UI 的人类动作，不能由模型自批。
- 审批卡片要显示：来源节点（display_name + id）、目标路径、命令/工具原文、请求理由、将提升到什么权限。不要把 target 传来的长文本渲染成 HTML（注入）。
- 审批 UI 直接复用 DSH 的 approval 卡片（Host 既有机制），不另做插件面板。
- 同一 task 的升级次数上限（默认 3），超过即 failed 并告警；防止被调用节点反复索权。
- origin 侧支持**预授权**（避免每次都弹）：按 `(workgroup, target, tool)` 记一条本地策略，如“允许 N7K3QM 在 P2W8XA 上跑 shell，单次 ≤15 分钟”。预授权记录进审计。

### 9.5 目标侧硬拒绝清单

硬拒绝 = 与权限模式、grant 都无关，永远不执行（除非人坐在 target 前、在本地显式解除）。这个清单刻意很短：它只保护“做错了就救不回来”和“做完就再也管不了这台机器”的操作。

- 磁盘与引导：分区、格式化、`diskpart`/`mkfs`/`dd` 写裸设备、改引导项；
- 关安全软件、清审计日志、改系统时间同步源；
- 改本插件自己的配置与凭证（`<profile>/plugins/pod/`），以及 DSH 的凭据存储——防止远程把自己锁死或把密码读走。

除此之外**不再硬拒**：

- `~/.ssh`、`~/.aws`、`~/.config/gh`、浏览器 profile 等 → 允许，但默认走 escalate 由 origin 批准（§9.7）；
- 装包、改服务、配防火墙、跨系统实验 → 允许，按继承的 mode 与 grant 执行；
- 后台常驻进程 → 允许，但必须登记 PID 与清理方式，否则任务结束时按进程树清理。

### 9.6 ACP `request_permission` 映射

| 继承 mode | 请求的操作 | 结论 |
|---|---|---|
| `read-only` | 读 / 只读命令 | `allow` |
| `read-only` | 写 / 变更类执行（装包、改配置、起服务） | `escalate` → 回 origin（§9.4） |
| `workspace-write` | 工作区内写 | `allow` |
| `workspace-write` | 工作区外写 / 提权命令 | `escalate` |
| `danger-full-access` | 任意 | `allow`，除 §9.5 |
| 任意 | 命中 §9.5 | `deny`（原因写进 task error） |
| 任意 | 无 grant | `deny(missing_grant)` |

实现方式：AcpExecutor 把 ACP 的 permission 请求交给网关策略层，策略层返回三态；`escalate` 时先不回复 ACP（挂起该步），等 origin 的后续 message 到达后决定 `allow`/`deny`。挂起有超时（`expires_in_s`），超时按 `deny` 收尾，避免 ACP 侧永久悬挂。

### 9.7 凭据回传与注入防护

远程节点上经常有 key：`~/.ssh/id_ed25519`、`~/.config/gh/hosts.yml`、`.env`。两种需求同时存在——**要能取回**（开发调试），**又不能被一句话骗走**（prompt injection 的典型外泄路径）。所以做成显式策略，而不是硬规则：

| 配置 `credential_readback` | 行为 |
|---|---|
| `deny` | artifact 里出现凭据类内容 → 拒发，任务标 `failed(credential_blocked)` |
| `ask`（默认） | 检出凭据类内容 → 任务挂 `input-required`，origin 卡片问“是否回传”，人点 |
| `allow` | 直接回传，仅审计 |

检出靠三层：文件路径模式（`*.pem`、`id_*`、`.env*`、`known_hosts`）、内容模式（私钥头、AKIA/ghp_ 前缀、长 base64 高熵串）、以及 agent 主动标注。

另外两条与开关无关的规则：

- **origin 不自动执行回传内容**：拿回来的文本进 artifact，不进下一轮 prompt，除非人明确引用；
- **审批卡片永远显示原文**（转义后），不显示模型复述——防的是“模型说这是无害的”。

---

## 10. 控制面：full mesh 成员与时序

### 10.1 成员状态的三个问题

| 问题 | 回答 |
|---|---|
| 谁有资格说“某节点存在”？ | 只有该节点自己。别人只能转述端点，不能转述在线。 |
| “在线”由谁判定？ | 收方本地。`last_recv_at` 只由对方心跳更新；收不到就下线，与别人怎么说无关。 |
| 死掉的节点怎么从表里消失？ | 本地过期 + 墓碑 + 修剪。不需要共识，也不需要广播。 |

由此推出三条硬规则：

1. 成员表里只放**直接观测**：我收到过它的心跳，或它成功 join 过我。
2. 别人的表只提供 **hint（端点候选）**，永远不提供“它在线上”这一事实。
3. 在线判定的唯一输入是本地的 `last_recv_at`，hint 不得修改它、不得重置退避、不得清除墓碑。

### 10.2 引导与加入

**首次启用（插件安装）**

```text
1. 生成 node_id（§6.1），写配置
2. 采集 runtime，生成 runtime_digest
3. 起监听（默认 127.0.0.1:41241）
4. 若配置里已有 workgroup_id + 密码：向目录内每个已知端点后台发第一拍心跳
5. 否则进入“未加入”状态，只响应 /health
```

**加入任意节点（host + port）**

```text
D（新）                                            A（已在 mesh）
  POST http://A:41241/cluster/join
  { workgroup_id, node_id, display_name, endpoint,
    self, nonce, ts, proof }
                                              ├ 校验 workgroup_id
                                              ├ 校验 proof（§12.2）
                                              ├ 校验 ts 窗口 / nonce 未用过
                                              ├ 校验 node_id 冲突
                                              └ 记录 D（只记 D 的自述）
  200 { self: A, members: [...], members_digest, server_version }

  D 拿到成员表 → 对每个 peer 发第一拍心跳（带 full self）
  → peer 校验签名 → 登记 D → 回心跳（双向计时开始）
  → 漏在别处的成员，靠 members_digest 变化拉全量补上
```

要点：

- **join 只用于引导**：拿目录、完成第一次登记。之后进入 mesh 靠心跳，不需要逐节点 join。
- **第一拍心跳就是“我在这里”的声明**：带完整 self（≤ 2 KB），对方收到后验签、登记、回拍；**登记即纳入对方的发送列表**（心跳是对称的，不存在只收不发）。后续心跳只带 digest，不再带 self。
- **方向恒为单向出站**：新节点主动连已知节点；旧节点不需要能反向连新节点（NAT 场景只在 D 能出站时成立）。
- **不广播**：没有 announce 消息、没有 gossip。D 自己去找目录里的每个人，这本身就把“我在”传播出去了。
- **幂等**：同一 `node_id` 重复 join / 重复心跳，端点相同即成功，不重复写表。
- **自动接受**：workgroup 密码正确即接受。想被通知可开 `notify_only`（只发本地通知，不阻塞）。默认自动接受 + 审计。
- **拒绝**：`401` 用统一文案（不区分“workgroup 不对”和“密码不对”）；`429` 限流；`409` 只给 id 冲突（需要人改名，必须可诊断）。

### 10.3 心跳与双向看门狗

> 判定在线不是“我能不能连上它”，而是“我最近有没有收到它”。

每个节点对每个 peer 维护两条时间线：

| 字段 | 含义 | 谁更新 |
|---|---|---|
| `last_recv_at` | 最近一次**收到**该 peer 心跳的时间 | 本节点（收包时） |
| `last_ok_at` | 最近一次**成功发出**并为该 peer 收到响应的时间 | 本节点（请求返回时） |
| `fails` | 连续失败次数（用于退避） | 本节点 |

`POST /cluster/heartbeat`：

```http
POST /cluster/heartbeat
{ "from": "P2W8XA", "endpoint": "http://192.168.1.12:41241",
  "runtime_digest": "sha256:...", "members_digest": "sha256:...",
  "self": { ... },                                   // 仅首次，或记录变更时
  "hints": [{ "node_id": "Z3M4AQ", "endpoint": "http://192.168.1.13:41241" }] }

200 { "from": "N7K3QM", "endpoint": "http://192.168.1.11:41241",
      "runtime_digest": "sha256:...", "members_digest": "sha256:...", "hints": [] }
```

- `members_digest` 不同 → `GET /cluster/members` 拉全量。
- `hints` ≤ 8 条，只含**自己认为在线**的 peer 的端点；接收方严格按 §10.5 处理，只当候选。
- 心跳超时（客户端侧）取 `interval` 的一半，别用 30s 默认值。
- 心跳同时是 keep-alive 与“我还活着”的证明；没有单独 ping。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `interval` | 2s（±20% 抖动） | 10 节点 = 45 条链路 ≈ 45 req/s |
| `suspect_after` | 3 次 ≈ 6s | 连续未收到 |
| `offline_after` | 6 次 ≈ 12s | 累计未收到，移出在线集 |
| `recover_probe` | 15s → 30s 退避 | offline 后的探测 |
| `record_ttl` | 7d | offline 记录保留上限，之后修剪 |
| `hint_ttl` | 10min | 候选节点失败后的墓碑时长 |

超时判定用**单调时钟**。墙上时钟只用于显示与 `ts` 校验：Windows 休眠一夜唤醒后 `Date.now()` 会跳几小时，用墙钟算“多久没心跳”会把全网点成 offline。

状态机：

```text
unknown ──(收到第一拍心跳)──────────────────────► online
online  ──(连续 3 次未收到)─────────────────────► suspect(quiet)
online  ──(连续 3 次发失败，但仍在收到心跳)──────► suspect(unreachable)
suspect(unreachable) ──(某次发送成功)───────────► online
suspect(unreachable) ──(开始也收不到)───────────► suspect(quiet)
suspect(quiet) ──(再 3 次未收到，累计 6 次 ≈12s)─► offline
suspect(quiet) ──(任何一次收到)─────────────────► online
offline ──(低频探测成功)────────────────────────► online
offline ──(record_ttl 到期)─────────────────────► 修剪出表（本地）
```

路由规则：**只有 `online` 接受新任务**；`suspect`/`unreachable`/`offline` 都不派新任务，但不取消已经在跑的任务。`suspect(unreachable)` 在 UI 里单独标“单向不通”——这和“它挂了”是两种故障，排障方向完全相反。

### 10.4 收敛时序

```text
t0      D → A: join
t0+5ms  A: 记下 D，返回 {self: A, members: [A, B, C]}
t0+20ms D → B: 第一拍心跳（带 full self）        ← 并发
t0+20ms D → C: 第一拍心跳（带 full self）        ← 并发
t0+25ms B/C: 验签 → 登记 D → 回心跳
t0+2s   三向心跳稳定；D 出现在所有人的 online 集
```

- 已有 N 个节点时，新节点的开销 = 1 次 join + N-1 次心跳，全部并发。
- 目录是旧的（漏了 E）：E 的心跳 digest 变化 → D 拉全量 → 补发心跳给 E。最多 2 个心跳周期。
- hint 引入的未知端点：先当候选拨一次，失败即墓碑 10 分钟，不进正式表（§10.5）。

### 10.5 hints、候选与墓碑（死节点为什么不会复活）

**先看要避免的死循环**。它只会在“把整张表塞进心跳、且接收方照单全收”时出现——`hints` 只带 online peer 是第 0 道防线，下面讲的是万一第 0 道被绕过（比如实现者图省事，把表原样发出去）时，接收方靠什么兜住：

```text
D 掉线
A 的表里还有 D（旧记录）→ A 的心跳把 D 发给 C
C 收到 → “原来还有 D” → 把 D 加回心跳列表 → 给 D 发心跳（失败，但表里留着）
C 的心跳又把 D 发给 A → A 把 D 加回列表
→ A、C 互相刷新，D 永远活着
```

根因只有一个：**把“别人的记忆”当成了“D 还活着的证据”**。解法是把“记录”和“在线”彻底拆开：

| 动作 | 允许吗 |
|---|---|
| 别人的 hint 给我一个端点 | 允许（进候选） |
| 别人的 hint 修改我的 `last_recv_at` | **禁止** |
| 别人的 hint 把节点直接写进成员表 | **禁止** |
| 别人的 hint 重置我对该节点的退避/墓碑 | **禁止** |
| 只有 D 自己的心跳能让我把它标 online | 是 |

具体规则：

1. **候选**：hint 里的未知 `node_id` 进候选区（最多 32 条，TTL 10 分钟），立即拨一次；成功则等对方回心跳自然入表，失败则写墓碑 `hint_ttl=10min`，期间同 id 的 hint 直接丢弃。
2. **已知节点**：hint 只在“我当前端点已失败且新端点不同”时更新候选端点，触发一次探测，且受退避约束（每 5 分钟最多一次）。
3. **offline 节点**：hint 不改状态、不复活；只有它自己的心跳能复活它。
4. **修剪**：offline 超过 `record_ttl`（7d）→ 从表里删除（同时留 7d 墓碑）。这是纯本地决定。
5. **墓碑**：`{node_id, until}` 小表，只在本地，不传播；过期的墓碑自动清掉。

于是 A、C 之间互换 hint 不会产生任何活着的 D：hint 只能让某个节点“再试一次”，试完还是失败，就进墓碑，10 分钟内不再试；7 天后记录修剪，D 彻底消失。**D 要回来，只能是 D 自己发心跳**（或重新 join）。

> 回答“能不能用 `offline_after` 阻止别人的缓存进入我的表”：不要。`offline_after` 是**在线阈值**，不是**入表过滤器**。拿它当过滤器会把“刚启动还没收到心跳的新节点”也挡掉，而且它不解决“A 和 C 都用旧记录互相刷新”的问题。该做的是：hint 只进候选 + 墓碑 + 只有本人能复活。

### 10.6 目录合并与墓碑

- 合并原则：**按 `node_id` 去重，字段以本人记录为准**；本地只保留 `last_recv_at`/`last_ok_at`/`state`/`fails`。
- 冲突（同 id 不同端点）：以最近一次成功心跳的端点为当前端点；旧端点保留为候选 24h，失败即丢。
- 删除：只删本地记录，不通知别人；别人会在 `record_ttl` 后自己修剪。
- **踢人（安全语义）**：没有共识，所以“移除节点”不是可广播的操作。真正把它踢出去只能**换密码**：换完所有旧签名立即失效，其余节点用新密码重新加入。UI 必须这么写，别让用户以为点一下 forget 就安全了。
- 换密码的代价：所有节点要同步新密码；这是**唯一**的吊销手段，也是它简单的原因。

### 10.7 故障、恢复、休眠

- 网络抖动：`suspect` 是可恢复态；新任务在 suspect 期间暂停路由（只有 `online` 接新任务），但**不取消**在跑的任务。
- 单向不通：`suspect(unreachable)`，UI 提示检查防火墙/代理/端口，而不是“对方关机了”。
- 机器休眠：唤醒后所有 peer 同时超时；用单调时钟避免“睡了 8 小时 = 离线 8 小时”的误判；唤醒后立即对全部 peer 发一拍。
- 时钟漂移：`ts` 窗口 ±60s；超过就拒，并在错误里说明“检查系统时间”，别静默容忍。
- 脑裂（本设计不存在“裂”）：没有主节点，没有需要多数派的状态；每个节点各自观测，最多是互相看不见，恢复后靠心跳自动重连。

### 10.8 id 变更、冲突、离开

- 改 `node_id`：等同 leave + rejoin；旧记录靠 `record_ttl` 自然消失。
- 冲突：后到者 `409`；允许同一节点换端点（同 id 同端点幂等）。
- `POST /cluster/leave`：本地不再响应心跳、删除对方记录（best-effort）；**不是安全操作**，对方仍可凭密码重新加入。

---

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
- **多 origin 共享同一份工作区**：允许，但串行（§11.4）。A 和 C 的交接靠 `notes/`，而不是互相看不见。
- origin 不能指定目录、不能传路径（§11.7）。

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
- `busy` 写进 self record（§6.2），随心跳刷新；origin 的 UI 显示“B 正在跑 X，已 3 分钟”，和模型的判断互相印证。
- **为什么单槽**：两个 agent 同改一棵树的冲突是语义层的（一个删了函数、另一个还在调），工程约束拦不住；而“同一节点上跑多件事”争的是同一台机器的 CPU、磁盘和 DSH 状态，不是换个目录就能隔离的。
- 槽位在任务终态/取消/失败时释放；`input-required` 也释放（任务在等 A 回话时不占槽，§7.4），恢复时重新竞争，不预留。网关崩溃后按 `task_ttl_s` 过期，重启时清空并按下文对账。

### 11.5 session / context / workspace 的绑定

```text
(workgroup_id, origin_node, context_id) → session_id
session_id → workspace（本节点唯一的那份）
```

- 同一个 context 的后续任务复用同一 session（同 cwd、同对话历史）。
- 不同 context 各自新 session，但**共用同一份工作区**，所以文件上下文不断。
- 网关重启 / session 丢失：**不猜旧 session**，直接开新 session、cwd 不变；第一条 prompt 里带一句“先读 `notes/STATUS.md`”。会话可丢，工作区不丢。
- 目标节点重启后 task 状态在 SQLite 里，`working` 的按 §13.3 处理。

### 11.6 任务结果与产物

任务结果分三层，不要混在一起：

| 层 | 走哪 | 说明 |
|---|---|---|
| 结论文本 | `tasks/get` 的 `status.message`，内联 | agent 最后一轮说的话，截断到 32 KiB；超长部分写 `result.txt` blob，消息里带摘要与引用 |
| 产物文件 | blob 通道（§7.10） | manifest 给 `{blob_id, name, media_type, bytes}`；origin 按需拉 |
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
- 凭据类内容按 §9.7 的策略处理，不因为“在 artifact 里”就绕过。

### 11.7 明确不做

- **不做发布式目录**：`label`、`fingerprint`、`containment` 检查全部不实现。origin 只能在目标节点自动分配的工作区里跑。
- **不做多任务并发 / task-subdir 隔离**：节点单槽（§11.4）。
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
## 12. 安全与授权

### 12.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**必填**，最短 12 字符；UI 默认生成 24 字符随机串（`base64url`），并提供复制/二维码。
- 密码不入库明文：首选系统钥匙串引用；退而求其次才在插件配置里存 `HKDF` 派生密钥（文件权限 0600）。存派生密钥的代价是：配置文件泄露 = 直接获得签名能力，所以推荐前者。
- 日志、配置文件、错误信息里都不出现密码或派生密钥。
- 密钥派生：

```text
k = HKDF-SHA256(ikm = password, salt = "whale-pod", info = workgroup_id, len = 32)
```

- 换密码：**改过的节点用新密码重启，重新 join 组成新 group**；没改的节点留在旧 mesh 里，签名对不上就 401/offline，等于被移出（§12.3）。没有“过渡期双密码”，也不需要集中式踢人。

### 12.2 请求签名（没有 session token）

每个请求自带证明，服务端用同一把 `k` 现验：

```http
Authorization: Pod node_id=N7K3QM; ts=1763100000; nonce=9f2c1a; proof=<base64url>
```

```text
proof = HMAC-SHA256(k, "pod-v1|" + method + "|" + path + "|" + sha256(body) + "|" + ts + "|" + nonce)
```

校验顺序：

1. `ts` 与本地时间差 ≤ 60s（时钟漂移单独报错，别混进 401）；
2. `nonce` 未在 5 分钟窗口内出现过（每节点 LRU，容量 10k）；
3. `proof` 常量时间比较；
4. 通过后按 `node_id` 找/建 peer 记录（首次即登记，见 §10.2）。

性质与代价：

- **无状态**：服务端不存 token，不需要清理、不需要刷新、不需要 TTL；
- **密码即凭证**：密码泄露 = 全组沦陷；所以密码强度与分发是唯一的安全边界；
- **不可撤销单个节点**：密码是全组共享的，想踢人只能换密码并重建 group（§12.3）。
- **重放窗口**：60s + nonce 去重；跨节点时钟必须大致同步（NTP）；
- **代理友好**：签名覆盖 method/path/body，代理改写 body 会验签失败（这是特性）。
- **大 body 的签名**：带 body 的请求加 `X-Pod-Body-SHA256` 头，签名覆盖这个摘要而不是把整个 body 读进内存重算一遍；服务端流式落盘后再自校验，不一致即 `400 body_digest_mismatch`。
- **下载可换短期直链**：授权方调 `POST /blobs/{id}/link`，服务端生成一个**不可预测的随机 token**（32 字节，存库，绑定 `blob_id + exp`，TTL 5 分钟），返回 `GET /blobs/{id}?token=...`。浏览器/curl/前端直链不用带长期请求头。token 是服务端签发的，不是本地 HMAC——否则任何持有共享密钥的成员都能自造一条绕过 ACL 的链接。撤销 = 删库行。

`/cluster/join` 用同一种签名；区别只是它同时返回目录。`/health` 不签。

### 12.3 密钥与密码的分发

- 推荐：`workgroup_id` + 密码通过带外通道给（人当面、密码管理器、私聊），不放进任何仓库；
- 插件配置里只存 `workgroup_id` 与钥匙串引用；导出的配置不含密码；
- 二维码/复制按钮只用于本机设备间传递，UI 明确写“这是明文，别发群里”；
- 轮换（“解散再重建”，是特性不是缺陷）：
  1. A 改密码并重启监听 → 旧签名全部失效，A 对旧成员表现为 401，旧成员对 A 表现为 offline；
  2. B 也改成同一新密码、重启、重新 join A → 新 group 成立（此刻 A、B 互见）；
  3. 没改密码的 C 留在旧状态：它能拨 A，但签名验不过，**进不来**；A 也不会把 C 当成员；
  4. 想恢复 C，就把它的密码改成新的、重新 join 任意一个新成员。
- 结论：整个过程不需要“踢人接口”，也不需要维护黑名单——**密码就是成员资格**。

### 12.4 TLS 部署矩阵

| 场景 | 方案 | 要点 |
|---|---|---|
| 局域网/VPN | 明文 HTTP | 密码是唯一门槛；确保网络本身可信 |
| 公网单节点 | Caddy `reverse_proxy` + 域名 | 自动证书；节点只听 127.0.0.1 |
| 公网多节点 | Caddy/nginx 各节点一套 | 证书可集中签发；注意 SSE 缓冲关闭 |
| 零信任 | Tailscale/WireGuard | 网络层隔离，节点仍要密码 |

`trust_proxy`：只有配置了 `127.0.0.1` 才读 `X-Forwarded-For/Proto`，否则一律用 socket 地址。

### 12.5 远程任务是不可信输入

- 任务 prompt、artifact 内容、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 审计记录：谁（origin_node）、何时、对哪个任务/工作区、用了什么 mode、批了什么。

### 12.6 授权矩阵

不是“同 workgroup 就能跑一切”。每个节点维护：

| 维度 | 默认 | 可配 |
|---|---|---|
| 谁能派任务 | 同 workgroup 的任意已加入节点 | 按 node_id 白名单 |
| 权限上限 | 继承 origin 会话 mode | 本机可再降一档 |
| group workspace 可见性 | 同 workgroup | 仅本机 |
| 任务/产物读取 | 同 workgroup 凭 id | —（无 per-task / per-blob ACL） |
| 任务接续 | 同 workgroup，且来源 task 已终态 | — |
| 硬拒绝 | §9.5 | 仅本机人类解除 |

### 12.7 SSRF / hints 防护

- hint 的 endpoint 在拨号前校验：拒绝回环、`0.0.0.0`、组播、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`::1`、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；公网地址需要 `allow_public_peers: true`；
- 失败 3 次退避 5 分钟；hint 触发的探测单独计数，防止被当作端口扫描器。

### 12.8 审计

- 落盘 JSONL，按天轮转；字段：`ts, actor_node, action, target, result, task_id, grant_id`；
- 审计文件不放在 group workspace 里；
- `permission_request` 全文入审计（脱敏后），便于事后回答“它当时要什么”。

---

## 13. 任务可靠性

### 13.1 语义

- **at-least-once + 幂等**，不是 exactly-once；
- **失败立即、终止明确**：节点失联 → `failed`，不重发、不自动恢复（§13.2）；
- **副作用可见**：`failed` 带 `effects_unknown`，提示“目标侧可能已经改了文件”；
- **状态诚实**：宁可说“失败/未知”，不假装成功。

### 13.2 节点失联 = 任务失败，不重发

```text
origin 轮询 tasks/get
  → 连续连接失败达到 offline_after（≈12s）
  → task = failed(reason=node_unreachable, effects_unknown=true)
  → 停止轮询；不再派同一任务
```

为什么不做重发 / 不做 unknown 挂起：

- 跨节点无法知道“执行到哪一步”：重发可能重复写文件、重复调 API、重复产生副作用；
- 挂 `unknown` 等于把问题留给用户，而用户没有信息去判断——不如直接失败并标清不确定性；
- 目标恢复后如果它自己完成了，origin 已经 failed：**不处理、不召回**，也没有 `late_result` 状态。要不要保留现场由人看工作区 diff 决定；没有被引用的 blob 按 7 天 GC。

目标侧的处理：

- 目标节点继续跑（如果还活着），任务结果留在本地 SQLite；origin 已失败时不再回调；
- 目标重启后 `working` 的任务按 §13.3 处理。

### 13.3 目标重启

- `submitted`：未开始，标 `failed(node_restart)`；
- `working`：标 `failed(node_restart, effects_unknown=true)`，**不尝试 resume**；提示用户检查工作区 diff；
- `input-required`：标 `failed(node_restart)`（授权请求已失效）；
- 重启后不允许把旧 task 悄悄“接着跑”——那会让 origin 的状态和实际再次分叉。

### 13.4 幂等键

- 作用域 `(workgroup_id, origin_node, idempotency_key)`，窗口 24h；
- 重复提交（同键）返回已有 task，不新建；
- 不承担重试语义：重试必须显式，且产生新 task（带 `retry_of`），由人决定。

### 13.5 超时与背压

- `task_ttl_s` 默认 3600；超时 → `failed(timeout)` + 尽力 `tasks/cancel`；
- 节点单槽：同一时间只跑 1 个任务（§11.4）；忙时 `429 node_busy` + `Retry-After`，不排队；
- origin 侧轮询退避到 2s 后不再增长（避免“等太久以为挂了”）。

### 13.6 放大与唤醒（为什么不会风暴）

一句话：**默认单跳，所以没有环**；多跳与扇出是可选能力，默认关闭，打开后由 `hop`/`chain`/`fanout` 和单槽封顶。节点不会因为心跳互相唤醒——唤醒只来自任务请求。

默认（`delegation` 关）构造上就没有环：

1. **任务不转发**：节点只执行 origin 给它的任务，不把任务转给第三个节点；executor 默认没有 pod 远程工具（§8.3），且 `hop > 0` 被拒（§7.5）。
2. **没有回调**：target 从不反连 origin（§9.4）；完成靠 origin 轮询/SSE。不存在“B 做完叫醒 A、A 又叫醒 B”。
3. **没有广播**：心跳固定 2s、单向；成员变化靠 digest 拉取（§10.1）；没有 gossip、没有事件订阅、没有 completion webhook。

打开 `delegation` 之后（多跳/扇出），约束换成：

- **注入而非自填**：网关把 `hop+1`、`chain+[self]`、`root` 写进子任务；agent 改不了。目标节点已在 `chain` 中 → `403 ancestor_call_forbidden`。
- **预算**：`max_hop` 默认 0、可配 1–3；`max_fanout` 默认 0、可配（按 `root` 计）。超限直接拒，不排队。
- **单槽仍在**：每个 target 同一时间只跑 1 个任务；多余的请求在**建 task 之前**就 429，不创建进程——唤醒成本 = 一个 429 响应。
- **祖先禁调（硬限制）**：子任务不能指向 `chain` 里的任何节点或自身；网关直接 `403 ancestor_call_forbidden`。A→B→A 在第一跳就断，不依赖 `max_hop` 的深度。
- **兄弟互调不会僵死**：单槽下先占槽的一方还在跑自己的任务，另一方调它时直接 `429 node_busy`——不会出现“两边都等着对方把活干完”。拿到 429 的一方把这个事实写进 `blocked` 回报 A，由 A 协调（换顺序、拆任务，或回报用户）。TTL 只兜底极端情况（两边恰好都在 `input-required` 被同时唤醒），到期 `failed(timeout)`。
- **重试**：服务端从不自动重试；模型重试必须退避 + 抖动。幂等键只防重复建 task，不制造重试。
- **熔断**：连续失败 → peer 进 suspect/unreachable，发送停止并退避（§10.3）；不会“越连不上越猛试”。
- **总闸**：本机总开关一次性取消所有远程任务（§9.5），不依赖网络。

数量级：

| 场景 | 10 节点时的量 |
|---|---|
| 空闲 | 心跳 45 req/s，~200 B/req ≈ 9 KB/s，与任务数无关 |
| 全部在跑 | 最多 10 个 agent 进程（每节点 1 个槽），不是 10² |
| 被打爆 | 每个 target 1 个任务 + 其余 429；429 < 1 KB 且不创建进程 |
| 链式（默认关） | `max_hop=3`，每跳最多 `max_fanout` 个子任务，超预算即拒 |
| 扇出（默认关） | 一个 root task 最多 `max_fanout` 个活跃子任务 |

真正会失控的只有一种情况：**允许 target 上的 agent 再调其他节点**。那是指数扇出的来源，所以默认关闭；要开就必须同时接受 hop/chain/fanout 三重限制。这是刻意的保守选择：宁可少一种编排能力，也不要一个会自己跑起来的集群——但能力本身保留，需要时显式打开。

---

## 14. 可观测性

指标：

- `pod_peer_state{peer,state}` gauge（online/suspect/unreachable/offline/unknown）
- `pod_peer_last_recv_age_seconds{peer}`、`pod_peer_last_ok_age_seconds{peer}`
- `pod_members_known`、`pod_members_digest_changes_total`
- `pod_hint_accepted_total`、`pod_hint_rejected_total{reason}`、`pod_tombstones_active`
- `pod_join_total{result}`、`pod_join_failures_total{reason}`
- `pod_auth_failures_total{reason}`
- `pod_tasks_submitted_total{target,workspace_kind}`
- `pod_tasks_terminal_total{state,reason}`
- `pod_task_duration_seconds{skill}`
- `pod_grants_issued_total{mode}`、`pod_grants_denied_total{reason}`
- `pod_approvals_total{result}`、`pod_approval_latency_seconds`
- `pod_workspace_bytes{workgroup}`、`pod_node_busy`、`pod_node_busy_seconds_total`、`pod_node_busy_rejected_total{reason}`
- `pod_blob_uploads_total{result}`、`pod_blob_downloads_total`、`pod_blob_bytes{workgroup}`、`pod_blob_gc_total{reason}`
- `pod_heartbeat_rtt_seconds{peer}`
- `pod_executor_errors_total{type}`

日志：JSON；必带 `trace_id`、`task_id`、`origin_node`、`target_node`、`grant_id`；不记录密码、签名、密钥；错误带类型与可重试标记。

UI（节点卡片）至少展示：`display_name (node_id)`、OS 与版本、CPU/内存、DSH 版本、在线状态与延迟、group workspace 用量与配额、忙闲（正在跑哪个任务、已跑多久）、最近一次任务、当前会话权限模式。

---

## 15. 分阶段路线图

### Phase 0：两台机器，静态 peer，EchoExecutor

- 单端口：`/health`、Agent Card、`/a2a`、`/cluster/join|heartbeat|members`。
- 短 id 生成 + 持久化；workgroup_id + 非空密码；HKDF + 请求签名。
- EchoExecutor（§8.6）：按脚本模拟耗时、挂起（`blocked`/`permission`）、最终文本与产物；`ping` 只返回节点信息。
- `message/send` + `tasks/get` + `tasks/cancel`；SQLite task store。
- 验收：`/health` OK；带签名能读 Agent Card；join 成功；两节点双向心跳；kill 一方 12s 内从在线集消失；重启后 task store 仍可查。

### Phase 1：三节点 full mesh 与惰性收敛

- 新节点 join 任意节点 → 按目录对每个 peer 各 join 一次（幂等）→ 自动补全 mesh。
- 双向看门狗（6s/12s）、单调时钟、`unreachable` 状态。
- hints/候选/墓碑（§10.5）：验证“死节点不会互相刷活”。
- `runtime` 采集与展示；`members_digest` 比对。
- id 冲突 409；leave；记录修剪。
- 验收：C 加入 A 后 2s 内 A/B/C 互相可见；kill B 后 6s suspect、12s offline；拔掉 B 的网线后 A/C 不会把 B 互相刷回在线；B 重启并重新发心跳后 15s 内恢复。

### Phase 2：接 DSH 执行 + workgroup 工作区

- `HeadlessExecutor` → `AcpExecutor`；专属 profile；cwd = group workspace。
- context → session 绑定；`session/update` → task 事件；thought 过滤。
- 取消（process tree / `session/cancel`）；`input-required` 透传。
- 工作区持久化、`notes/STATUS.md` 约定、配额；单槽 busy（`429 node_busy` + `Retry-After`）。
- blob 通道（§7.10）：上传素材、下载产物、去重、GC；结论文本内联回传。
- 权限模式继承（先只做 `read-only`/`workspace-write` 两档的映射，escalate 先回固定 deny）。
- 验收：真实任务完成；跨任务续跑能看到上次的文件与 notes；节点失联 → 12s 内 `failed(node_unreachable)`；取消生效；重启后 `working` 标 `failed(node_restart)`；上传→任务→下载 roundtrip 通过；节点忙时第二个任务返回 429 且 UI 显示持有者。

### Phase 3：权限模型 + 审批回路

- grant 签发/校验/吊销（§9.3）；默认 `delegated`。
- `input-required` 升级回路（§9.4）：**task 置 input-required 并把 `permission_request` 写进 task 记录**（不是 target 拨 origin）→ origin 轮询/SSE 看到 → **用 DSH 审批卡片弹** → 批准生成新 grant 并作为同一 task 的后续 message 补发 / 拒绝置 `failed(permission_denied)`。
- 预授权策略（按 target + 工具 + 时长）与本机总开关。
- `credential_readback` 三档 + 审计。
- 工作区加固：配额、清理、Windows 长路径/保留名测试矩阵（§11.8）。
- 验收：越界写被拒；权限模式继承正确（origin 只读 → target 写被拒）；升级请求只在 origin 弹卡片、target 无本地弹窗；无人值守节点不会被阻塞。

### Phase 4：安全与规模化

- TLS 部署配方（Caddy/nginx）、`trust_proxy`、限流、审计落盘与轮转。
- 10 节点 full mesh 压测：45 链路、45 心跳/s、任务延迟、内存/CPU。
- 可选：SSE、`tasks/resubscribe`、push notification。
- 可选：节点内建 mTLS。
- 验收：安全测试通过；10 节点 24h 稳定；单节点故障不影响其他节点任务。

---

## 16. 代码结构与模块边界

目标有三个，按优先级：每个模块能**单独用夹具测**；最简核心能在**纯 Node 里起 N 个节点**跑复杂 group 场景；DSH 插件只做适配，**不实现协议**。

### 16.1 包划分

```text
packages/
  protocol/    类型 + schema + 签名规范化 + 错误码（零依赖）
  crypto/      HKDF、请求签名、node_id
  config/      schema、默认值、加载、环境覆盖
  storage/     接口 + 实现（fs / sqlite）+ GC
  gateway/     HTTP 路由、鉴权、槽位、心跳、成员表
  executor/    LocalExecutor 接口 + EchoExecutor + AcpExecutor
  orca_node/   组合根：一个进程 = 一个节点
  harness/     进程内多节点 + 场景 DSL + CLI
  ui/          与框架无关的 view-model + 组件
  dsh-plugin/  DSH 适配：工具、审批卡片、状态页
```

依赖方向单向，禁止反向：

```text
protocol  ← crypto, config, storage, gateway, executor, ui
crypto    ← gateway, orca_node
storage   ← gateway, executor, orca_node
gateway   ← orca_node  （gateway 只依赖 protocol + storage 接口，不 import executor 实现）
executor  ← orca_node
orca_node ← harness, dsh-plugin
ui        ← dsh-plugin
```

`gateway` 通过构造参数拿到 `LocalExecutor` 接口实例，而不是 import 具体实现——这是“gateway 能单独测”的前提。

包名刻意避开 `node`：`orca_node` 是“orca 的节点”，跟 Node.js 运行时没有关系，import 时也不容易看错。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、`trustProxy`、错误处理都用它现成的，不手写 http server。

### 16.2 每个模块怎么测

| 模块 | 夹具 | 断言 |
|---|---|---|
| protocol | 固定 JSON 样本 + 签名向量 | schema 通过/拒绝、MAC 与向量一致 |
| crypto | RFC 5869 向量 + 冻结的 MAC | 换密钥/时间/body 任一字节即变 |
| config | 合法/非法配置样本 | 错误信息指向具体字段 |
| storage | 一套 contract test，跑 fs 与 sqlite | 两实现行为一致 |
| gateway | 进程内 `fetch`，假 executor、注入时钟 | 路由、401/403/429、签名 |
| executor | echo 脚本样本；假 ACP 子进程 | 状态时序、`input-required`、resume |
| harness | 场景 DSL | 成员收敛、任务往返 |
| ui | view-model 纯函数 | 忙闲、任务列表的渲染数据 |
| dsh-plugin | 假 DSH host 的 smoke | 工具注册、生命周期 |

### 16.3 进程内多节点

`orca_node` 的 `createNode(config)` 返回 handle：`start() / stop() / port / members() / tasks() / invoke(peer, payload)`。

- 端口用 `0` 让系统分配，避免并行测试抢 41241；
- 时钟可注入；心跳间隔与 suspect/offline 阈值都可配，测试里用 20ms/60ms/120ms，不必真等 6s/12s；
- 日志进内存 ring buffer，失败时 dump；
- harness DSL：`createMesh({ nodes: 3 })`、`until(cond)`、`assertTaskState`。

```ts
const mesh = await createMesh({ nodes: 3, password: "test" });
const t = await mesh.get("A").invoke("B", {
  echo: { steps: [], final: { state: "completed", text: "hi" } }
});
await until(() => mesh.get("A").task(t.id).state === "completed");
```

### 16.4 组合入口：库根在 `orca_node`，安装根在 `dsh-plugin`

“组合根”有两层，别混：

| 层 | 文件 | 谁调用它 | 职责 |
|---|---|---|---|
| 库根 | `packages/orca_node/src/index.ts` → `createNode(config)` | harness、dsh-plugin、将来的独立服务 | 装配一个节点：config → storage → gateway → executor。不读 argv、不读 DSH |
| 安装根 | `packages/dsh-plugin/`（bundle `@orca/pod`） | DSH 的 Loader | `apply(ctx, config)` 里 createNode、注册工具/审批/UI，cleanup 里 `stop()` |

DSH 加载一个 bundle 靠包清单里的 patch 行，不是 `main`：

```text
packages/dsh-plugin/
  package.json       "exports": { ".": "./index.js", "./client": "./client.js" },
                     "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
                              "client": { "platform": "web", "immediately": true } }
  cordis.patch.yml   - insert: { id: orca-pod, name: '@orca/pod' }          # Host 行
                     - insert: { id: orca-pod-client, name: '@orca/pod/client' }  # Client 行
  index.js           export const inject = ['tools']
                     export const Config = ...
                     export function apply(ctx, config) { ... }
  client.js          UI（状态页、审批视图），只消费 view-model
  locale/{en,zh}.json  meta.title / meta.description / meta.detail
```

`apply` 只做四件事，其余都靠注入：

```ts
export function apply(ctx, config) {
  const node = createNode({
    workgroupId: config.workgroup_id,
    displayName: config.display_name,
    port: config.port,                        // 默认 0：系统分配，启动后写回 config
    dataRoot: config.data_root ?? defaultDataRoot(),
    password: () => ctx.credentials.readRecord('orca-pod'),  // 签名时取，不缓存
  })
  ctx.effect(() => () => node.stop())
  void node.start().catch(err => ctx.logger.error(err))
  for (const tool of podTools(node)) ctx.tools.register(tool)
}
```

三条约束：

- `apply` 必须快速返回：`start()` 异步，端口占用/证书问题写日志与状态页，不能让 DSH 启动卡在网络监听上。
- 配置分两类：`workgroup_id` / `port` / `display_name` 走普通 config（Plugin manager 可改，`configEditor.edit` 持久化）；**密码进 `ctx.credentials` 记录，不进 config**，也不写进 bundle patch。
- 进程内嵌、不开子进程；DSH 退出 → cleanup → listener 关闭。工具注册用 `inject: ['tools']`；审批走 DSH 的 approval/卡片（§9.4），插件只把 `permission_request` 转成卡片数据、把人的操作回成后续 message。

harness / CLI 是第三个入口：`packages/harness` 的 `orca-node serve`，同一个 `createNode`，不依赖 DSH；测试与“非 DSH 机器”用它，将来单独跑 headless 服务也是它，不是新代码。

一句话：**装进 DSH desktop 的东西 = `dsh-plugin` 这个 bundle；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是 `createNode()`。**

### 16.5 工程约定

- TypeScript、ESM、Node ≥ 22；pnpm workspace；vitest + `@vitest/coverage-v8`；`tsc --noEmit` 进 CI。
- 构建 `tsup`（ESM + d.ts），开发 `tsx`，lint/format 用 `biome`（一个工具替 eslint+prettier），CLI 用 `commander`，日志用 `pino`（开发加 `pino-pretty`）。
- 不引入框架级 DI 容器：构造函数注入足够，装配只在 `orca_node` 包。
- 存储默认 fs（`lowdb` + `steno` 原子写），sqlite 用 `better-sqlite3` 作为可选实现进 Phase 2（嫌原生依赖麻烦可退回 `node:sqlite`）。
- 命令：`pnpm -r test`、`pnpm harness --nodes 5 --scenario join`。

### 16.6 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、CLI、原子写、id 生成这类“基础功能”直接用成熟包；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、grant、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 能力 | 选型 | 说明 |
|---|---|---|
| HTTP 服务 | `fastify` | 成熟、插件生态、schema 校验、`trustProxy`、`bodyLimit`；不手写 http server 与路由 |
| 参数校验 | `zod` + `fastify-type-provider-zod` | `protocol` 包统一用 zod，服务端复用同一套 schema |
| 结构化日志 | `pino` / `pino-pretty` | 低开销、字段化；测试里可静音 |
| 小 JSON 状态 | `lowdb` + `steno` | 原子写、无数据库；存成员缓存、配置、GC 标记 |
| 任务存储 | `better-sqlite3` | 同步 API、稳定；替代方案 `node:sqlite` |
| 文件原子写 | `write-file-atomic` | blob 落盘与 manifest；避免手写 rename+fsync |
| id 生成 | `ulid` | `task_id` 单调可排序；`node_id` 仍需自写（6 字符 Crockford） |
| HTTP 客户端 | 内置 `fetch`（undici） | 不引 axios；测试用 `undici` MockAgent 或 `msw` |
| 重试/退避 | `p-retry` | 只在客户端（模型/UI）用；服务端仍然不自动重试 |
| 假时钟 | `@sinonjs/fake-timers` | 心跳阈值与 `at_ms` 的单测；配合注入的 `Clock` 接口 |
| 构建/开发 | `tsup`、`tsx` | ESM 输出 + 直接跑 TS |
| Lint/format | `biome` | 一个工具，配置在根目录 |
| CLI | `commander` | harness 与节点启动参数 |
| MIME/文件名 | `mime-types`、`sanitize-filename` | blob 下载 `Content-Type` 与 `Content-Disposition` |
| 限流（Phase 4） | `@fastify/rate-limit` | 代理后按 IP；现在不装 |
| SSE（Phase 4） | `fastify-sse-v2` | 只在做 `message/stream` 时引 |

明确不引的：认证/签名框架（没有比 30 行 Node `crypto` 更合适的）、DI 容器、ORM、消息队列、服务网格。集群只有十台机器，这些是负资产。

### 16.7 与路线图的对应

- Phase 0：protocol、crypto、config、storage、gateway、executor(echo)、node、harness。
- Phase 1：harness 场景覆盖成员收敛与故障注入。
- Phase 2：AcpExecutor、ui 基本视图。
- Phase 3：dsh-plugin、审批卡片、权限。
- Phase 4：10 节点压测复用 harness。

---

## 17. 验收标准（摘要）

### 两台节点

- [ ] `/health` 无鉴权可达；Agent Card 公开可读且不含 runtime/路径/拓扑；`/cluster/members` 无签名被 401
- [ ] 错误 workgroup / 错误密码被 401（同一文案，不区分）
- [ ] 正确密码 + 签名可 join、心跳、拉目录
- [ ] 两节点双向心跳；kill 一方 12s 内从在线集消失
- [ ] 节点重启后 task store 与工作区仍在

### Echo 脚本（Phase 0/1）

- [ ] `echo.final.text` 原样出现在 `tasks/get` 的 `status.message.text`，逐字节相等
- [ ] 到 `at_ms` 时任务变 `input-required`，`blocked`/`permission_request` 可读，槽位释放
- [ ] 恢复后从上次位置继续，不重放已过去的 step；总时长约等于各 step 间隔之和（不含挂起时间）
- [ ] `artifacts[].blob_id == sha256(content)`，产物可被另一节点 GET
- [ ] `hang` 脚本被 `tasks/cancel` 后 2s 内变 `canceled` 且槽位释放；不取消则 `task_ttl_s` 到期进 `failed(timeout)`
- [ ] 非法脚本（`at_ms` 递减、未知字段、`state` 非法）在建 task 前 `400 bad_echo_script`

### 三台节点

- [ ] C join A 后 2s 内三向可见（C 按目录自行补全到 B 的边）
- [ ] 拔掉 B 的网线：A 与 C 都判 offline，且不会通过 hints 互相把 B 刷回 online
- [ ] B 恢复后仅凭自己的心跳回到 online（无人手动清缓存）
- [ ] B 离线 7 天后记录被修剪
- [ ] 不出现任何 epoch/incarnation 字段

### 权限与工作区

- [ ] origin 只读会话 → target 写文件被 escalate/deny
- [ ] origin workspace-write → target 只能在 group workspace 内写
- [ ] 升级请求只在 origin 弹审批卡片，target 无本地弹窗
- [ ] 同一 context 的第二个任务能读到第一个任务的 `notes/STATUS.md`
- [ ] `credential_readback=ask` 时私钥内容回传需 origin 批准
- [ ] 绝对路径与 `..` 被拒（协议层根本不接受路径）
- [ ] 节点忙时第二个任务返回 429 `node_busy` + `Retry-After`，UI 显示当前持有者；调用方模型能从错误体拿到 `retry_after_s` 与持有者，自行选择重试、换节点或向用户回报（全场只有一台能执行时，回报用户即正确结局）
- [ ] C 用 A 给的 `task_id` 能读到 A 在 B 上的结果；没有 `task_id` 时无法枚举
- [ ] C 凭 `blob_id` 直接 `GET` B 上的产物，不需要额外授权
- [ ] C 用 `continuation_of` 续跑：旧 task 状态与 artifact 不变，新 task 落在同一工作区；旧 task 未终态 → `409 task_not_terminal`

### 文件交换

- [ ] 上传 1 MiB 文件返回 201，`blob_id == sha256(bytes)`
- [ ] 重复上传同内容返回 200，不占新空间
- [ ] `X-Pod-Body-SHA256` 与实际字节不符 → 400 且不落盘
- [ ] 素材上传 → 任务引用 → 产物下载 roundtrip 通过
- [ ] 短期直链 token 过期后不可用；换 blob 或篡改 blob_id 被拒；token 不可由本地密钥伪造
- [ ] 未被任务引用的 blob 在 TTL 后被 GC，下载返回 410

### agent 侧（插件接线）

- [ ] `pod_send` 立即返回 `task_id`，工具调用不挂到任务结束
- [ ] 插件后台 tracker 按 500ms→2s 拉状态；target 开了 `message/stream` 时改持 SSE，两种模式行为一致
- [ ] agent 工具列表里没有任何阻塞等待工具（没有 `pod_wait`），`pod_send`/`pod_status` 都在毫秒级返回
- [ ] target 忙时 `pod_send` 拿到 `429 node_busy` + 持有者，agent 把“B 忙、约 N 秒”回报用户并结束本轮（或先做别的），不自动重试
- [ ] 普通完成走 `agent.inject()`：日志出现 `agent/inbox/spliced`，下一轮上下文能看到，**没有**凭空开新一轮
- [ ] `permission_request` 走 `agent.followup()`：新一轮开始并弹出审批卡片
- [ ] 全程没有 `sleep`/长轮询的 bash 命令；agent 工具列表里没有 `orca-node wait`
- [ ] `notify: auto`：派发后 `turn/end`、任务才完成 → 只唤醒一次，新一轮读到结果并继续
- [ ] 同一轮内完成的任务不触发唤醒（`pod_status` 已可读，只 inject）
- [ ] 派发后用户发了新消息 → 完成时只 inject，不打断当前轮
- [ ] 2s 内三个任务完成只产生一次 `followup()`；连续第 4 次后台唤醒被拦下并留 inbox

### 安全

- [ ] 无密码不能创建 workgroup
- [ ] 密码不出现在配置、日志、错误信息中
- [ ] 改密码后旧签名立即失效
- [ ] 重放请求（同 nonce）被拒
- [ ] hint 指向 `169.254.169.254` 被拒

### 10 节点

- [ ] 45 条心跳链路稳定 24h，CPU/内存无泄漏
- [ ] 单节点故障不影响其余节点任务
- [ ] 任务延迟与 2 节点相比无数量级退化
- [ ] 默认 `delegation` 关：构造 `pod.hop=1` 的任务被 `400 hop_limit`；目标节点已在 `chain` 中被 `403 ancestor_call_forbidden`
- [ ] 开 `max_hop=1` 后一跳子任务能跑通（子任务 `hop=1`、`chain` 追加自身、`root` 不变）；`hop=2` 被拒
- [ ] 开 `max_hop=2` 后二跳任务能跑通（子任务 `hop=2`）；`hop=3` 被拒
- [ ] 子任务目标集合排除 `chain` 中节点与自身：B 尝试调 A → `403 ancestor_call_forbidden`，不建 task
- [ ] B 卡住 → task 变 `input-required` 且 `blocked` 可读；B 的槽已释放（其他 origin 能立刻建 task）；A 回复后任务继续
- [ ] B、C 互调：后到的一方拿到 `429 node_busy` 并能把它写进 `blocked` 回报 A；不出现两边都卡到 TTL
- [ ] 开 `max_fanout=2` 后，同一 root 的第 3 个活跃子任务被拒；关掉后行为恢复默认
- [ ] origin 对同一 target 并发 10 个请求：target 只创建 1 个 agent 进程，其余 429
- [ ] 一个 origin 连续快速失败后进入退避，不出现“越失败越发”的请求上升

---

## 18. 未决问题

> 已有结论、不再列为未决：并发策略（单槽，§11.4）、发布式目录（不做）、结果文本与 `notes/` 分层（§11.6）、文件通道（§7.10）、Agent Card 公开（§5.2）、密码轮换（解散重建，§12.1/§12.3）、迟到结果（不处理，§13.2）、多端点（每节点一个 endpoint）、32 KiB 与文件名恢复（§11.6）。

1. **密码分发方式**：二维码、剪贴板、系统钥匙串/密码管理器，选哪个作为默认？自动生成后怎么让人确认“对面拿到的是同一串”。
2. **大文件传输**：Range/断点续传要不要做、阈值取多少（比如 >64 MiB 才分片）；跨网段重传成本如何。
3. **超过 10 个节点的行为**：UI 提示 O(n²) 心跳负荷即可，还是直接拒绝加入？当前计划是提示。
4. **局域网自动发现**（mDNS / UDP 广播）：当前不做，host+port 手动加入已够；若做，要接受“网段内可见”的隐私代价。
5. **Windows 路径测试矩阵**：8.3 短名、junction、`\\?\`、保留名（`CON`/`NUL`/`aux`）、尾随点——作为 Phase 2/3 的实现 checklist，当前无阻塞。

---

## 19. 新工作区交接

### 19.1 阅读顺序

1. 本文件 `DESIGN.md`（宏观基线）。
2. 之后拆分出的 `AGENTS.md`（硬约束）。
3. `docs/design/00-overview.md`、`01-a2a-task-plane.md`、`02-control-plane.md`、`03-permissions.md`、`04-workspace.md`、`05-security.md`。
4. ADR：关键决策及理由。

### 19.2 第一条 prompt 建议

```text
Read DESIGN.md first.

Hard constraints that must not be undone:
- Topology is full mesh only. There is no ring, no gossip, no coordinator.
- There is no epoch, no incarnation, no global membership table.
  A node's table contains only peers it directly heard from; hints are endpoint
  candidates, never liveness claims.
- Listener is plain HTTP/1.1 with keep-alive. TLS is terminated by Caddy/nginx.
- node_id is a 6-char Crockford base32 label generated at install, editable,
  persisted in plugin config. It is NOT a security principal.
- Auth = workgroup_id + non-empty password -> HKDF key -> per-request HMAC.
  No session token, no TTL, no empty password.
- Agent Card is public but carries no runtime, paths, or topology; runtime and
  busy state sit behind signed endpoints only.
- File exchange goes through a content-addressed blob channel. Task conclusions
  come back inline as text; artifacts are pulled explicitly by blob id.
- Approval happens on the ORIGIN node and follows the origin session's
  permission mode. The target never opens a local approval dialog.
- Execution dir is the persistent per-workgroup workspace; there is no
  published-root concept. One task at a time per node (single slot), otherwise
  429 node_busy with retry_after and holder; the calling model decides whether
  to retry, switch node, or report back to the user. No server-side queue.
  One endpoint per node. Absolute paths from origin are rejected.
- Tasks are single-hop by default: no forwarding, no callbacks. The gateway, not
  the agent, decides hop/chain/root. Multi-hop and fan-out exist as opt-in
  capabilities (max_hop/max_fanout default 0); when enabled, the gateway injects
  hop+1, appends the node to chain, keeps root stable, and rejects over-budget
  children. Nodes never wake each other except by an origin-issued request.
- A child task may never target a node already in its chain: the gateway returns
  403 ancestor_call_forbidden, regardless of max_hop. A blocked sub-agent reports
  via input-required with a `blocked` payload and releases its slot; the origin
  decides and continues the task with a follow-up message. No reverse calls.
- Polling lives in the Host plugin, not in the agent's shell: pod_send returns a
  task_id immediately; a background tracker polls tasks/get (or holds an SSE
  stream), and completion reaches the session through agent.inject() as a compact
  inbox notice that does not wake the agent. Default notify is "auto": if the
  dispatching turn ended before the task reached a terminal state, a completion
  wakes the agent once (batch completions within 2s, cap 3 consecutive background
  turns, drop to inbox beyond that). Only must-act-now events (a permission_request,
  a blocked sub-agent, a hard failure) also use followup(). Never implement waiting
  with bash sleep loops, and provide no blocking wait tool at all: dispatch returns
  immediately, completion arrives by inject/wake, and a busy target answers 429
  node_busy (with holder and retry_after_s) which the agent reports to the user
  before ending the turn or doing unrelated work.
- Task and blob ids are the only access handles: any workgroup member holding a
  task_id or blob_id can read it; there is no per-task/per-blob ACL and no
  listing. Id leakage is the exposure boundary. One shared key means node-level
  checks are policy, not cryptographic isolation.
- Continuation is a new task with `continuation_of` pointing at a terminal task;
  it reuses the same context and workspace and never mutates the old task.
- Password rotation rebuilds the whole group. There is no per-node revocation
  and no transition window with two passwords.
- Task storage is single-node SQLite (WAL). Node loss fails the task; do not
  re-dispatch and do not invent a resume.
```

### 19.3 交接规则

1. 新 agent 的第一件事是读本文与 ADR，不是写代码。
2. 任何与本文冲突的实现选择，要么改文档（并写 ADR），要么改实现；不允许“代码里先这么写，文档以后补”。
3. 新增依赖、放宽权限、改变传输层，必须显式提出，不能夹带在功能 PR 里。
4. 每个 Phase 结束时更新 §17 的勾选项与 §18 的未决问题。

### 19.4 建议的下一步拆分

- `docs/design/00-overview.md`：§0–§4 的展开。
- `01-a2a-task-plane.md`：§7–§8。
- `02-control-plane.md`：§10（含 hints/墓碑的测试用例）。
- `03-permissions.md`：§9 + §12.5，附威胁模型。
- `04-workspace.md`：§11，附目录布局图与清理策略。
- `05-security.md`：§12，附密码分发与轮换 runbook。
- ADR：`0001-full-mesh-no-ring.md`、`0002-node-id-as-label.md`、`0003-password-derived-hmac.md`、`0004-approval-on-origin.md`、`0005-group-workspace.md`、`0006-fail-fast-on-node-loss.md`、`0007-hints-are-not-liveness.md`、`0008-plain-http-behind-proxy.md`、`0009-sqlite-task-store.md`。

---

## 20. 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP（Agent Client Protocol）：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- HKDF（RFC 5869）：https://www.rfc-editor.org/rfc/rfc5869
- Crockford Base32：https://www.crockford.com/base32.html

---

## 21. 一句话总结

> 一个 workgroup、一把密码、一张 full mesh；每个节点只相信自己的眼睛，只在自己的屏幕上点头；工作区是办公室，不是酒店房间；节点没了，任务就诚实地说没了。
