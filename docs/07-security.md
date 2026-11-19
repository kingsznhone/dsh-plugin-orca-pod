# 07 安全与权限

> 本章描述信任边界：workgroup 与密码、请求签名、TLS 部署、不可信输入，以及权限如何跟随发起 orca node。

## 7. 安全与权限

### 7.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**必填，不可为空**；没有最短长度检查，建议至少 12 字符。面板向导强制填写，保存空密码会被拒绝；没有 workgroup 或密码时节点保持未配置、不启动、不监听——`scrypt(password = "")` 是公开常量，等于没有准入控制。**密码用来证明“此刻在组内”**：每个节点间请求的头里都带一个由它派生的 HMAC 证明（[§7.2](07-security.md#72-请求签名没有-session-token)）；请求与答复的签名用节点自己的 Ed25519 私钥（[§2.4](02-model.md#24-orca-node-身份ed25519-公钥)）。
- **密钥派生**（内存困难，每次启动付一次代价，只在内存里）：

```text
k = scrypt(password, salt = "orca-pod\0" + workgroup_id, N = 2^15, r = 8, p = 1, len = 32)
```

  `proof` 是 HMAC，输入（方法、路径、body 摘要、ts、nonce、workgroup_id……）都是明文；明文 HTTP 上嗅到一个请求就能离线跑字典。scrypt 每次猜测要 ~32 MiB 内存与 ~100 ms，把爆破成本抬到数量级之上。仍然没有按 IP 限速（要限速在代理层做）——scrypt 只抬高单次猜测成本，弱口令仍应避免。
- **机密只在 DSH 凭据库，派生物只在内存**（一台机器一个节点，所有 profile 共用，[§9.2](09-implementation.md#92-面板)）：

  | 机密 | 存在哪 | 怎么用 |
  | --- | --- | --- |
  | workgroup 密码 | `ctx.credentials` 的引用 **`ORCA_POD_PASSWORD`**（固定名字，整台机器一份；凭据库里没有值时依次回落到启动环境变量与 `.env`，无头宿主可以直接导出同名变量） | `Pod` 启动时读一次，派生出 workgroup key 交给 `Orca`；**key 只在内存里，不写进任何文件** |
  | 节点私钥（Ed25519） | `ctx.credentials` 的记录 **`credentialKey('orca-pod', 'node')`** → `{ kind: 'grant', payload: { ed25519: <base58 私钥种子> } }` | 启动时读出；不存在就用 `modifyRecord` 生成并写入（写入时独占，同时启动的两个进程得到同一把钥匙）。公钥由私钥推导；记录损坏时启动失败并点名，**不会**悄悄生成新身份 |

  `<data_root>`（固定为 `$DSH_HOME/orca-pod`）里没有任何机密：只有设置文件 `settings.json`、SQLite、工作区与 `state/`。插件配置（profile 的 `cordis.patch.yml`）只有一个字段 `skill_injection`，设置也不在里面（[§9.2](09-implementation.md#92-面板)）。面板读到的配置视图永不返回密码（也没有 `password_set` 之类的标志）。外部改了这两个名字（DSH 设置页、`.credentials.yaml`、另一个 DSH 进程）会触发 `credentials/reference-updated` / `credentials/record-updated`，节点排队重启一次用上新值。
  执行任务的 agent 与节点是同一个 OS 用户，**不做密钥隔离**；“任务里不能再派任务”是非对抗性约束（[§7.9](07-security.md#79-权限跟随发起-orca-node)），防的是守规矩的 agent 走偏，不防有意绕过。
- DSH 插件默认 `bind_host: "127.0.0.1"`，bundle 不携带任何 workgroup/密码：首次启动必须先在面板向导里完成 setup（workgroup、密码、监听地址）。向导默认仍选 loopback，只有显式选择 LAN 地址或 `::` 才接受 peer——同网段访问是运维的显式决定，不是默认。认证靠两样证明；不支持无密码的开放 mesh。需要更严格时保持 loopback 并让流量只走代理。
- **换密码**：**改过的 orca node 用新密码重启组成新 group**（节点私钥在凭据库，节点 id 不变）；没改的 orca node 留在旧 mesh 里，**下一个请求**的 workgroup 证明就对不上（`401 bad_proof`），双方互相丢弃，等于被移出（[§7.3](07-security.md#73-密钥与密码的分发)）。没有“过渡期双密码”，也不需要集中式踢人。
- **身份 = Ed25519 公钥**：`orca_node_id` 就是节点公钥，每个请求由本节点私钥签名，接收方用公钥验签——签名能证明“谁在调用”，伪造不了。密码不参与签名，只补上“此刻在组内”这一条。
- **两样证明各管一件事**：只有签名，陌生人生成一把 Ed25519 密钥同样能签出合法格式的请求；只有密码，组内任一成员就能冒充另一个成员。所以每个节点间请求同时带两样，且**成员表不管准入**：成员表只决定谁在线、往哪里拨，请求被接受与否只看两样证明。
- **面板跟 DSH web 的登录走，不依赖节点签名**：面板的 `/orca-api` 由 DSH web server 承接，准入交给 DSH 的 `ctx.connection.admit`（`Host`/`Origin` 信任 + 签名的浏览器会话 cookie，`401 unauthorized` / `403 forbidden`），只放行 owner 身份；之外要 `X-Orca-Pod` 头（`403 cross_origin`），非 GET 且无 JSON `Content-Type` 时为 `403 json_required`。能登录 DSH web 的人本来就能让 agent 执行命令，面板不比它多暴露什么，所以远程访问 DSH web 时面板一样可用。文件 blob 的登记没有 HTTP 路由，只有本节点自己的代码写本机 SQLite（[§5.6](05-tasks.md#56-文件交换blob-通道)）。
- **目录不能改写已知成员**：他人目录里的条目只是“我还知道这个人”的提示，只用于把从未见过的 `orca_node_id` 加为候选端点；已存在记录的端点/显示名/runtime 只接受该节点本人签名的 `hello` 更新，否则任一成员都能把别人的流量重定向到自己。
- **答复由应答方签名**：每个给签名请求的答复都带 `Pod-Reply`，签名覆盖**请求的 nonce、status 与 body 的 sha256**；发起方统一验：已知节点的答复必须由它签名，首次接触时签名者的 id 就是 TOFU 记下的身份。答复被改、被挪去答别的请求、或来自另一个节点，一律按 `peer_error` 处理。流式的文件下载事先算不出 body 摘要，签名只覆盖 status 与 `blob_id`，收完后按内容的 sha256 校验（文件本来就按 sha256 命名）。**内容仍是明文传输**：这里保证完整性与来源，机密性由前置代理的 TLS 承担。
- **未认证请求只允许小 body**：认证发生在 body 解析之后、schema 校验之前，所以全局 `bodyLimit` 是 1 MiB，没有任何路由放宽；陌生人最多让服务端缓冲 1 MiB。
- **不存在隐式接触**：出站调用不认识的节点时直接 `unknown_peer`，只有种子地址（设置里的 `peers`、记住的 peers、`connect` 工具、面板）才会向陌生地址发出请求（[§4.7](04-transport.md#47-方法与异步语义)）。
- **授权按记录归属，不按签名身份**：读接口允许同组成员读；写操作在记录归属上校验——`tasks/cancel` 与恢复（`message/send` 带 `taskId`）只接受 task 的 origin（或本机自己），其他成员 `403 not_task_origin`。

### 7.2 请求签名（没有 session token）

每个节点间请求在 `Authorization` 头里同时带 **Ed25519 签名**与 **workgroup HMAC 证明**，输入相同；服务端用 `id`（即公钥）现验签名，用派生密钥验证明：

```http
Authorization: Pod id=<base58 public key>; wg=<workgroup_id>; target=<receiver orca_node_id>; ts=1763100000000; nonce=<base64url>; sig=<base64url>; proof=<base64url>
```

```text
输入  = "orca-pod/request|" + METHOD + "|" + target_orca_node_id + "|" + url_with_query + "|" + sha256_hex(body) + "|" + ts + "|" + nonce + "|" + workgroup_id
sig   = Ed25519(identity.private_key, 输入)
proof = HMAC-SHA256(k, 输入)            // k 是上面的 scrypt 密钥
```

`ts` 是毫秒时间戳。`target` 是**接收方**的 `orca_node_id`，`url_with_query` 是请求路径连同查询串。目标是让请求不能被“换一个收件人重放”、也不能被代理在查询串上做小动作。域分离标签 `orca-pod/request` 把这种签名和答复的签名隔开。答复的签名见 [§7.1](07-security.md#71-workgroup-与密码)：`Pod-Reply: id=<应答方>; sig=<Ed25519("orca-pod/reply|" + 请求 nonce + "|" + status + "|" + sha256_hex(body))>`。

校验顺序（`preValidation` 钩子里，先于 schema 校验）：

1. `Authorization` 能解析、`id` 是合法公钥、`wg` 是合法 workgroup id（否则 `missing_auth` / `malformed_auth`）；
2. `ts` 与本地时间差 ≤ 60s（`clock_skew`，时钟漂移单独报错，别混进 401）；且 `ts` 不早于本进程启动时刻（`stale_request`，重启后拒绝重启前的签名重放）；
3. `target` 等于本机 `orca_node_id`（唯一的例外是 `hello`：首次接触时发起方还不知道接收方 id，允许空 `target`），否则 `wrong_target`；
4. `wg` 等于本机的 workgroup（`workgroup_mismatch`）；
5. 用 `id` 对应的公钥验 `sig`（改动方法/`target`/路径/查询串/body/`ts`/workgroup 都会 `bad_signature`）；
6. 验 `proof`（`bad_proof`）——在验签之后，所以只有真实存在的节点才能让对方知道“密码错了”；
7. `nonce` 未在 5 分钟窗口内出现过（每 orca node 的进程内 LRU，容量 10k，`nonce_replay`）。

没有第 8 步“查成员表”：两样证明都对就进路由。`/health` 不签。

性质与代价：

- **无状态**：服务端不存 token，不需要清理、不需要刷新、不需要 TTL；
- **密码即准入凭证**：密码泄露 = 对方可以加入组（能发现成员、发任务），但**不能伪造已有节点的请求**（每个节点用自己的私钥）。密码强度与分发仍是入组的安全边界；
- **撤销**：私钥在凭据库，删掉它就从 mesh 消失；把某节点踢出组则要换密码重建 group：旧节点的请求签名本身仍有效（Ed25519 与密码无关），但 workgroup 证明过不了，**下一个请求**就被拒，双方互相丢弃（[§7.3](07-security.md#73-密钥与密码的分发)）；
- **重放窗口**：60s + nonce 去重 + 重启拒绝；跨 orca node 时钟必须大致同步（NTP）；
- **同组内的定向往返**：签名绑定接收方 id 与完整 URL，因此 A 发给 B 的请求不能被转发给 C、也不能被代理换掉查询串参数；代价是所有出站调用都要先知道对方 id（调用的就是那个节点对象，id 不用反查）；
- **代理友好**：签名覆盖 method/url（含 query）/body，代理改写 body 或查询串会验签失败（这是特性）；路径大小写、百分号编码也要求前后一致。

### 7.3 密钥与密码的分发

- 推荐：`workgroup_id` + 密码通过带外通道给（人当面、密码管理器、私聊），不放进任何仓库；
- 面板向导接收明文密码，交给 DSH 凭据库保存（见 [§7.1](07-security.md#71-workgroup-与密码)）；没有别的入口，也没有命令行安装器；
- 轮换（“解散再重建”，是特性不是缺陷）：
  1. A 改密码并重启监听 → A 的每个请求的 workgroup 证明换成新密码，旧成员收到的下一个请求就是 `401 bad_proof`，把 A 丢弃，A 也把旧成员丢弃；
  2. B 也改成同一新密码、重启、`hello` A → 新 group 成立（此刻 A、B 互见）；
  3. 没改密码的 C 留在旧状态：它能拨 A，但证明验不过，401 后被 A 丢弃且 A 也把 C 丢弃——既进不来也不再显示在线；
  4. 想恢复 C，就把它的密码改成新的、`hello` 任意一个新成员。
- 结论：整个过程不需要“踢人接口”，也不需要维护黑名单——**密码就是成员资格**。

### 7.4 TLS 部署矩阵

| 场景             | 方案                          | 要点                               |
| ---------------- | ----------------------------- | ---------------------------------- |
| 局域网/VPN       | 明文 HTTP                     | 密码是唯一门槛；确保网络本身可信   |
| 公网单 orca node | Caddy `reverse_proxy` + 域名  | 自动证书；orca node 只听 127.0.0.1 |
| 公网多 orca node | Caddy/nginx 各 orca node 一套 | 证书可集中签发                     |
| 零信任           | Tailscale/WireGuard           | 网络层隔离，orca node 仍要密码     |

节点不读转发头：既不用 `X-Forwarded-For` 判断“是谁”，也不用它判断“是不是本机”。面板入口不看转发头：经反向代理访问时，浏览器地址的主机名要列进 DSH `client-connection` 配置的 `trustedHosts`（这是 DSH 自己 `/api` 的规则，面板沿用）。TLS 由前置代理终结，节点自身只监听明文 HTTP（[§4.2](04-transport.md#42-路由表)）。

### 7.5 远程任务是不可信输入

- 任务 prompt、结论文本、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- **目标侧**：任务书里节点自己的前言永远在最前，远端任务正文放进显式的 `<untrusted-task-input>` 块并排在最后（正文里伪造的结束标签会被转义；`src/task/prompt.ts` 的 `composePrompt`，[§6.7](06-execution.md#67-工作区一份持久)）；正文里的文件名只是数据，取不取由 agent 在本任务的权限模式下决定；
- **origin 侧**：tracker 通知只给状态/原因，远端结论放进 `<untrusted-remote-result>` 块并截断到 800 字符（结束标签转义），并提示 agent 用 `orca_pod` 的 `status` 自己拉全文；权限请求不进对话，面板卡片只显示 `requested` 的 160 字符预览（`src/plugin/tracker.ts`、`panel.ts`）；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 可观测：谁（origin_orca_node）、何时、对哪个任务、用了什么 mode——留在任务记录与派发日志里（`tasks/get`、面板的“全部任务”），不另落一份审计文件。

### 7.6 授权矩阵

“同 workgroup”不等于“能做一切”，但也没有细粒度策略：

| 操作                                   | 谁能做                                                     | 依据                                  |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| 派任务（`message/send` 新建）          | 同 workgroup 的任意 orca node                              | 两样证明；不做按 `orca_node_id` 的白名单 |
| 读任务 / 读 blob                       | 同 workgroup 凭 id                                         | 无 per-task / per-blob ACL            |
| 取消、恢复（批准/拒绝/补输入）         | 只有 task 的 origin（及本机自己）                          | `403 not_task_origin`                 |
| 面板 API（`/orca-api`）                | DSH web 的 owner 会话（`connection.admit`，不验节点签名）  | `401 unauthorized` / `403 forbidden` / `403 cross_origin` / `403 json_required` |
| 权限上限                               | 继承 origin 会话的 mode，本机 `permission_mode` 可再降一档 | [§7.10](07-security.md#710-权限模式继承) |
| 工作区                                 | 整个 workgroup 共用一份                                    | [§6.7](06-execution.md#67-工作区一份持久) |
| 登记本机文件为 blob                    | 只有本机：宿主的 `orca_pod` 在进程内登记；任务里的 `orca_pod` 经本地路由（`local`：本节点的令牌，D46） | 没有成员可用的路由 |

不做按节点的派发白名单：同组即可派任务。权限请求改为请求升级权限模式的方案见 [§11](11-open-questions.md#11-未决问题)。

### 7.7 SSRF / 候选端点防护

- 候选端点（从别人目录里学到、尚未直接 `hello` 过的）在拨号前校验；种子地址（设置里的 `peers`、记住的 peers、`connect`、面板）不在此列；
- 恒定拒绝：`0.0.0.0`/`::`、组播与保留段（≥ 224.0.0.0）、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；**回环默认允许**（同机多进程是常见部署），可用 `allow_loopback_peers: false` 收紧为拒绝；公网地址需要 `allow_public_peers: true`；
- 主机名先解析、再按**所有**解析结果判断，解析失败即拒；判定结果只缓存 60 秒，过期重新解析；被拒的候选只 warning 一次，不进 online，计作一次拨号失败，连续 5 次后删除（[§3.5](03-membership.md#35-候选端点与墓碑)）；
- **入站 `hello` 自报的端点**在登记前筛查：恒定拒绝的地址剔除；回环地址只在请求本身经回环到达时接受（远端机器不可能在我的 127.0.0.1 上）；公网地址可以（对方已证明持有密码）；解析不出来的主机名保留；一个都不剩 → `400 endpoint_refused`；
- **不跟随重定向**：出站请求带 `redirect: "manual"`，3xx 按失败处理，签名请求不会被弹到别的地址；
- 已知残余：校验与 `fetch` 各自解析一次 DNS，两次之间改答案（DNS rebinding）的窗口仍在。

实现：`OrcaNode`（`src/mesh/orca-node.ts`）记着自己的 `origin: "explicit" | "candidate"`（`hello` 登记 → explicit；只从目录 merge 进来 → candidate）与拨号状态；`EndpointScreen`（`src/mesh/screening.ts`，一个 orca 实例一份，在 `MeshContext` 里）缓存两类筛查结论——候选端点按节点自己的策略（`OrcaNode.dialOrder` 只在拨号 candidate 前筛查），入站 `hello` 自报的端点按显式接触的策略；`screenEndpoint` 是纯策略。心跳循环与种子重试在 `Mesh`（`src/mesh/mesh.ts`）。

### 7.8 审计

- **不做持久审计落盘**（局域网自用，[§10.5](10-roadmap.md#105-phase-4规模化与部署)）：任务记录、`dispatches` 派发日志与 DSH 会话记录已经能回答“谁在什么时候派了什么、结果如何”，额外一条审计通道收益低、维护成本高。
- 排查靠现有记录：origin 的派发日志（`dispatches` 表，面板的任务列表）、`tasks/get` 的任务状态与 `reason`、插件 tracker 的通知文本；`permission_request` 全文留在任务状态里，便于事后回答“它当时要什么”。
- 真要合规审计属于部署层外挂（代理访问日志 + DSH 会话留档），不在插件内实现。
- 网关状态（`<data_root>/state/<workgroup_id>/`）放在 workgroup 根之外：agent 对 cwd 有写权限，看得见就能删（[§6.7](06-execution.md#67-工作区一份持久)）。
- 面板 API（`/orca-api`）的闸门见 [§9.2](09-implementation.md#92-面板)：DSH 的浏览器准入（Host/Origin 信任防 DNS rebinding 与跨站，会话 cookie 认人）+ owner 身份 + `X-Orca-Pod` 头（同站页面也得先过 CORS 预检）。

### 7.9 权限跟随发起 orca node

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；
- 需要更多权限时，target 把请求写进 task 状态（`input-required`），由 origin 的人在自己的 UI 上决定。

**审批面属于发起这个任务的会话，不属于节点**：

| 谁发起的任务                                    | 谁批           | 行为                                                                                                                                         |
| ----------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面 DSH 里的交互式会话（`orca_pod` 的 `send`） | 这台机器上的人 | tracker 留着权限请求等 UI 作答：当前会话聊天卡、后台会话弹窗、或面板列表（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)） |

**任务只有一跳**：target 上执行任务的 agent 不能再派任务。ACP 执行器拉起 `dsh --profile acp` 子进程时注入 `ORCA_POD_IN_TASK=1`；acp profile 也装了本插件，插件在任务进程里见到它就不启动节点，`orca_pod` 只有 `fetch` 与 `publish` 两个方法（经本机节点收发文件，[§5.6](05-tasks.md#56-文件交换blob-通道)），没有 `send`；做不完用 `BLOCKED:` 结论交回 origin（[§6.14](06-execution.md#614-acpexecutor)）。所以审批面永远是派发任务的那个会话，不存在“替下游上交”的中间节点。

这是**非对抗性约束**：agent 与节点同一个 OS 用户、读得到私钥（[§7.1](07-security.md#71-workgroup-与密码)），存心绕过的 agent 可以去掉环境变量、自己签请求，或拿环境里的本地路由令牌直接调本机节点。它挡住的是守规矩的 agent 因为任务难就转手、以及因此带来的协议复杂度（祖先链、批准转发、逐跳上交）。要硬边界，得在部署层把执行器放到另一个 OS 用户或沙箱里。

### 7.10 权限模式继承

origin 发起任务时携带会话的 permission mode（`metadata.pod.permission_mode`），target 按它执行：

- **继承**：`orca_pod` 的 `send` 默认从 DSH 的 `sandboxPolicy` 服务读当前会话的 sandbox 模式（`ctx.sandboxPolicy.resolve({ session }).mode`，其 `SandboxMode` 与本报文的三档同名）；工具的 `permission_mode` 参数只能比会话模式**更窄**，更宽的直接报错（要更宽就由 target 在需要时请求升级，[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）；读不到会话模式时按 `read-only`。
- **没继承到**（元数据没带 mode）：target 按 `read-only` 执行。
- **本机上限**：`permission_mode` 设置（面板高级设置）是本机上限，生效模式 = 上限与继承值中较窄的一个；没配上限就用继承值。继承只能降；任务运行中可以经 origin 批准**升级**，但永远不超过本机上限（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。
- **模式阶梯**：宽窄顺序用 DSH 的 `WIDER_MODES`（`read-only` → `workspace-write` → `danger-full-access`），本包不自己排序。
- **执行**：target 并不把模式传给 `dsh` 子进程；约束完全来自对 ACP `session/request_permission` 的应答规则（[§7.14](07-security.md#714-acp-request_permission-映射)）。

| 生效模式             | 含义                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `read-only`          | 自动放行读/搜索/思考类请求；其余请求升级（本机上限不允许时自动拒绝）                         |
| `workspace-write`    | 自动放行读写类请求：`edit`/`delete`/`move`/`execute`；**不校验路径是否在工作区内**；其它类型请求升级到 `danger-full-access` |
| `danger-full-access` | 全部自动放行，没有额外限制                                                                   |

起始 mode 随任务元数据一起签名传递，target 校验签名后再执行，中间人改不了；升级后的 mode 是 target 自己挂起的请求里的 `requested_mode`，origin 的批准只是对那次请求的答复（[§7.11](07-security.md#711-批准与拒绝)）。两者都只对这一个任务有效，任务结束即失效，下一个任务重新从继承的 mode 开始。

### 7.11 批准与拒绝

origin 对一次升级请求的答复，是对**同一 task** 的一条恢复 `message/send`（`message.taskId` 为该 task）。消息只有一个 data part，是下面两者之一（`resumeControlOf`，`task/wire.ts`）：

```json
{ "permission_granted": true, "request_id": "<被批准的请求 id>" }
{ "permission_denied": true, "reason": "<拒绝原因>" }
```

两者同时出现时拒绝优先；`reason` 不是文本时按 `denied by origin`。批准没有单独的签名记录：恢复请求本身就是 [§7.2](07-security.md#72-请求签名没有-session-token) 的 Ed25519 + HMAC 签名请求（绑定 target、路径、body 与 nonce），origin 的身份与消息的完整性由它担保。人批的是“这个任务升到这一档”：档就是挂起的请求里的 `requested_mode`（target 发请求时已按本机上限算过），批准不带别的字段，origin 改不了档。

target 收到恢复消息后按顺序校验（`SingleSlotTaskRunner.resume`），任一不符就拒绝这条消息：

1. 任务存在（否则 `404 task_not_found`），且还在运行、没有终态（否则 `400 bad_request`）；
2. 调用者就是该任务的 origin（`403 not_task_origin`）——别的成员的恢复消息不算数；
3. 任务处于 `input-required`（否则 `400 bad_request`）；
4. 槽位空闲（`429 orca_node_busy`）：挂起的任务让出了槽，恢复时重新竞争（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）；
5. data part 是批准或拒绝（纯文本等其它内容 → `400 bad_request`，任务不变）；
6. 批准的 `request_id` 等于任务挂起的那次请求的 id（否则 `400 bad_request`，**任务不失败、继续等**）。

通过后：批准 → 任务用 `requested_mode` 跑到结束，只对这一个任务有效；拒绝 → 任务 `failed(permission_denied)`，`status.message` 为 `permission denied: <reason>`。

其他：

- **重放**：靠每个请求都有的 nonce 缓存、时间窗与 `stale_request`（重启前签的请求不再被接受，[§7.2](07-security.md#72-请求签名没有-session-token)）挡住原样重发；对同一次请求的第二次批准会发现任务已不是 `input-required`，或已停在新的请求 id 上（旧 id → `400 bad_request`），不会放行第二次。没有单独的“已用批准”集合；
- 批准与拒绝都不持久化，也没有“取消时吊销”这一步：升级随任务结束而失效（重启时任务本来就都失败了）；
- 答复见 [§7.12](07-security.md#712-升级回路任务状态不是反向调用)：只有 origin 节点的 `approve` / `deny`（`OrcaNode`）发出它。

### 7.12 升级回路：任务状态，不是反向调用

```text
target: 执行器收到一次生效模式之外的权限请求
  → 按 DSH 的 WIDER_MODES 找能放行它的最窄一档；超出本机上限 → 直接拒绝这次调用，不打扰人
  → 任务运行器（不是 agent）把 task 置为 input-required、释放槽位
  → 结构化 permission_request 写进 task 的 status.message（data part）
  → 连接结束。target 不拨 origin，不新建任何到 origin 的请求：

    {
      "request_id": "<uuid>",
      "task_id": "<target 上的 task>",
      "tool": "write_file",
      "requested": { "tool_call_id": "…", "tool_kind": "edit" },
      "requested_by": "<需要权限的 orca node，即 target 自己>",
      "current_mode": "workspace-write",    // 任务现在的模式
      "requested_mode": "danger-full-access"  // 请求升到的模式
    }

origin: tracker 的下一次 tasks/get 看到 input-required
  → tracker 留着等 UI 作答（不往 agent 对话里塞原始文本）
  → UI 三落点：正在看的会话里贴聊天卡；后台会话弹窗；面板 Pending approvals 列表
  → 批准：origin 发同一 task 的后续 message，data part 为 { permission_granted: true, request_id }；
    target 校验后把这个任务的模式升到 requested_mode、放行这次调用，之后同类操作按新模式自动应答，不再询问
  → 拒绝：发后续 message，data part 为 { permission_denied: true, reason }，target 把 task 置 failed(reason=permission_denied)
  → 默认不超时（人可能不在）；挂起期间任务 TTL 暂停，只要没人答复，任务就一直停在 input-required
```

要点：

- **这不是反向调用。** 全设计只有 origin → target 一个方向；target 没有 origin 的地址，也不需要。所谓“送回 origin”只是把请求写进 task 状态，等 origin 来读。
- **任务记录是唯一权威载体**：`permission_request` 必须能只靠 `tasks/get` 拿到；origin 重启、停轮询后恢复，都读得到同一份。
- 补发的答复是**同一 task 的后续 message**（带 `taskId` + 批准或拒绝的 data part），不是第二个任务，也不是独立的审批端点；只有 origin 能发。
- **权限请求只在 tracker 一处，UI 是唯一的答复通道**：`orca_pod` 工具没有 approve/deny 方法（方法只有 `send`/`status`/`cancel`/`members`/`connect`/`publish`/`fetch`），所以模型无法替用户批准。批准/拒绝按钮直接调 `OrcaNode.approve/deny`，不经过模型与工具轮次。
- **权限请求不产生聊天 notice**，也不唤醒 agent；UI 三个落点共用同一个 broker 与同一条决议通道：**当前正在看的会话**里贴一张聊天卡（`conversation.input.dock`，按发起任务的会话 id 匹配）；**后台会话**的请求在框内弹窗（`shell.overlay`）；**面板** Pending approvals 列表可随时签发。任务终态或不再挂起时，卡片自动收回。
- 卡片显示：需要权限的节点、触发升级的工具与 `requested` 的预览、以及“本任务改用 X 运行到结束（当前 Y）”；远端文本当纯文本渲染，不当 HTML。
- `decided_by` 必须来自 UI 的人类动作，不能由模型自批；origin 端是唯一能产生“用户同意”的地方。

- **agent 这一侧不做任何事**：权限请求来自 ACP 的 `session/request_permission`，由执行器与任务运行器挂起任务、等待、恢复，agent 只是这次工具调用暂时没有返回；批准后同一个任务、同一轮从卡住的地方继续，拒绝则任务以 `permission_denied` 结束。没有 agent 可调用的“上交”命令。
- **升级只对这一个任务有效**：中断、授权、继续都发生在同一个任务上，所以升级随任务结束失效；同一会话上下文的下一个任务重新从继承的模式开始。挂起期间 target 重启，任务以 `node_restart` 失败，升级随之作废。
- **只有一跳**：任务里的 agent 不能再派任务（[§7.9](07-security.md#79-权限跟随发起-orca-node)），所以请求总是直接挂在 origin 派出的那个任务上，批准也总是 origin 对这个任务发的；没有中间节点转发批准，也没有逐跳上交。

### 7.13 目标侧硬拒绝清单

没有。权限请求要么落在 [§7.14](07-security.md#714-acp-request_permission-映射) 的自动应答规则里，要么请求 origin 升级模式；节点不维护与模式、批准无关的“永远拒绝”清单，也不保护自己的配置与凭据目录不被 agent 读写（见 [§7.1](07-security.md#71-workgroup-与密码)）。要限制一台机器能做什么，把本机 `permission_mode` 设成 `read-only` 或 `workspace-write`。

### 7.14 ACP `request_permission` 映射

AcpExecutor 收到 `session/request_permission` 时，用任务当前的生效模式（[§7.10](07-security.md#710-权限模式继承)，可能已被升级）和请求里的工具类别 `kind` 决定（`src/executor/acp/permissions.ts`）：

| 生效模式             | 请求的 `kind`                                          | 结论                                                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `danger-full-access` | 任意                                                   | 自动 `allow`                                            |
| `workspace-write`    | `read` / `search` / `think` / `edit` / `delete` / `move` / `execute` | 自动 `allow`（不校验路径）                |
| `workspace-write`    | 其它（`fetch`、`switch_mode`、`other` 或未标注）       | 请求升级到 `danger-full-access`：不回复 ACP，任务挂起为 `input-required` → origin 决定 |
| `read-only`          | `read` / `search` / `think`                            | 自动 `allow`                                            |
| `read-only`          | `edit` / `delete` / `move` / `execute`                 | 请求升级到 `workspace-write`                            |
| `read-only`          | 其它                                                   | 请求升级到 `danger-full-access`                         |

请求的目标档超过本机上限（`permission_mode` 设置）时，这次调用自动 `reject`，不弹卡；上限内最窄的那一档才是请求的目标。

- 自动应答选 `allow_once`/`reject_once` 选项，没有就选第一个同类选项，都没有则回 `cancelled`。
- 升级请求等 origin 的后续 message：批准 → 回 `allow`，任务改用新模式，排在后面的同类请求直接按新模式放行；拒绝/取消 → 任务终止，所有未答复的请求回 `cancelled`，避免 ACP 侧永久悬挂。挂起本身没有超时。
- 没有“无批准即拒绝”这一条：模式覆盖的请求不需要批准，批准只对升级请求有意义。

### 7.15 凭据回传与注入防护

节点不做凭据检测，也没有回传开关：agent 在它的权限里能读到的文件，就能写进结论文本或 `publish` 出去。防的是另外两件事：

- **origin 不自动执行回传内容**：拿回来的文本放进 `<untrusted-remote-result>`，不进下一轮 prompt 的指令位置（[§7.5](07-security.md#75-远程任务是不可信输入)）；
- **审批由人在 UI 上做**，模型无法自批（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

---
