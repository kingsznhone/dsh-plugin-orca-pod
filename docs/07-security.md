# 07 安全与权限

> 本章描述信任边界：workgroup 与密码、请求签名、TLS 部署、不可信输入，以及权限如何跟随发起 orca node。

## 7. 安全与权限

### 7.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**必填**，最短 12 字符；UI 默认生成 24 字符随机串（`base64url`），并提供复制/二维码。空密码在局域网上等于“任何人可派任务”，没有安全的默认。
- 密码不入库明文：首选系统钥匙串引用；退而求其次才在插件配置里存 `HKDF` 派生密钥（文件权限 0600）。存派生密钥的代价是：配置文件泄露 = 直接获得签名能力，所以推荐前者。
- 日志、配置文件、错误信息里都不出现密码或派生密钥。
- 密钥派生：

```text
k = HKDF-SHA256(ikm = password, salt = "orca-pod", info = workgroup_id, len = 32)
```

- 换密码：**改过的 orca node 用新密码重启，重新 join 组成新 group**；没改的 orca node 留在旧 mesh 里，签名对不上就 401/offline，等于被移出（[§7.3](07-security.md#73-密钥与密码的分发)）。没有“过渡期双密码”，也不需要集中式踢人。

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

`trust_proxy`：只有配置了 `127.0.0.1` 才读 `X-Forwarded-For/Proto`，否则一律用 socket 地址。

### 7.5 远程任务是不可信输入

- 任务 prompt、artifact 内容、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 审计记录：谁（origin_orca_node）、何时、对哪个任务/工作区、用了什么 mode、批了什么。

### 7.6 授权矩阵

不是“同 workgroup 就能跑一切”。每个 orca node 维护：

| 维度 | 默认 | 可配 |
|---|---|---|
| 谁能派任务 | 同 workgroup 的任意已加入 orca node | 按 orca_node_id 白名单 |
| 权限上限 | 继承 origin 会话 mode | 本机可再降一档 |
| group workspace 可见性 | 同 workgroup | 仅本机 |
| 任务/产物读取 | 同 workgroup 凭 id | —（无 per-task / per-blob ACL） |
| 任务接续 | 同 workgroup，且来源 task 已终态 | — |
| 硬拒绝 | [§7.13](07-security.md#713-目标侧硬拒绝清单) | 仅本机人类解除 |

### 7.7 SSRF / 候选端点防护

- 候选端点在拨号前校验：拒绝回环、`0.0.0.0`、组播、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`::1`、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；公网地址需要 `allow_public_peers: true`；
- 探测失败按 `recover_probe`（15s→30s）退避；候选探测单独计数，防止被当作端口扫描器。

### 7.8 审计

- 落盘 JSONL，按天轮转；字段：`ts, actor_node, action, target, result, task_id, grant_id`；
- 审计文件不放在 group workspace 里；
- `permission_request` 全文入审计（脱敏后），便于事后回答“它当时要什么”。

### 7.9 权限跟随发起 orca node

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；会话能写工作区，远端就只能写工作区；
- 需要更多权限时，target 通过 A2A 把请求送回 origin，由人在 origin 的卡片上决定。

这条前提排除了两种设计：target 本地审批（无人应答、任务挂死）和 target 自由裁量（origin 无法预期远端能做什么）。

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

#### 链式调用：授权向下收窄，升级向上回传

链 A→B→C 里，如果让 B 直接批准 C 的越界请求，A 的授权就被一个 agent 转授放大了。规则只有一条：**每个 task 的 origin 只能在自己拿到的 grant 范围内放行；超出一律上升，直到有人的那个 orca node，通常是根 A。**

为什么不是 B 自主决策：

- A 给 B 的 grant 表达的是 A 的意图（比如“B 可以在工作区写”），B 批准 C 写 `/etc` 不在这个意图里——B 的“同意”不是人的同意；
- B 也没有能力替 A 扩大授权：它没有 A 的 UI、没有人类动作，自批等于把授权链悄悄放宽；
- 唯一例外：A 明确给了 B `danger-full-access`（用户已接受该风险），或 B 本地预授权策略命中。此时 B 可自行放行，但审计记 `decided_by: "orca_node:<B>:policy"`，A 的 task 里也能看到一条“B 自动批准了 C 的请求”事件。

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

- **grant 逐跳收窄**：sub-grant 的 `permission_mode` 不高于父 grant、`limits` 不宽于父 grant、`expires_at` 不晚于父 grant，`chain` 追加当前跳；审计能回答“谁批给谁、绕过几跳”。
- **请求逐跳上升**：`via` 只追加、不改写；每跳把自己的 `expires_in_s` 减一档，避免“最后一秒批下来、下游已超时”。任一跳超时 → 该跳 deny，逐跳向下传 `failed(permission_denied)` 或 `failed(permission_timeout)`。
- **等待不占槽**：C 与 B 都停在 `input-required`（槽位释放）；A 长期无人 → 链上各级超时失败，不会挂住 B 或 C。
- **链深有界**：`max_hop` 默认 0（链式默认不开）；打开后 `via` 长度 ≤ `max_hop`，超过即 deny（[§5.1](05-tasks.md#51-任务标识与元数据)）。
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
| `allow` | 直接回传，仅审计 |

检出靠三层：文件路径模式（`*.pem`、`id_*`、`.env*`、`known_hosts`）、内容模式（私钥头、AKIA/ghp_ 前缀、长 base64 高熵串）、以及 agent 主动标注。

另外两条与开关无关的规则：

- **origin 不自动执行回传内容**：拿回来的文本进 artifact，不进下一轮 prompt，除非人明确引用；
- **审批卡片永远显示原文**（转义后），不显示模型复述——防的是“模型说这是无害的”。

---
