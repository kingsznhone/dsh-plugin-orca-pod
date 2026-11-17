# 10 路线图与验收

> 本章给出从两台机器到 10 台机器的分阶段计划与验收标准。各阶段的当前状态以 [§10.6](10-roadmap.md#106-验收标准) 的勾选为准；本章不再记录“进展”流水账。

## 10. 路线图与验收

### 10.1 Phase 0：两台机器，静态 peer，EchoExecutor

- 单端口：`/health`、Agent Card、`/a2a`、`/cluster/join|heartbeat|members`。
- Ed25519 身份生成 + `identity.json` 持久化；workgroup_id + 非空密码（空 = 未配置、节点不启动）；密码派生 join/心跳准入证明 + 请求用节点私钥签名。
- EchoExecutor（[§6.3](06-execution.md#63-echoexecutor用脚本模拟任务)）：按脚本模拟耗时、权限挂起（`permission`）、最终文本与产物。
- `message/send` + `tasks/get` + `tasks/cancel`；SQLite task store。
- 验收：`/health` OK；Agent Card 公开可读；join 成功；两个 orca node 双向心跳；kill 一方 3 拍内从在线集消失；重启后 task store 仍可查。

### 10.2 Phase 1：三个 orca node full mesh 与惰性收敛

- 新 orca node join 任意 orca node → 按目录补全 mesh（被拒就 join，幂等）。
- 双向看门狗（1 拍 suspect、3 拍 offline）、单调时钟、`unreachable` 状态、自适应心跳节奏。
- 候选端点与墓碑（[§3.5](03-membership.md#35-候选端点与墓碑)）：验证“死 orca node 不会互相刷活”。
- `runtime` 采集与展示；`members_digest` 比对；leave；记录修剪。
- 验收：C 加入 A 后一拍内 A/B/C 互相可见；kill B 后 1 拍 suspect、3 拍 offline；拔掉 B 的网线后 A/C 不会把 B 互相刷回在线；B 重启并重新发心跳后 15s 内恢复。

### 10.3 Phase 2：接 DSH 执行 + workgroup 工作区

- `AcpExecutor`；专属 profile；cwd = workgroup 根（工作区）。
- context → session 绑定；`session/update` → 结论文本；thought 过滤。
- 取消（`session/cancel` + 进程树）；`input-required` 透传。
- 工作区持久化（根即 cwd）、`notes/`；工作区配额；单槽 busy（`429 orca_node_busy`）。
- 文件交换（[§5.6](05-tasks.md#56-文件交换blob-通道)）：`publish` 登记、带签名的直链、谁需要谁来拉；结论文本内联回传。
- 权限模式继承（[§7.10](07-security.md#710-权限模式继承)）：origin 会话模式写进 `pod.permission_mode`，本机 `permission_mode` 为上限取较窄，ACP 权限请求按模式自动应答。
- 验收：真实任务完成；跨任务续跑能看到上次的文件与 notes；失联的任务不被悄悄重发，origin 的追踪放弃时告知 agent；取消生效；重启后非终态任务标 `failed(node_restart)`；发布 → 任务书引用 → 对端下载、产物发布 → origin 下载两个方向都通过；orca node 忙时第二个任务返回 429 且 UI 显示持有者。

### 10.4 Phase 3：权限模型 + 审批回路

- grant 签发/校验（[§7.11](07-security.md#711-grant)）：单次、绑定请求与决策链。
- `input-required` 升级回路（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）：**task 置 input-required 并把 `permission_request` 写进 task 记录**（不是 target 拨 origin）→ origin 轮询看到 → **UI 卡片/弹窗/面板作答** → 批准发 grant 作为同一 task 的后续 message / 拒绝置 `failed(permission_denied)`。
- 链式升级：中间节点不自批，越界请求沿 task 状态逐跳上升，grant 由 origin 签发、逐跳转发；自动上升靠 CLI 的 child-link 与 `wait --local-task`。
- 验收：权限模式继承正确（origin 只读 → target 写被拒）；升级请求只在 origin 弹卡片、target 无本地弹窗；无人值守 orca node 不会被阻塞。

### 10.5 Phase 4：规模化与部署

- `orca-pod install`：检查 `dsh --version`、生成/复用节点配置、渲染 systemd unit 并 `daemon-reload` + `enable --now`；固定常驻 `orca-node serve`（不提供 web 模式）。裸 `install` 或只带 `--dry-run` 是交互式向导；带任何其他参数即进入参数分支、完全不提问（agent 通过 SSH 安装时用 `--workgroup` + `-p/--password`）；`--dry-run`、`--system`、`--skip-dsh-check` 适合无 sudo/CI 场景。
- 部署（不做进插件）：TLS 由前置代理（Caddy/nginx）终结，节点自身只监听明文 HTTP；代理健康检查打 `/health`，不代理 `/cluster/child-link` 与 `/cluster/task`（它们故意只认传输层回环）。跨机验证前用 `scripts/sync-guest.ps1` 把当前提交同步到 guest 并重装依赖，避免两端代码漂移。
- 10 个 orca node full mesh 压测：任务延迟、内存/CPU、心跳稳定性。
- 验收：10 个 orca node 24h 稳定；单 orca node 故障不影响其他 orca node 任务。

### 10.6 验收标准

> 只勾已经由当前代码与测试或跨机实测覆盖的项；未勾表示尚未验收，不代表设计被删除。

#### 两台 orca node

- [x] `/health` 无鉴权可达；Agent Card 公开可读且不含 runtime/路径/拓扑；`/cluster/members` 无签名被 401
- [ ] 错误 workgroup 被 `400 workgroup_mismatch`、错误密码被 `401 bad_proof`
- [x] 正确密码 + 签名可 join、心跳、拉目录
- [x] 两个 orca node 双向心跳；kill 一方 3 拍内从在线集消失（测试用缩短间隔的等价看门狗）
- [x] orca node 重启后 task store 与工作区仍在（非终态标 `failed(node_restart)`，`tasks/get` 可查，`workgroups/` 目录不删）

#### Echo 脚本

- [x] `echo.final.text` 原样出现在 `tasks/get` 的 `status.message.text`，逐字节相等
- [x] 到 `at_ms` 时任务变 `input-required`，`permission_request` 可读，槽位释放
- [x] 权限挂起只接受签名 grant 或拒绝：纯文本恢复回 `400 bad_request`，任务不变
- [x] 恢复后从上次位置继续，不重放已过去的 step；总时长约等于各 step 间隔之和（不含挂起时间）
- [x] `artifacts[].artifactId == sha256(content)`，artifact 元数据与字节数正确
- [x] 产物 blob 可被另一 orca node GET（artifact id = sha256，与跨 orca node blob GET 同通道）
- [x] `hang` 脚本被 `tasks/cancel` 后 2s 内变 `canceled` 且槽位释放；不取消则 `task_ttl_s` 到期进 `failed(timeout)`
- [x] 非法脚本（`at_ms` 递减、未知字段、`state` 非法）在建 task 前 `400 bad_echo_script`

#### AcpExecutor

- [x] 假 ACP server：`session/update` 文本累积 → `completed`；`session/new` 的 cwd = workgroup 根
- [x] `session/request_permission` 超出模式 → `input-required`，批准后回 allow 并继续
- [x] 取消任务发 `session/cancel`，任务进 `canceled`
- [x] 同一 `(origin, context)` 复用 session（`session/new` 只一次）；orca node 重启后走 `session/resume`
- [x] 命令不存在时首个事件是 `failed`，不悬挂
- [x] 真实 `dsh --profile acp` + 模型凭据的端到端手动冒烟（`scripts/e2e-acp.mjs`，不进 `npm test`）

#### 三台 orca node

- [x] C join A 后一拍内三向可见（C 按目录自行补全到 B 的边）
- [x] 拔掉 B 的网线：A 与 C 都判 offline，且不会把 B 刷回 online
- [ ] B 恢复后仅凭自己的心跳回到 online（无人手动清缓存）
- [x] B 离线 7 天后记录被修剪（测试用缩短 `record_ttl` 的等价修剪）
- [x] 目标非 online 时拒绝派发（`peer_not_online`）
- [x] 出站调用不认识的 URL 时 `unknown_peer`，不隐式 join
- [x] 不出现任何 epoch/incarnation 字段

#### 权限与工作区

- [x] origin 只读会话 → target 写文件被拒（ACP 按继承模式自动拒绝）
- [x] 没带模式的任务按 `read-only` 执行；本机上限收窄继承值
- [x] `workspace-write` 之外的请求类型上交 origin，由人决定
- [x] 升级请求只在 origin 由人决定，target 无本地弹窗（权限请求 park 在 `ApprovalBroker`，由会话聊天卡/后台弹窗/面板作答；`orca_pod` 没有 approve 方法）
- [x] 权限请求不产生聊天 notice
- [x] 审批卡片显示来源链（`requested_by`/`via`/`upstream`）
- [ ] 同一 context 的第二个任务能读到第一个任务的 `notes/STATUS.md`
- [x] 工作区超过 `max_workspace_bytes`/`max_workspace_files` 时新任务 `507 quota_exceeded`，清理后恢复
- [ ] orca node 忙时第二个任务返回 429 `orca_node_busy` + `Retry-After`，调用方能从错误体拿到 `retry_after_s` 与持有者
- [ ] 挂起任务的恢复遇到槽被占时 `429 orca_node_busy`，任务仍是 `input-required`，origin 稍后重试成功
- [x] C 用 A 给的 `task_id` 能读到 A 在 B 上的结果；没有 `task_id` 时无法枚举（`tasks/get` 只认 id，无列表接口）
- [x] C 凭 `blob_id` 直接 `GET` B 上的产物，不需要额外授权（Windows↔Linux 双向实测）
- [x] 交接不走协议层：同一 workgroup 的任务共享 workgroup 根（agent cwd）与 `notes/`，协议没有 `continuation_of`
- [x] 链式升级：A→B→C 时 C 的越界请求经 B 上升为 A 的 `input-required`，A 批准后 grant 原样逐跳转发、C 继续；等待期间 B/C 槽位都释放（child-link 轮询自动上升）
- [x] 只有 origin 能取消/恢复任务，其他成员 `403 not_task_origin`

#### 文件交换

- [x] `publish` 登记的文件可凭直链下载，`blob_id == sha256(bytes)`
- [x] `X-Pod-Body-SHA256` 与实际字节不符 → `400 blob_digest_mismatch`
- [x] 过期直链 `410 link_expired`，文件被删 `410 blob_file_missing`
- [x] 直链过期后不可用；篡改 blob_id/exp 或换 blob 被拒

#### agent 侧（插件接线）

- [x] `orca_pod` 的 `send` 立即返回 `task_id`，工具调用不挂到任务结束
- [x] 插件后台 tracker 每 1s 拉 `tasks/get`；瞬时失败退避重试，连续失败后放弃并告知 agent“tracking interrupted”
- [x] agent 工具列表里没有任何阻塞等待工具，也没有 approve 方法；`send`/`status` 都在毫秒级返回
- [ ] target 忙时 `orca_pod` 的 `send` 拿到 `429 orca_node_busy` + 持有者，agent 把“B 忙、约 N 秒”回报用户并结束本轮（或先做别的），不自动重试
- [x] 普通完成由 tracker 投递：running → `agent.inject()`（不打断），idle → `agent.followup()`（开新一轮）
- [x] 派发后本轮结束、任务才完成 → `followup()` 只唤醒一次，新一轮读到结果并继续；同一轮内完成的任务不触发唤醒
- [x] 2s 内三个任务完成只产生一次 `followup()`；连续第 4 次后台唤醒被拦下并留 inbox
- [x] 用户给 agent 发消息后，唤醒预算重置
- [x] 标准 skill bundle：`skills/orca-node/` 随包发布；可选 `skill_injection` 经 `ctx.skills.register` 注册进 Host（默认关，不写用户 skill 目录）

#### 安全

- [x] 无密码不能创建 workgroup
- [x] 改密码后旧节点在下一拍心跳被双方丢弃（`401 bad_proof`）
- [x] 重放请求（同 nonce）被拒；重启前签发的请求被 `stale_request` 拒绝
- [x] 候选端点指向 `169.254.169.254` 被拒；私网候选正常拨号，回环默认允许、可用 `allow_loopback_peers: false` 收紧
- [x] 非成员的签名请求 `403 not_a_member`；`local` 路由带转发头 `403 local_only`

#### 10 orca node

- [ ] 心跳链路稳定 24h，CPU/内存无泄漏
- [ ] 单 orca node 故障不影响其余 orca node 任务
- [ ] 任务延迟与 2 个 orca node 相比无数量级退化
- [x] 多跳无深度上限：`pod.hop=2` 的任务照常执行（`hop` 只记账）；目标 orca node 已在 `chain` 中、或是根 origin，被 `403 ancestor_call_forbidden`
- [x] origin 对同一 target 并发 10 个请求：target 只创建 1 个 agent 进程，其余 429
- [ ] B、C 互调：后到的一方拿到 `429 orca_node_busy` 并写进结论文本回报 A；不出现两边都卡到 TTL

### 10.7 构建顺序

> 上面的阶段回答“做到什么程度”，这一节回答“先写哪一块”。原则：每一层都能脱离下一层单独验证，不通过就不往上堆。

1. **仓库骨架**：单包（根 `src/` + `test/`）、tsconfig/vitest/biome；`npm run check` 只跑进程内测试。
2. **node core（无 UI）**：protocol/crypto/storage/gateway/node + EchoExecutor；`/health`、join、heartbeat、members、`/a2a`、task store；harness 能起单 orca node。
3. **本地集群测试**：先进程内 `createMesh`（可注入时钟、端口 0），再 `npm run harness` 起两个真实进程和 socket；覆盖 10.1–10.2 验收。这一层完全不碰 DSH。
4. **Echo 行为**：按 10.6 的“Echo 脚本”“三台 orca node”逐条跑；挂起/恢复/取消/TTL/blob 在这一层定死，后面的执行器只换实现、不换协议。
5. **真实执行器**：AcpExecutor；cwd 是工作区、context→session 绑定、取消、`input-required` 映射。放在插件之前，是为了让“协议正确”和“DSH 集成正确”分两次验证，不同时调两个未知量。
6. **DSH 插件**：`apply` 启动 orca node、注册工具、后台 tracker、inject/followup、审批卡片与面板。先在单机两个 DSH 实例之间跑通（不同端口、不同 profile）。
7. **跨机器**：Windows 主机 + Hyper-V Linux guest。分两次做：core 完成后先跑 2 个 orca node smoke（join/心跳/echo），尽早暴露路径、时钟、编码问题；全部组件完成后再做完整 E2E（真实任务、权限、blob、可选 TLS）。
8. **加固**：10 个 orca node 压测、安全验收、Phase 4。

---
