# 07 安全与权限

> 本章描述信任边界：workgroup 与密码、请求签名、TLS 部署、不可信输入，以及权限如何跟随发起 orca node。

## 7. 安全与权限

### 7.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**可空**（空 = 开放 mesh：局域网内任何人可加入并派任务，仅限受信 LAN/原型）；推荐最短 12 字符，面板首启向导默认留空、可填。空密码时 `HKDF(ikm = "")` 是公开常量，等于没有认证。
- 密码不入库明文：首选系统钥匙串引用；退而求其次才在插件配置里存 `HKDF` 派生密钥（文件权限 0600）。存派生密钥的代价是：配置文件泄露 = 直接获得签名能力，所以推荐前者。面板覆盖层 `<data_root>/ui-config.json` 目前以明文保存 `workgroup_password`（只由回环闸门写入，生产应换成 credentials 引用）。
- DSH 插件默认 `bind_host: "::"`（整机网卡监听），并用识别到的 LAN/IPv6 地址做 advertised endpoints：否则局域网 peer 拨不到。代价是**同网段任何人都能打到 `/health`、`/a2a` 与 `/blobs`**——认证仍靠 workgroup 签名，密码为空（开放 mesh）时就等于没有认证，只适合受信 LAN；需要更严格时设 `bind_host: "127.0.0.1"` 并让流量只走代理。
- 日志、配置文件、错误信息里都不出现密码或派生密钥。
- 密钥派生：

```text
k = HKDF-SHA256(ikm = password, salt = "orca-pod", info = workgroup_id, len = 32)
```

- 换密码：**改过的 orca node 用新密码重启，重新 join 组成新 group**；没改的 orca node 留在旧 mesh 里，签名对不上就 401/offline，等于被移出（[§7.3](07-security.md#73-密钥与密码的分发)）。没有“过渡期双密码”，也不需要集中式踢人。
- **同组 = 同一密码学主体**：任意成员都能为任意 `orca_node_id` 生成合法签名，签名里的 id 不证明“谁在调用”。因此凡是“只有本机可以做”的能力，一律不能用签名身份判定，只能用传输层事实判定：监听在回环、没有转发头、或干脆不经过网络（本机 CLI 直写本机状态）。已落实的一例是文件 blob 登记：[§5.6](05-tasks.md#56-文件交换blob-通道) 里 `publish` 由 CLI 直写本机 SQLite，不提供 HTTP 路由——曾经的设计是 `POST /blobs/register` 加 `auth.orcaNodeId === self` 检查，那等于任何 peer 都能让目标节点读任意本机路径。要真正区分“谁”只有 per-node keypair / mTLS，本设计不做。
- **授权按记录归属，不按签名身份**：正因为签名只证明“属于这个组”，普通读接口允许同组成员读，但写操作必须在**记录归属**上校验——`tasks/cancel` 只接受 task 的 origin（或执行它的本机节点），其他成员 `403 not_task_origin`（[§5.3](05-tasks.md#53-取消)）；`tasks/resume`、`tasks/escalate` 同理只接受 origin / 本机（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。`/cluster/child-link` 则同时要求传输层回环——它登记的是“本机任务在等某个子任务的权限”，不能让别的节点替你登记。

### 7.2 请求签名（没有 session token）

每个请求自带证明，服务端用同一把 `k` 现验：

```http
Authorization: Pod orca_node_id=N7K3QM; ts=1763100000; nonce=9f2c1a; proof=<base64url>
```

```text
proof = HMAC-SHA256(k, "pod-v1|" + method + "|" + path + "|" + sha256(body) + "|" + ts + "|" + nonce)
```

校验顺序：

1. `ts` 与本地时间差 ≤ 60s（时钟漂移单独报错，别混进 401）；
2. `nonce` 未在 5 分钟窗口内出现过（每 orca node LRU，容量 10k）；
3. `proof` 常量时间比较；
4. 通过后按 `orca_node_id` 找/建 peer 记录（首次即登记，见 [§3.2](03-membership.md#32-引导与加入)）。

性质与代价：

- **无状态**：服务端不存 token，不需要清理、不需要刷新、不需要 TTL；
- **密码即凭证**：密码泄露 = 全组沦陷；所以密码强度与分发是唯一的安全边界；
- **不可撤销单个 orca node**：密码是全组共享的，想踢人只能换密码并重建 group（[§7.3](07-security.md#73-密钥与密码的分发)）。
- **重放窗口**：60s + nonce 去重；跨 orca node 时钟必须大致同步（NTP）；
- **代理友好**：签名覆盖 method/path/body，代理改写 body 会验签失败（这是特性）。
- **大 body 的签名**：带 body 的请求加 `X-Pod-Body-SHA256` 头，签名覆盖这个摘要而不是把整个 body 读进内存重算一遍；服务端流式落盘后再自校验，不一致即 `400 body_digest_mismatch`。
- **下载可换短期直链**：任意同组 orca node 调 `POST /blobs/{id}/link`，服务端返回 `GET /blobs/{id}?exp=<unix>&sig=<base64url>`，`sig = HMAC(k, "link|" + blob_id + "|" + exp)`，TTL 5 分钟。浏览器/curl/前端直链不用带长期请求头。Phase 0 用**无状态 HMAC**而不存 token：持有 `k` 的成员本来就能直接 `GET` 这个 blob，所以直链只是省掉签名头的便利，不扩大可读范围；真正需要“授权方才能发链接”时再换成服务端签发、存库、可撤销的随机 token（多一张表、多一次读写）。

`/cluster/join` 用同一种签名；区别只是它同时返回目录。`/health` 不签。

### 7.3 密钥与密码的分发

- 推荐：`workgroup_id` + 密码通过带外通道给（人当面、密码管理器、私聊），不放进任何仓库；
- 插件配置里只存 `workgroup_id` 与钥匙串引用；导出的配置不含密码；
- 二维码/复制按钮只用于本机设备间传递，UI 明确写“这是明文，别发群里”；
- 轮换（“解散再重建”，是特性不是缺陷）：
  1. A 改密码并重启监听 → 旧签名全部失效，A 对旧成员表现为 401，旧成员对 A 表现为 offline；
  2. B 也改成同一新密码、重启、重新 join A → 新 group 成立（此刻 A、B 互见）；
  3. 没改密码的 C 留在旧状态：它能拨 A，但签名验不过，**进不来**；A 也不会把 C 当成员；
  4. 想恢复 C，就把它的密码改成新的、重新 join 任意一个新成员。
- 结论：整个过程不需要“踢人接口”，也不需要维护黑名单——**密码就是成员资格**。

### 7.4 TLS 部署矩阵

| 场景 | 方案 | 要点 |
|---|---|---|
| 局域网/VPN | 明文 HTTP | 密码是唯一门槛；确保网络本身可信 |
| 公网单 orca node | Caddy `reverse_proxy` + 域名 | 自动证书；orca node 只听 127.0.0.1 |
| 公网多 orca node | Caddy/nginx 各 orca node 一套 | 证书可集中签发；注意 SSE 缓冲关闭 |
| 零信任 | Tailscale/WireGuard | 网络层隔离，orca node 仍要密码 |

`trust_proxy`：不读转发头做鉴权——插件既不用 `X-Forwarded-For` 判断“是谁”，也不用它判断“是不是本机”；`/cluster/child-link` 只认 socket 回环地址，带任何转发头直接 403。TLS 由前置代理终结，节点自身只监听明文 HTTP（[§4.2](04-transport.md#42-http-路由)）。

### 7.5 远程任务是不可信输入

- 任务 prompt、artifact 内容、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 可观测：谁（origin_orca_node）、何时、对哪个任务/工作区、用了什么 mode、批了什么——这些都留在任务记录与派发日志里（`tasks/get`、`orca-node log`），不另落一份审计文件。

### 7.6 授权矩阵

不是“同 workgroup 就能跑一切”。每个 orca node 维护：

| 维度 | 默认 | 可配 |
|---|---|---|
| 谁能派任务 | 同 workgroup 的任意已加入 orca node | 按 orca_node_id 白名单 |
| 权限上限 | 继承 origin 会话 mode | 本机可再降一档 |
| group workspace 可见性 | 同 workgroup | 仅本机 |
| 任务/产物读取 | 同 workgroup 凭 id | —（无 per-task / per-blob ACL） |
| 硬拒绝 | [§7.13](07-security.md#713-目标侧硬拒绝清单) | 仅本机人类解除 |

### 7.7 SSRF / 候选端点防护

- 候选端点（从别人目录里学到、尚未直接 join 的）在拨号前校验；显式配置、CLI `--peer`、直接 `join` 的端点不在此列；
- 恒定拒绝：`0.0.0.0`/`::`、组播、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；**回环默认允许**（同机多进程是常见部署），可用 `allow_loopback_peers: false` 收紧为拒绝；公网地址需要 `allow_public_peers: true`；
- 主机名先解析、再按解析结果判断，解析失败即拒；探测失败按 `recover_probe`（15s→30s）退避；候选探测单独计数，防止被当作端口扫描器。

**实现状态（Phase 3）**：已实现。`membership.ts` 给每个 peer 记 `origin: "explicit" | "candidate"`（直接 join → explicit；只从目录 merge 进来 → candidate），心跳循环在拨号 candidate 前调用 `src/net.ts` 的 `candidateEndpointAllowed`（`test/ssrf.test.ts` 8 条覆盖私网/回环/元数据/组播/公网/主机名/非法 URL、origin 标记与 fetch 禁用端口）。被拒的候选只 warning 一次、不进 online，也不会被当作在线成员。

### 7.8 审计

- **不做持久审计落盘**（局域网自用，[§10.5](10-roadmap.md#105-phase-4规模化与部署)）：任务记录、`dispatches` 派发日志与 DSH 会话记录已经能回答“谁在什么时候派了什么、结果如何”，额外一条审计通道收益低、维护成本高。
- 排查靠现有记录：`orca-node log`（origin 派发）、`tasks/get` 的任务状态与 `reason`、插件 tracker 的通知文本；`permission_request` 全文留在任务状态里，便于事后回答“它当时要什么”。
- 真要合规审计属于部署层外挂（代理访问日志 + DSH 会话留档），不在插件内实现。
- 网关状态（`<data_root>/state/<workgroup_id>/`：session 绑定、任务目录）也必须在 workgroup 根之外：agent 对 cwd 有写权限，看得见就能删；放进工作区等于把会话绑定和网关状态交给被调用的 agent（[§6.7](06-execution.md#67-工作区一份持久)）。
- 面板写入的配置覆盖层 `<data_root>/ui-config.json` 与插件配置同属明文（`workgroup_password` 会在里面），只由回环闸门后的 `/orca-api/config` 写入；面板读取的配置视图永不返回密码（只给 `password_set`）。这是原型取舍：生产应把密码换成 DSH credentials 引用，让 UI 只写引用名。

### 7.9 权限跟随发起 orca node

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；会话能写工作区，远端就只能写工作区；
- 需要更多权限时，target 通过 A2A 把请求送回 origin，由人在 origin 的卡片上决定。

这条前提排除了两种设计：target 本地审批（无人应答、任务挂死）和 target 自由裁量（origin 无法预期远端能做什么）。

**审批面属于会话，不属于节点**，所以 orca node 不需要判断“本机有没有人”，只看这个 task 的 `origin_orca_node`：

| 情形 | 谁批 | 行为 |
| --- | --- | --- |
| `origin == self`，且 task 由**交互式会话**（桌面插件的 agent）发起 | 本机的人 | 弹审批卡片（`pod_approve` → DSH `approval.request`） |
| `origin == self`，且会话本身在执行某个 inbound task（headless/ACP 执行器派出的子任务） | 链上更上游的人 | 本机不批：请求沿这条 inbound task 继续上升（CLI `wait --local-task <那个 task>` 自动 `tasks/escalate`），一直走到有人的会话为止 |
| `origin == self`，且是本机真实根（没有 inbound task，人在这台机器前） | 本机的人 | 弹审批卡片；默认无限等待，可配置 `approval_timeout_s` 到点自动 `failed(permission_timeout)`；预授权命中则自动放行并记 `decided_by: policy` |
| `origin != self` | 链上更上游的人 | 本机不批，只逐跳上升：`permission_request` 交给 origin（CLI 的 `wait --local-task` 自动调 `tasks/escalate`），批准后下发 child grant |

不存在“节点级 attended 标志”：同一台机器通常同时跑桌面 DSH 和 headless/ACP 执行器，有没有人取决于**是哪个会话发起了这个 task**；ACP 执行器会话只有 CLI、没有审批面，所以它派出的子任务一律 escalate。链上唯一的人坐在根会话前。

注意 `origin == self` 不等于“本机有人”：A→B→C 里，C 上子任务的 origin 是 B（B 的 CLI 用 B 的密钥签名），但 B 的会话正被 A 的 task 驱动，B 屏幕前没有人。所以这个请求要沿 B 自己的 inbound task 继续上升（CLI `wait --local-task <B 的 inbound task>`），直到 A 的交互式会话。

链式调用（A→B→C）时，“origin”是相对的：每个 task 的 origin 负责把请求往上传，直到有人的那个 orca node——规则见 [§7.12](07-security.md#712-升级回路任务状态不是反向调用) 的「链式调用」小节。

### 7.10 权限模式继承

origin 发起任务时携带会话的 permission mode，target 原样执行：

| origin 会话模式 | target 上的含义 |
|---|---|
| `read-only` | 只读：可读工作区内文件、可跑只读命令；写文件/改状态一律 escalate 或 deny |
| `workspace-write` | 只在工作区内写；出界（家目录、系统目录、其它项目）一律 escalate |
| `danger-full-access` | 全机可用，但 [§7.13](07-security.md#713-目标侧硬拒绝清单) 的硬拒绝清单仍然生效 |

三条规则：

- **mode 只能降不能升**：target 可以把 `danger-full-access` 降为 `workspace-write`（配置更严），不能反向；
- mode 随任务签名一起传，target 校验签名后再执行，防止中间人改宽；
- mode 不写进 grant 之外的任何持久状态；任务结束即失效。

**实现状态（Phase 3）**：`pod.permission_mode` 进任务元数据并随签名传递，`chain.ts` 校验合法性、子任务由 `childPodMetadata` 继承；本机 `config.json` 的 `permission_mode` 是上限，`src/tasks.ts` 取「上限 vs 继承值」较窄者后交给执行器。`HeadlessExecutor` 传 `--permission-mode`；`AcpExecutor` 在 `session/request_permission` 处按模式自动回答（`read-only` 拒绝写类工具、`workspace-write` 放行工作区内编辑/执行、`danger-full-access` 全放行），没有继承模式时仍挂起、回到 origin 的审批卡片。`pod_send` 与 `orca-node send --permission-mode` 都能显式指定；测试见 `test/permission-mode.test.ts`（8 条）。

### 7.11 Grant

grant 是 origin 对“这一次任务”的授权凭证，随 A2A 请求下发：

```json
{
  "grant_id": "g_01JABC",
  "workgroup_id": "orca-dev",
  "origin_orca_node": "N7K3QM",
  "target_node": "P2W8XA",
  "task_id": "t_01JABD",
  "permission_mode": "workspace-write",
  "workspace": { "kind": "group" },
  "limits": { "max_runtime_s": 3600, "max_write_bytes": 536870912 },
  "nonce": "9f2c...",
  "chain": [],
  "issued_at": "2026-11-14T04:40:00Z",
  "expires_at": "2026-11-14T05:40:00Z"
}
```

校验：

- 绑定 `(workgroup_id, origin_orca_node, target_node, task_id, nonce)`，五者任一不符即拒；
- 只能**收窄**：target 拿到的 mode 不能高于 origin 会话当时的 mode；链式转授时，sub-grant 的 mode/limits 不能宽于父 grant、`expires_at` 不能晚于父 grant，`chain` 追加当前跳（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）；
- `expires_at` 到点即失效；任务 cancel / 完成即吊销（target 本地删记录，不需要广播）；
- 无 grant 的请求直接 `deny(missing_grant)`，不接受“老客户端”兼容。

**实现状态（Phase 3 第一版）**：`crypto.ts` 的 `signGrant`/`verifyGrant` 用 workgroup key 做 HMAC，签名覆盖 `grant_id|workgroup_id|task_id|target_orca_node|tool|mode|chain|issued_at|expires_at`；grant 由 origin 批准时签发，target 端校验签名、`task_id`、`target_orca_node`、`workgroup_id`、`tool` 与过期时间，任一不符即 `failed(reason=grant_invalid)` 或 `failed(reason=grant_expired)`。当前只支持 `mode: "allow_once"`；`limits`、`nonce`、`permission_mode` 尚未进签名结构（原型阶段先只做“单次工具放行”），grant 随 resume message 的 data part 下发，不单独持久化。

### 7.12 升级回路：任务状态，不是反向调用

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
- 审批卡片要显示：来源 orca node（display_name + id）、目标路径、命令/工具原文、请求理由、将提升到什么权限。不要把 target 传来的长文本渲染成 HTML（注入）。
- 审批 UI 直接复用 DSH 的 approval 卡片（Host 既有机制），不另做插件面板。
- 同一 task 的升级次数上限（默认 3），超过即 failed 并告警；防止被调用 orca node 反复索权。
- origin 侧支持**预授权**（避免每次都弹）：按 `(workgroup, target, tool)` 记一条本地策略，如“允许 N7K3QM 在 P2W8XA 上跑 shell，单次 ≤15 分钟”。预授权记录进审计。

**实现状态（Phase 3 第一版）**：target 在挂起时生成 `permission_request`（`request_id`、`task_id`、`tool`、`requested`、`requested_by`、`via`、`expires_at`）写进 `status.message`；只有任务 origin 能 `message/send` resume（其他成员 `403 not_task_origin`，但读取不受限）。插件侧由 tracker 看到该请求即强制 `followup` 唤醒派发它的 agent（不受连续唤醒预算限制），模型调用 `pod_approve(peer, task_id, decision, reason?)`；工具在 open turn 内调 DSH `approval.request` 弹卡，只有 `allowed-once` 才签 grant，其余 outcome 与显式 `deny` 都发 `permission_denied`。

**实现状态（Phase 3 第二版）**：链式第一版已实现——`chain.ts` 提供 `childPodMetadata`、`validatePodMetadata`、`grantCovers`、`deriveChildGrant`；`approveTask(..., { parentGrant })` 先校验父 grant 签名与覆盖范围（同 tool、未过期），再派生 child grant（`chain` 追加当前 orca node、`target_orca_node` 指向请求者、`expires_at` 不晚于父），派生失败抛 `escalation_required` 或 `grant_expired`，不发请求。hop 与祖先链校验见 [§5.1](05-tasks.md#51-任务标识与元数据)。**未实现**：`permission_mode`/`limits` 的收窄（签名结构只有 `mode`）；中间节点按本地策略自动放行。

**实现状态（Phase 3 第三版，Echo relay 原型）**：`tasks.ts` 支持 executor 在 permission 挂起时携带 `relay`（子任务 endpoint、task id、子任务的 `permission_request` 快照）。这时父任务自己挂成 `input-required`，请求里 `requested_by` 是本 orca node、`via` 是祖先路径、`upstream` 记着真正需要权限的下游 `requested_by`；origin 审批后，父任务用拿到的 grant `deriveChildGrant` 派生出面向下游的 child grant，通过 `message/send` 发给子任务，然后继续自己的执行；拒绝或取消则把 `permission_denied` 往下传，子任务随之失败而不是悬挂。每一跳都释放执行槽、不保持连接、不反连，所以 relay 天然非阻塞。**限制**：relay 链接只在内存里（重启后按 §8.3 整体标 `node_restart`，不会恢复）；早期版本要求执行器自己注入 `relay`，这一点已由第六版的自动上升取代（见下）；审批卡片的 `upstream` 展示见第四版。

**实现状态（Phase 3 第六版，自动上升）**：父任务不再依赖执行器注入 `relay`，改由 origin 侧自己发现。CLI `send --local-task <此 task>` 在子任务建成后向本机发 `POST /cluster/child-link`（`headless` 执行器的子进程通过环境变量 `ORCA_POD_PARENT_TASK` 自动带上，agent 不必记参数）；节点为该 `(parent, child)` 起 1s 轮询，看到子任务 `input-required` 且带 `permission_request` 就对本机父任务调用 `tasks/escalate`，父任务随即挂成 `input-required`（`upstream` 指向子任务请求者），origin 批准后 child grant 逐跳下发、父任务回 `working`、子任务继续——第 17 轮测试（`test/relay-auto.test.ts`）用 headless 父任务 + Echo 子任务覆盖了整条链路，父任务未被中断。轮询有界：子任务终态、父任务终态、或连续 10 次读失败都会摘掉链接。**这个控制接口只登记、不执行**，所以它的本地性用传输层判定：只接受回环地址且没有 `x-forwarded-for`/`forwarded`/`x-real-ip` 的请求，否则 `403 local_only`——同组共享 workgroup key 时签名里的身份可伪造（[§7.1](07-security.md#71-威胁模型)），local-only 能力不能靠 `auth.orca_node_id`。**仍未实现**：child link 只在内存里（重启后不恢复，父任务按 §8.3 对账）；`permission_mode`/`limits` 收窄。

**实现状态（Phase 3 第四版，显式 escalate）**：中间 orca node 的 task 可以在执行中主动挂起自己——CLI `orca-node escalate --peer <child> --task <child task> --local-task <此 task>` 取子任务的 `permission_request`，经本机 `tasks/escalate` 交给 runner；runner 把此 task 改成 `input-required` 并填一条上游请求（`requested_by`=本 orca node、`upstream`=[子请求者]、`via`=祖先链），执行器本身继续跑（不打断 ACP turn，也不动 iterator）。origin 批准后按第三版派生子 grant 发回子任务，然后把此 task 放回 `working`；拒绝则向下传 `permission_denied` 并让此 task 失败。`tasks/escalate` 只接受本 orca node 自己签名（跨节点调用一律拒绝）。ACP 的 preamble 里已写明：`wait` 退出码为 3 时用 `escalate` 把决定权交还 origin。审批卡片与 tracker 通知现在都会显示来源链：`permissionOriginNote` 把 `via` 与 `upstream` 拼成 ` via A → B` 后缀，`pod_approve` 的 `approval.request.reason` 由 `approvalReason` 生成（形如 `Remote task <id> on <peer> wants to run "<tool>" via A → B: {...}`），人能看到这张卡是替谁批的。自动感知就是轮询：`orca-node wait` 带上 `--local-task <此 task>` 时，一旦在轮询中看到子任务 `input-required` 且带 `permission_request`，会自己调用 `tasks/escalate` 把请求上升，然后继续等；同一个 `request_id` 只上升一次，批准后子任务恢复、拒绝则失败，agent 不需要再单独发一次 `escalate`。**仍未实现**：不经 CLI 的宿主（例如插件工具直接派发子任务）没有这层轮询；`permission_mode`/`limits` 收窄。

**实现状态（Phase 3 第五版，默认无限等待）**：审批不再默认 120 秒过期。`permission_request.expires_at` 变成可选字段，只有配置了 `approval_timeout_s` 的 orca node 才会填；没配就是无限等待——人可能正在吃饭，任务不该因此失败。对应地，`input-required` 期间 task TTL（`task_ttl_s`）暂停，`resume` 后才重新计时，否则“等人”会被 TTL 当成“超时”。配置 `approval_timeout_s` 后，到点自动拒绝对应的挂起请求：先向下游（`pending_escalation`/`relay`）发 `permission_denied`，再让本 task `failed(permission_timeout)`。CLI 的 `wait`/`escalate` 的 `--timeout` 也变成可选：不给就一直等到 origin 决策。grant 范围内按工具/路径自动放行（预授权的自动化）仍未实现。

#### 链式调用：授权向下收窄，升级向上回传

链 A→B→C 里，如果让 B 直接批准 C 的越界请求，A 的授权就被一个 agent 转授放大了。规则只有一条：**每个 task 的 origin 只能在自己拿到的 grant 范围内放行；超出一律上升，直到有人的那个 orca node，通常是根 A。**

为什么不是 B 自主决策：

- A 给 B 的 grant 表达的是 A 的意图（比如“B 可以在工作区写”），B 批准 C 写 `/etc` 不在这个意图里——B 的“同意”不是人的同意；
- B 也没有能力替 A 扩大授权：它没有 A 的 UI、没有人类动作，自批等于把授权链悄悄放宽；
- 唯一例外：A 明确给了 B `danger-full-access`（用户已接受该风险），或 B 本地预授权策略命中。此时 B 可自行放行，但任务记录里记 `decided_by: "orca_node:<B>:policy"y"`，A 的 task 里也能看到一条“B 自动批准了 C 的请求”事件。

回路仍然没有反向调用，只是把同一份状态沿链上升：

```text
C：工具越界 → C 的 task 变 input-required，permission_request 落在 C 的 task 上
B（C 的 origin）：agent 通过 pod_status/tracker 看到 → B 的 task 也变 input-required
   status.message 里放一条 permission_request，带来源链：
   {
     "request_id": "pr_01J",
     "task_id": "t_B",                 // B 自己的 task
     "requested_by": "P2W8XA",         // 真正要权限的 orca node（C）
     "via": [{ "orca_node": "P2W8XA", "task_id": "t_C" }],
     "tool": "write_file",
     "target": "/etc/nginx.conf",
     "reason": "...",
     "requested": { "permission_mode": "danger-full-access" },
     "expires_in_s": 60                 // 逐跳递减
   }
A（B 的 origin，也是人的位置）：tasks/get 看到 → 审批卡片显示“C 经 B 请求写 /etc…” → 人批
   → A 给 B 发新 grant（t_B 的后续 message）
   → B 恢复，把等价但更窄的 grant 作为 t_C 的后续 message 发给 C
   → C 恢复执行
```

规则：

- **grant 逐跳派生，派生必然收窄**：每一跳不转发父 grant，而是由当前 orca node 用自己持有的父 grant 派生一张新的 SignedGrant（绑定自己的 task 与 `target_orca_node`，`chain` 追加当前跳）——这就是“继承”。因为派生只能从父 grant 里取子集，`permission_mode` 不高于父 grant、`limits` 不宽于父 grant、`expires_at` 不晚于父 grant，所以结果必然收窄，不需要额外一步“裁剪”。父 grant 的 `task_id`/`target_orca_node` 绑定的是上一跳，原样转发给下一跳本来就会被 target 校验拒绝（既无效，也让审计失去“谁批给谁”）。
- **请求逐跳上升**：`via` 只追加、不改写；每跳把自己的 `expires_in_s` 减一档，避免“最后一秒批下来、下游已超时”。任一跳超时 → 该跳 deny，逐跳向下传 `failed(permission_denied)` 或 `failed(permission_timeout)`。
- **等待不占槽**：C 与 B 都停在 `input-required`（槽位释放）；A 长期无人 → 链上各级超时失败，不会挂住 B 或 C。
- **环靠祖先禁调阻断，不靠深度上限**：链可以任意长（workgroup 就是几台机器），但子任务不能指向 `chain` 里的任何 orca node 或自身（[§5.1](05-tasks.md#51-任务标识与元数据)）；长链由每跳超时与 task TTL 兜底。
- **根 A 的卡片必须显示来源链**：否则人只看到“C 要写 /etc”，不知道是 B 代“B 转述的 C”在问。

Phase 3 先只做“逐跳上升 + 逐跳收窄”，不做 B 的自动放行；等链式任务实际跑过，再决定要不要给中间节点 `auto_approve_within_grant` 开关。

### 7.13 目标侧硬拒绝清单

硬拒绝 = 与权限模式、grant 都无关，永远不执行（除非人坐在 target 前、在本地显式解除）。这个清单刻意很短：它只保护“做错了就救不回来”和“做完就再也管不了这台机器”的操作。

- 磁盘与引导：分区、格式化、`diskpart`/`mkfs`/`dd` 写裸设备、改引导项；
- 关安全软件、清审计日志、改系统时间同步源；
- 改本插件自己的配置与凭证（`<profile>/plugins/pod/`），以及 DSH 的凭据存储——防止远程把自己锁死或把密码读走。

除此之外**不再硬拒**：

- `~/.ssh`、`~/.aws`、`~/.config/gh`、浏览器 profile 等 → 允许，但默认走 escalate 由 origin 批准（[§7.15](07-security.md#715-凭据回传与注入防护)）；
- 装包、改服务、配防火墙、跨系统实验 → 允许，按继承的 mode 与 grant 执行；
- 后台常驻进程 → 允许，但必须登记 PID 与清理方式，否则任务结束时按进程树清理。

### 7.14 ACP `request_permission` 映射

| 继承 mode | 请求的操作 | 结论 |
|---|---|---|
| `read-only` | 读 / 只读命令 | `allow` |
| `read-only` | 写 / 变更类执行（装包、改配置、起服务） | `escalate` → 回 origin（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)） |
| `workspace-write` | 工作区内写 | `allow` |
| `workspace-write` | 工作区外写 / 提权命令 | `escalate` |
| `danger-full-access` | 任意 | `allow`，除 [§7.13](07-security.md#713-目标侧硬拒绝清单) |
| 任意 | 命中 [§7.13](07-security.md#713-目标侧硬拒绝清单) | `deny`（原因写进 task error） |
| 任意 | 无 grant | `deny(missing_grant)` |

实现方式：AcpExecutor 把 ACP 的 permission 请求交给网关策略层，策略层返回三态；`escalate` 时先不回复 ACP（挂起该步），等 origin 的后续 message 到达后决定 `allow`/`deny`。挂起有超时（`expires_in_s`），超时按 `deny` 收尾，避免 ACP 侧永久悬挂。

### 7.15 凭据回传与注入防护

远程 orca node 上经常有 key：`~/.ssh/id_ed25519`、`~/.config/gh/hosts.yml`、`.env`。两种需求同时存在——**要能取回**（开发调试），**又不能被一句话骗走**（prompt injection 的典型外泄路径）。所以做成显式策略，而不是硬规则：

| 配置 `credential_readback` | 行为 |
|---|---|
| `deny` | artifact 里出现凭据类内容 → 拒发，任务标 `failed(credential_blocked)` |
| `ask`（默认） | 检出凭据类内容 → 任务挂 `input-required`，origin 卡片问“是否回传”，人点 |
| `allow` | 直接回传 |

检出靠三层：文件路径模式（`*.pem`、`id_*`、`.env*`、`known_hosts`）、内容模式（私钥头、AKIA/ghp_ 前缀、长 base64 高熵串）、以及 agent 主动标注。

另外两条与开关无关的规则：

- **origin 不自动执行回传内容**：拿回来的文本进 artifact，不进下一轮 prompt，除非人明确引用；
- **审批卡片永远显示原文**（转义后），不显示模型复述——防的是“模型说这是无害的”。

---
