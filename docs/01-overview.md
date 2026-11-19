# 01 概述

> Orca Pod 是若干台安装了 DSH 的机器组成的对等集群：每个 orca node 既是 A2A server 也是 client，任务在目标 orca node 本地执行，结果按 id 交接。本章给出目标、非目标、术语与阅读入口，是后续所有章节的约束来源。

## 1. 概述

### 1.1 概览

一页摘要见 [README](README.md#一页摘要)；本章不重复展开，只列骨架：

- 每台机器一个 orca node（只以 DSH 插件的形态运行，不论有几个 DSH profile）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 拓扑只有 full mesh；成员关系只来自直接收到的心跳；身份是 Ed25519 公钥，入组靠 workgroup 密码派生的准入证明。
- 任务面是 A2A（`message/send` / `tasks/get` / `tasks/cancel`），异步、轮询；单槽执行，忙时 429。
- 文件按 `<节点 id>/<sha256>` 命名：节点只发布自己机器上的文件，谁需要谁让自己的节点去拉；交接靠持久的 group 工作区，里面留什么由 agent 决定。
- 权限继承发起会话的模式；越界请求回到 origin 由人决定。

### 1.2 目标

1. 任一 orca node 都能向任一其他 orca node 发起任务，并拿回状态和结果。
2. orca node 对等：没有永久中心调度器；每个 orca node 既是 A2A server，也是 A2A client。
3. 支持 2–10 个 orca node；10 个 orca node 时 full mesh 仍然可控。
4. 新 orca node 能用「任意一个已知 orca node 的 host:port + workgroup 密码」加入，并在几个心跳周期内自动补全成 mesh。
5. 任务异步执行：提交后返回 task id，进度和结果通过 task 状态取回。
6. orca node 上下线可被观测；某个 orca node 掉线后，其余 orca node 不再给它派任务。
7. 跨 workgroup 隔离；不同 workgroup 的 orca node 互不可见、互不可调。
8. 本地执行器可替换：Echo / ACP 不改变集群协议。
9. 设计可跨 Windows/Linux 移植；不依赖某台机器的本地路径或 DSH profile。
10. orca node 信息可发现：OS 与版本、CPU、内存、Node 版本、可用模型，以及当前是否忙。
11. 长程协作连贯：同一个 workgroup 里，后续任务能在同一工作区接着上次的上下文继续，而不是每次从零开始。

### 1.3 非目标

1. **不做分布式共享会话/共享上下文**。每个任务在目标 orca node 本地 DSH 里执行；A2A 只传任务和结果。
2. **不做 exactly-once，也不做重发。** 失败就是失败，要不要重来由人或 agent 显式再派一次。
3. **不做跨 workgroup 联邦**。不同 workgroup 默认互不可见。
4. **不做 ring。** 连接拓扑只有 full mesh，不保留“后续可选环”的设计位。
5. **不做全局成员表版本号（epoch）和 orca node 代数（incarnation）。** 见 [§3.1](03-membership.md#31-成员状态的判定)。
6. **不做被调用 orca node 阻塞式人工审批。** 无人值守机器上弹窗等人是设计错误；审批只在发起 orca node 做（[§7](07-security.md#7-安全与权限)）。
7. **不做 target-local-approval。** 目标侧本地弹窗没有意义：人不在那台机器前，弹了也没人点。
8. **不做共享文件系统 / 反向挂载。** 不引入 SMB/NFS/9p/分布式 FS；跨 orca node 只传 blob（[§6.12](06-execution.md#612-明确不做)）。
9. **不做空密码 workgroup。** 没有密码就没有准入控制，不存在“先跑起来再补”的中间态。
10. **不做 session token / 短期令牌。** 每个请求由节点私钥签名，少一层状态和一层失效语义。
11. **不把 ACP 或 MCP 当集群协议。** ACP 只允许本地 stdio；MCP 是 agent→tool，不是对等任务协议。
12. **不把 DSH 内部 Web API（`/api/*`、`/api/remote.mux`）当公开协议。** 它是单 Host 的内部 BFF，没有稳定契约。
13. **不做 orca node 内建 TLS。** 默认明文监听 + 前置代理。
14. **不做公网裸奔。** 公网暴露必须经 TLS 代理或 VPN。

### 1.4 术语与命名约定

| 术语                      | 含义                                                                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **orca node**             | mesh 里的一台机器（一个进程、一个 `orca_node_id`）。本文统一写 orca node，不写裸的“节点”，避免与 Node.js 混淆；代码里对应 `src/node/orca-node.ts` 与 `createOrcaNode()`。 |
| **workgroup_id**          | 集群命名空间 + 凭证作用域，如 `orca-dev`。正则 `[a-z0-9][a-z0-9-]{1,31}`。                                                                                           |
| **orca_node_id**          | Ed25519 公钥（43 字符 base64url）；节点身份即公钥，面板与日志显示缩略形式。                                                                                          |
| **Peer**                  | 同一 workgroup 内、本 orca node 已知的另一个 orca node。                                                                                                             |
| **SelfRecord**            | orca node 对自己的描述（`endpoints`、runtime、忙闲、模型目录），只能由本人写。                                                                                       |
| **members_digest**        | 排序后的成员记录摘要，用于“我落后了没有”的比对，不表达在线状态。                                                                                                     |
| **candidate**（候选端点） | 心跳摘要不一致时对端回传的目录条目，只是可拨号的 `(orca_node_id, endpoints[])`，**不是**在线声明，见 [§3.5](03-membership.md#35-候选端点与墓碑)。                    |
| **tombstone**             | 本地的“别再试它”标记，带过期时间；不传播。                                                                                                                           |
| **workspace**             | orca node 上自动分配的持久目录，跨任务、跨 session 保留上下文；每个 workgroup 一份，也叫 group workspace。                                                           |
| **session**               | ACP 会话状态，绑定 `(origin_orca_node, context_id)`，存在 `<data_root>/state/<workgroup_id>/sessions.json`。                                                         |
| **context_id**            | A2A 的逻辑会话 id，把多个 task 归到同一串工作里。                                                                                                                    |
| **grant**                 | origin 对一次升级请求的签名答复：允许这个任务改用某个权限模式跑到结束；绑定 origin/target/task/tool/request/模式，用掉即作废。                                                             |

**命名注意：** `workgroup_id`、`workspace`、`session` 三者不能混用。DSH GUI 里把项目目录叫“工作区”，本文的 `workspace` 指的是被调用 orca node 上自动分配的那份执行目录；代码与日志里不允许用裸的 `workspace` 表示命名空间。同理，mesh 成员一律写 **orca node**，不写裸的 `node`——那是 Node.js。

### 1.5 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP（Agent Client Protocol）：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- scrypt（RFC 7914）：https://www.rfc-editor.org/rfc/rfc7914
- Ed25519（RFC 8032）：https://www.rfc-editor.org/rfc/rfc8032

---
