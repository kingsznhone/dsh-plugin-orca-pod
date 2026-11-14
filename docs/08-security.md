# 08 安全与授权

> 关注：节点之间怎么认证（workgroup + 密码）、请求怎么签名、TLS 怎么部署、谁能读什么、审计记什么、SSRF 怎么挡。
>
> 章节编号沿用全局编号；审批与权限模式在 07-permissions.md。

## 12. 安全与授权

### 12.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**必填**，最短 12 字符；UI 默认生成 24 字符随机串（`base64url`），并提供复制/二维码。
- 密码不入库明文：首选系统钥匙串引用；退而求其次才在插件配置里存 `HKDF` 派生密钥（文件权限 0600）。存派生密钥的代价是：配置文件泄露 = 直接获得签名能力，所以推荐前者。
- 日志、配置文件、错误信息里都不出现密码或派生密钥。
- 密钥派生：

```text
k = HKDF-SHA256(ikm = password, salt = "whale-pod", info = workgroup_id, len = 32)
```

- 换密码：**改过的节点用新密码重启，重新 join 组成新 group**；没改的节点留在旧 mesh 里，签名对不上就 401/offline，等于被移出（[§12.3](08-security.md#123-密钥与密码的分发)）。没有“过渡期双密码”，也不需要集中式踢人。

### 12.2 请求签名（没有 session token）

每个请求自带证明，服务端用同一把 `k` 现验：

```http
Authorization: Pod node_id=N7K3QM; ts=1763100000; nonce=9f2c1a; proof=<base64url>
```

```text
proof = HMAC-SHA256(k, "pod-v1|" + method + "|" + path + "|" + sha256(body) + "|" + ts + "|" + nonce)
```

校验顺序：

1. `ts` 与本地时间差 ≤ 60s（时钟漂移单独报错，别混进 401）；
2. `nonce` 未在 5 分钟窗口内出现过（每节点 LRU，容量 10k）；
3. `proof` 常量时间比较；
4. 通过后按 `node_id` 找/建 peer 记录（首次即登记，见 [§10.2](02-architecture.md#102-引导与加入)）。

性质与代价：

- **无状态**：服务端不存 token，不需要清理、不需要刷新、不需要 TTL；
- **密码即凭证**：密码泄露 = 全组沦陷；所以密码强度与分发是唯一的安全边界；
- **不可撤销单个节点**：密码是全组共享的，想踢人只能换密码并重建 group（[§12.3](08-security.md#123-密钥与密码的分发)）。
- **重放窗口**：60s + nonce 去重；跨节点时钟必须大致同步（NTP）；
- **代理友好**：签名覆盖 method/path/body，代理改写 body 会验签失败（这是特性）。
- **大 body 的签名**：带 body 的请求加 `X-Pod-Body-SHA256` 头，签名覆盖这个摘要而不是把整个 body 读进内存重算一遍；服务端流式落盘后再自校验，不一致即 `400 body_digest_mismatch`。
- **下载可换短期直链**：授权方调 `POST /blobs/{id}/link`，服务端生成一个**不可预测的随机 token**（32 字节，存库，绑定 `blob_id + exp`，TTL 5 分钟），返回 `GET /blobs/{id}?token=...`。浏览器/curl/前端直链不用带长期请求头。token 是服务端签发的，不是本地 HMAC——否则任何持有共享密钥的成员都能自造一条绕过 ACL 的链接。撤销 = 删库行。

`/cluster/join` 用同一种签名；区别只是它同时返回目录。`/health` 不签。

### 12.3 密钥与密码的分发

- 推荐：`workgroup_id` + 密码通过带外通道给（人当面、密码管理器、私聊），不放进任何仓库；
- 插件配置里只存 `workgroup_id` 与钥匙串引用；导出的配置不含密码；
- 二维码/复制按钮只用于本机设备间传递，UI 明确写“这是明文，别发群里”；
- 轮换（“解散再重建”，是特性不是缺陷）：
  1. A 改密码并重启监听 → 旧签名全部失效，A 对旧成员表现为 401，旧成员对 A 表现为 offline；
  2. B 也改成同一新密码、重启、重新 join A → 新 group 成立（此刻 A、B 互见）；
  3. 没改密码的 C 留在旧状态：它能拨 A，但签名验不过，**进不来**；A 也不会把 C 当成员；
  4. 想恢复 C，就把它的密码改成新的、重新 join 任意一个新成员。
- 结论：整个过程不需要“踢人接口”，也不需要维护黑名单——**密码就是成员资格**。

### 12.4 TLS 部署矩阵

| 场景 | 方案 | 要点 |
|---|---|---|
| 局域网/VPN | 明文 HTTP | 密码是唯一门槛；确保网络本身可信 |
| 公网单节点 | Caddy `reverse_proxy` + 域名 | 自动证书；节点只听 127.0.0.1 |
| 公网多节点 | Caddy/nginx 各节点一套 | 证书可集中签发；注意 SSE 缓冲关闭 |
| 零信任 | Tailscale/WireGuard | 网络层隔离，节点仍要密码 |

`trust_proxy`：只有配置了 `127.0.0.1` 才读 `X-Forwarded-For/Proto`，否则一律用 socket 地址。

### 12.5 远程任务是不可信输入

- 任务 prompt、artifact 内容、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 审计记录：谁（origin_node）、何时、对哪个任务/工作区、用了什么 mode、批了什么。

### 12.6 授权矩阵

不是“同 workgroup 就能跑一切”。每个节点维护：

| 维度 | 默认 | 可配 |
|---|---|---|
| 谁能派任务 | 同 workgroup 的任意已加入节点 | 按 node_id 白名单 |
| 权限上限 | 继承 origin 会话 mode | 本机可再降一档 |
| group workspace 可见性 | 同 workgroup | 仅本机 |
| 任务/产物读取 | 同 workgroup 凭 id | —（无 per-task / per-blob ACL） |
| 任务接续 | 同 workgroup，且来源 task 已终态 | — |
| 硬拒绝 | [§9.5](07-permissions.md#95-目标侧硬拒绝清单) | 仅本机人类解除 |

### 12.7 SSRF / hints 防护

- hint 的 endpoint 在拨号前校验：拒绝回环、`0.0.0.0`、组播、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`::1`、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；公网地址需要 `allow_public_peers: true`；
- 失败 3 次退避 5 分钟；hint 触发的探测单独计数，防止被当作端口扫描器。

### 12.8 审计

- 落盘 JSONL，按天轮转；字段：`ts, actor_node, action, target, result, task_id, grant_id`；
- 审计文件不放在 group workspace 里；
- `permission_request` 全文入审计（脱敏后），便于事后回答“它当时要什么”。

---
