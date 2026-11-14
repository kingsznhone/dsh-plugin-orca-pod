# 05 任务

> 本章描述任务的数据模型与生命周期：如何标识、如何回报、如何取消、结果放在哪里、任务如何接续。

## 5. 任务

### 5.1 任务标识与元数据

```json
{
  "workgroup_id": "orca-dev",
  "origin_node": "N7K3QM",
  "target_node": "P2W8XA",
  "trace_id": "01J...",
  "idempotency_key": "N7K3QM:ctx-42:1",
  "task_ttl_s": 3600,
  "grant_id": "g_01JABC",
  "workspace": { "kind": "group" },
  "continuation_of": null,
  "pod": { "hop": 0, "chain": ["N7K3QM"], "root": "t_01JABD", "notify": "auto" }
}
```

规则：

- `task_id` 由 A2A server（目标 orca node）生成；origin 保存 `(target_node, task_id)` 映射。
- `context_id` 把多个 task 归到同一逻辑会话；目标 orca node 把它映射到本地 DSH session，cwd 固定为本 orca node 的工作区（[§6.7](06-execution.md#67-工作区一份持久)）。
- `idempotency_key` 作用域 = 同一 workgroup 内；目标 orca node 去重窗口默认 24h。它只防重复提交，不承担重发。
- `trace_id` 跨 orca node 传递；`task_ttl_s` 是任务寿命，不是转发跳数（本设计无转发）。
- `pod.hop`：任务已经跨了几跳。origin 建 task 时为 0。target 是否接受 `hop > 0` 由 `delegation.max_hop` 决定（默认 **0** → `400 hop_limit`；可配 1–3）。target 上的 agent 新建子任务时，由网关注入 `hop+1` 与 `chain + [self]`，agent 不能自己写。
- `pod.chain`：经过的 node_id 列表（祖先路径），只用于环检测，不做路由；target 若发现自己已在链中 → `403 ancestor_call_forbidden`（`chain` 由网关注入，正常不会出现重复）。
- `pod.root`：这条调用树的根 task id，扇出预算按它计（`max_fanout`）。origin 建 task 时等于自己的 task id。
- 任务本身不转发：多跳是 target 上的 agent **新建**子任务，不是把原任务转出去；原任务仍只属于它的 origin。
- **祖先禁调（硬限制）**：子任务的目标集合必须排除 `pod.chain` 里的所有 orca node 和自身。尝试调用 → `403 ancestor_call_forbidden`。这条不受 `max_hop` 影响，开了多跳也一样——A→B→A 在第一次就被拒绝，而不是等到第 N 跳才断。
- 被祖先禁调挡住时，正确动作是把问题写进 `input-required` + `blocked`（[§4.8](04-transport.md#48-任务状态机)），让 A 看到后决定下一步；不是换条路再调回去。
- 这两个字段都进签名；target 只读不写。
- `grant_id` 指向 origin 签发的 grant；目标 orca node 校验其绑定关系（[§7.11](07-security.md#711-grant)）。
- `workspace.kind` 当前只有 `"group"` 一个合法值，显式声明“在本 orca node 工作区执行”；没有发布式目录（[§6.12](06-execution.md#612-明确不做)）。
- `continuation_of`：接续的来源 task id。非空时表示“这是 C 接着 A 的活”，target 校验来源 task 已终态且同 workgroup（[§5.7](05-tasks.md#57-任务接续c-接着在-b-上干)）。旧 task 本身不改。
- `pod.notify`：`"auto" | "inbox" | "wake"`，默认 `"auto"`。决定任务终态时怎么回 origin 的会话；`auto` 的判定规则见 [§5.2](05-tasks.md#52-任务回报)「完成唤醒」。它只是 origin 本地的投递策略，target 不关心，也不进 target 的授权判断。

### 5.2 任务回报

```text
origin: POST message/send（带 grant）→ { task_id }
origin: 本地任务日志落库（state=dispatched）
origin: 轮询 tasks/get，500ms 起，指数退避到 2s
target: task store（SQLite，见 §5.5）推进 submitted/working/completed
origin: 终态 → 落结果 + 展示工作区状态 → 停止轮询
```

**Phase 0 现状**：协议层已经支持 `tasks/get` 轮询；`scripts/cross.ts task` 用固定 100ms、最多 300 次轮询到终态，只是联调脚本。下面的退避与自动判定属于 plugin tracker 的设计，尚未实现。target 侧 TTL 已实现：默认 3600s，可由 `metadata.pod.task_ttl_s` 覆盖，到期置 `failed(reason=timeout)`；origin 侧超时后补发 `tasks/cancel` 也尚未实现。

轮询规则（plugin 目标实现）：

- 初始 500ms，退避到 2s，加 ±20% 抖动；
- 终态立即停；连续 `404` 说明目标重启丢了 task → 记 `failed(reason=task_lost)`；
- 连续连接失败达到 `offline_after`（≈12s）→ origin 直接记 `failed(reason=node_unreachable, effects_unknown=true)`，**不重发**（[§8.2](08-reliability.md#82-orca-node-失联-任务失败不重发)）；
- 总时长受 `task_ttl_s` 约束，超时记 `failed(reason=timeout)` 并发 `tasks/cancel`（若还能连上）。

#### 轮询归 Host，不归 agent

轮询是插件的后台行为，不是 agent 的一条命令：

- `pod_send` 建完 task 立刻返回 `task_id`，不挂着连接等结果；
- 插件里的 tracker 按上面的参数拉 `tasks/get`（target 开了 `message/stream` 就改成持有一条 SSE），状态写进内存与本地任务日志；
- agent 只看到薄工具，没有一个会阻塞：`pod_send`（建完 task 立刻返回 `task_id`）、`pod_status(task_id)`（读缓存/任务存储，立即返回）、`pod_cancel(task_id)`、`pod_members()`。**没有 `pod_wait`**——等待不是 agent 的职责。

**Phase 0 现状**：`orca-pod` 插件已注册 `pod_send`/`pod_status`/`pod_cancel`/`pod_members` 四个工具（见 [§9.4](09-implementation.md#94-组合入口库根在-orca_nodets安装根是整个包)），但**后台 tracker、`inject`/`followup` 唤醒、`pod_wait`（已明确不做）都未实现**；当前完成通知要靠 agent 自己 `pod_status` 轮询，`scripts/cross.ts` 是联调入口。

派发即返回，所以 agent 的循环里没有“等”：任务在跑就继续干别的，或者干脆结束本轮、把控制权还给用户；完成会按 `notify` 注入或唤醒（[§5.2](05-tasks.md#52-任务回报) 完成唤醒）。target 忙（`429 node_busy`）时也没有可等的东西——要不要重试、什么时候重试，由模型判断（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)），不由协议层排队。

**为什么不让模型用 bash 长轮询**：`sleep 2 && pod_status` 每跑一次就是一次工具调用、一轮上下文；`timeout` 杀掉的是 shell 不是等待语义，容易留孤儿；退避策略交给模型，token 花在等待上而不是决策上。Host 有单调时钟、可取消、能挂 SSE，也知道任务该等多久。

状态怎么回到会话——不塞 user 消息，也不让 agent 猜：

| 事件 | 手段 | 效果 |
|---|---|---|
| 任务完成 / 失败（普通） | `agent.inject()` 写一条紧凑 notice（`pod task <id> completed: <一句话>`） | 落 `agent/inbox/spliced`，下一次 admitted step 自动进上下文；**不唤醒** agent，等下一次交互看到 |
| `input-required` 的 `permission_request`、祖先禁调的 `blocked`、需要人立刻决定 | `agent.followup()` | 唤醒 agent 开新一轮，走审批卡片/回报流程（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)） |
| 任何时刻用户主动问 | `pod_status` | 从任务存储/缓存读，与会话历史无关 |

只有“必须现在处理”的事件才 `followup()`——唤醒是有代价的（新一轮模型调用、可能打断用户）。普通完成一律 `inject()`，让它在下次交互时自然出现。

`followup()` 的语义与边界：

- 它只对**仍然活着**的 session 有效：DSH 进程里还有这个 `Agent` 实例，插件才有对象可唤醒。会话已关闭/归档时没有对象，任务结果留在任务存储里，等会话下次恢复时再由 `inject()` 进入上下文——不存在“插件把 DSH 会话从磁盘拉起来”。
- 被唤醒的 turn 不是用户消息：上下文从注入的 notice 开始，UI 里表现为同一会话里新的一轮 assistant 回复，不会伪造一个 user 气泡。
- 它继承该 session 的审批策略：唤醒后若需要权限，仍然弹 DSH 卡片；用户不在电脑前就会超时。
- 因此“完成即唤醒”按任务声明：`pod.notify` 为 `auto`（默认）、`inbox` 或 `wake`；想做“用户离开时提醒”，也可以由客户端插件做徽标/桌面通知，而不是让模型空转一轮。

会话日志仍是唯一事实源：`inject()` 的内容以 `agent/inbox/spliced` 落日志；任务状态本体在任务存储里，`pod_status` 随时可重放，插件内存只是缓存。

CLI 的 `orca-node wait <task_id>` 只给人和测试用（harness、脚本、没装插件的机器），不作为 agent 工具暴露——那是 [§9.4](09-implementation.md#94-组合入口库根在-orca_nodets安装根是整个包) 里 harness 入口的一部分。

#### 完成唤醒（notify: auto）

典型场景：A 把“编译验证”派给 B，A 结束这一轮；十几分钟后 B 完成，A 需要被叫醒、看结果、继续修。默认的 `inbox` 做不到这件事——用户不回来就没人看。所以默认是 `auto`：

`auto` 的判定只在 origin 侧：

- 任务是在**哪一轮**派发的，插件记着；
- 那一轮结束时（`turn/end`）任务仍未终态 → 这个 task 标记 `wake_pending`；
- 若同一轮内就拿到终态（agent 还在、`pod_status` 已经能读到），只 `inject()`，不唤醒。

真正 `followup()` 需要同时满足：

| 条件 | 不满足时 |
|---|---|
| `wake_pending` 为真 | 按 `inbox` 处理 |
| session 仍活着（有 Agent 实例） | 结果留在任务存储，会话恢复时 `inject()` |
| 当前 idle（没有 turn 在跑） | 等这一轮结束后再判断，不打断 |
| 派发后用户没有发过新消息 | 用户在场，结果进 inbox 等下一轮 |

其余细节：

- **合并**：2s 窗口内到达的多个终态合成一条 notice、一次 `followup()`；五个任务同时完成不该叫醒五次。
- **唤醒后的指令**：注入的 notice 带一句明确要求——“这是后台任务完成，接着干：检查结果，修/继续/汇报；只有被阻塞才问用户；结束时一句话总结”。避免唤醒后模型又去问“你想让我做什么”。
- **预算**：连续后台唤醒轮次 ≤3（中间没有用户输入）；超了就不再唤醒，结果标未读并留在 inbox。用户下一次说话重置。这是防 A→B→A 自动循环烧 token 的闸，不是防正常续跑。
- **不反向**：唤醒是 origin 自己对自己做的，不涉及任何 target→origin 的连接；B 那边只是任务变终态。

例子：A 的 `pod_send` 带 `notify: "auto"`，随后 `turn/end`；B 在 12 分钟后 `completed`；插件看到 `wake_pending` + idle + 用户没回来 → `inject()` notice + `followup()`；A 开新一轮，读到 `status.message`，发现编译报错，继续改代码。若编译通过，A 一句话总结并停。

### 5.3 取消

`tasks/cancel` 必须传到 LocalExecutor：

- ACP：`session/cancel`，等待确认，超时后终止子进程；
- headless：终止进程树（Windows 用 Job Object，Linux 用 process group）；
- in-process：调取消钩子。

取消后 task 置 `canceled`；若执行器已完成，返回 `completed` 并说明“取消未生效”。取消同时**吊销该 task 的 grant**（[§7.11](07-security.md#711-grant)）。

### 5.4 流式与隐私

- ACP `session/update` 可能含 assistant message、thought、tool call、usage。
- 只把**已提交助手消息、工具状态、最终 artifact**映射给 A2A。
- 不转发原始 thought / chain-of-thought。
- 不暴露本地绝对路径、环境变量、凭据；artifact 用相对路径 + manifest（[§6.11](06-execution.md#611-任务结果与产物)）。
- artifact 有类型与大小上限；超限改引用或拒绝。

### 5.5 任务存储

每个 orca node 的 task store 是它自己产生的 task 状态的唯一事实来源。2–10 个 orca node 不需要数据库服务：一个文件、一个进程、可备份，就是全部要求。

**Phase 2 现状（已实现）**：`storage.ts` 定义 `TaskStore` 接口（`save/load/list`），`sqlite.ts` 用 Node 内置 `node:sqlite` 的 `DatabaseSync` 实现：`<data_root>/tasks.db`、WAL 模式、`synchronous=NORMAL`，一条 task 记录序列化进 `tasks(task_id, payload, updated_at)`。`tasks.ts` 在每次状态变迁后写入，并在 orca node 启动时把库里所有非终态 task 标成 `failed(node_restart)`（[§8.3](08-reliability.md#83-目标重启)）；`tasks/get` 对不在内存的 task 回落到 SQLite，因此重启后仍可查。内存 `TaskStore` 保留给单测与 harness。尚未做：`task_events` 表、origin 侧本地任务日志、`blobs` 表（blob 元数据目前在 fs sidecar 里）。

**目标字段**（当前 payload JSON 已包含其中的视图部分，`target_node/workgroup_id/session_id/grant_id` 等字段随里程碑补齐）：

```text
task_id, context_id, origin_node, target_node,
state, created_at, updated_at,
idempotency_key, trace_id, grant_id,
workgroup_id, session_id, artifacts, error, reason
```

持久化：

- **单机 SQLite**：`<data_root>/tasks.db`，WAL 模式，`synchronous=NORMAL`；
- 表：`tasks`（状态与元数据，已实现）、`task_events`（状态变迁与错误，未实现）、`blobs`（blob_id + size + name + refs + expires_at，未实现；当前在 fs sidecar）；
- 一个进程独占写；不做连接池、不做服务、不共享库；
- 备份 = 拷贝 db（WAL 下先 checkpoint）；损坏时允许丢未落盘的最近事件，不允许静默重建；
- 内存 store 只用于协议单测与 harness。

发起 orca node 另有**本地任务日志**（同一张表的 `role=origin` 行或独立表），只记录“我派过什么、最后一次看到什么”，不与目标库对账（[§8.2](08-reliability.md#82-orca-node-失联-任务失败不重发)）。

**可见性**

- 同 workgroup 的任意 orca node 凭 `task_id` 可 `tasks/get`；没有列表接口，`task_id` 就是句柄（ULID，不可枚举）。
- origin 额外拥有交互权：`input-required` 后补发消息、`tasks/cancel`；其他 orca node 只读（不能取消、看不到 live 事件）。
- 因此**`task_id` 泄露 = 结果泄露**。它只该出现在任务消息、审计和给人看的日志里，不要贴到公开 issue 或截图里。
- 同组是信任域：密钥共享、orca node 身份可伪造，所以“谁能读”是约定与审计问题，不是密码学保证（[§7.1](07-security.md#71-workgroup-与密码)）。

**Phase 0 实现**：`tasks/get`、`tasks/cancel` 与 `message/send` 恢复只校验 workgroup 签名，不区分 origin 与其他同组 orca node；上面“origin 额外拥有交互权、其他 orca node 只读”尚未实现。修复前应把 `task_id` 当作同组内可读写的句柄。

### 5.6 文件交换（blob 通道）

任务素材与产物不走 JSON 内联：base64 会膨胀 33%，而且没法流式、没法续传、没法去重。单独一条内容寻址通道：

```http
POST /blobs
Authorization: Pod node_id=N7K3QM; ts=...; nonce=...; proof=...
X-Pod-Body-SHA256: <hex>
Content-Type: application/octet-stream
Content-Length: 1048576

<bytes>

201 { "blob_id": "<sha256>", "size": 1048576, "name": "input.zip", "expires_at": "2026-11-21T..." }
```

```http
GET /blobs/<blob_id>
Authorization: Pod ...

200 <stream>
```

```http
POST /blobs/<blob_id>/link
Authorization: Pod ...

200 { "url": "https://host.example/blobs/<id>?exp=...&sig=...", "expires_at": "..." }
```

规则：

- `blob_id = sha256(bytes)`，内容寻址 → 天然去重；同内容重复上传返回 `200` 且不占新空间，首次返回 `201`。
- 上传必须带 `X-Pod-Body-SHA256` 并被签名覆盖；服务端边收边算，落盘后不一致 → `400 blob_digest_mismatch` 并删除。签名不覆盖 body 本身，避免为 1 GiB 文件算两遍哈希。
- 上限：单文件默认 256 MiB，每 workgroup 默认 5 GiB；超限 `413`。
- 文件名只作提示（`name`），不参与寻址；存储路径由 blob_id 决定，元数据里出现 `../`、绝对路径、驱动器号一律拒绝。
- 生命周期：默认 7 天未被任务引用即 GC；被任务引用则延长到任务终态 + 24h。GC 是本地行为，不传播；下载方拿不到就是被清了，按 `410 blob_expired` 处理。**GC 全自动，不依赖用户到子 orca node 手动清理**——没人会去 B 的机器上清 blob；要保住某个产物，就在 7 天内下载它，或让它继续被任务引用。
- 下载支持短期直链：任意同组 orca node 调 `POST /blobs/{id}/link` 拿 TTL 5 分钟的 URL，方便 `curl` / 浏览器 / 前端直链，不必把长期密钥给第三方。直链只是省掉签名头，不改变可读范围。
- **不做 per-blob ACL**：同 workgroup 的任意 orca node 知道 `blob_id` 就能 `GET`。跨 orca node 直取（C 去 B 拿 A 的产物）是设计目标，不要加一层“看起来更安全”的检查。
- **blob 不可枚举**：知道 `blob_id` 才能取，没有列表接口；id 是内容哈希，不泄露目录结构。跨 orca node 交接产物就是传一个 id；id 泄露 = 内容泄露，按这个标准管理它。
- 不做目录树、不做 rename、不做覆盖：要改内容就是新 blob。

**实现状态**：`POST /blobs`、`GET /blobs/{id}`、`POST /blobs/{id}/link` 已实现；存储默认 fs（内容寻址目录 + sidecar 元数据 + 临时文件 rename），`gc()` 在 orca node 启动时跑一次，默认 7 天过期；`201/200` 去重、`X-Pod-Body-SHA256` 校验（`400 blob_digest_mismatch`）、256 MiB 上限（`413 blob_too_large`）、文件名清洗（`400 bad_blob_name`）已可用。直链用 `?exp=&sig=`：`sig = base64url(HMAC(k, "link|"+blob_id+"|"+exp))`，TTL 300s；未知 blob `404`、过期直链 `403 link_invalid`/`410`。**未实现**：每 workgroup 5 GiB 配额、引用延期（目前只看 ttl 不看任务引用）、`Content-Disposition` 文件名恢复、断点续传。

**输入**：origin 先把素材 `POST /blobs` 到 target，任务消息里带 `inputs: [{blob_id, name, media_type}]`；target 直接读本地已落盘的 blob（上传即到达），不需要回源。小于 64 KiB 的可以直接内联 `bytes`（A2A file part），省一次往返。

**输出**：任务终态时 manifest 给 `artifacts: [{blob_id, name, media_type, bytes}]`；origin 按需 `GET /blobs/{id}`。**不自动全量回传**：大产物由人或 agent 显式取，避免把网络当同步盘。

方向始终是 origin → target 的请求（上传素材、下载产物），target 从不反向连 origin。NAT 下只需要 target 可达，与 [§3.2](03-membership.md#32-引导与加入) 的单向出站原则一致。

### 5.7 任务接续（C 接着在 B 上干）

A 在 B 上跑完一段，想把后续交给 C（另一台机器、另一个模型，或者只是 A 要关机）。协议不复活旧 task，而是**在同一 context 上开一个新 task**：

```json
// C → B: message/send
{
  "context_id": "<A 用过的 context_id>",
  "message": { "parts": [{ "kind": "text", "text": "接着 A 的进度继续" }] },
  "metadata": { "pod": { "continuation_of": "t_01JABD" } }
}
```

规则：

- `continuation_of` 指向的 task 必须**已终态**且同 workgroup；还在跑就 `409 task_not_terminal`——先等它结束或 `tasks/cancel`，不允许两个 orca node 同时写一个工作区（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事) 单槽）。
- 工作区原地复用：C 的新任务和 A 的旧任务落在同一个 `<data_root>/workgroups/<id>/`，文件、`notes/`、产物都在，不需要拷贝。
- 上下文恢复尽力而为：target 优先 `session/resume(context_id)`；失败则以新 session 启动，把 `notes/` 与旧 task 结论注入首条 prompt，并在结果里记 `resume=degraded`。降级不是错误，但必须可见。
- 旧 task 不变：状态、artifact、`updated_at` 都不动；新 task 元数据里记 `continuation_of`，审计能还原“A 干的前半段、C 干的后半段”。
- C 先要拿到 `task_id`（A 告诉它，或 `tasks/get` 里看到 `context_id`）；没有列表接口，所以接续也是“凭 id 交接”。
- 不推送、不回调：B 不会通知 C“A 停了”，C 必须自己发起（单向出站）。

一句话：**接续 = 新任务 + 旧上下文 + 原地工作区**；task 的不可变性不破，工作区的连续性也不破。

---
