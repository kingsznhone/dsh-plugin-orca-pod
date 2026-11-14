# Orca Pod 设计文档

> Status: Draft / handoff baseline
> Revision: 2026-11-14
> Scope: 2–10 台安装了 DSH 的机器，跨 Windows/Linux，对等任务调用与结果回报
> Audience: 接手实现的新工作区 agent / 工程师

**术语警告（先读这条）：** 这里的 `workgroup_id` 是**集群命名空间 + 凭证作用域**（例如 `whale-pod`），不是 DSH 的 GUI 工作区，也不是文件系统路径。节点上真正干活的目录统一叫 `workspace`。协议里禁止传输绝对路径。

## 文档地图

| 文档 | 关注方向 | 覆盖章节 |
|---|---|---|
| [01-vision.md](01-vision.md) | 目标与非目标 | 1 |
| [02-architecture.md](02-architecture.md) | 架构、节点身份、成员与收敛 | 4、6、10 |
| [03-protocol.md](03-protocol.md) | 监听、端口、单入口路由、A2A 面 | 5、7.1–7.4 |
| [04-tasks.md](04-tasks.md) | 任务元数据、回报与唤醒、取消、存储、文件交换、接续 | 7.5–7.11 |
| [05-executor.md](05-executor.md) | LocalExecutor、ACP 的位置、Echo 脚本 | 8 |
| [06-workspace.md](06-workspace.md) | 工作区目录、单槽执行、结果与产物 | 11 |
| [07-permissions.md](07-permissions.md) | 权限模式、grant、审批回路、硬拒绝清单 | 9 |
| [08-security.md](08-security.md) | workgroup、签名、TLS、授权矩阵、审计 | 12 |
| [09-reliability.md](09-reliability.md) | 失联/重启/幂等/背压/放大，以及指标 | 13、14 |
| [10-roadmap.md](10-roadmap.md) | Phase 0–4 与验收清单 | 15、17 |
| [11-implementation.md](11-implementation.md) | 包结构、模块夹具、DSH 组合入口、依赖选型 | 16 |
| [12-open-questions.md](12-open-questions.md) | 未决问题 | 18 |
| [13-handoff.md](13-handoff.md) | 交接与第一条 prompt | 19 |
| [DECISIONS.md](DECISIONS.md) | 关键决策日志（D1–D36） | 2 |
| [GLOSSARY.md](GLOSSARY.md) | 术语与命名约定 | 3 |

## 阅读顺序

- 第一次读：01 → 02 → 03 → 04，先建立“节点怎么找到彼此、任务怎么流动”的骨架。
- 要动手实现：05 → 06 → 11（执行器、工作区、代码结构）。
- 关心安全与权限：07 → 08。
- 接手维护：DECISIONS（决策为什么是现在这样）→ 12 → 13（未决与交接）。

## 维护规则

- **章节编号只增不改。** 文档按主题拆开了，但编号仍是全局坐标：7.5 这类编号在任何文档里都指同一个地方。
- **引用写成链接。** 正文里的 `§x.y` 已指向对应文档；新增引用照此格式：`[§7.5](04-tasks.md)`。
- **改协议或语义时同时改三处：** 对应文档、DECISIONS（新决策追加编号，不删旧的）、10-roadmap 的验收清单。
- **这个目录是唯一事实源。** 根目录不再维护大文件，也不要复制正文到别处。

## 一页摘要

Orca Pod 是一个小规模、对等的 DSH 集群：

- 每台机器上跑一个 **DSH 插件**（Pod 网关）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 本地执行由 **LocalExecutor** 驱动，ACP 只走本地 stdio，绝不跨网络。
- 节点之间是 **full mesh**，10 台以内不做 ring、不做 gossip、不做中心调度器。
- **默认单跳**：origin → target，不转发、不回调、不广播；多跳与扇出是可选能力，默认关闭（[§13.6](09-reliability.md#136-放大与唤醒为什么不会风暴)）。节点只被任务请求唤醒，忙时 429 而不是排队。
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

## 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP（Agent Client Protocol）：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- HKDF（RFC 5869）：https://www.rfc-editor.org/rfc/rfc5869
- Crockford Base32：https://www.crockford.com/base32.html

---

## 一句话总结

> 一个 workgroup、一把密码、一张 full mesh；每个节点只相信自己的眼睛，只在自己的屏幕上点头；工作区是办公室，不是酒店房间；节点没了，任务就诚实地说没了。
