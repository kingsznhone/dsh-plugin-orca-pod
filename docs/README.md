# Orca Pod 设计文档

> Status: 当前设计（与代码一致）
> Updated: 2026-11-16
> Scope: 2–10 台安装了 DSH 的机器，跨 Windows/Linux，对等任务调用与结果回报
> Audience: 实现者 / 接手的新工作区 agent

**编号约定（先读这条）：文档号 = 章号。** 第 N 篇文档的章节号是 `N.x`，所以 `§6.9` 永远指 [06-execution.md](06-execution.md) 的第 9 节，跨文档引用不需要额外坐标。

**术语：** `workgroup_id` 是**集群命名空间 + 凭证作用域**（例如 `orca-dev`），不是 DSH 的 GUI 工作区，也不是文件系统路径。orca node 上真正干活的目录统一叫 `workspace`。协议里禁止传输绝对路径。

## 文档地图

| 文档                                         | 章  | 内容                                                              |
| -------------------------------------------- | --- | ----------------------------------------------------------------- |
| [01-overview.md](01-overview.md)             | 1   | 概览、目标与非目标、术语、参考                                    |
| [02-model.md](02-model.md)                   | 2   | 两个平面、orca node 职责与部署、Ed25519 身份、SelfRecord、runtime |
| [03-membership.md](03-membership.md)         | 3   | 成员状态判定、加入、心跳与看门狗、收敛、候选端点与墓碑            |
| [04-transport.md](04-transport.md)           | 4   | 监听与路由、反向代理、A2A 面、任务状态机                          |
| [05-tasks.md](05-tasks.md)                   | 5   | 任务元数据、回报与唤醒、取消、存储、blob 通道、交接               |
| [06-execution.md](06-execution.md)           | 6   | LocalExecutor、EchoExecutor、ACP、工作区、单槽、结果与产物        |
| [07-security.md](07-security.md)             | 7   | workgroup 与签名、TLS、不可信输入、授权、grant、审批回路          |
| [08-reliability.md](08-reliability.md)       | 8   | 失联与重启、背压、放大与唤醒、可观测性                            |
| [09-implementation.md](09-implementation.md) | 9   | 模块划分、面板、进程内多 orca node、DSH 组合入口、依赖            |
| [10-roadmap.md](10-roadmap.md)               | 10  | Phase 0–4 与验收清单                                              |
| [11-open-questions.md](11-open-questions.md) | 11  | 未决问题、待讨论与暂缓项（每项写明当前行为）                      |
| [12-handoff.md](12-handoff.md)               | 12  | 阅读顺序、第一条 prompt、交接规则、后续专题                       |
| [DECISIONS.md](DECISIONS.md)                 | —   | 顶层/跨模块决策（章节内取舍已并入各章正文）                       |

## 阅读顺序

- **建立骨架**：01 → 02 → 03 → 04，先弄清“orca node 怎么找到彼此、任务怎么流动”。
- **任务与执行**：05 → 06，元数据、回报、工作区、执行器。
- **安全与运维**：07 → 08。
- **落地**：09 → 10，模块结构、组合入口、路线图与验收。
- **接手维护**：11 → 12 → DECISIONS，先看未决项和决策理由。

## 维护规则

- **编号只增不改。** 文档号 = 章号；新增内容用 `N.现有最大编号+1`，不重排、不挪用已有编号。
- **引用写成链接。** 形如 `[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)`；锚点是 GitHub slug。
- **改协议或语义时三处同步**：对应文档、[10.6 验收标准](10-roadmap.md#106-验收标准)；只有顶层/跨模块决策才写进 DECISIONS。
- **未决问题只放在 11。** 正文只陈述当前设计，不写“待定 / 也许 / 可选（未定）”这类悬空状态；确实没定的，去 11 登记并写明当前行为。
- **不写版本与兼容。** 插件未发布：协议、配置、密钥派生都没有版本号，也没有迁移或兼容分支；格式变了就是变了。
- **这个目录是唯一事实源。** 根目录不再维护大文件，也不要复制正文到别处。

## 一页摘要

Orca Pod 是一个小规模、对等的 DSH 集群：

- 每台机器上跑一个 **DSH 插件**（Pod 网关）：对外是 A2A server + 控制面，对内驱动本地 DSH。
- 本地执行由 **LocalExecutor** 驱动，ACP 只走本地 stdio，绝不跨网络。
- orca node 之间是 **full mesh**，10 台以内不做 ring、不做 gossip、不做中心调度器。
- **没有隐式转发**：origin → target 是一次请求；target 上的 agent 想再派活，必须显式新建子任务（CLI），没有回调、没有广播。orca node 只被任务请求唤醒，忙时 429 而不是排队。
- **没有全局成员表，也没有成员版本号。** 每个 orca node 的表里只放“我直接收到过它心跳”的 orca node；别人的表只能提供**候选端点**，不能替谁声明在线。
- orca node 身份 = 首次启动生成的 **Ed25519 公钥**（`<data_root>/identity.json`，43 字符 base64url；面板显示缩略，如 `psB9aQ…3Zlw`）。节点用自己的私钥签每个请求，别人用公钥验签——id 就是公钥，可验证、不可伪造。
- 入组 = `workgroup_id` + **非空密码**：密码只派生 `/cluster/join` 与每拍心跳的准入证明（HMAC）；**请求认证靠节点 Ed25519 签名，没有 session token、没有 TTL**。换密码 = 重建组。
- 监听是**明文 HTTP/1.1 + keep-alive**；TLS 由 Caddy / nginx 终止，orca node 本身不必管证书。
- 任务面用 **A2A**：`message/send` 异步建 task，`tasks/get` 轮询；没有 SSE、没有 push。
- 文件交换按**名字**：节点只发布自己机器上的文件，名字是 `<节点 id>/<sha256>`，不含地址；谁需要谁让自己的节点去拉（`orca-node fetch`）——产物的名字写在结论文本里由 origin 取，交给任务的文件写在任务书里由 target 上的 agent 取；结论文本内联返回，`notes/` 不出本机。
- **任务与产物凭 id 交接**：同 workgroup 任意 orca node 知道 `task_id` / `blob_id` 就能读；没有列表接口，也没有 per-task ACL——id 就是句柄。
- **交接靠工作区**：同一 workgroup 的任务共享一份持久工作区（agent 的 cwd 就是 workgroup 根）与 `notes/`；后到的 agent 读现场决定接着干什么，协议不定义“续跑”。
- **权限跟着发起会话走**：任务继承发起会话的权限模式（没继承到就按只读）；target 按这个模式自动应答 ACP 的权限请求，模式之外的请求挂起为 `input-required`，由 origin 的人在 UI 上决定；target 永不本地弹窗。
- 目标侧执行目录 = **workgroup 工作区**：加入 workgroup 时自动分配、跨任务持久。**orca node 是单槽的**：同一时间只跑一个任务，忙时 `429 orca_node_busy`（不排队），忙闲状态对其他 orca node 可见；**遇到忙时由调用方模型决定**重试、换 orca node 还是回报用户。
- 任务状态落**单机 SQLite**；target 重启则所有非终态任务 `failed(node_restart)`，origin 的追踪连续失败则放弃并告知 agent，不重发、不猜、不复活。

---

## 参考

- A2A Protocol：https://a2a-protocol.org/
- ACP（Agent Client Protocol）：https://agentclientprotocol.com/
- DSH 文档：本地 `resources/app.asar` 内的 dsh 包与官方文档
- Caddy reverse_proxy：https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- nginx proxy 模块：https://nginx.org/en/docs/http/ngx_http_proxy_module.html
- SQLite WAL：https://sqlite.org/wal.html
- scrypt（RFC 7914）：https://www.rfc-editor.org/rfc/rfc7914
- Ed25519（RFC 8032）：https://www.rfc-editor.org/rfc/rfc8032

---

## 一句话总结

> 一个 workgroup、一把密码、一张 full mesh；每个 orca node 只相信自己的眼睛，只在自己的屏幕上点头；工作区是办公室，不是酒店房间；orca node 没了，任务就诚实地说没了。
