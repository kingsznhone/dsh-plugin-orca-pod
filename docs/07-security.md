# 07 安全与权限

> 本章描述信任边界：workgroup 与密码、请求签名、TLS 部署、不可信输入，以及权限如何跟随发起 orca node。

## 7. 安全与权限

### 7.1 workgroup 与密码

- `workgroup_id`：`[a-z0-9][a-z0-9-]{1,31}`，创建时指定，之后不可改（改名 = 新建 workgroup）。
- 密码：**必填，不可为空**；没有最短长度检查，建议至少 12 字符。面板向导强制填写，保存空密码会被拒绝；配置里没有 workgroup 或密码时节点保持未配置、不启动、不监听——`scrypt(password = "")` 是公开常量，等于没有准入控制。**密码只用于组网准入**（`/cluster/join` 与每拍心跳的 HMAC 证明），请求签名与 grant 都用节点自己的 Ed25519 私钥（[§2.4](02-model.md#24-orca-node-身份ed25519-公钥)）。
- **密钥派生**（内存困难，只在创建配置时付一次代价）：

```text
k = scrypt(password, salt = "orca-pod\0" + workgroup_id, N = 2^15, r = 8, p = 1, len = 32)
```

  join/heartbeat 的 `proof` 是 HMAC，输入（workgroup_id、节点 id、ts、nonce）全是明文；明文 HTTP 上嗅到一个心跳就能离线跑字典。scrypt 每次猜测要 ~32 MiB 内存与 ~100 ms，把爆破成本抬到数量级之上。仍然没有 `/cluster/join` 的按 IP 限速（要限速在代理层做）——scrypt 只抬高单次猜测成本，弱口令仍应避免。
- **密码和密钥放在哪里**：
  - **DSH 插件**：密码是 DSH 凭据（`ctx.credentials`，默认是 `$DSH_HOME/.credentials.yaml`），引用名默认按 workgroup 派生为 `ORCA_POD_PASSWORD_<WORKGROUP>`（`-` 换成 `_`，全大写），也可以用 `workgroup_password_ref` 指定。凭据文件为整个 DSH home 共用，所以引用名按 workgroup 区分：同一 workgroup 的 profile 共用密码，不同 workgroup 互不覆盖。凭据库里没有值时依次回落到启动环境变量与 `.env`，无头宿主可以直接导出同名变量。插件配置（profile 的 `cordis.patch.yml`）**不接受**明文 `workgroup_password`，校验直接报错。面板读到的配置视图永不返回密码，只给 `password_set`。
  - `<data_root>/config.json`：存**派生密钥** `key_base64`（不存密码），原子写入、文件权限 0600；`orca-node serve` 与 CLI 只读它，不再需要密码。配置文件泄露 = 直接获得准入证明能力。
  - `<data_root>/identity.json`：节点私钥，0600。
  - 同一个节点的 agent 能读到这些文件：ACP 子进程继承 `ORCA_POD_DATA_ROOT`，CLI 就是用这里的私钥以本节点身份签名；agent 也可以不带 `--local-task` 直接以本节点身份发根任务（见 [§11](11-open-questions.md#11-未决问题)“agent 侧密钥隔离”）。
- DSH 插件默认 `bind_host: "127.0.0.1"`，bundle 不携带任何 workgroup/密码：首次启动必须先在面板向导里完成 setup（workgroup、密码、监听地址）。向导默认仍选 loopback，只有显式选择 LAN 地址或 `::` 才接受 peer——同网段访问是运维的显式决定，不是默认。认证仍靠节点签名与成员闸门；不支持无密码的开放 mesh。需要更严格时保持 loopback 并让流量只走代理。
- **换密码**：**改过的 orca node 用新密码重启、重新 join 组成新 group**（本机 `identity.json` 保留，节点 id 不变）；没改的 orca node 留在旧 mesh 里，下一拍心跳的准入证明对不上，双方互相 401 丢弃，等于被移出（[§7.3](07-security.md#73-密钥与密码的分发)）。没有“过渡期双密码”，也不需要集中式踢人。
- **身份 = Ed25519 公钥**：`orca_node_id` 就是节点公钥，每个请求由本节点私钥签名，接收方用公钥验签——签名能证明“谁在调用”，伪造不了。密码不参与请求签名。
- **local-only 能力用传输层判定**：“只有本机可以做”的操作（`/cluster/child-link`、`/cluster/task`、`/a2a` 的 `tasks/escalate`、面板的 `/orca-api`）只看 socket 与转发头，并要求签名身份就是本机自己——代理可能改写来源地址，传输层事实更难伪造。文件 blob 登记更彻底：`publish` 由 CLI 直写本机 SQLite，根本没有 HTTP 路由（[§5.6](05-tasks.md#56-文件交换blob-通道)）。
- **目录不能改写已知成员**：他人目录里的条目只是“我还知道这个人”的提示，只用于把从未见过的 `orca_node_id` 加为候选端点；已存在记录的端点/显示名/runtime 只接受该节点本人签名的 join 更新，否则任一成员都能把别人的流量重定向到自己。
- **响应绑定拨号目标**：join/heartbeat 的响应体本身没有签名，接收方把 `self`/`from` 绑定到本次拨号目标的身份——已知端点不得声明成另一个 `orca_node_id`，否则按失败处理。首次接触没有可比对的身份，仍是 TOFU；明文 HTTP 下的完整消息认证由前置代理的 TLS 承担。
- **未认证请求只允许小 body**：认证发生在 body 解析之后、schema 校验之前，所以全局 `bodyLimit` 是 1 MiB，只有 `/blobs` 上传路由单独放宽到 256 MiB（流式，签名覆盖文件摘要）；陌生人最多让服务端缓冲 1 MiB。
- **先证明是成员，再谈签名**：签名只证明“持有这把私钥”，陌生人生成一把 Ed25519 密钥同样能签出合法格式的请求。因此除 `/health`、agent card、`/cluster/join` 和 blob 直链外，所有签名路由在验签后都要过成员闸门：调用者必须是本机，或在成员表里，否则 `403 not_a_member`。`/cluster/join` 是唯一的准入入口——它同时校验密码派生的准入证明。**不存在隐式 join**：出站调用不认识的 URL 时直接 `unknown_peer`，只有显式的 join/connect 才会向陌生地址发出准入证明（[§4.7](04-transport.md#47-方法与异步语义)）。
- **授权按记录归属，不按签名身份**：读接口允许同组成员读；写操作在记录归属上校验——`tasks/cancel` 与恢复（`message/send` 带 `taskId`）只接受 task 的 origin（或本机自己），其他成员 `403 not_task_origin`；`tasks/escalate` 只接受本机自己（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

### 7.2 请求签名（没有 session token）

每个请求自带 Ed25519 签名，服务端用 `orca_node_id`（即公钥）现验：

```http
Authorization: Pod orca_node_id=<43-char base64url public key>; target=<receiver orca_node_id>; ts=1763100000000; nonce=<base64url>; sig=<base64url>
```

```text
sig = Ed25519(identity.private_key,
  "orca-pod/request|" + METHOD + "|" + target_orca_node_id + "|" + url_with_query + "|" + sha256_hex(body) + "|" + ts + "|" + nonce)
```

`ts` 是毫秒时间戳。`target` 是**接收方**的 `orca_node_id`，`url_with_query` 是请求路径连同查询串（`/blobs?name=a.zip` 的 `?name=` 也被签名）。目标是让请求不能被“换一个收件人重放”、也不能被代理在查询串上做小动作。域分离标签 `orca-pod/request` 把这种签名和 grant、直链、准入证明的签名隔开。

校验顺序（`preValidation` 钩子里，先于 schema 校验）：

1. `Authorization` 能解析、`orca_node_id` 是合法公钥（否则 `missing_auth` / `malformed_auth`）；
2. `ts` 与本地时间差 ≤ 60s（`clock_skew`，时钟漂移单独报错，别混进 401）；且 `ts` 不早于本进程启动时刻（`stale_request`，重启后拒绝重启前的签名重放）；
3. `target` 等于本机 `orca_node_id`（唯一的例外是 `/cluster/join`：首次接触时发起方还不知道接收方 id，允许空 `target`），否则 `wrong_target`；
4. 用 `orca_node_id` 对应的公钥验 `sig`（改动方法/`target`/路径/查询串/body/`ts` 都会 `bad_signature`）；
5. `nonce` 未在 5 分钟窗口内出现过（每 orca node 的进程内 LRU，容量 10k，`nonce_replay`）；
6. 通过后检查成员资格：`orca_node_id` 必须是本机或已在成员表里，否则 `403 not_a_member`；例外是 `/cluster/join`（准入入口）、`/health`、agent card、blob 直链。`local` 路由还要求回环 socket、无转发头、且签名者就是本机。

性质与代价：

- **无状态**：服务端不存 token，不需要清理、不需要刷新、不需要 TTL；
- **密码即准入凭证**：密码泄露 = 对方可以加入组（能发现成员、发任务），但**不能伪造已有节点的请求**（每个节点用自己的私钥）。密码强度与分发仍是入组的安全边界；
- **撤销**：私钥在本机，删掉它就从 mesh 消失；把某节点踢出组则要换密码重建 group：旧节点的请求签名本身仍有效（Ed25519 与密码无关），但心跳准入证明过不了，双方在下一拍互相丢弃（[§7.3](07-security.md#73-密钥与密码的分发)）；
- **重放窗口**：60s + nonce 去重 + 重启拒绝；跨 orca node 时钟必须大致同步（NTP）；
- **同组内的定向往返**：签名绑定接收方 id 与完整 URL，因此 A 发给 B 的请求不能被转发给 C、也不能被代理换掉查询串参数；代价是所有出站调用都要先知道对方 id（成员表/join 已提供）；
- **代理友好**：签名覆盖 method/url（含 query）/body，代理改写 body 或查询串会验签失败（这是特性）；路径大小写、百分号编码也要求前后一致；
- **大 body 的签名**：带 body 的流式上传加 `X-Pod-Body-SHA256` 头，签名覆盖这个摘要而不是把整个 body 读进内存重算一遍；服务端流式落盘并计算实际摘要，不一致即 `400 blob_digest_mismatch` 并丢弃这些字节；
- **下载可换短期直链**：任意同组 orca node 调 `POST /blobs/{id}/link`，服务端返回 `GET /blobs/{id}?exp=<unix 秒>&sig=<base64url>`，`sig = Ed25519(该节点私钥, "orca-pod/blob-link|" + blob_id + "|" + exp)`，用该节点自己的公钥验。直链只是省掉签名头的便利，不扩大可读范围（持有成员身份的人本来就能直接 `GET`）；有效期见 [§5.6](05-tasks.md#56-文件交换blob-通道)。

`/cluster/join` 除节点签名外还带 `ts`/`nonce`/`proof`：`proof = base64url(HMAC-SHA256(k, "orca-pod/join|" + workgroup_id + "|" + orca_node_id + "|" + ts + "|" + nonce))`，其中 `k` 是上面的 scrypt 密钥——密码只出现在这一步。`/cluster/heartbeat` 同样带 `ts`/`nonce`/`proof`（标签 `orca-pod/heartbeat`），验不过回 `401 bad_proof`，双方据此在下一拍互相丢弃。`/health` 不签，会返回 `orca_node_id`（公开信息，不扩大权限面）。

### 7.3 密钥与密码的分发

- 推荐：`workgroup_id` + 密码通过带外通道给（人当面、密码管理器、私聊），不放进任何仓库；
- 面板向导接收明文密码，交给 DSH 凭据库保存；`orca-pod install` 接收明文密码，只把派生密钥写进 `config.json`（见 [§7.1](07-security.md#71-workgroup-与密码)）；
- 轮换（“解散再重建”，是特性不是缺陷）：
  1. A 改密码并重启监听 → A 的心跳准入证明换成新密码，旧成员在下一拍收到 401 并把 A 丢弃，A 也把旧成员丢弃；
  2. B 也改成同一新密码、重启、重新 join A → 新 group 成立（此刻 A、B 互见）；
  3. 没改密码的 C 留在旧状态：它能拨 A，但心跳准入证明验不过，401 后被 A 丢弃且 A 也把 C 丢弃——既进不来也不再显示在线；
  4. 想恢复 C，就把它的密码改成新的、重新 join 任意一个新成员。
- 结论：整个过程不需要“踢人接口”，也不需要维护黑名单——**密码就是成员资格**。

### 7.4 TLS 部署矩阵

| 场景             | 方案                          | 要点                               |
| ---------------- | ----------------------------- | ---------------------------------- |
| 局域网/VPN       | 明文 HTTP                     | 密码是唯一门槛；确保网络本身可信   |
| 公网单 orca node | Caddy `reverse_proxy` + 域名  | 自动证书；orca node 只听 127.0.0.1 |
| 公网多 orca node | Caddy/nginx 各 orca node 一套 | 证书可集中签发                     |
| 零信任           | Tailscale/WireGuard           | 网络层隔离，orca node 仍要密码     |

节点不读转发头：既不用 `X-Forwarded-For` 判断“是谁”，也不用它判断“是不是本机”；`local` 路由带任何转发头直接 `403 local_only`。TLS 由前置代理终结，节点自身只监听明文 HTTP（[§4.2](04-transport.md#42-路由表)）。

### 7.5 远程任务是不可信输入

- 任务 prompt、结论文本、`permission_request` 文本都是不可信输入；
- 不把远端文本拼进 shell 命令；不把远端文本当 HTML 渲染；不自动执行回传内容；
- **目标侧**：任务书里节点自己的前言永远在最前，远端任务正文放进显式的 `<untrusted-task-input>` 块并排在最后（正文里伪造的结束标签会被转义），inputs/notes 清单在块外、notes 文件名 JSON 转义（`src/task_inputs.ts` 的 `composePrompt`，[§6.7](06-execution.md#67-工作区一份持久)）；
- **origin 侧**：tracker 通知只给状态/原因/产物名，远端结论放进 `<untrusted-remote-result>` 块并截断到 800 字符（结束标签转义），并提示 agent 用 `orca_pod` 的 `status` 自己拉全文；权限请求不进对话，面板卡片只显示 `requested` 的 160 字符预览（`src/plugin/tracker.ts`、`admin.ts`）；
- 任务内容按 workgroup 隔离，不跨 workgroup 复用 session 或工作区；
- 可观测：谁（origin_orca_node）、何时、对哪个任务、用了什么 mode——留在任务记录与派发日志里（`tasks/get`、`orca-node log`），不另落一份审计文件。

### 7.6 授权矩阵

“同 workgroup”不等于“能做一切”，但也没有细粒度策略：

| 操作                                   | 谁能做                                                     | 依据                                  |
| -------------------------------------- | ---------------------------------------------------------- | ------------------------------------- |
| 派任务（`message/send` 新建）          | 同 workgroup 的任意已加入 orca node                        | 成员闸门；没有按 `orca_node_id` 的白名单 |
| 读任务 / 读 blob                       | 同 workgroup 凭 id                                         | 无 per-task / per-blob ACL            |
| 取消、恢复（批准/拒绝/补输入）         | 只有 task 的 origin（及本机自己）                          | `403 not_task_origin`                 |
| `tasks/escalate`                       | 只有本机自己                                               | `400 bad_request`                     |
| `child-link`、`/cluster/task`、面板 API | 只有本机（回环 + 无转发头 + 本机签名）                     | `403 local_only`                      |
| 权限上限                               | 继承 origin 会话的 mode，本机 `permission_mode` 可再降一档 | [§7.10](07-security.md#710-权限模式继承) |
| 工作区                                 | 整个 workgroup 共用一份                                    | [§6.7](06-execution.md#67-工作区一份持久) |
| 登记本机文件为 blob                    | 只有本机（`publish` 直写 SQLite）                          | 没有 HTTP 路由                        |

按节点白名单、预授权策略目前没有（[§11](11-open-questions.md#11-未决问题)）。

### 7.7 SSRF / 候选端点防护

- 候选端点（从别人目录里学到、尚未直接 join 的）在拨号前校验；显式配置、CLI `--peer`、直接 `join` 的端点不在此列；
- 恒定拒绝：`0.0.0.0`/`::`、组播与保留段（≥ 224.0.0.0）、`169.254.0.0/16`（含元数据地址 `169.254.169.254`）、`fe80::/10`；
- 允许 RFC1918、`100.64/10`、`fd00::/8`；**回环默认允许**（同机多进程是常见部署），可用 `allow_loopback_peers: false` 收紧为拒绝；公网地址需要 `allow_public_peers: true`；
- 主机名先解析、再按**所有**解析结果判断，解析失败即拒；判定结果只缓存 60 秒，过期重新解析；被拒的候选只 warning 一次，不进 online；
- **入站 join 自报的端点**在登记前筛查：恒定拒绝的地址剔除；回环地址只在 join 本身经回环到达时接受（远端机器不可能在我的 127.0.0.1 上）；公网地址可以（对方已证明持有密码）；解析不出来的主机名保留；一个都不剩 → `400 endpoint_refused`；
- **不跟随重定向**：出站请求带 `redirect: "manual"`，3xx 按失败处理，签名请求不会被弹到别的地址；
- 已知残余：校验与 `fetch` 各自解析一次 DNS，两次之间改答案（DNS rebinding）的窗口仍在。

实现：`membership.ts` 给每个 peer 记 `origin: "explicit" | "candidate"`（直接 join → explicit；只从目录 merge 进来 → candidate），心跳循环在拨号 candidate 前调用 `src/net.ts` 的 `candidateEndpointAllowed`；入站 join 走 `screenEndpoint`。

### 7.8 审计

- **不做持久审计落盘**（局域网自用，[§10.5](10-roadmap.md#105-phase-4规模化与部署)）：任务记录、`dispatches` 派发日志与 DSH 会话记录已经能回答“谁在什么时候派了什么、结果如何”，额外一条审计通道收益低、维护成本高。
- 排查靠现有记录：`orca-node log`（origin 派发）、`tasks/get` 的任务状态与 `reason`、插件 tracker 的通知文本；`permission_request` 全文留在任务状态里，便于事后回答“它当时要什么”。
- 真要合规审计属于部署层外挂（代理访问日志 + DSH 会话留档），不在插件内实现。
- 网关状态（`<data_root>/state/<workgroup_id>/`）放在 workgroup 根之外：agent 对 cwd 有写权限，看得见就能删（[§6.7](06-execution.md#67-工作区一份持久)）。
- 面板 API（`/orca-api`）的闸门见 [§9.2](09-implementation.md#92-面板)：回环 + 无转发头，之外还有同源闸门（CSRF / DNS rebinding）。

### 7.9 权限跟随发起 orca node

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；
- 需要更多权限时，target 把请求写进 task 状态（`input-required`），由 origin 的人在自己的 UI 上决定。

**审批面属于发起这个任务的会话，不属于节点**：

| 谁发起的任务                                          | 谁批                      | 行为                                                                                                                                         |
| ----------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面 DSH 里的交互式会话（`orca_pod` 的 `send`）       | 这台机器上的人            | tracker 把权限请求交给 `ApprovalBroker`，UI 作答：当前会话聊天卡、后台会话弹窗、或面板列表（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)） |
| ACP 执行器里的 agent，用 CLI 带 `--local-task` 派的子任务 | 链上更上游的人            | 本机不批：本节点轮询子任务，看到权限请求就把**本机的父任务**挂成 `input-required` 上交，沿父任务的 origin 逐跳上升直到有人的会话               |
| 脚本/终端里不带 `--local-task` 的 CLI 派发             | 没有审批面                | 请求停在 `input-required`，直到 target 配置的 `approval_timeout_s` 到点失败；CLI 没有批准命令                                                  |

不存在“节点级 attended 标志”：同一台机器通常同时跑桌面 DSH 和 ACP 执行器，有没有人取决于**是哪个会话发起了这个 task**；ACP 执行器会话只有 CLI、没有审批面，所以它派出的子任务一律上交。链上唯一的人坐在根会话前。

### 7.10 权限模式继承

origin 发起任务时携带会话的 permission mode（`metadata.pod.permission_mode`），target 按它执行：

- **继承**：`orca_pod` 的 `send` 默认从 DSH 的 `permissionPresets` 服务读当前会话的 sandbox 模式（`SandboxMode` 与本报文的三档同名）；工具的 `permission_mode` 参数显式给出时**用显式值**（是否应只允许收窄见 [§11](11-open-questions.md#11-未决问题)“显式 permission_mode 的方向”）。CLI `orca-node send` 没有 DSH 会话，用 `--permission-mode` 显式传；带 `--local-task` 且没显式传时继承父任务的模式。
- **没继承到**（元数据没带 mode）：target 按 `read-only` 执行。
- **本机上限**：`permission_mode` 设置（面板高级设置）是本机上限，生效模式 = 上限与继承值中较窄的一个；没配上限就用继承值。**只能降，不能升**。
- **执行**：target 并不把模式传给 `dsh` 子进程；约束完全来自对 ACP `session/request_permission` 的应答规则（[§7.14](07-security.md#714-acp-request_permission-映射)）。

| 生效模式             | 含义                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------- |
| `read-only`          | 只放行读/搜索/思考类请求，其余一律自动拒绝（不上交）                                         |
| `workspace-write`    | 放行读写类请求：`edit`/`delete`/`move`/`execute`；**不校验路径是否在工作区内**；其它类型上交 origin |
| `danger-full-access` | 全部自动放行，没有额外限制                                                                   |

mode 随任务元数据一起签名传递，target 校验签名后再执行，中间人改不了；mode 不写进 grant 之外的任何持久状态，任务结束即失效。

### 7.11 Grant

grant 是 origin 对“这一次权限请求”的授权凭证，由 origin 节点的 Ed25519 私钥签名，随恢复消息（`message/send` 的 data part）下发：

```json
{
  "grant_id": "<uuid>",
  "workgroup_id": "orca-dev",
  "origin_orca_node": "<A 的 id>",
  "task_id": "<被授权的 task>",
  "target_orca_node": "<请求者的 id>",
  "tool": "write_file",
  "mode": "allow_once",
  "chain": ["<A 的 id>", "<经过的节点…>"],
  "request_id": "<叶子请求的 id>",
  "issued_at": "2026-11-14T04:40:00Z",
  "expires_at": "2026-11-14T04:45:00Z",
  "sig": "<base64url>"
}
```

- 签名输入是 `orca-pod/grant\n` + 固定键序的规范 JSON（上面除 `sig` 外的全部字段），所以 `origin_orca_node`、`request_id` 都在签名保护内，grant 不能被改标成另一个 origin 或拿去回应另一个请求；
- `mode` 只有 `allow_once`；有效期由 origin 在批准时决定（默认 300 秒，只需覆盖一次恢复）；grant 不带 `limits` 或 `permission_mode`。

target 收到恢复消息后按顺序校验（`checkGrant`，全部通过才放行，任一不符即终止任务并以对应 reason `failed`）：

1. 签名能用 `origin_orca_node` 的公钥验过；
2. `chain[0] === origin_orca_node`，且它等于该任务的**根 origin**（`pod.root_origin`；单跳时就是任务自己的 origin）——中间节点不能冒充 origin；
3. `workgroup_id` 一致、`tool` 与挂起的请求一致；
4. 未过期（`grant_expired`）；
5. `request_id` 等于叶子请求的 id（`origin_request_id` 或本请求的 `request_id`）——relay 逐跳原样携带，不重新生成；
6. 未被用过：target 在进程内按 `grant_id` 记已消费集合（到 `expires_at` 为止，容量 1024），重复使用 `grant_replayed`；
7. direct（`task_id` 与 `target_orca_node` 就是本任务与本节点），或 delegated（`target_orca_node` 在本任务的 `chain` 里，且 `grant.chain.slice(1)` 是任务祖先链的前缀）。

其他：

- 中间节点**不重签**：`deriveChildGrant` 只验父 grant 的签名、`target_orca_node` 是自己、`tool` 一致、未过期，然后把原 grant 转发给子任务；所以 `origin_orca_node` 始终指向真正签字的那个人，也不可能被放宽；
- 已消费集合与 grant 都不持久化（重启时任务本来就都失败了）；没有“取消时吊销 grant”这一步，grant 本身只有一次有效且很快过期；
- 签发见 [§7.12](07-security.md#712-升级回路任务状态不是反向调用)：只有 origin 节点的 `approveTask` 签 grant。

### 7.12 升级回路：任务状态，不是反向调用

```text
target: 执行器发起一次生效模式之外的权限请求
  → 任务运行器（不是 agent）把 task 置为 input-required、释放槽位
  → 结构化 permission_request 写进 task 的 status.message（data part）
  → 连接结束。target 不拨 origin，不新建任何到 origin 的请求：

    {
      "request_id": "<uuid>",
      "task_id": "<target 上的 task>",
      "tool": "write_file",
      "requested": { "tool_call_id": "…", "tool_kind": "edit" },
      "requested_by": "<需要权限的 orca node>",
      "via": ["<A>", "<…>"],                // 本任务的祖先链
      "upstream": ["<C>"],                  // 可选：真正需要权限的下游
      "origin_request_id": "<叶子请求 id>",  // 可选：relay 时
      "expires_at": "…"                     // 可选：仅当 target 配置了 approval_timeout_s
    }

origin: tracker 的下一次 tasks/get 看到 input-required
  → 交给 ApprovalBroker（不往 agent 对话里塞原始文本）
  → UI 三落点：正在看的会话里贴聊天卡；后台会话弹窗；面板 Pending approvals 列表
  → 批准：origin 节点签 grant（单次、默认 300s），作为同一 task 的后续 message 发给 target
  → 拒绝：发 message `permission_denied`，target 把 task 置 failed(reason=permission_denied)
  → 默认不超时（人可能不在）；target 配置了 approval_timeout_s 才在到点后 failed(permission_timeout)
```

要点：

- **这不是反向调用。** 全设计只有 origin → target 一个方向；target 没有 origin 的地址，也不需要。所谓“送回 origin”只是把请求写进 task 状态，等 origin 来读。
- **任务记录是唯一权威载体**：`permission_request` 必须能只靠 `tasks/get` 拿到；origin 重启、停轮询后恢复，都读得到同一份。
- 补发的授权是**同一 task 的后续 message**（带 `taskId` + grant），不是第二个任务，也不是独立的 grant 端点；只有 origin 能发。
- **只有一个 `ApprovalBroker`，UI 是唯一的答复通道**：`orca_pod` 工具没有 approve 方法（方法只有 `send`/`status`/`cancel`/`members`/`connect`），所以模型无法替用户批准。批准/拒绝按钮直接调 `OrcaNode.approveTask/denyTask`，不经过模型与工具轮次。
- **权限请求不产生聊天 notice**，也不唤醒 agent；UI 三个落点共用同一个 broker 与同一条决议通道：**当前正在看的会话**里贴一张聊天卡（`conversation.input.dock`，按发起任务的会话 id 匹配）；**后台会话**的请求在框内弹窗（`shell.overlay`）；**面板** Pending approvals 列表可随时签发。任务终态或不再挂起时，卡片自动收回。
- 卡片显示：需要权限的节点、请求链、工具名、`requested` 的预览；这些都是不可信的远端文本，当纯文本渲染，不当 HTML。
- `decided_by` 必须来自 UI 的人类动作，不能由模型自批；origin 端是唯一能产生“用户同意”的地方。

#### 链式调用：授权向下收窄，升级向上回传

链 A→B→C 里，如果让 B 直接批准 C 的越界请求，A 的授权就被一个 agent 转授放大了。规则只有一条：**每个 task 的 origin 只能在自己拿到的 grant 范围内放行；超出一律上升，直到有人的那个 orca node，通常是根 A。** B 不自批，也没有“中间节点自动放行”的开关。

```text
C：模式之外的请求 → C 的 task 变 input-required，permission_request 落在 C 的 task 上
B 的 agent 用 `send --local-task <B 的 task>` 派的这个子任务，CLI 向 B 登记了 child-link
B 的节点每 1s 轮询 C 的 task：看到 permission_request
  → 对 B 自己的父任务调 tasks/escalate(relay = {C 的 endpoint, C 的 task id, C 的请求})
  → B 的父任务也变 input-required：permission_request 里 requested_by = B，via = B 的祖先链，
    upstream = [C]，origin_request_id = C 的请求 id
A（B 的 origin，也是人的位置）：tracker 看到 → 卡片显示“C 经 B 请求…” → 人批
  → A 签 grant（request_id = 叶子请求 id，target = B，task_id = B 的 task），发给 B
B 恢复：校验 grant（direct）→ 原样转发给 C 的 task（deriveChildGrant）
C 校验 grant（delegated：target 在 C 的 chain 里）→ 恢复执行
```

规则：

- **grant 只由 origin 签发、链上逐跳转发**：中间节点不重签（否则“谁批给谁”的链就断了）；target 端按 [§7.11](07-security.md#711-grant) 的 7 步校验，收窄来自 origin 签发时对请求的约束（同 tool、单次、短有效期），而不是中间节点的二次裁剪。
- **拒绝/取消向下传**：A 拒绝，B 的父任务 `failed(permission_denied)` 并向 C 发 `permission_denied`，C 随之失败，不悬挂；B 的父任务被取消同理。
- **等待不占槽**：C 与 B 都停在 `input-required`（槽位释放）；A 长期无人 → 各级继续等，除非 target 配置了 `approval_timeout_s`（到点 `permission_timeout`，同样向下传）。
- **自动上升靠 CLI**：`send --local-task` 登记 child-link（子任务终态、父任务终态、或连续 10 次读失败都会摘掉链接）；`wait --local-task` 在轮询里看到子任务权限请求时也会自己上升（同一 `request_id` 只上升一次）；`escalate` 是手动路径。不经 CLI 派发子任务的宿主没有这层轮询。child-link 只在内存里，重启后不恢复。
- **环靠 `chain` 检测，不靠深度上限**（[§5.1](05-tasks.md#51-任务标识与元数据)）；长链由 task TTL 与上面的超时兜底。
- **根 A 的卡片必须显示来源链**：否则人只看到“C 要写文件”，不知道是 B 代 C 在问。来源链来自 `requested_by`、`via`、`upstream`。

### 7.13 目标侧硬拒绝清单

没有。权限请求要么落在 [§7.14](07-security.md#714-acp-request_permission-映射) 的自动应答规则里，要么上交 origin；节点不维护与模式、grant 无关的“永远拒绝”清单，也不保护自己的配置与凭据目录不被 agent 读写（见 [§7.1](07-security.md#71-workgroup-与密码)）。要限制一台机器能做什么，把本机 `permission_mode` 设成 `read-only` 或 `workspace-write`。

### 7.14 ACP `request_permission` 映射

AcpExecutor 收到 `session/request_permission` 时，先用生效模式（[§7.10](07-security.md#710-权限模式继承)）和请求里的工具类别 `kind` 做自动应答（`src/acp/permissions.ts`）：

| 生效模式             | 请求的 `kind`                                          | 结论                                                    |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------- |
| `danger-full-access` | 任意                                                   | 自动 `allow`                                            |
| `workspace-write`    | `read` / `search` / `think` / `edit` / `delete` / `move` / `execute` | 自动 `allow`（不校验路径）                |
| `workspace-write`    | 其它（`fetch`、`switch_mode`、`other` 或未标注）       | 不回复 ACP，任务挂起为 `input-required` → origin 决定   |
| `read-only`          | `read` / `search` / `think`                            | 自动 `allow`                                            |
| `read-only`          | 其它一切                                               | 自动 `reject`（不上交，不弹卡）                         |

- 自动应答选 `allow_once`/`reject_once` 选项，没有就选第一个同类选项，都没有则回 `cancelled`。
- 上交的请求等 origin 的后续 message：批准 → 回 `allow`；拒绝/取消/TTL/超时 → 任务终止，所有未答复的请求回 `cancelled`，避免 ACP 侧永久悬挂。挂起本身没有超时，除非配置 `approval_timeout_s`。
- 没有“无 grant 即拒绝”这一条：自动放行不需要 grant，grant 只对上交的请求有意义。

### 7.15 凭据回传与注入防护

节点不做凭据检测，也没有回传开关：agent 在它的权限里能读到的文件，就能写进结论文本或 `publish` 出去。防的是另外两件事：

- **origin 不自动执行回传内容**：拿回来的文本放进 `<untrusted-remote-result>`，不进下一轮 prompt 的指令位置（[§7.5](07-security.md#75-远程任务是不可信输入)）；
- **审批由人在 UI 上做**，模型无法自批（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

---
