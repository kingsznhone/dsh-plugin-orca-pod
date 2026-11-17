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
- **任务只有一跳**：任务不转发，执行任务的 agent 也不能再派新任务（CLI 与插件的 `send` 在执行器会话里拒绝，[§7.9](07-security.md#79-权限跟随发起-orca-node)）。做不完就以 `BLOCKED:` 结论交回 origin，由 origin 的会话决定把哪部分派给谁。元数据里因此没有调用链、根任务或跳数。
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
- **预算**：连续后台唤醒轮次 ≤3（中间没有用户输入）。**用户给该 agent 发消息时重置**（监听 `agent/inbox/claimed` 且 `source.kind === "user"`）。这是防后台通知反复叫醒同一会话烧 token 的闸，不是防正常续跑。
- **不反向**：唤醒是 origin 自己对自己做的，不涉及任何 target→origin 的连接。
- `followup()` 只对**仍然活着**的 session 有效：DSH 进程里还有这个 `Agent` 实例，插件才有对象可唤醒。会话已关闭/归档时没有对象，任务结果留在目标侧任务存储里，靠 `status` 重读——不存在“插件把 DSH 会话从磁盘拉起来”。
- 会话日志仍是唯一事实源：`inject()` 的内容以 `agent/inbox/spliced` 落日志；任务状态本体在任务存储里，`status` 随时可重放，插件内存只是缓存。

CLI 的 `orca-node wait <task_id>` 只给人和测试、以及 ACP 会话里的 agent 用（它们没有插件工具），不作为插件工具暴露；`orca-node log [--json]` 直接读 origin 侧派发日志（[§8.3](08-reliability.md#83-目标重启)），用于重启后对账。

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

文件不走 JSON 内联（base64 会膨胀 33%，也没法流式），也不在节点之间推送：**节点只发布自己机器上的文件，谁需要谁来拉**。任务的产物由 target 发布、origin 拉取；origin 要交给任务的文件，由 origin 发布、target 上的 agent 拉取。

**文件的名字不含地址**：一个文件写作 `<orca_node_id>/<sha256>`——谁发布的、内容哈希是什么。取文件的一方问**自己的**节点，由它按成员表里对方宣告的地址、用和心跳相同的顺序去拨（上次成功的地址在前，来自他人名单的候选地址先筛查，[§7.7](07-security.md#77-ssrf--候选端点防护)）。发布方在反代后面、有多张网卡或 IPv4/IPv6 双栈都不影响：它只要在 `endpoints` 里宣告取得到它的地址（[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）。

```text
# 在本机登记一个文件（不经过网络，不需要节点在跑）
$ orca-node publish ./report.md --ttl 86400
<orca_node_id>/<sha256>

# 在任何成员上取它：本机节点找到发布方并拉取，写盘前校验 sha256
$ orca-node fetch <orca_node_id>/<sha256> --output report.md
```

```http
GET /blobs/<blob_id>                         # 成员签名；只读本节点发布的文件
GET /cluster/blob?node=<id>&blob=<blob_id>   # 仅本机：本节点替 CLI 去取任一成员的文件
```

规则：

- **登记**：`orca-node publish <path> [--ttl <seconds>]`：CLI 算 `sha256`、把 `blob_id → {绝对路径, size, expires_at}` 写进本机 SQLite 的 `file_blobs` 表，打印文件名 `<orca_node_id>/<sha256>`。字节不复制，`GET` 时网关按映射从磁盘流式读出；映射跨重启保留。同一文件重复登记得到同一个 `blob_id`，并刷新过期时间。
- **登记不是 HTTP 路由**：登记一个路径等价于授权读它，而同组共享 workgroup 密钥，任何成员都能让目标节点替它去读本机路径，“只有本机能登记”无法靠成员签名在网络层实现，所以登记只在本地发生：CLI 直写节点自己的数据库。这也让登记不依赖节点进程。
- **获取**：`orca-node fetch <ref> [--output <path>]` 经回环的 `GET /cluster/blob` 让本机节点去取：引用的是自己就直接读盘；是别的成员就按拨号顺序逐个地址试，对方一旦作答（包括 `404`）就以它为准，只有连不上才换下一个地址，全都连不上 → `503 peer_not_online`；不是成员 → `404 unknown_orca_node`。下载流式进行，不受普通响应 4 MiB 上限的约束；截止时间只管等到对方开始作答，不管传输多久。CLI 边写临时文件边算 `sha256`，与引用一致才改名到位，不一致就删掉并报错。
- **节点不接收别人的字节**：没有上传路由，也就没有接收侧的配额、临时文件与垃圾回收。
- **读取要成员签名**：`GET /blobs/{id}` 的访问级别是 `member`，没有可以转交给组外的无签名链接。面板经本机的 `/orca-api/blob` 中转（[§9.2.1](09-implementation.md#921-同源桥pluginwebts)）。
- **生命周期**：登记默认 **7 天**过期（`--ttl` 可改，`--ttl 0` 不过期）。过期 → `410 blob_expired`；文件被删或移走 → `410 blob_file_missing`；没登记过 → `404 blob_not_found`。文件本身属于工作区，节点不删；要保住某个产物，就在过期前取走它。
- **不做 per-blob ACL**：同 workgroup 的任意 orca node 知道名字就能取。跨 orca node 直取（C 去 B 拿 A 的产物）是设计目标，不要加一层“看起来更安全”的检查。
- **blob 不可枚举**：知道 `blob_id` 才能取，没有列表接口；id 是内容哈希，不泄露目录结构。id 泄露 = 内容泄露，按这个标准管理它。
- 不做目录树、不做 rename、不做覆盖：要改内容就是新文件、新登记。

**交给任务的文件**：origin（人通过插件工具，或上游任务里的 agent）先在本机 `publish`，把文件名写进任务书；target 上的 agent 读到后用 `orca-node fetch` 取到工作区，任务书的前言也这样提示（[§6.7](06-execution.md#67-工作区一份持久)）。节点不替 agent 预先下载、不物化、不清点数量与大小；`fetch` 是 agent 执行的命令，受本任务的权限模式约束（[§7.10](07-security.md#710-权限模式继承)）。这要求 **target 能连到 origin**：全互联 mesh 里两边互相在线即满足；origin 在对端看来是 `suspect(unreachable)`（例如在 NAT 后）时取不到，文件需要放到双方都能访问的节点上。

**输出**：结论文本内联在 `status.message`（[§6.11](06-execution.md#611-任务结果与产物)）；大文件由子节点 `publish` 后把文件名写进结论文本，origin 按需 `fetch`，**不自动全量回传**，避免把网络当同步盘。只有 Echo 脚本会产生 `artifacts` 数组：内容写进节点自己的 `state/<workgroup_id>/artifacts/<task_id>/`、按同样的方式登记，`artifactId` 就是 `blob_id`，发布者就是跑任务的节点。

**方向**：两类文件都由需要它的一方发起请求——产物是 origin 去 target 取，交给任务的文件是 target 去 origin 取；没有任何一方往对方推字节。

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
