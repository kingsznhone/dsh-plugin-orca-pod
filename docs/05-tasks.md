# 05 任务

> 本章描述任务的数据模型与生命周期：如何标识、如何回报、如何取消、结果放在哪里、任务之间如何交接。

## 5. 任务

### 5.1 任务标识与元数据

任务元数据是 `message/send` 的 `params.metadata`；节点相关的部分在 `metadata.pod`：

```json
{
  "pod": {
    "permission_mode": "workspace-write",
    "model": { "provider": "deepseek", "model": "deepseek-flash", "reasoningEffort": "high" },
    "reasoning_effort": "high",
    "task_ttl_s": 1800
  }
}
```

规则：

- `task_id` 由 target 生成（ULID 形状：48 位毫秒时间戳 + 80 位随机，26 字符，按创建时间排序，不可枚举）；origin 在派发日志里记 `(peer, task_id)`。
- **origin 是请求的签名者**（`origin_orca_node`），不由元数据声明。`context_id` 取 `message.contextId`，缺省等于 task id；目标 orca node 把 `(origin, context_id)` 映射到本地 ACP session，cwd 固定为 workgroup 根（[§6.10](06-execution.md#610-sessioncontext-与-workspace-的绑定)）。
- `pod.origin_orca_node`：target 在建任务时按签名者写进任务视图，让读任务的人（面板）不必再查一次；调用方自己带的值被覆盖。
- `pod.permission_mode`：origin 会话的权限模式（`read-only` / `workspace-write` / `danger-full-access`）；缺省按 `read-only`；本机 `permission_mode` 是上限，取两者较窄（[§7.10](07-security.md#710-权限模式继承)）。非法值 → `400 bad_request`。
- `pod.model` / `pod.reasoning_effort`（可选）：origin 想用的模型与 effort；由 ACP 执行器用 `session/set_config_option` 落地，选不到就 `failed(model_unavailable)`，不会退回默认模型（[§6.15](06-execution.md#615-按任务选择模型)）。
- `pod.task_ttl_s`（可选）：origin 期望的任务寿命；实际寿命取它与本机 `task_timeout_s`（默认 3600）的较小者。等待 `input-required` 时 TTL 暂停，恢复后重新计时（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- **任务只有一跳**：任务不转发，执行任务的 agent 也不能再派新任务（插件的 `send` 在执行器会话里拒绝，[§7.9](07-security.md#79-权限跟随发起-orca-node)）。做不完就以 `BLOCKED:` 结论交回 origin，由 origin 的会话决定把哪部分派给谁。元数据里因此没有调用链、根任务或跳数。
- 元数据是不可信输入：在 `submit` 时一次性解析成类型化的 `TaskMeta`，之后的代码不再读原始 metadata。`pod` 块类型不合法 → `400 bad_request`；`metadata.echo` 不合法 → `400 bad_echo_script`（[§6.3](06-execution.md#63-echoexecutor用脚本模拟任务)），不会建出任务。

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
- `send` 把任务写进本地派发日志；插件里的 tracker 每轮从派发日志查出未结束的任务，拉 `tasks/get`，把读到的状态写回派发日志（每次变化一条 `UPDATE`）。派发日志的状态只有 tracker 写，`status`、面板与审批的读取都不写；
- agent 只看到一个薄工具 `orca_pod`，没有一个方法会阻塞：`send`、`status`（读目标侧任务状态，立即返回）、`cancel`、`members`、`connect`。**没有等待方法**——等待不是 agent 的职责，也没有批准方法（批准只在 UI，[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

派发即返回，所以 agent 的循环里没有“等”：任务在跑就继续干别的，或者干脆结束本轮、把控制权还给用户；完成会由 tracker 注入或唤醒。target 忙（`429 orca_node_busy`）时也没有可等的东西——要不要重试、什么时候重试，由模型判断（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)），不由协议层排队。

**为什么不让模型用 bash 长轮询**：每等一次就是一次工具调用、一轮上下文；`timeout` 杀掉的是 shell 不是等待语义，容易留孤儿；退避策略交给模型，token 花在等待上而不是决策上。Host 有单调时钟、可取消，也知道什么时候该停。

tracker 的行为：

- **轮询**：固定 1s，自调度（上一轮结束才排下一轮，不重叠）；插件启动即开始。每轮的工作集就是派发日志里未结束、且记着节点的条目，tracker 自己只记读失败的退避；没有节点在运行时一轮什么也不读。
- **瞬时失败**（超时、网络错误、5xx、节点不在线）：该任务按 1s 起翻倍、上限 30s 退避重试；连续 5 次失败后在派发日志里把它记成 `failed`（`last_error` 是最后一次的错误），停止轮询，告诉 agent `task … on … is failed; reason: …; this node could not read the task and stopped following it`。不补发 `tasks/cancel`。
- **确定性失败**（`404 task_not_found`、节点已不在节点表、401/403）：第一次读到就记成 `failed`，同样告知 agent。
- **终态**：照常合并成 notice。结论文本以 `BLOCKED` 开头的 completed 任务会被标注为“completed with a blocker report”（[§6.14](06-execution.md#614-acpexecutor)）。
- **权限请求**：任务进入 `input-required` 且带 `permission_request` 时，tracker 把它交给 `ApprovalBroker`（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）等 UI 作答，**不产生聊天 notice**，不唤醒 agent；任务继续被跟踪到终态。`input-required` 只因权限请求出现；任务因其他原因无法继续时以 `BLOCKED:` 结论结束，按上一条作为终态通知 agent。
- **与会话无关**（D45）：轮询哪些任务只看派发日志，不看宿主里开着哪些会话；没有发起会话的派发（`agent_id` 为空）也照常轮询，权限请求进面板。会话只在交付 notice 时用到：按条目的 `agent_id` 向宿主的 agent 注册表找会话，找到就 inject / followup，找不到（会话已关闭，或重启后还没恢复）就不通知，结果留在派发日志与面板里。
- **宿主重启**：不需要“恢复跟踪”。节点启动时把未结束的条目标成 `unknown`（[§8.3](08-reliability.md#83-目标重启)），tracker 下一轮照常读到真实状态。

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
- **预算**：连续后台唤醒轮次 ≤3（中间没有用户输入）。**用户给该 agent 发消息时重置**（监听 `agent/inbox/claimed` 且 `source.kind === "user"`）。这是防后台通知反复叫醒同一会话烧 token 的闸，不是防正常续跑。
- **不反向**：唤醒是 origin 自己对自己做的，不涉及任何 target→origin 的连接。
- `followup()` 只对**仍然活着**的 session 有效：DSH 进程里还有这个 `Agent` 实例，插件才有对象可唤醒。会话已关闭/归档时没有对象，任务结果留在目标侧任务存储里，靠 `status` 重读——不存在“插件把 DSH 会话从磁盘拉起来”。
- 会话日志仍是唯一事实源：`inject()` 的内容以 `agent/inbox/spliced` 落日志；任务状态本体在任务存储里，`status` 随时可重放，插件内存只是缓存。

`orca_pod` 的 `status` 随时读一个任务；重启后对账读的是 origin 侧派发日志（[§8.3](08-reliability.md#83-目标重启)），面板的“全部任务”就是它。没有 `wait`：完成由 tracker 自动通知，agent 不需要等。

### 5.3 取消

`tasks/cancel` 必须传到 LocalExecutor：

- ACP：发 `session/cancel`；2s 宽限后如果该 session 仍是连接上正在跑的那个，就关闭连接、终止子进程树（避免误杀已复用同一连接的下一个任务）；
- Echo：中止脚本。

取消后 task 置 `canceled`；挂着的权限请求随之作废（ACP 侧回 `cancelled`）。task 已是终态时原样返回，不报错、不改状态。

**谁可以取消**：只有 task 的 origin（以及执行该 task 的本机节点自身，用于本地控制路径）。同组其他成员可以 `tasks/get` 读，但 `tasks/cancel` 返回 `403 not_task_origin`——共享 workgroup 密钥下“同组”不等于“可以互相杀任务”，取消按任务归属校验而不是按签名身份。

### 5.4 流式与隐私

- ACP `session/update` 可能含 assistant message、thought、tool call、usage。
- 只累积 `agent_message_chunk` 的文本作为结论；thought、tool_call、usage 都不映射、不转发。
- 任务视图里没有流式事件：origin 只能轮询到状态与最终结论。
- 结论文本是 agent 自己说的话，节点不过滤其中的路径或凭据（[§7.15](07-security.md#715-凭据回传与注入防护)）。

### 5.5 任务存储

每个 orca node 的 task store 是它自己产生的 task 状态的唯一事实来源。2–10 个 orca node 不需要数据库服务：一个文件、一个进程、可备份，就是全部要求。

- **单机 SQLite**：`<data_root>/tasks.db`，Node 内置 `node:sqlite`，WAL 模式，`synchronous=NORMAL`；一个进程独占写；不做连接池、不做服务、不共享库。
- `tasks` 与 `dispatches` 结构相同——`(task_id TEXT PRIMARY KEY, payload TEXT /* JSON */, updated_at TEXT)`：`tasks`（目标侧任务：`{view, origin_orca_node, created_at, updated_at}`）、`dispatches`（origin 派发日志，[§8.3](08-reliability.md#83-目标重启)）。另有 `file_blobs`，列不同：`(blob_id TEXT PRIMARY KEY, path TEXT, size INTEGER, expires_at TEXT)`（`publish` 登记的本机文件）。
- 任务每次状态变迁都写库；`tasks/get` 先查内存，再回落 SQLite，所以重启后仍可查。进程启动时所有非终态 task 标 `failed(node_restart)`（[§8.3](08-reliability.md#83-目标重启)）。
- 备份 = 拷贝 db（WAL 下先 checkpoint）；落盘失败只记 warning，任务继续留在内存里可读。
- 内存 store 只用于协议单测与 harness。
- `file_blobs` 只记“blob_id → 本机路径”的映射，字节留在原处、不复制（[§5.6](05-tasks.md#56-文件交换blob-通道)）。

**可见性**

- 同 workgroup 的任意 orca node 凭 `task_id` 可 `tasks/get`；没有列表接口，`task_id` 就是句柄。
- origin 额外拥有交互权：`input-required` 后补发消息（`message/send` 带 `taskId`）与 `tasks/cancel`；其他成员只读。
- 因此**`task_id` 泄露 = 结果泄露**。它只该出现在任务消息和给人看的日志里，不要贴到公开 issue 或截图里。
- 同组是信任域：密钥共享，“谁能读”是约定与信任问题，不是密码学保证（[§7.1](07-security.md#71-workgroup-与密码)）；取消与恢复按 task 归属校验。

### 5.6 文件交换（blob 通道）

文件不走 JSON 内联（base64 会膨胀 33%，也没法流式），也不在节点之间推送：**节点只发布自己机器上的文件，谁需要谁来拉**。**文件不是任务的一部分**（D46）：任务模型里没有文件字段，交接靠文本——origin 把要交给任务的文件发布出去、把名字写进任务文本；任务里的 agent 按名字取，把要交回的文件发布出去、把名字写进结论。blob 只管登记、下载与过期清理，不知道任务的存在。

**文件的名字不含地址**：一个文件写作 `<orca_node_id>/<sha256>`——谁发布的、内容哈希是什么。取文件的一方问**自己的**节点，由它按成员表里对方宣告的地址、用和心跳相同的顺序去拨（上次成功的地址在前，来自他人名单的候选地址先筛查，[§7.7](07-security.md#77-ssrf--候选端点防护)）。发布方在反代后面、有多张网卡或 IPv4/IPv6 双栈都不影响：它只要在 `endpoints` 里宣告取得到它的地址（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。

```http
GET /blobs/<blob_id>                         # 成员签名；只读本节点发布的文件，答复签名覆盖 status 与 blob_id
```

两边的 agent 都用同一个工具 `orca_pod` 的两个方法：`publish`（`path`，可选 `ttl_s`）把本机文件登记到本机节点、返回名字；`fetch`（`ref`、`output`）按名字取任一成员发布的文件，写到会话沙箱允许写的位置。

- **宿主 agent**：工具和节点在同一个进程里，直接调用节点。
- **任务里的 agent**：任务在宿主的 profile 里运行（[§6.14](06-execution.md#614-acpexecutor)），所以插件也在那个 `dsh` 进程里；看到 `ORCA_POD_IN_TASK=1` 时它不起节点，只注册只有 `fetch`/`publish` 两个方法的 `orca_pod`，经本机节点的**本地路由**办事。执行器启动子进程时注入 `ORCA_POD_NODE_URL`（本机节点的 loopback 地址）与 `ORCA_POD_NODE_TOKEN`（节点每次启动随机生成的令牌）。

```http
GET  /blobs/<blob_id>                        # 成员签名；只读本节点发布的文件，答复签名覆盖 status 与 blob_id
POST /local/blobs           { path, ttl_s? } # 本机进程带 x-orca-local 令牌；登记 path，答 { ref, size, expires_at }
GET  /local/blobs/<node>/<blob_id>           # 同上；本节点的直接读，别的成员的由本节点按拨号顺序去拉
```

规则：

- **登记即复制**：节点把文件复制进自己的 `<data_root>/blobs/<sha256>`（先写临时文件、边写边算哈希，再改名到位），`file_blobs` 表把 `blob_id → {副本路径, size, expires_at}` 记下，得到名字 `<orca_node_id>/<sha256>`。之后改动或删掉原文件都不影响别人取到的内容。同样的字节再登记一次，沿用已有副本，过期时间取两者中较晚的；`ttl_s = 0` 表示永不过期。
- **登记只在本机发生**：登记一个路径等价于授权读它，而同组共享 workgroup 密钥，任何成员都能让目标节点替它去读本机路径，所以登记不是成员路由。宿主工具在进程内直写；任务里的工具走 `local` 访问级别的本地路由，只认本节点的令牌（[§7.1](07-security.md#71-workgroup-与密码)）。令牌在任务进程的环境变量里，任务 agent 的 shell 也读得到；它能做的事和工具相同，按非对抗前提接受（D39）。
- **获取**：`mesh.get(<发布方>).fetchBlob(blob_id)`：发布方是自己就直接读盘；是别的成员就按拨号顺序逐个地址试，对方一旦作答（包括 `404`）就以它为准，只有连不上才换下一个地址，全都连不上 → `503 peer_not_online`；不是成员 → `404 unknown_orca_node`。下载流式进行，不受普通响应 4 MiB 上限的约束；截止时间只管等到对方开始作答，不管传输多久。写盘时边写临时文件（`<目标>.part`）边算 `sha256`，与引用一致才改名到位，不一致就删掉并报错（文件按内容哈希命名，所以这一步同时是流式下载在没有整体签名时的完整性保证）。
- **写到哪里由会话沙箱决定**：`fetch` 的 `output` 必须在会话沙箱可写的范围内。`read-only` 的会话写不了任何地方，所以**需要收文件的任务要以 `workspace-write` 派出**。
- **节点不接收别人的字节**：没有上传路由，也就没有接收侧的配额、临时文件与垃圾回收。
- **读取要成员签名**：`GET /blobs/{id}` 的访问级别是 `member`，没有可以转交给组外的无签名链接。面板经本机的 `/orca-api/blob` 中转（[§9.2.1](09-implementation.md#921-同源桥pluginwebts)）。
- **生命周期归 blob 自己**：登记默认 **7 天**过期。节点启动时清扫一次，之后每小时一次：过期的行连同它的副本一起删除（副本正被下载、删不掉时保留这一行，下次再试）；老版本写的、指向发布者原文件的行只删行，不动那个文件。过期 → `410 blob_expired`；副本不在了 → `410 blob_file_missing`；没登记过 → `404 blob_not_found`。要保住某个文件，就在过期前取走它。
- **不做 per-blob ACL**：同 workgroup 的任意 orca node 知道名字就能取。跨 orca node 直取（C 去 B 拿 A 发布的文件）是设计目标，不要加一层“看起来更安全”的检查。
- **blob 不可枚举**：知道 `blob_id` 才能取，没有列表接口；id 是内容哈希，不泄露目录结构。id 泄露 = 内容泄露，按这个标准管理它。
- 不做目录树、不做 rename、不做覆盖：要改内容就是新文件、新登记。

**一次交接**（任务本身只带文本）：

```text
发起方（宿主 agent）                          目标节点（任务里的 agent）
orca_pod publish { path }  → <origin>/<sha256>
orca_pod send { peer, text: "… <origin>/<sha256> …" } ─────▶  任务书里只有这段文本
                                                    orca_pod fetch { ref: <origin>/<sha256>, output }
                                                      → 本机节点 /local/blobs/<origin>/<sha256> → 向 origin 拉取，校验 sha256
                                                    orca_pod publish { path } → <target>/<sha256>
                                                    结论："… <target>/<sha256> …"
tracker 通知（结论文本） ◀──────────────────────────
orca_pod fetch { ref: <target>/<sha256>, output }  → 写到 output（经会话沙箱检查可写），校验 sha256
```

- 这要求 **target 能连到 origin**：全互联 mesh 里两边互相在线即满足；origin 在对端看来是 `suspect(unreachable)`（例如在 NAT 后）时取不到，文件需要放到双方都能访问的节点上。
- 取不到（发布方离线、已过期、哈希不符）只是这一次 `fetch` 失败；任务继续，由 agent 决定怎么办（例如以 `BLOCKED:` 结论交回）。

**输出**：结论文本内联在 `status.message`（[§6.11](06-execution.md#611-任务结果与交回的文件)），交回的文件以名字出现在文本里，origin 用 `orca_pod fetch` 按需取，**不自动全量回传**，避免把网络当同步盘。面板把结论文本里形如 `<节点 id>/<sha256>` 的名字显示成下载链接，这只是展示，没有语义。tracker 通知里的结论截到 800 字符，名字在后面时用 `status` 看完整结论。

**方向**：文件都由需要它的一方发起请求——交回的文件是 origin 去 target 取，交给任务的文件是 target 去 origin 取；没有任何一方往对方推字节。

### 5.7 交接（工作区即态势）

A 在 B 上跑完一段，想把后续交给 C（另一台机器、另一个模型，或者只是 A 要关机）。**协议里没有“接续”这个概念**：没有 `continuation_of` 字段，没有来源 task 校验，也没有等待/接管的状态机。

交接靠工作区本身：

- 同一 workgroup 的任务共用一份持久工作区（[§6.7](06-execution.md#67-工作区一份持久)）：workgroup 根是执行现场（agent 的 cwd）。要不要记笔记、记在哪里，由 agent 自己决定，节点不规定、也不列出。
- 后到的 C 发起一个**普通新任务**；B 的 agent 在 workgroup 根里看代码、看 diff、看前面的任务留下的东西，自己判断该接着干什么、从哪一步开始。
- 这就是“态势感知”：它需要读文件、看测试结果、判断语义，只有 LLM 做得好；协议层只能表达“我声明要接续某个 task”，既保证不了正确性，还把判断从 agent 手里拿走了。

协议只保证两件与交接有关的事：

- 工作区跨任务、跨 session、跨重启持久（[§6.7](06-execution.md#67-工作区一份持久)）；
- 同一 orca node 单槽串行（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)），所以不会有两个任务同时写同一份工作区。

旧 task 天然不可变：C 的新任务和 A 的旧 task 是两个独立记录，追溯靠时间戳与 task id 还原，不需要一个指向“前一个 task”的字段。

一句话：**交接 = 共享工作区里的现场 + 一个新任务**；协议不解释“接着干”，agent 自己看现场决定。

---
