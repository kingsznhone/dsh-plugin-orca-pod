# 05 任务

> 本章描述任务的数据模型与生命周期：如何标识、如何回报、如何取消、结果放在哪里、任务之间如何交接。

## 5. 任务

### 5.1 任务标识与元数据

任务元数据是 `message/send` 的 `params.metadata`；节点相关的部分在 `metadata.pod`：

```json
{
  "pod": {
    "hop": 1,
    "chain": ["<A 的 orca_node_id>"],
    "root": "<根 task id>",
    "root_origin": "<A 的 orca_node_id>",
    "permission_mode": "workspace-write",
    "model": { "provider": "deepseek", "model": "deepseek-flash", "reasoning_effort": "high" },
    "reasoning_effort": "high",
    "task_ttl_s": 1800,
    "inputs": [{ "blob_id": "<sha256>", "name": "input.zip" }]
  }
}
```

规则：

- `task_id` 由 target 生成（ULID 形状：48 位毫秒时间戳 + 80 位随机，26 字符，按创建时间排序，不可枚举）；origin 在派发日志里记 `(peer, task_id)`。
- **origin 是请求的签名者**（`origin_orca_node`），不由元数据声明。`context_id` 取 `message.contextId`，缺省等于 task id；目标 orca node 把 `(origin, context_id)` 映射到本地 ACP session，cwd 固定为 workgroup 根（[§6.10](06-execution.md#610-sessioncontext-与-workspace-的绑定)）。
- `pod.hop`：任务已经跨了几跳，只作信息与排查，**没有上限**——一个 workgroup 就是几台机器，环检测靠 `chain` 不靠深度。非负整数。
- `pod.chain`：经手派发的 orca_node_id 列表（祖先路径），只用于环检测，不做路由；每个派发子任务的节点把自己追加进去。`pod.root_origin`：整棵委派树的发起节点；每个接收方都把它写进自己存下的任务，两条子任务路径（CLI `--local-task`、本地任务委派）原样带下去。target 若发现自己在 `chain` 中、或自己就是 `root_origin` → `403 ancestor_call_forbidden`。用插件工具派发的根任务不带 `chain`，所以“根 origin 不能被回调”必须靠 `root_origin` 判断，A → B → A 因此也会被挡住。被挡住时，agent 应把问题写进结论文本（`BLOCKED: …`）交还 origin，而不是换条路再调回去。仍然拦不住的是 agent 不带 `--local-task` 直接发一个新的根任务（见 [§11](11-open-questions.md#11-未决问题)“agent 侧密钥隔离”）。
- `pod.root`：这条调用树的根 task id；`pod.root_origin`：根任务的 origin。`root_origin` 缺省取本任务的 origin，并写回 task 视图的 `metadata.pod`，grant 只认根 origin 的签名（[§7.11](07-security.md#711-grant)）。
- **`hop`/`chain`/`root`/`root_origin` 由发起方的 CLI 在客户端拼装**：`orca-node send --local-task <本机 task>` 通过回环的 `GET /cluster/task` 读父任务视图，写成 `hop+1`、`chain + [本机 id]`、沿用 `root`/`root_origin`，并在没有显式 `--permission-mode` 时继承父任务的模式。target 只校验形状与环，不重算这些字段；这意味着节点上的 agent 能自己写它们（见 [§11](11-open-questions.md#11-未决问题)“agent 侧密钥隔离”）。
- `pod.permission_mode`：origin 会话的权限模式（`read-only` / `workspace-write` / `danger-full-access`）；缺省按 `read-only`；本机 `permission_mode` 是上限，取两者较窄（[§7.10](07-security.md#710-权限模式继承)）。非法值 → `400 bad_request`。
- `pod.model` / `pod.reasoning_effort`（可选）：origin 想用的模型与 effort；由 ACP 执行器用 `session/set_config_option` 落地，选不到就 `failed(model_unavailable)`，不会退回默认模型（[§6.15](06-execution.md#615-按任务选择模型)）。
- `pod.task_ttl_s`（可选）：origin 期望的任务寿命；实际寿命取它与本机 `task_timeout_s`（默认 3600）的较小者。等待 `input-required` 时 TTL 暂停，恢复后重新计时（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- `pod.inputs`（可选）：随任务的素材清单，见 [§5.6](05-tasks.md#56-文件交换blob-通道)。
- 任务本身不转发：多跳是 target 上的 agent **新建**子任务，不是把原任务转出去；原任务仍只属于它的 origin。
- 元数据是不可信输入：在 `submit` 时一次性解析成类型化的 `TaskMeta`，之后的代码不再读原始 metadata；类型不合法 → `400 bad_request`。

### 5.2 任务回报

```text
origin: POST message/send → { task_id }
origin: 派发日志落库（记下 peer 与最后看到的状态）
origin: tracker 每 1s 拉一次 tasks/get
target: 推进 submitted / working / input-required / 终态，每步写 SQLite
origin: 终态 → 合并成一条 notice 交还发起会话 → 停止轮询
```

#### 轮询归 Host，不归 agent

轮询是插件的后台行为，不是 agent 的一条命令：

- `orca_pod` 的 `send` 方法建完 task 立刻返回 `task_id`，不挂着连接等结果；
- 插件里的 tracker 拉 `tasks/get`，状态写进内存与本地派发日志；
- agent 只看到一个薄工具 `orca_pod`，没有一个方法会阻塞：`send`、`status`（读目标侧任务状态，立即返回）、`cancel`、`members`、`connect`。**没有等待方法**——等待不是 agent 的职责，也没有批准方法（批准只在 UI，[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

派发即返回，所以 agent 的循环里没有“等”：任务在跑就继续干别的，或者干脆结束本轮、把控制权还给用户；完成会由 tracker 注入或唤醒。target 忙（`429 orca_node_busy`）时也没有可等的东西——要不要重试、什么时候重试，由模型判断（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)），不由协议层排队。

**为什么不让模型用 bash 长轮询**：每等一次就是一次工具调用、一轮上下文；`timeout` 杀掉的是 shell 不是等待语义，容易留孤儿；退避策略交给模型，token 花在等待上而不是决策上。Host 有单调时钟、可取消，也知道什么时候该停。

tracker 的行为：

- **轮询**：固定 1s，自调度（上一轮结束才排下一轮，不重叠）；只在有待跟踪任务时运行。
- **瞬时失败**（超时、网络错误、5xx）：该任务按 1s 起翻倍、上限 30s 退避重试；连续 5 次失败后放弃跟踪，告诉 agent `tracking of task … was interrupted: …; the task may still be running — call orca_pod with method "status" to check it`。**不**把任务记成 failed，也不补发 `tasks/cancel`。
- **确定性失败**（`404 task_not_found`、401/403）：立即放弃跟踪，同样告知 agent。
- **终态**：照常合并成 notice。结论文本以 `BLOCKED` 开头的 completed 任务会被标注为“completed with a blocker report”（[§6.14](06-execution.md#614-acpexecutor)）。
- **权限请求**：任务进入 `input-required` 且带 `permission_request` 时，tracker 把它交给 `ApprovalBroker`（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）等 UI 作答，**不产生聊天 notice**，不唤醒 agent；任务继续被跟踪到终态。`input-required` 只因权限请求出现；任务因其他原因无法继续时以 `BLOCKED:` 结论结束，按上一条作为终态通知 agent。
- **宿主重启**：派发时 tracker 把发起会话 id 写进派发日志。插件就绪且 agent 注册表可用后，对“非终态、且该会话此刻在宿主里存在”的任务恢复跟踪；之后每有会话被创建或恢复（`agent/created`），只恢复**该会话自己**的派发。会话被销毁时，它的跟踪随会话一起撤销。重复恢复是幂等的：已在跟踪的任务保持原状（退避与最后视图不清零），本进程已放弃跟踪的任务（404、401/403、瞬时失败超限）不会被再次拉起。宿主里不存在的会话，其任务靠 `status` 或面板查看。

#### 状态怎么回到会话

不塞 user 消息伪装成用户，也不让 agent 猜：notice 是 `source.kind = "orca-pod"` 的 user 角色消息，内容形如 `[orca-pod] task <id> on <peer> is completed; …`，远端结论文本放在 `<untrusted-remote-result>` 块里（[§7.5](07-security.md#75-远程任务是不可信输入)）。

| 会话状态                     | 手段                                   | 效果                                                              |
| ---------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| 仍在 `running`（同一轮没结束） | `agent.inject()`，并把唤醒计数清零     | 落 `agent/inbox/spliced`，等下一步读到，不打断这一轮              |
| idle，且连续唤醒不足 3 次    | `agent.followup()`，唤醒计数 +1        | 开新一轮；UI 里是同一会话里新的一轮 assistant 回复，不伪造 user 气泡 |
| idle，但已连续唤醒 3 次      | `agent.inject()`                       | 留在 inbox，不再叫醒；用户下一次说话后重置预算                    |
| 用户随时想看                 | `orca_pod` 的 `status`                 | 直接读目标侧任务状态，与会话历史无关                              |

要点：

- **合并**：2s 窗口内到达的多个终态按会话合成一条 notice、一次 `followup()`；五个任务同时完成不该叫醒五次。
- **预算**：连续后台唤醒轮次 ≤3（中间没有用户输入）。**用户给该 agent 发消息时重置**（监听 `agent/inbox/claimed` 且 `source.kind === "user"`）。这是防 A→B→A 自动循环烧 token 的闸，不是防正常续跑。
- **不反向**：唤醒是 origin 自己对自己做的，不涉及任何 target→origin 的连接。
- `followup()` 只对**仍然活着**的 session 有效：DSH 进程里还有这个 `Agent` 实例，插件才有对象可唤醒。会话已关闭/归档时没有对象，任务结果留在目标侧任务存储里，靠 `status` 重读——不存在“插件把 DSH 会话从磁盘拉起来”。
- 会话日志仍是唯一事实源：`inject()` 的内容以 `agent/inbox/spliced` 落日志；任务状态本体在任务存储里，`status` 随时可重放，插件内存只是缓存。

CLI 的 `orca-node wait <task_id>` 只给人和测试、以及 ACP 会话里的 agent 用（它们没有插件工具），不作为插件工具暴露；`orca-node log [--json]` 直接读 origin 侧派发日志（[§8.3](08-reliability.md#83-目标重启)），用于重启后对账。

### 5.3 取消

`tasks/cancel` 必须传到 LocalExecutor：

- ACP：发 `session/cancel`；2s 宽限后如果该 session 仍是连接上正在跑的那个，就关闭连接、终止子进程树（避免误杀已复用同一连接的下一个任务）；
- Echo：中止脚本。

取消后 task 置 `canceled`；如果它正挂着一个替子任务上交的权限请求，同时向子任务发 `permission_denied`，子任务随之失败而不是悬挂。task 已是终态时原样返回，不报错、不改状态。

**谁可以取消**：只有 task 的 origin（以及执行该 task 的本机节点自身，用于本地控制路径）。同组其他成员可以 `tasks/get` 读，但 `tasks/cancel` 返回 `403 not_task_origin`——共享 workgroup 密钥下“同组”不等于“可以互相杀任务”，取消按任务归属校验而不是按签名身份。

### 5.4 流式与隐私

- ACP `session/update` 可能含 assistant message、thought、tool call、usage。
- 只累积 `agent_message_chunk` 的文本作为结论；thought、tool_call、usage 都不映射、不转发。
- 任务视图里没有流式事件：origin 只能轮询到状态与最终结论。
- 结论文本是 agent 自己说的话，节点不过滤其中的路径或凭据（[§7.15](07-security.md#715-凭据回传与注入防护)）。

### 5.5 任务存储

每个 orca node 的 task store 是它自己产生的 task 状态的唯一事实来源。2–10 个 orca node 不需要数据库服务：一个文件、一个进程、可备份，就是全部要求。

- **单机 SQLite**：`<data_root>/tasks.db`，Node 内置 `node:sqlite`，WAL 模式，`synchronous=NORMAL`；一个进程独占写；不做连接池、不做服务、不共享库。
- 三张表，结构相同——`(task_id TEXT PRIMARY KEY, payload TEXT /* JSON */, updated_at TEXT)`：`tasks`（目标侧任务：`{view, origin_orca_node, created_at, updated_at}`）、`dispatches`（origin 派发日志，[§8.3](08-reliability.md#83-目标重启)）；另有 `file_blobs`（`publish` 登记的本机文件，`blob_id, path, size, expires_at`）。
- 任务每次状态变迁都写库；`tasks/get` 先查内存，再回落 SQLite，所以重启后仍可查。进程启动时所有非终态 task 标 `failed(node_restart)`（[§8.3](08-reliability.md#83-目标重启)）。
- 备份 = 拷贝 db（WAL 下先 checkpoint）；落盘失败只记 warning，任务继续留在内存里可读。
- 内存 store 只用于协议单测与 harness。
- blob 内容与元数据不在这里：fs 内容寻址目录 `<data_root>/blobs/`（[§5.6](05-tasks.md#56-文件交换blob-通道)）。

**可见性**

- 同 workgroup 的任意 orca node 凭 `task_id` 可 `tasks/get`；没有列表接口，`task_id` 就是句柄。
- origin 额外拥有交互权：`input-required` 后补发消息（`message/send` 带 `taskId`）与 `tasks/cancel`；其他成员只读。
- 因此**`task_id` 泄露 = 结果泄露**。它只该出现在任务消息和给人看的日志里，不要贴到公开 issue 或截图里。
- 同组是信任域：密钥共享，“谁能读”是约定与信任问题，不是密码学保证（[§7.1](07-security.md#71-workgroup-与密码)）；取消与恢复按 task 归属校验。

### 5.6 文件交换（blob 通道）

任务素材与产物不走 JSON 内联：base64 会膨胀 33%，而且没法流式、没法去重。单独一条内容寻址通道：

```http
POST /blobs?name=input.zip
Authorization: Pod orca_node_id=<43-char public key>; target=<receiver orca_node_id>; ts=...; nonce=...; sig=<base64url>
X-Pod-Body-SHA256: <hex>
Content-Type: application/octet-stream

<bytes>

201 { "blob_id": "<sha256>", "size": 1048576, "name": "input.zip", "expires_at": "2026-11-21T..." }
```

```http
GET /blobs/<blob_id>                       # 签名，或 ?exp=<unix>&sig=<base64url> 直链
POST /blobs/<blob_id>/link                 # → 200 { "url": ".../blobs/<id>?exp=...&sig=...", "expires_at": "..." }
```

```text
# 在本机登记一个已生成的文件（不经过网络，不需要节点在跑）
$ orca-node publish ./report.md --ttl 86400
http://host.example/blobs/<sha256>?exp=...&sig=...
```

规则：

- `blob_id = sha256(bytes)`，内容寻址 → 天然去重；同内容重复上传返回 `200`、不占新空间，并把过期时间延长到“现在 + TTL”；首次返回 `201`。
- 上传与下载都**流式**：客户端先算摘要再签名（签名覆盖 `X-Pod-Body-SHA256` 而不是 body 本身），服务端边收边算、写临时文件，内存里不攒整个文件；摘要与实际字节不符 → `400 blob_digest_mismatch`，字节直接丢弃，不以任何 id 保存。落盘顺序是“数据 rename 到位 → 写 sidecar（`<id>.json`）”，sidecar 就是提交标记：没有 sidecar 的数据文件不算 blob，GC 过了宽限期把它清掉；sidecar 在而数据丢了，同样不算 blob、由 GC 清理。`GET` 走流式响应。
- 上限：单 blob 256 MiB（`413 blob_too_large`）；单个任务附带的 inputs 默认 32 个文件 / 512 MiB（`max_input_files`、`max_input_bytes` 可调）。
- **存储配额**：`max_blob_store_bytes`（默认 5 GiB）限制 blob 存储总量（已落盘 + 正在上传的字节）；超出的上传 `507 quota_exceeded`。
- 文件名只作提示（`name`），不参与寻址；存储路径由 blob_id 决定。上传时 `?name=` 必须是无路径分隔符、无 `..`、无盘符的纯文件名，否则 `400 bad_request`。下载响应不带文件名。
- **生命周期**：上传的 blob 与 `publish` 登记的文件默认 **7 天**过期（`publish --ttl` 可改）。**GC 全自动**：节点启动时跑一次，之后每 10 分钟跑一次，清理过期 blob 及其元数据，以及超过 10 分钟没写入的残留 `.part` 临时文件；`publish` 登记行过期后不再提供下载但行不清理。过期未被 GC 的下载返回 `410 blob_expired`，GC 之后返回 `404 blob_not_found`。没人会去 B 的机器上清 blob；要保住某个产物，就在 7 天内下载它。
- **直链**：任意同组 orca node 调 `POST /blobs/{id}/link` 拿一条直链，有效期 7 天（与 blob 默认保留期一致）；面板的产物链接默认 300 秒；`orca-node publish` 打印的链接 24 小时有效。直链的 `sig` 是**该 blob 所在节点自己的 Ed25519 签名**（签 `orca-pod/blob-link|<blob_id>|<exp>`），用它自己的公钥验证；篡改 `blob_id`/`exp` → `403 link_invalid`，过期 → `410 link_expired`。直链只是省掉请求签名头，不改变可读范围，浏览器/curl 不必拿长期密钥。
- **本地文件按路径登记（文件不离开工作区也能给 URL）**：子节点在结论文本里要引用一个已生成的文件时，用 `orca-node publish <path> [--ttl <seconds>]`：CLI 算 `sha256`、把 `blob_id → {绝对路径, size, expires_at}` 写进本机 SQLite 的 `file_blobs` 表，打印一条带 `?exp&sig` 的直链。字节不复制，`GET` 时网关按映射从磁盘流式读出；映射跨重启保留；TTL 到期 → `410 blob_expired`，文件被删 → `410 blob_file_missing`。
- **登记不是 HTTP 路由**：登记一个路径等价于授权读它，而同组共享 workgroup 密钥，任何成员都能让目标节点替它去读本机路径，“只有本机能登记”无法靠成员签名在网络层实现，所以登记只在本地发生：CLI 直写节点自己的数据库，网关没有 `POST /blobs/register`（访问它是 `404`）。这也让登记不依赖节点进程。
- **不做 per-blob ACL**：同 workgroup 的任意 orca node 知道 `blob_id` 就能 `GET`。跨 orca node 直取（C 去 B 拿 A 的产物）是设计目标，不要加一层“看起来更安全”的检查。
- **blob 不可枚举**：知道 `blob_id` 才能取，没有列表接口；id 是内容哈希，不泄露目录结构。id 泄露 = 内容泄露，按这个标准管理它。
- 不做目录树、不做 rename、不做覆盖：要改内容就是新 blob。

**输入**：origin 先把素材 `POST /blobs` 到 target（`orca-node send --file <path>` 会自动做这一步，文件名取 basename），再在任务消息里带 `metadata.pod.inputs: [{blob_id, name}]`。`name` 必须匹配 `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`。target 在**建 task 之前**检查（blob 缺失 `400 input_blob_missing`、超上限 `400 too_many_inputs` / `400 inputs_too_large`、重名 `409 duplicate_input_name`、名字不安全 `400 bad_request`），任何失败都不建任务；通过后在任务开始前把 blob 物化到 `inputs/<task_id>/`（cwd 相对，见 [§6.7](06-execution.md#67-工作区一份持久)），任务书里列出相对清单，终态删除目录。

**输出**：结论文本内联在 `status.message`（[§6.11](06-execution.md#611-任务结果与产物)）；大文件由子节点 `publish` 后把 URL 写进结论文本，origin 按需 `GET`，**不自动全量回传**，避免把网络当同步盘。只有 Echo 脚本会产生 `artifacts` 数组（`artifactId` 就是 `blob_id`）。

方向始终是 origin → target 的请求（上传素材、下载产物），target 从不反向连 origin。NAT 下只需要 target 可达，与 [§3.2](03-membership.md#32-引导与加入) 的单向出站原则一致。

### 5.7 交接（工作区即态势）

A 在 B 上跑完一段，想把后续交给 C（另一台机器、另一个模型，或者只是 A 要关机）。**协议里没有“接续”这个概念**：没有 `continuation_of` 字段，没有来源 task 校验，也没有等待/接管的状态机。

交接靠工作区本身：

- 同一 workgroup 的任务共用一份持久工作区（[§6.7](06-execution.md#67-工作区一份持久)）：workgroup 根是执行现场（agent 的 cwd），`notes/` 是跨 session 的状态备忘。
- 后到的 C 发起一个**普通新任务**；B 的 agent 在 workgroup 根里看代码、看 diff、看 `notes/` 里上一次的结论，自己判断该接着干什么、从哪一步开始。
- 这就是“态势感知”：它需要读文件、看测试结果、判断语义，只有 LLM 做得好；协议层只能表达“我声明要接续某个 task”，既保证不了正确性，还把判断从 agent 手里拿走了。

协议只保证两件与交接有关的事：

- 工作区跨任务、跨 session、跨重启持久（[§6.7](06-execution.md#67-工作区一份持久)）；
- 同一 orca node 单槽串行（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)），所以不会有两个任务同时写同一份工作区。

旧 task 天然不可变：C 的新任务和 A 的旧 task 是两个独立记录，追溯靠时间戳与 task id 还原，不需要一个指向“前一个 task”的字段。

一句话：**交接 = 共享工作区里的现场 + 一个新任务**；协议不解释“接着干”，agent 自己看现场决定。

---
