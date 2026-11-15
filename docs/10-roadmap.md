# 10 路线图与验收

> 本章给出从两台机器到 10 台机器的分阶段计划与验收标准。

## 10. 路线图与验收

### 10.1 Phase 0：两台机器，静态 peer，EchoExecutor

- 单端口：`/health`、Agent Card、`/a2a`、`/cluster/join|heartbeat|members`。
- Ed25519 身份生成 + `identity.json` 持久化；workgroup_id + 非空密码（首启向导填写；空 = 未配置、节点不启动）；密码派生 join 准入证明 + 请求用节点私钥签名。
- EchoExecutor（[§6.3](06-execution.md#63-echoexecutor用脚本模拟任务)）：按脚本模拟耗时、挂起（`blocked`/`permission`）、最终文本与产物；`ping` 只返回 orca node 信息。
- `message/send` + `tasks/get` + `tasks/cancel`；SQLite task store。
- 验收：`/health` OK；Agent Card 公开可读（当前仅最小字段，签名接口另测）；join 成功；两个 orca node 双向心跳；kill 一方 3 拍内从在线集消失；重启后 task store 仍可查。

**Phase 0 进展**

- core 已跑通：`npm test` 315 个测试通过（39 个文件；workspace、inputs、blobs 流式、origin 派发日志、自动上升、CLI `send --file`、多端点拨号、面板数据面与 `/orca-api` 桥、面板改配置/首启向导/连接与断开 peer/完全重置/会话内审批卡与后台弹窗/任务详情与全部任务模态、忙状态/重启自动 join 记住的 peer/按任务选择模型均已覆盖），`npm run typecheck` 通过；真实进程 smoke `npm run harness` 通过。
- 跨机已实测：Windows 主机 `192.168.86.142:11811` 与 Hyper-V Ubuntu guest `192.168.86.252:11812` 互 join，`members_digest` 一致；跨机 A2A（blocked→续跑→产物）与 `/blobs` 双向上传/下载/直链均通过。
- 已实现：单端口 `/health`、最小 Agent Card、`/a2a`（`message/send`、`tasks/get`、`tasks/cancel`）、`/cluster/join|heartbeat|members|leave`；Ed25519 身份与配置持久化；workgroup + 非空密码（仅入组准入）；请求签名；EchoExecutor；单槽（忙时 429 `orca_node_busy` + `Retry-After` + holder）；`/blobs` 上传/下载/直链；`orca-pod` 单包 DSH host 插件（5 个非阻塞工具 + 后台 tracker/inject/followup）。持久化底座按计划挪到 Phase 2 落地（SQLite task store、fs blob + GC、工作区）。
- 未实现：`/blobs` 的配额与 `Content-Disposition`、`message/stream` / `tasks/resubscribe` / push；权限、工作区与 session 已在 Phase 2/3 落地。Agent Card 的完整字段与 A2A schema 对齐也属于后续里程碑。

### 10.2 Phase 1：三个 orca node full mesh 与惰性收敛

- 新 orca node join 任意 orca node → 按目录对每个 peer 各 join 一次（幂等）→ 自动补全 mesh。
- 双向看门狗（1 拍 suspect、3 拍 offline）、单调时钟、`unreachable` 状态。
- 候选端点与墓碑（[§3.5](03-membership.md#35-候选端点与墓碑)）：验证“死 orca node 不会互相刷活”。
- `runtime` 采集与展示；`members_digest` 比对。
- id 冲突 409；leave；记录修剪。
- 验收：C 加入 A 后一拍内 A/B/C 互相可见；kill B 后 1 拍 suspect、3 拍 offline；拔掉 B 的网线后 A/C 不会把 B 互相刷回在线；B 重启并重新发心跳后 15s 内恢复。

**Phase 1 进展**

- 已实现：自适应心跳（`N` 秒，夹 2–10s，±10% 抖动）、双向看门狗（1 拍 suspect、3 拍 offline）、单调时钟、`suspect(unreachable)`、offline 探测退避（15s→30s）、墓碑与 `record_ttl` 修剪、摘要差异回目录（候选端点）与 404 重 join；只有 `online` 接受新任务（`peer_not_online`）。
- 测试：`membership.test.ts`（注入时钟 5 条）、`watchdog.test.ts`（三个 orca node 收敛、停 orca node→offline→修剪，2 条）、`discovery.test.ts`（心跳 404 重 join、四个 orca node 分半收敛，2 条）、`formation.test.ts`（并发加入、交错 join 幂等、死目录条目仍收敛、重启重认、10 个 orca node、404 重 join 不放大，7 条）、`transport.test.ts`（随机延迟、丢包恢复、单向出站失败、短暂全断，4 条）。
- 已实现：`waitFor` 断言 helper（`src/harness.ts` 导出，超时信息带 label）、真实进程 `npm run harness`（`src/harness_run.ts`：两个 `orca-node serve`、`--peer` 启动即 join、CLI members 收敛、Echo 任务到终态、临时数据根清理）。

### 10.3 Phase 2：接 DSH 执行 + workgroup 工作区

- `AcpExecutor`；专属 profile；cwd = workgroup 根（工作区）。
- context → session 绑定；`session/update` → task 事件；thought 过滤。
- 取消（process tree / `session/cancel`）；`input-required` 透传。
- 工作区持久化（根即 cwd）、`notes/` 与 `inputs/`（已实现）；`notes/STATUS.md` 约定、配额；单槽 busy（`429 orca_node_busy` + `Retry-After`）。
- blob 通道（[§5.6](05-tasks.md#56-文件交换blob-通道)）：上传素材、下载产物、去重、GC；结论文本内联回传。
- 权限模式继承（[§7.10](07-security.md#710-权限模式继承)）：origin 会话模式写进 `pod.permission_mode`，本机 `config.permission_mode` 为上限取较窄（ACP 按模式自动回答）。
- 验收：真实任务完成；跨任务续跑能看到上次的文件与 notes；orca node 失联 → 3 拍内 `failed(node_unreachable)`；取消生效；重启后 `working` 标 `failed(node_restart)`；上传→任务→下载 roundtrip 通过；orca node 忙时第二个任务返回 429 且 UI 显示持有者。

**Phase 2 进展**

- 已实现：`node:sqlite` task store（`<data_root>/tasks.db`、WAL、`synchronous=NORMAL`、payload JSON、`tasks/get` 回落库、启动时非终态标 `failed(node_restart)`）；fs blob store（内容寻址、临时文件 rename、sidecar 元数据、去重、启动时 7 天 TTL GC）；workgroup 工作区（`<data_root>/workgroups/<wg>/` 即 agent cwd，含 `notes/` 与 `inputs/<task_id>/`；网关状态另在 `<data_root>/state/<wg>/`，启动时 `ensure()` + `purgeInputs()`）；orca node/CLI/插件都接持久化存储；`AcpExecutor`（[§6.14](06-execution.md#614-acpexecutorphase-23-长任务执行器)，`dsh --profile acp` stdio、`session/update`→文本、`session/request_permission`→`input-required`、grant 回 allow-once、`session/cancel` 取消、session 复用与重启 `session/resume`）；`orca-node` CLI（`send`/`status`/`wait`/`members`/`escalate`/`publish`，签名打本机或对端 `/a2a`，`--json`、`--text -` 读 stdin、`--file` 上传附件、退出码 0/1/2/3）与 AcpExecutor 的 prompt preamble（把 CLI 绝对路径、task id 与用法注入 ACP 会话，agent 用自带 shell 调用），ACP 会话因此不需要 MCP schema 常驻。
- 测试：`storage-sqlite.test.ts` 3 条、`blobs-fs.test.ts` 5 条、`workspace.test.ts` 5 条、`persistence.test.ts` 2 条（真实 HTTP：重启后 task 仍 completed；hang 中的 working 重启后 `failed/node_restart`）、`acp.test.ts` 12 条（假 ACP server；含一条 ACP 叶子经 relay 链升级的端到端、按任务选模型先于 prompt 且目标拒绝时 `model_unavailable`），`cli.test.ts` 11 条（真实 HTTP + 子进程，含 `escalate` 错误路径、`publish` 本地登记/无 HTTP 路由、`send --file` 上传附件），`escalation.test.ts` 5 条（父任务挂起、批准派生 child grant、拒绝向下传播、CLI `wait --local-task` 自动上升、重复上升静默幂等），`skill.test.ts` 4 条（模板入库且渲染后无占位符/技能内容/幂等安装/DSH_HOME 解析），`permission-mode.test.ts` 7 条（rank/取窄、`pod.permission_mode` 校验、子任务继承、ACP 自动拒绝/允许/无模式挂起、本地上限收窄），`acceptance.test.ts` 4 条（双向断链→offline→恢复、同组成员凭 `task_id` 读结果、并发 10 请求只建 1 个 agent、旧密码被拒），`ssrf.test.ts` 9 条（候选端点私网/回环/元数据/组播/公网/主机名/非法 URL，`allow_public_peers` 与 `allow_loopback_peers` 开关，membership origin 标记，避开 fetch 禁用端口，识别本机 advertised 地址且 IPv4 在前、无 loopback），`limits.test.ts` 6 条（硬 TTL 到点杀任务、`result_max_bytes` 截断与标记、usage 记录、`max_task_ttl_s` 在 Agent Card 与成员记录可见），`inputs.test.ts` 7 条（物化/附录/清理、notes 附录、重名、越界名、文件数上限、字节上限、缺失 blob），`dispatches.test.ts` 4 条（跨实例持久化、重启只标 unknown、删除、node 级派发与 `unknown` 对账），`relay-auto.test.ts` 2 条（child 请求权限→父任务自动挂起→批准后 child 完成、未知父任务拒绝登记），`a2a.test.ts` 8 条（含“只有 origin 能取消，其他成员 403”），`multi-endpoint.test.ts` 2 条（自报完整 `endpoints`、首个地址不可达时按序拨通第二个），`heartbeat-adaptive.test.ts` 5 条（节奏公式与钳位、1 拍 suspect / 3 拍 offline、mesh 变大后节奏自动换算、显式 pin 不漂移），`ui-surface.test.ts` 4 条（任务列表、task/members/dispatch 事件、签名产物直链、admin 工作区与审批），`web.test.ts` 15 条（state/config/task/tasks 快照（含 parked prompts）、回环与转发头闸门、approve/deny/cancel、config 保存（含高级项透传与 null 清除）、connect 与 disconnect、reset、`ctx.inject` 注册与清理），`approval-prompts.test.ts` 5 条（park/resolve/cancel、同任务替换、面板批准唤醒 `orca_pod` 的 `approve` 方法、拒绝则 deny），`panel-config.test.ts` 15 条（override 首启→重配→重启保持节点身份、空 workgroup 空闲→填好后启动、live join 并持久化、失败 peer 不落盘、重启自动 join 记住的 peer、disconnect 清空并落盘、完全重置后回到向导与全新 id、admin 不返回密码、换组沿用原密码、peer 归一化、显示名回退 node id、`detected_endpoints`），`heartbeat-admission.test.ts` 2 条（心跳带密码准入证明、改密码节点在下一拍心跳被双方丢弃），`model-selection.test.ts` 5 条（配置校验边界、join 目录双向可见、非 ACP 执行器 `model_unsupported`、Host 服务目录采集）、`install.test.ts` 23 条（host 安装计划与 systemd unit、`--peer` 注入、`dsh` 检查、配置生成与权限、命令执行与 `--dry-run`、交互式调用判定），全套 315 通过；跨进程 smoke 由 `npm run harness` 覆盖（不进 vitest）。
- 未实现：`notes/` 的清理策略（约定本身已注入 preamble 与任务书附录，不做协议强制）、blob 配额与引用延期。

### 10.4 Phase 3：权限模型 + 审批回路

- grant 签发/校验/吊销（[§7.11](07-security.md#711-grant)）；默认 `delegated`。
- `input-required` 升级回路（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）：**task 置 input-required 并把 `permission_request` 写进 task 记录**（不是 target 拨 origin）→ origin 轮询/SSE 看到 → **用 DSH 审批卡片弹** → 批准生成新 grant 并作为同一 task 的后续 message 补发 / 拒绝置 `failed(permission_denied)`。
- 链式升级（[§7.12](07-security.md#712-升级回路任务状态不是反向调用) 的「链式调用」）：中间节点只能在自己 grant 内放行，越界请求沿 task 状态逐跳上升，grant 逐跳收窄下发；中间节点不自批（除非 A 给了 `danger-full-access` 或本地预授权命中）。Phase 3 只做“逐跳上升 + 逐跳收窄”，不做中间节点自动放行开关。
- 预授权策略（按 target + 工具 + 时长）与本机总开关。
- `credential_readback` 三档。
- 工作区加固：配额、清理、Windows 长路径/保留名测试矩阵（[§6.13](06-execution.md#613-配额清理跨平台)）。
- 验收：越界写被拒；权限模式继承正确（origin 只读 → target 写被拒）；升级请求只在 origin 弹卡片、target 无本地弹窗；无人值守 orca node 不会被阻塞。

**Phase 3 进展**：插件后台 tracker 与 `inject`/`followup` 唤醒已实现（`test/tracker.test.ts` 8 条，[§5.2](05-tasks.md#52-任务回报)）。审批回路第一版已实现：grant 由 origin 节点 Ed25519 私钥签发、公钥校验（§7.11）、`permission_request` 写进 task 状态、只有 origin 能 resume（其他成员 403）、插件 `orca_pod` 的 `approve` 方法 在 open turn 内调 DSH approval 卡片、tracker 对权限请求强制唤醒；`test/approval.test.ts` 12 条覆盖批准/拒绝/篡改/过期/非 origin/无 grant，以及“等人期间 task TTL 暂停”“配置 `approval_timeout_s` 后自动 `permission_timeout`”。链式第一版已实现：`chain.ts` 提供 `childPodMetadata`/`validatePodMetadata`/`deriveChildGrant`，`submit` 校验祖先链（`403 ancestor_call_forbidden`，`hop` 无上限），`approveTask({parentGrant})` 校验父 grant 后派生收窄的 child grant（失败 `escalation_required`/`grant_expired`）；`test/chain.test.ts` 11 条；同文件另有 2 条 Echo relay 原型（父任务以 `relay` 挂起 → origin 批准 → 派生 child grant 下发 → 子任务继续；拒绝向下传播），全套 315 通过。显式 escalate 已实现：中间 orca node 的 task 可在执行中自己挂起（CLI `orca-node escalate --peer <child> --task <child task> --local-task <this task>` → 本机 `tasks/escalate` → runner 置 `input-required` 并带上游请求），origin 批准后派生 child grant 下发、拒绝向下传播，执行器不被打断（`test/escalation.test.ts` 3 条；`test/cli.test.ts` 8 条含 CLI 错误路径）。AcpExecutor 已把权限挂起接进真实执行器（`session/request_permission` → `input-required` → grant 回 allow-once，`test/acp.test.ts` 9 条），并透传 `mcp_servers` 给 ACP 会话；ACP 叶子已能被链式 relay 覆盖（子任务在 C 上由 ACP 挂起 permission → B 以 `relay` 挂起父任务 → A 批准 → B 派生 child grant 下发 → C 的 ACP 会话回 allow-once 并完成）。ACP 会话的工具入口改走 CLI（preamble 注入 `orca-node` 路径与用法，agent 用自带 shell 调用），MCP bridge 降级为可选；技能改为标准 Agent Skill bundle `skills/orca-node/`（随包发布，SKILL.md + references/add-machine.md）；本地 `.agents/skills`/`.dsh/skills`/`$DSH_HOME/skills` 都是安装目标而非仓库内容；ACP/CLI 子会话由 executor 注入 `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT`，`skill_injection`（默认关）可选把同一 bundle 复制到 user 根；审批卡片与 tracker 通知显示来源链（`permissionOriginNote`/`approvalReason`，形如 ` via A → B`）。父任务侧的“自动感知”落到了 origin：`orca-node send --local-task` 建成子任务后向本机 `POST /cluster/child-link` 登记（子进程通过 `ORCA_POD_PARENT_TASK` 自动带），节点每 1s 轮询子任务，看到 `permission_request` 就对本机父任务 `tasks/escalate`，父任务自动挂起、origin 批准后 child grant 逐跳下发（`test/relay-auto.test.ts` 用 ACP 父任务 + Echo 子任务覆盖整条链路）；CLI `wait --local-task` 仍保留手动上升路径，同一 `request_id` 只上升一次；`/cluster/child-link` 只登记不执行，按回环 + 无转发头做传输层限制（403 `local_only`）。审批默认无限等待：`permission_request.expires_at` 是可选字段（未配置 `approval_timeout_s` 时不写），`input-required` 期间 task TTL 暂停、`resume` 后重新计时，CLI `wait`/`escalate` 的 `--timeout` 也可省略；配置 `approval_timeout_s` 后到点自动 `failed(permission_timeout)` 并向下游（`pending_escalation`/`relay`）下发 denial。权限模式继承已实现：`pod.permission_mode` 校验与子任务继承、本机 `config.permission_mode` 上限取窄、`ACP` 传 `--permission-mode`、`AcpExecutor` 按模式自动回答 `session/request_permission`（`test/permission-mode.test.ts` 7 条）。按任务选模型已实现：节点自述 `models`/`default_model`/`default_reasoning_effort`（含本地 effort 默认与任务覆盖）、任务 `pod.model`、CLI `--model`/`--reasoning-effort`、ACP `session/set_config_option` 落地（[§6.15](06-execution.md#615-按任务选择模型)，`test/model-selection.test.ts` 4 条）。`limits` 收窄、预授权策略、`credential_readback`、配额与 Windows 路径矩阵仍未开始。

### 10.5 Phase 4：规模化与部署

- `orca-pod install`：检查 `dsh --version`、生成/复用节点配置、渲染 systemd unit 并 `daemon-reload` + `enable --now`；固定常驻 `orca-node serve`（不提供 web 模式）。裸 `install` 或只带 `--dry-run` 是交互式向导；带任何其他参数即进入参数分支、完全不提问（agent 通过 SSH 安装时用 `--workgroup` + `-p/--password`，程序不读 stdin，避免调用被挂住）；`--dry-run`、`--system`、`--skip-dsh-check` 适合无 sudo/CI 场景。

- 部署（不做进插件）：TLS 由前置代理（Caddy/nginx）终结，节点自身只监听明文 HTTP；代理健康检查打 `/health`，不代理 `/cluster/child-link`（该接口故意只认传输层回环）。跨机验证前用 `scripts/sync-guest.ps1` 把当前提交同步到 guest 并重装依赖，避免两端代码漂移。
- 10 个 orca node full mesh 压测：45 链路、45 心跳/s、任务延迟、内存/CPU。
- 可选：SSE、`tasks/resubscribe`、push notification。
- 可选：独立前端——当前面板已实现设置页 + 侧栏按钮 + 停靠式浮层，并支持首启向导、第一屏集群状态、UI 改配置与直连 peer（`client.js` 注册 `settings.section` / `sidebar.footer.action` / `shell.overlay`，经同源 `/orca-api` 轮询与提交；配置写入 `<data_root>/ui-config.json` 并重启节点；Host 数据面见 [§9.2](09-implementation.md#92-面板数据面--同源桥--设置页)）；若要做独立窗口/路由，再补 client 入口与布局容器。
- 可选：orca node 内建 mTLS（传输层双向证书；应用层身份已由 Ed25519 解决，见 [§2.4](02-model.md#24-orca-node-身份ed25519-公钥)）。
- 验收：10 个 orca node 24h 稳定；单 orca node 故障不影响其他 orca node 任务。

### 10.6 验收标准

> 只勾已经由当前代码与测试或跨机实测覆盖的项；未勾表示尚未验收，不代表设计被删除。

#### 两台 orca node

- [x] `/health` 无鉴权可达；Agent Card 公开可读且不含 runtime/路径/拓扑；`/cluster/members` 无签名被 401
- [ ] 错误 workgroup / 错误密码被 401（同一文案，不区分）
- [x] 正确密码 + 签名可 join、心跳、拉目录
- [x] 两个 orca node 双向心跳；kill 一方 3 拍内从在线集消失（测试用缩短间隔的等价看门狗）
- [x] orca node 重启后 task store 与工作区仍在（SQLite 保留 task 记录，重启后 `tasks/get` 可查；非终态标 `failed(node_restart)`；`workgroups/` 目录不删）

#### Echo 脚本（Phase 0/1）

- [x] `echo.final.text` 原样出现在 `tasks/get` 的 `status.message.text`，逐字节相等
- [x] 到 `at_ms` 时任务变 `input-required`，`blocked`/`permission_request` 可读，槽位释放
- [x] 恢复后从上次位置继续，不重放已过去的 step；总时长约等于各 step 间隔之和（不含挂起时间）
- [x] rtifacts[].blob_id == sha256(content)，artifact 元数据与字节数正确
- [x] 产物 blob 可被另一 orca node GET（artifact id = sha256，与跨 orca node blob GET 同通道）
- [x] `hang` 脚本被 `tasks/cancel` 后 2s 内变 `canceled` 且槽位释放；不取消则 `task_ttl_s` 到期进 `failed(timeout)`
- [x] 非法脚本（`at_ms` 递减、未知字段、`state` 非法）在建 task 前 `400 bad_echo_script`

#### AcpExecutor（Phase 2/3）

- [x] 假 ACP server：`session/update` 文本累积 → `completed`；`session/new` 的 cwd = workgroup 根
- [x] `session/request_permission` → `input-required`，`approveTask` 后回 `allow-once` 并继续
- [x] 取消任务发 `session/cancel`，任务进 `canceled`
- [x] 同一 `(origin, context)` 复用 session（`session/new` 只一次）；orca node 重启后走 `session/resume`
- [x] 命令不存在时首个事件是 `failed`，不悬挂
- [x] 真实 `dsh --profile acp` + 模型凭据的端到端（Windows 本机 `scripts/e2e-acp.mjs`：`completed`、文本 `pong`、约 2.6s、sessions.json 绑定正确）

#### 三台 orca node

- [x] C join A 后一拍内三向可见（C 按目录自行补全到 B 的边）
- [x] 拔掉 B 的网线：A 与 C 都判 offline，且不会把 B 刷回 online（`test/acceptance.test.ts` 用可注入 fetch 模拟双向断链并恢复）
- [ ] B 恢复后仅凭自己的心跳回到 online（无人手动清缓存）
- [x] B 离线 7 天后记录被修剪（测试用缩短 `record_ttl` 的等价修剪）
- [x] 目标非 online 时拒绝派发（`peer_not_online`）
- [x] 不出现任何 epoch/incarnation 字段

#### 权限与工作区

- [x] origin 只读会话 → target 写文件被拒（ACP 按继承模式自动拒绝）
- [ ] origin workspace-write → target 只能在 group workspace 内写
- [x] 升级请求只在 origin 由人决定，target 无本地弹窗（`orca_pod` 的 `approve` 方法 park 在插件 `prompts` 注册表，由会话聊天卡/后台弹窗/面板作答；target 侧无审批 UI）
- [x] 审批卡片 reason 与 tracker 通知显示来源链（`permissionOriginNote`/`approvalReason`，形如 `wants to run "write_file" via A → B`）
- [ ] 同一 context 的第二个任务能读到第一个任务的 `notes/STATUS.md`
- [ ] `credential_readback=ask` 时私钥内容回传需 origin 批准
- [ ] 绝对路径与 `..` 被拒（协议层根本不接受路径）
- [x] orca node 忙时第二个任务返回 429 `orca_node_busy` + `Retry-After`，调用方模型能从错误体拿到 `retry_after_s` 与持有者，自行选择重试、换 orca node 或向用户回报（UI 显示持有者尚未实现）
- [x] C 用 A 给的 `task_id` 能读到 A 在 B 上的结果；没有 `task_id` 时无法枚举（`tasks/get` 只认 id，无列表接口）
- [x] C 凭 `blob_id` 直接 `GET` B 上的产物，不需要额外授权（Windows↔Linux 双向实测）
- [x] 交接不走协议层：同一 workgroup 的任务共享 workgroup 根（agent cwd）与 `notes/`，后到的 agent 自己读现场决定接着干什么；协议没有 `continuation_of`，旧 task 天然不可变（`test/workspace.test.ts`、`test/persistence.test.ts`）
- [x] 链式升级：A→B→C 时 C 的越界请求经 B 上升为 A 的 `input-required`（`via` 带来源、`expires_in_s` 逐跳递减、等待期间 B/C 槽位都释放），A 批准后 grant 逐跳收窄下发、C 继续；任一跳超时则整链失败且不挂住节点（`chain.ts` 校验与 child grant 派生 + `tasks.escalate` + origin 侧 child-link 轮询自动上升，`test/chain.test.ts`、`test/escalation.test.ts`、`test/relay-auto.test.ts`）

#### 文件交换

- [x] 上传 1 MiB 文件返回 201，`blob_id == sha256(bytes)`
- [x] 重复上传同内容返回 200，不占新空间
- [x] `X-Pod-Body-SHA256` 与实际字节不符 → 400 且不落盘
- [x] 素材上传 → 任务引用 → 产物下载 roundtrip 通过
- [x] 短期直链过期后不可用；篡改 blob_id/exp 或换 blob 被拒（直链用 `exp+sig`，节点私钥无状态签名）
- [x] 未被任务引用的 blob 在 TTL 后被 GC（orca node 启动时跑 `blobStore.gc()`，默认 7 天；测试用注入 `now` 覆盖）；GC 后下载返回 `404 blob_not_found`。引用延期（被任务引用的 blob 延长到终态后）尚未实现。

#### agent 侧（插件接线）

- [x] `orca_pod` 的 `send` 立即返回 `task_id`，工具调用不挂到任务结束（插件 smoke 验证）
- [x] 插件后台 tracker 定时拉 `tasks/get`（当前固定 1s；`message/stream` 的 SSE 模式未接，两种模式一致性待两项都有时再验）
- [x] agent 工具列表里没有任何阻塞等待工具（没有 `pod_wait`），`send`/`status` 方法都在毫秒级返回
- [ ] target 忙时 `orca_pod` 的 `send` 方法 拿到 `429 orca_node_busy` + 持有者，agent 把“B 忙、约 N 秒”回报用户并结束本轮（或先做别的），不自动重试
- [x] 普通完成由 tracker 投递：running → `agent.inject()`（不打断），idle → `agent.followup()`（开新一轮）
- [x] `permission_request` 走 `agent.followup()`：tracker 强制唤醒（不受预算限制），模型调用 `orca_pod` 的 `approve` 方法 后 park 到 Orca Pod UI 决定，无超时
- [x] 标准 skill bundle：`skills/orca-node/`（SKILL.md + references）随包发布；可选 `skill_injection` 复制到 user 根（默认关），ACP/CLI 子会话另有 `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT` 环境变量
- [ ] 全程没有 `sleep`/长轮询的 bash 命令；agent 工具列表里没有 `orca-node wait`
- [x] 派发后本轮结束、任务才完成 → `followup()` 只唤醒一次，新一轮读到结果并继续
- [x] 同一轮内完成的任务不触发唤醒（agent 仍在 running，只 `inject`）
- [ ] 派发后用户发了新消息 → 完成时只 inject，不打断当前轮
- [x] 2s 内三个任务完成只产生一次 `followup()`；连续第 4 次后台唤醒被拦下并留 inbox（连续唤醒预算 3）

#### 安全

- [x] 无密码不能创建 workgroup
- [ ] 密码不出现在配置、日志、错误信息中
- [x] 改密码后旧节点在下一拍心跳被双方丢弃（心跳准入证明 `401 bad_proof`，`test/heartbeat-admission.test.ts` 2 条）
- [x] 重放请求（同 nonce）被拒
- [x] 候选端点指向 `169.254.169.254` 被拒；私网候选正常拨号，回环默认允许、可用 `allow_loopback_peers: false` 收紧（`test/ssrf.test.ts`）

#### 10 orca node

- [ ] 45 条心跳链路稳定 24h，CPU/内存无泄漏
- [ ] 单 orca node 故障不影响其余 orca node 任务
- [ ] 任务延迟与 2 个 orca node 相比无数量级退化
- [x] 多跳无深度上限：`pod.hop=2` 的任务照常执行（`hop` 只记账）；目标 orca node 已在 `chain` 中被 `403 ancestor_call_forbidden`（`test/chain.test.ts`）
- [x] 子任务目标集合排除 `chain` 中 orca node 与自身：B 尝试调 A → `403 ancestor_call_forbidden`，不建 task（`test/chain.test.ts`）
- [ ] B 卡住 → task 变 `input-required` 且 `blocked` 可读；B 的槽已释放（其他 origin 能立刻建 task）；A 回复后任务继续
- [ ] B、C 互调：后到的一方拿到 `429 orca_node_busy` 并能把它写进 `blocked` 回报 A；不出现两边都卡到 TTL
- [x] origin 对同一 target 并发 10 个请求：target 只创建 1 个 agent 进程，其余 429（`test/acceptance.test.ts`）
- [ ] 一个 origin 连续快速失败后进入退避，不出现“越失败越发”的请求上升

### 10.7 构建顺序

> 上面的阶段回答“做到什么程度”，这一节回答“先写哪一块”。原则：每一层都能脱离下一层单独验证，不通过就不往上堆。

1. **仓库骨架**：单包（根 src/ + 	est/）、tsconfig/vitest、CI（只跑进程内测试）。
2. **node core（无 UI）**：protocol/crypto/storage/gateway/node + EchoExecutor；`/health`、join、heartbeat、members、`/a2a`、task store；harness 能起单 orca node。
3. **本地集群测试**：先进程内 `createMesh`（可注入时钟、端口 0），再 `npm run harness` 起两个真实进程和 socket（`src/harness_run.ts`）；覆盖 10.1–10.2 验收。这一层完全不碰 DSH。
4. **Echo 行为与回调**：按 10.6 的“Echo 脚本”“三台 orca node”逐条跑；挂起/恢复/取消/TTL/blob 在这一层定死，后面的执行器只换实现、不换协议。
5. **真实执行器**：ACP（ACP stdio）→ AcpExecutor；cwd 是工作区、context→session 绑定、取消、`input-required` 映射。放在插件之前，是为了让“协议正确”和“DSH 集成正确”分两次验证，不同时调两个未知量。
6. **DSH 插件**：`apply` 启动 orca node、注册工具、后台 tracker、inject/followup、审批卡片与状态卡片。先在单机两个 DSH 实例之间跑通（不同端口、不同 profile）。
7. **跨机器**：Windows 主机 + Hyper-V Linux guest。分两次做：core 完成后先跑 2 个 orca node smoke（join/心跳/echo），尽早暴露路径、时钟、编码问题；全部组件完成后再做完整 E2E（真实任务、权限、blob、可选 TLS）。
8. **加固**：10 个 orca node 压测、安全验收、Phase 4。

进程内测试不依赖网络和真实时钟；每个模块都有自己的夹具测试；任何一层验收没过，不进入下一层。

---
