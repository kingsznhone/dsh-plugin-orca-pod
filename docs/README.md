# Orca Pod 设计文档

> Status: 当前设计（可直接交给实现）
> Updated: 2026-11-14
> Scope: 2–10 台安装了 DSH 的机器，跨 Windows/Linux，对等任务调用与结果回报
> Audience: 实现者 / 接手的新工作区 agent

**编号约定（先读这条）：文档号 = 章号。** 第 N 篇文档的章节号是 `N.x`，所以 `§6.9` 永远指 [06-execution.md](06-execution.md) 的第 9 节，跨文档引用不需要额外坐标。

**术语：** `workgroup_id` 是**集群命名空间 + 凭证作用域**（例如 `orca-dev`），不是 DSH 的 GUI 工作区，也不是文件系统路径。orca node 上真正干活的目录统一叫 `workspace`。协议里禁止传输绝对路径。

## 文档地图

| 文档 | 章 | 内容 |
|---|---|---|
| [01-overview.md](01-overview.md) | 1 | 概览、目标与非目标、术语、参考 |
| [02-model.md](02-model.md) | 2 | 两个平面、orca node 职责与部署、短 id、SelfRecord、runtime |
| [03-membership.md](03-membership.md) | 3 | 成员状态判定、加入、心跳与看门狗、收敛、候选端点与墓碑 |
| [04-transport.md](04-transport.md) | 4 | 监听与路由、反向代理、A2A 面、任务状态机 |
| [05-tasks.md](05-tasks.md) | 5 | 任务元数据、回报与唤醒、取消、存储、blob 通道、交接 |
| [06-execution.md](06-execution.md) | 6 | LocalExecutor、EchoExecutor、ACP、工作区、单槽、结果与产物 |
| [07-security.md](07-security.md) | 7 | workgroup 与签名、TLS、不可信输入、授权矩阵、grant、审批回路 |
| [08-reliability.md](08-reliability.md) | 8 | 失联与重启、幂等、背压、放大与唤醒、可观测性 |
| [09-implementation.md](09-implementation.md) | 9 | 包划分与夹具、进程内多 orca node、DSH 组合入口、依赖选型 |
| [10-roadmap.md](10-roadmap.md) | 10 | Phase 0–4 与验收清单 |
| [11-open-questions.md](11-open-questions.md) | 11 | 仍未定的问题（数量很少，且都附了默认处理方式） |
| [12-handoff.md](12-handoff.md) | 12 | 阅读顺序、第一条 prompt、交接规则、后续专题 |
| [DECISIONS.md](DECISIONS.md) | — | 顶层/跨模块决策（章节内取舍已并入各章正文） |

## 阅读顺序

- **建立骨架**：01 → 02 → 03 → 04，先弄清“orca node 怎么找到彼此、任务怎么流动”。
- **任务与执行**：05 → 06，元数据、回报、工作区、执行器。
- **安全与运维**：07 → 08。
- **落地**：09 → 10，包结构、组合入口、路线图与验收。
- **接手维护**：11 → 12 → DECISIONS，先看未决项和决策理由。

## 维护规则

- **编号只增不改。** 文档号 = 章号；新增内容用 `N.现有最大编号+1`，不重排、不挪用已有编号。
- **引用写成链接。** 形如 `[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)`；锚点是 GitHub slug。
- **改协议或语义时三处同步**：对应文档、[10.6 验收标准](10-roadmap.md#106-验收标准)；只有顶层/跨模块决策才写进 DECISIONS。
- **未决问题只放在 11。** 正文只陈述当前设计，不写“待定 / 也许 / 可选（未定）”这类悬空状态；确实没定的，去 11 登记并写默认处理方式。
- **这个目录是唯一事实源。** 根目录不再维护大文件，也不要复制正文到别处。

## 一页摘要

Orca Pod 是一个小规模、对等的 DSH 集群：

- 每台机器上跑一个 **DSH 插件**（Pod 网关）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 本地执行由 **LocalExecutor** 驱动，ACP 只走本地 stdio，绝不跨网络。
- orca node 之间是 **full mesh**，10 台以内不做 ring、不做 gossip、不做中心调度器。
- **默认单跳**：origin → target，不转发、不回调、不广播；多跳与扇出是可选能力，默认关闭（[§8.6](08-reliability.md#86-放大扇出与唤醒)）。orca node 只被任务请求唤醒，忙时 429 而不是排队。
- **没有全局成员表，也没有成员版本号。** 每个 orca node 的表里只放“我直接收到过它心跳”的 orca node；别人的表只能提供**候选端点**，不能替谁声明在线。
- orca node 身份 = 安装时自动生成的 **6 字符短 id**（`N7K3QM`），可手改、持久化；它只是标签，不是安全主体。
- 认证 = `workgroup_id` + **非空密码**；密钥由密码直接派生，**每个请求现签现验，没有 session token、没有 TTL**。密码一致就能调，密码一改所有旧凭证立刻作废。
- 监听是**明文 HTTP/1.1 + keep-alive**；TLS 由 Caddy / nginx 终止，orca node 本身不必管证书。
- 任务面用 **A2A**：`message/send` 异步建 task，`tasks/get` 轮询，SSE 可选。
- 文件交换走**内容寻址 blob 通道**：素材先传后引用，产物按需拉取；结论文本内联返回，`notes/` 不出本机。
- **任务与产物凭 id 交接**：同 workgroup 任意 orca node 知道 `task_id` / `blob_id` 就能读；没有列表接口，也没有 per-task ACL——id 就是句柄。
- **交接靠工作区**：同一 workgroup 的任务共享一份持久工作区（agent 的 cwd 就是 workgroup 根）与 `notes/`；后到的 agent 读现场决定接着干什么，协议不定义“续跑”。
- **权限跟着发起 orca node 的会话走**：origin 的会话是只读，target 就只能读；是 workspace-write，target 就只能写工作区；超出的操作回到 origin 弹审批卡片，target 永不本地弹窗。
- 目标侧执行目录 = **workgroup 工作区**：加入 workgroup 时自动分配、跨任务持久、跨 session 保留上下文。**orca node 是单槽的**：同一时间只跑一个任务，忙时明确拒绝（不排队），忙闲状态对其他 orca node 可见；**遇到忙时由调用方模型决定**重试、换 orca node 还是回报用户。
- 任务状态落**单机 SQLite**；orca node 失联即任务失败，不重发、不猜、不复活。
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

> 一个 workgroup、一把密码、一张 full mesh；每个 orca node 只相信自己的眼睛，只在自己的屏幕上点头；工作区是办公室，不是酒店房间；orca node 没了，任务就诚实地说没了。
