# 01 概述

> Orca Pod 是若干台安装了 DSH 的机器组成的对等集群：每个节点既是 A2A server 也是 client，任务在目标节点本地执行，结果按 id 交接。本章给出目标、非目标、术语与阅读入口，是后续所有章节的约束来源。

## 1. 概述

### 1.1 概览

Orca Pod 是一个小规模、对等的 DSH 集群：

- 每台机器上跑一个 **DSH 插件**（Pod 网关）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 本地执行由 **LocalExecutor** 驱动，ACP 只走本地 stdio，绝不跨网络。
- 节点之间是 **full mesh**，10 台以内不做 ring、不做 gossip、不做中心调度器。
- **默认单跳**：origin → target，不转发、不回调、不广播；多跳与扇出是可选能力，默认关闭（[§8.6](08-reliability.md#86-放大扇出与唤醒)）。节点只被任务请求唤醒，忙时 429 而不是排队。
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

### 1.2 目标

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

### 1.3 非目标

1. **不做分布式共享会话/共享上下文**。每个任务在目标节点本地 DSH 里执行；A2A 只传任务和结果。
2. **不做 exactly-once**。采用 at-least-once + 幂等；需要强一致的场景另加外部协调。
3. **不做跨 workgroup 联邦**。不同 workgroup 默认互不可见。
4. **不做 ring。** 连接拓扑只有 full mesh，不保留“后续可选环”的设计位。
5. **不做全局成员表版本号（epoch）和节点代数（incarnation）。** 见 [§3.1](03-membership.md#31-成员状态的判定)。
6. **不做被调用节点阻塞式人工审批。** 无人值守机器上弹窗等人是设计错误；审批只在发起节点做（[§7](07-security.md#7-安全与权限)）。
7. **不做 target-local-approval。** 目标侧本地弹窗没有意义：人不在那台机器前，弹了也没人点。
8. **不做共享文件系统 / 反向挂载。** 不引入 SMB/NFS/9p/分布式 FS；跨节点只传 artifact（[§6.12](06-execution.md#612-明确不做)）。
9. **不做空密码 workgroup。** 没有密码就没有认证，不存在“先跑起来再补”的中间态。
10. **不做 session token / 短期令牌。** 密码派生密钥直接做请求签名，少一层状态和一层失效语义。
11. **不把 ACP 或 MCP 当集群协议。** ACP 只允许本地 stdio；MCP 是 agent→tool，不是对等任务协议。
12. **不把 DSH 内部 Web API（`/api/*`、`/api/remote.mux`）当公开协议。** 它是单 Host 的内部 BFF，版本耦合。
13. **不做节点内建 TLS 作为默认部署。** 默认明文监听 + 前置代理；节点内建 mTLS 是 Phase 4 的可选项。
14. **不做公网裸奔。** 公网暴露必须经 TLS 代理或 VPN。

### 1.4 术语与命名约定

| 术语 | 含义 |
|---|---|
| **workgroup_id** | 集群命名空间 + 凭证作用域，如 `orca-dev`。正则 `[a-z0-9][a-z0-9-]{1,31}`。 |
| **node_id** | 6 字符短 id，节点的显示标签；同一 workgroup 内唯一，非安全主体。 |
| **Peer** | 同一 workgroup 内、本节点已知的另一个节点。 |
| **SelfRecord** | 节点对自己的描述（endpoint、runtime、工作区用量、忙闲），只能由本人写。 |
| **members_digest** | 排序后的成员记录摘要，用于“我落后了没有”的比对，不表达在线状态。 |
| **hint** | 心跳里捎带的 `(node_id, endpoint)` 候选，**不是**在线声明，见 [§3.5](03-membership.md#35-hints候选与墓碑)。 |
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
Workgroup: orca-dev
Full mesh (<= 10 nodes), 唯一拓扑
```

### 1.5 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP（Agent Client Protocol）：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- HKDF（RFC 5869）：https://www.rfc-editor.org/rfc/rfc5869
- Crockford Base32：https://www.crockford.com/base32.html

---
