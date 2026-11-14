# 10 路线图与验收

> 本章给出从两台机器到 10 台机器的分阶段计划与验收标准。

## 10. 路线图与验收

### 10.1 Phase 0：两台机器，静态 peer，EchoExecutor

- 单端口：`/health`、Agent Card、`/a2a`、`/cluster/join|heartbeat|members`。
- 短 id 生成 + 持久化；workgroup_id + 非空密码；HKDF + 请求签名。
- EchoExecutor（[§6.3](06-execution.md#63-echoexecutor用脚本模拟任务)）：按脚本模拟耗时、挂起（`blocked`/`permission`）、最终文本与产物；`ping` 只返回节点信息。
- `message/send` + `tasks/get` + `tasks/cancel`；SQLite task store。
- 验收：`/health` OK；Agent Card 公开可读（当前仅最小字段，签名接口另测）；join 成功；两节点双向心跳；kill 一方 12s 内从在线集消失；重启后 task store 仍可查。

**Phase 0 进展**

- core 已跑通：`npm test` 61 个测试通过（protocol 30、crypto 15、harness mesh 1、harness a2a 7、gateway blobs 8），`npm run typecheck` 通过。
- 跨机 join 已实测：Windows 主机 `192.168.86.152:11811` 与 Hyper-V Ubuntu guest `192.168.86.252:11812` 互 join，双方 `members_digest` 一致。
- 已实现：单端口 `/health`、最小 Agent Card、`/a2a`（`message/send`、`tasks/get`、`tasks/cancel`）、`/cluster/join|heartbeat|members|leave`；短 id 与配置持久化；workgroup + 非空密码 + HKDF/请求签名；EchoExecutor；单槽（忙时 429 `node_busy` + `Retry-After` + holder）；`/blobs` 上传/下载/直链（内存存储）；task store 与 blob store 为进程内内存。
- 未实现：SQLite task store（因此“重启后 task store 仍可查”不成立）、后台心跳循环与 12s 看门狗、`/blobs` 的 GC/配额与 `Content-Disposition`、`message/stream` / `tasks/resubscribe` / push、`continuation_of`、权限/工作区/session。Agent Card 的完整字段与 A2A schema 对齐也属于后续里程碑。

### 10.2 Phase 1：三节点 full mesh 与惰性收敛

- 新节点 join 任意节点 → 按目录对每个 peer 各 join 一次（幂等）→ 自动补全 mesh。
- 双向看门狗（6s/12s）、单调时钟、`unreachable` 状态。
- hints/候选/墓碑（[§3.5](03-membership.md#35-hints候选与墓碑)）：验证“死节点不会互相刷活”。
- `runtime` 采集与展示；`members_digest` 比对。
- id 冲突 409；leave；记录修剪。
- 验收：C 加入 A 后 2s 内 A/B/C 互相可见；kill B 后 6s suspect、12s offline；拔掉 B 的网线后 A/C 不会把 B 互相刷回在线；B 重启并重新发心跳后 15s 内恢复。

### 10.3 Phase 2：接 DSH 执行 + workgroup 工作区

- `HeadlessExecutor` → `AcpExecutor`；专属 profile；cwd = group workspace。
- context → session 绑定；`session/update` → task 事件；thought 过滤。
- 取消（process tree / `session/cancel`）；`input-required` 透传。
- 工作区持久化、`notes/STATUS.md` 约定、配额；单槽 busy（`429 node_busy` + `Retry-After`）。
- blob 通道（[§5.6](05-tasks.md#56-文件交换blob-通道)）：上传素材、下载产物、去重、GC；结论文本内联回传。
- 权限模式继承（先只做 `read-only`/`workspace-write` 两档的映射，escalate 先回固定 deny）。
- 验收：真实任务完成；跨任务续跑能看到上次的文件与 notes；节点失联 → 12s 内 `failed(node_unreachable)`；取消生效；重启后 `working` 标 `failed(node_restart)`；上传→任务→下载 roundtrip 通过；节点忙时第二个任务返回 429 且 UI 显示持有者。

### 10.4 Phase 3：权限模型 + 审批回路

- grant 签发/校验/吊销（[§7.11](07-security.md#711-grant)）；默认 `delegated`。
- `input-required` 升级回路（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）：**task 置 input-required 并把 `permission_request` 写进 task 记录**（不是 target 拨 origin）→ origin 轮询/SSE 看到 → **用 DSH 审批卡片弹** → 批准生成新 grant 并作为同一 task 的后续 message 补发 / 拒绝置 `failed(permission_denied)`。
- 预授权策略（按 target + 工具 + 时长）与本机总开关。
- `credential_readback` 三档 + 审计。
- 工作区加固：配额、清理、Windows 长路径/保留名测试矩阵（[§6.13](06-execution.md#613-配额清理跨平台)）。
- 验收：越界写被拒；权限模式继承正确（origin 只读 → target 写被拒）；升级请求只在 origin 弹卡片、target 无本地弹窗；无人值守节点不会被阻塞。

### 10.5 Phase 4：安全与规模化

- TLS 部署配方（Caddy/nginx）、`trust_proxy`、限流、审计落盘与轮转。
- 10 节点 full mesh 压测：45 链路、45 心跳/s、任务延迟、内存/CPU。
- 可选：SSE、`tasks/resubscribe`、push notification。
- 可选：节点内建 mTLS。
- 验收：安全测试通过；10 节点 24h 稳定；单节点故障不影响其他节点任务。

### 10.6 验收标准

> 只勾已经由当前代码与测试或跨机实测覆盖的项；未勾表示尚未验收，不代表设计被删除。

#### 两台节点

- [x] `/health` 无鉴权可达；Agent Card 公开可读且不含 runtime/路径/拓扑；`/cluster/members` 无签名被 401
- [ ] 错误 workgroup / 错误密码被 401（同一文案，不区分）
- [x] 正确密码 + 签名可 join、心跳、拉目录
- [ ] 两节点双向心跳；kill 一方 12s 内从在线集消失
- [ ] 节点重启后 task store 与工作区仍在

#### Echo 脚本（Phase 0/1）

- [x] `echo.final.text` 原样出现在 `tasks/get` 的 `status.message.text`，逐字节相等
- [x] 到 `at_ms` 时任务变 `input-required`，`blocked`/`permission_request` 可读，槽位释放
- [x] 恢复后从上次位置继续，不重放已过去的 step；总时长约等于各 step 间隔之和（不含挂起时间）
- [x] rtifacts[].blob_id == sha256(content)，artifact 元数据与字节数正确
- [ ] 产物 blob 可被另一节点 GET（跨节点取产物尚未实测）
- [x] `hang` 脚本被 `tasks/cancel` 后 2s 内变 `canceled` 且槽位释放；不取消则 `task_ttl_s` 到期进 `failed(timeout)`
- [x] 非法脚本（`at_ms` 递减、未知字段、`state` 非法）在建 task 前 `400 bad_echo_script`

#### 三台节点

- [ ] C join A 后 2s 内三向可见（C 按目录自行补全到 B 的边）
- [ ] 拔掉 B 的网线：A 与 C 都判 offline，且不会通过 hints 互相把 B 刷回 online
- [ ] B 恢复后仅凭自己的心跳回到 online（无人手动清缓存）
- [ ] B 离线 7 天后记录被修剪
- [x] 不出现任何 epoch/incarnation 字段

#### 权限与工作区

- [ ] origin 只读会话 → target 写文件被 escalate/deny
- [ ] origin workspace-write → target 只能在 group workspace 内写
- [ ] 升级请求只在 origin 弹审批卡片，target 无本地弹窗
- [ ] 同一 context 的第二个任务能读到第一个任务的 `notes/STATUS.md`
- [ ] `credential_readback=ask` 时私钥内容回传需 origin 批准
- [ ] 绝对路径与 `..` 被拒（协议层根本不接受路径）
- [x] 节点忙时第二个任务返回 429 `node_busy` + `Retry-After`，调用方模型能从错误体拿到 `retry_after_s` 与持有者，自行选择重试、换节点或向用户回报（UI 显示持有者尚未实现）
- [ ] C 用 A 给的 `task_id` 能读到 A 在 B 上的结果；没有 `task_id` 时无法枚举
- [ ] C 凭 `blob_id` 直接 `GET` B 上的产物，不需要额外授权
- [ ] C 用 `continuation_of` 续跑：旧 task 状态与 artifact 不变，新 task 落在同一工作区；旧 task 未终态 → `409 task_not_terminal`

#### 文件交换

- [x] 上传 1 MiB 文件返回 201，`blob_id == sha256(bytes)`
- [x] 重复上传同内容返回 200，不占新空间
- [x] `X-Pod-Body-SHA256` 与实际字节不符 → 400 且不落盘
- [x] 素材上传 → 任务引用 → 产物下载 roundtrip 通过
- [x] 短期直链过期后不可用；篡改 blob_id/exp 或换 blob 被拒（直链用 `exp+sig`，无状态 HMAC）
- [ ] 未被任务引用的 blob 在 TTL 后被 GC，下载返回 410（GC 未实现）

#### agent 侧（插件接线）

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

#### 安全

- [x] 无密码不能创建 workgroup
- [ ] 密码不出现在配置、日志、错误信息中
- [ ] 改密码后旧签名立即失效
- [x] 重放请求（同 nonce）被拒
- [ ] hint 指向 `169.254.169.254` 被拒

#### 10 节点

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

### 10.7 构建顺序

> 上面的阶段回答“做到什么程度”，这一节回答“先写哪一块”。原则：每一层都能脱离下一层单独验证，不通过就不往上堆。

1. **仓库骨架**：npm workspaces、十个包、tsconfig/biome/vitest、CI（只跑进程内测试）。
2. **headless node core**：protocol/crypto/storage/gateway/orca_node + EchoExecutor；`/health`、join、heartbeat、members、`/a2a`、task store；harness 能起单节点。
3. **本地集群测试**：先进程内 `createMesh`（可注入时钟、端口 0），再 `npm run harness -- --nodes 3` 起真实进程和 socket；覆盖 10.1–10.2 验收。这一层完全不碰 DSH。
4. **Echo 行为与回调**：按 10.6 的“Echo 脚本”“三台节点”逐条跑；挂起/恢复/取消/TTL/blob 在这一层定死，后面的执行器只换实现、不换协议。
5. **真实执行器**：HeadlessExecutor（ACP stdio）→ AcpExecutor；cwd 是工作区、context→session 绑定、取消、`input-required` 映射。放在插件之前，是为了让“协议正确”和“DSH 集成正确”分两次验证，不同时调两个未知量。
6. **DSH 插件**：`apply` 启动节点、注册工具、后台 tracker、inject/followup、审批卡片与状态卡片。先在单机两个 DSH 实例之间跑通（不同端口、不同 profile）。
7. **跨机器**：Windows 主机 + Hyper-V Linux guest。分两次做：core 完成后先跑 2 节点 smoke（join/心跳/echo），尽早暴露路径、时钟、编码问题；全部组件完成后再做完整 E2E（真实任务、权限、blob、可选 TLS）。
8. **加固**：10 节点压测、安全验收、Phase 4。

进程内测试不依赖网络和真实时钟；每个包都有自己的夹具测试；任何一层验收没过，不进入下一层。

---
