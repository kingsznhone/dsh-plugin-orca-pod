# orca-pod 审计：未完成事项

> 日期：2026-11-17
> 基线：`3b1dbc5 refactor` 加上工作区未提交的改动。
> 验证：`biome check .`、`tsc --noEmit`、`tsc --noEmit -p client`、`npm run build` 均通过；vitest 在 `--pool=vmThreads` 下 48 个文件、424 个用例全部通过（默认池的问题见 §6）。
> 架构重组（按限界上下文分目录，[§9.1](docs/09-implementation.md#91-单包内的模块划分)）完成后：49 个文件、427 个用例（新增 `test/architecture.test.ts`）全部通过；文中路径已改为新位置。
> R0 完成后（`ulid`、`@agentclientprotocol/sdk`，校验统一用 `zod`，先用过的 `typebox` 已移除）：50 个文件、437 个用例全部通过（新增 `test/gateway-schema.test.ts`）。
> 本文**只列尚未完成的事项**；已完成的项不再记录。编号沿用历次审计，便于对照。

---

## 1. 留待讨论（所有者决定）

| ID | 事项 | 现状 |
|---|---|---|
| G2 | 远端任务中的 agent 与节点密钥的隔离；子任务的 hop/chain 由 CLI 在客户端拼装 | agent 以同一个 OS 用户运行，读得到 `<data_root>`（`identity.json` 私钥、`config.json` 的 `key_base64`），也读得到 DSH 凭据文件 `$DSH_HOME/.credentials.yaml` 里的工作组口令。CLI 用本节点身份签名。`ORCA_POD_PARENT_TASK` 只在 `cli/send.ts` 读取，没有任何地方设置。由此导致 **N11**：agent 运行 CLI 时不带 `--local-task`，发出的就是一个全新的根任务，既没有 `chain` 也没有 `root_origin`，祖先禁调拦不住它回调整棵树的发起方。方向：密钥目录与工作区分离；CLI 改为调用回环控制端点，由节点代签，并强制注入父链与收窄后的权限；执行器按任务注入父任务 id |
| P1 | `orca_pod` `send` 的显式 `permission_mode` 可以**放宽**会话模式 | `plugin/tools.ts`：`explicitMode ?? sessionSandboxMode(...)`。需要确认这是否有意为之；若不是，应改为只能在会话模式之下收窄，读不到会话模式时按 `read-only` |

## 2. 延后实施（所有者决定）

| ID | 事项 | 现状 |
|---|---|---|
| G5 | 可观测性指标（`pod_*`） | 未做 |
| G9 | `message/stream` / SSE / `tasks/resubscribe` | 未做，任务进度只能轮询 |
| D5 | 工具 schema 中删除测试用的 `echo` 参数 | `echo` 仍在 schema 和 `METHODS_HELP` 里 |
| R0b | `write-file-atomic` 替换三处“写临时文件再 rename”（`storage/fs.ts`、`node/config.ts`、`execution/acp/session-store.ts`） | 收益小，R0 时未做 |

## 3. 待决策的设计缺口

| ID | 事项 | 现状 |
|---|---|---|
| G15 | `idempotency_key` | 类型中有字段（`protocol/task.ts`），没有任何逻辑使用；同一条 `message/send` 提交两次就是两个任务 |
| G16 | 预授权与可派发者白名单；不可达候选的处理 | 没有 origin 侧预授权，也没有按 `orca_node_id` 限制谁能派任务；候选（`unknown`）每一拍都去拨，失败不退避，也永不修剪 |

## 4. 延后修复的缺陷

| # | 位置 | 问题 |
|---|---|---|
| B6 | `security/identity.ts` `loadIdentity` | `identity.json` 损坏或无法读取时返回 null，身份被**静默重新生成**；应只在 ENOENT 时返回 null，其他情况报错 |
| B17 | `scripts/sync-guest.ps1` | 硬编码私网 IP `192.168.86.252` 与 `root` 用户，属于个人开发环境脚本 |
| B18 | `cli/send.ts`（`--local-task` 分支）、`delegation/delegation.ts`（`withParentChain`，`{ ...callerPod, ...childPodMetadata(...) }`） | 子任务的 `permission_mode` 没有按“只能收窄”继承：CLI 里显式 `--permission-mode` 覆盖父任务的模式，所以以 `read-only` 运行的 agent 可以派出 `danger-full-access` 的子任务（目标机仍受本机上限约束）；`delegation.ts` 则相反，父任务模式覆盖调用方。应统一为 `narrowPermissionMode(父, 请求)`，放进 `childPodMetadata` 一处实现，CLI 改调它（TY5）。与 G2/N11、P1 同属“子任务权限不可放大”一族 |

## 5. 架构重组中发现、不在本次范围内的问题

| # | 位置 | 问题 |
|---|---|---|
| R2 | 只在类型层面的逆向依赖 | 架构测试按约定不计 `import type`，以下几条在运行期被擦除，但归属是反的：`delegation/delegation.ts`、`membership/mesh.ts` → `transport` 的 `PeerClient`；`membership/mesh.ts` → `node` 的 `OrcaNodeConfig`；`execution/acp/executor.ts`、`execution/acp/session.ts` → `node` 的 `AcpExecutorConfig`/`AcpMcpServer`；`kernel/events.ts` → `protocol` 的 `PeerView`/`TaskView` 与 `storage` 的 `DispatchEntry`。方向：ACP 配置类型归 `execution/`，由 `node/settings.ts` 引用；`mesh` 只收它用到的配置字段；出站客户端的接口下沉到使用方或 `protocol/`；事件载荷类型随事件总线一起重新定位。另外 `NodeLogger` 定义在 `membership/mesh.ts`，却被 tasks、execution、node 共用，应归 `kernel/` |
| R3 | 插件侧工厂的签名 | 核心服务都是 `createX(deps)`；插件侧仍是位置参数：`startPod(config, logger, stores, hooks, defaultRoot)`、`createTracker(node, broker, logger)`、`createPodAdmin(handle, tracker, broker)`、`createPodTools(handle, tracker, presets)`。重组只搬家、不改签名，按 §9.6 的约定逐个改成单个 deps 对象 |
| R4 | `cli/*` 子命令 | 每个子命令导出 `run(args)`，没有 I/O 依赖参数，仍直接写 `process.stdout`；CLI 测试因此只能起子进程。需要进程内测 CLI 时，再给 `run` 加一个 `{ stdout, stderr, stdin, env }` 参数 |

## 6. 工具链

- **`npm run check` 不能作为验收入口**：Node v26.13.0 下，vitest 5.1.0 的默认 `forks`/`threads` 池连只有一条断言的测试文件都跑不起来（`TypeError: Cannot read properties of undefined (reading 'config')`）。这与代码无关，`--pool=vmThreads` 可以正常运行。处理方式：升级或降级 vitest/Node，或在 `vitest.config.ts` 中固定 `pool: "vmThreads"`。
- `esbuild` 的 postinstall 被本机 npm 配置拦下（`npm install-scripts`），但平台二进制来自可选依赖 `@esbuild/win32-x64`，构建不受影响；换机器安装时留意这条警告。

## 7. 尚未验证的事项

- 没有在真实的 DSH 桌面或浏览器中运行。客户端只有构建冒烟测试（`test/client-bundle.test.ts`：在假壳里执行工厂、调用 `apply`），没有在 React 里实际渲染过；TSX 改写之后需要在真实面板里点一遍所有视图。
- 宿主接口：`credentials`（`resolve`/`set`/`unset`）、`configEditor.edit(entry, change)`、`ctx.fiber.entry`、客户端 `locale.register`/`bind` 与 `__ModuleLoader__` 产物格式，都已对照本机 DSH 0.2.2-rc.3 安装包里的源码核对过，但没有实际跑通。尤其需要实测：面板保存配置 → `configEditor.edit` 写回 profile → Loader 重启插件 → 新实例从凭据库读到口令并启动，这条链路。
- 其余仍只来自本地镜像类型（`src/plugin/dsh.ts`）、没有对照源码确认的：
  - `ctx.inject` 回调拿到的子作用域是否带 `effect`，服务替换时是否先销毁再重跑（插件注册不叠加依赖这一点）；
  - `agent/created` 的载荷与 `agent.ctx`；
  - `tools.register(def, { when })` 与 `exec.signal`；
  - `skills.register` 的字段（`resourceBase`、`source: "runtime"`）；
  - `settings.configure({ auto: false }, ctx.fiber)`；
  - `ctx.baseUrl` 是否为 profile 目录；
  - 服务名 `agentDefaultModel`；
  - `package.json` 的 `icon` 字段与 `locale/*.json` 的 `meta`。
- DSH 是否向插件进程设置 `DSH_PROFILE_DIR`：仓库中没有依据，目前靠 `baseUrl` 兜底。
- 一次 `ctx.slots.inject("shell.overlay", …)` 回调里注册两个 slot 条目，是否被 DSH 支持。
- tracker 判断"用户消息"所依据的 `message.source.kind === "user"`，只能从 README 示例中确认。
- 跨机场景（Windows ↔ Linux、IPv6、`https` 端点）本轮改动后没有用 `scripts/cross.ts` 实测。
- ACP SDK 换上后，`scripts/e2e-acp.mjs` 在本机 dsh 0.2.2-rc.3 上走通了 `initialize`、`session/new`（dsh 返回真实 session id，绑定写入 `state/<workgroup>/sessions.json`）与 `session/prompt`，但这一轮被 dsh 以“没有 `deepseek-official` 的 API key”失败，没有拿到模型回答。需要在有 `DEEPSEEK_API_KEY`（或凭据库里有 key）的环境再跑一次，看到 `state: completed`、`text: pong`。权限挂起（`session/request_permission`）与 `session/resume` 只在假 ACP 上测过。

## 8. 已有结论、不再跟踪

- **挂起的权限请求默认无限等待**（原 P3）：`input-required` 期间 TTL 暂停，不设 `approval_timeout_s` 就一直等，由人决定。
- **发起会话被销毁后不处理远端挂起**（原 N8）：tracker 撤回审批卡片，远端任务保持 `input-required`。
- **DNS rebinding 窗口**（B9 余项）：候选端点的校验与 `fetch` 各解析一次 DNS，两次之间仍有窗口；所有者接受，不自写传输层。
- **完全重置会删除共用的工作组口令**：凭据库按 workgroup 存口令（整个 DSH home 共用一份），所以在一个 profile 里"完全重置"，同机同一 workgroup 的其他 profile 下次启动也会回到向导。按"重置即忘掉这个工作组的秘密"处理。

## 9. 代码整理候选（2026-11-17 审查）

> 来源：按上下文分三路只读审查全部 `src/` 与 `client/`，再人工抽查。只是候选，未改代码；位置按"文件 + 符号"给出（行号会漂移）。分四类：**TY** 散装 object 规范成命名强类型，**NE** 减少嵌套，**IN** 内联或删除超短函数，**MG** 合并单一使用者的短文件。与 R2（只在类型层面的逆向依赖：`NodeLogger`、`AcpExecutorConfig` 归属等）重叠的不再重复。

### 9.1 散装 object → 命名强类型（TY）

总原则：发送方与接收方共用的线上形状放 `protocol/`，写成 zod schema、类型用 `z.infer`；两端都引用同一个名字。以下按价值排序。

| # | 位置 | 现状 → 建议 |
|---|---|---|
| TY1 | `membership/mesh.ts` `admission()`/`selfDescription()`/join 与心跳请求体；`transport/gateway/cluster-routes.ts` `admission`/`selfDescription`/`JoinBody`/`HeartbeatBody`/`AdmissionBody`/`Profile`；`security/crypto.ts` `AdmissionFields`/`AdmissionKind` | 所有者举的例子。准入字段写了三份（mesh 内联返回类型、网关 zod、security 的驼峰版），`kind` 在 mesh 里写成字面量联合，请求体在发送端是无类型字面量。→ 新建 `protocol/cluster.ts`：`AdmissionKindSchema`、`AdmissionSchema`（id 字段用 `OrcaNodeIdSchema`/`WorkgroupIdSchema`）、`SelfDescriptionSchema`、`JoinRequestSchema`、`HeartbeatRequestSchema`；security 提供 `createAdmission(kind, key, ids): Admission` 与 `verifyAdmission`；mesh 的请求体标注成 `JoinRequest`/`HeartbeatRequest`。`/cluster/leave` 发送的 `{ orca_node_id }` 网关根本不读，删掉或定义成 schema |
| TY2 | `transport/peer-client.ts` `call`/`rpc` 的 `as T`；`protocol/peer.ts` `JoinResponse`/`HeartbeatResponse`/`MembersResponse`/`PeerView`/`SelfRecord`；`peer-client.ts` `ErrorBody` 与 `gateway/error-handler.ts` | 响应体靠类型断言信任，`mesh.join` 直接把对端返回的 `self`、`members` 写进成员表；错误体两端各写一份（接收端全是 `unknown` 再 `typeof` 探测）。→ 响应与错误体也写成 protocol schema，`PeerClient.call` 接收 schema 并 `parseSchema`，失败按 `peer_error` |
| TY3 | `transport/gateway/a2a-routes.ts` `Envelope`/`PARAMS`；`peer-client.ts` `rpc` 的请求封装；各处 `client.rpc<TaskView>(peer, "tasks/get", { id })` 等 | JSON-RPC 封装与按方法的参数只在网关有 schema，调用方手写字面量、结果类型手选（`{ id }` 约 7 处、`{ taskId, relay }`、`{ message, metadata }`）。→ `protocol/a2a.ts` 放 `A2A_PARAMS` 与封装 schema，`rpc<M>(endpoint, method: M, params: z.input<...>)` 按方法定类型；顺带去掉网关里的 `as A2AMessage`/`as SubmitTaskInput["metadata"]` |
| TY4 | `protocol/grant.ts` `PermissionRequest`/`Grant`/`SignedGrant`/`TaskRelay`；`security/grants.ts` 手写校验（`need`/`isText`/`onlyKeys`，结尾 `as SignedGrant`）；`protocol/task.ts` `permissionRequestOf` 的双重断言；`TaskRunner.escalate(relay: unknown)` | 类型与手写校验器可能漂移。→ 写成 schema（`mode: z.literal("allow_once")`、`chain` 非空），`parseSignedGrant`/`parseTaskRelay` 变成 `parseSchema` 包装并映射到原错误码；`escalate` 收 `TaskRelay`；`onlyKeys` 的"拒绝多余键"语义用 `z.strictObject` 保留 |
| TY5 | `protocol/task.ts` `PodTaskMetadata`/`TaskInputRef`/`TaskView.metadata`；`tasks/meta.ts` `parsePodMetadata`（约 12 个 `need`）；强转处：`delegation/delegation.ts`、`cli/send.ts`、`plugin/admin.ts`、`client/tasks.tsx` | → `PodTaskMetadataSchema`（`z.looseObject`，复用 `PermissionModeSchema`/`ModelSelectionSchema`/`ReasoningEffortSchema`）与 `TaskInputRefSchema`；定义 `TaskMetadata = { pod?: PodTaskMetadata; echo?: unknown } & Record<string, unknown>` 同时用于 `TaskView.metadata` 与 `SubmitTaskInput.metadata`；`parsePodMetadata` 只剩 schema 解析、祖先检查与缺省值。`cli/send.ts` 手工重写了一遍 `childPodMetadata`，改成调用它（见缺陷 B18） |
| TY6 | `delegation/delegation.ts` `sendControl(data: Record<string, unknown>)` 与 `{ grant }`/`{ permission_denied, reason }` 字面量；`tasks/meta.ts`/`tasks/record.ts` `parseResume`/`ResumeControl`；`record.ts` 私有的 `textMessage`/`messageText` | 恢复控制载荷发送端无类型、接收端 `typeof` 重解析。→ `ResumeControlSchema`（`{grant}` 与 `{permission_denied, reason}` 的联合）放 protocol；`controlMessage(taskId, control)`、`textMessage`、`messageText` 挪到 `protocol/task.ts` 与 `A2AMessage` 放一起 |
| TY7 | `execution/echo.ts` `parseEchoScript`（约 90 行手写校验）与 `EchoStep`/`EchoFinal`/`EchoArtifact` | echo 脚本随 `metadata.echo` 上线，是线上形状。→ `EchoScriptSchema`（`z.strictObject`、`.max()`、`at_ms` 递增用 `.refine`），失败映射 `bad_echo_script` |
| TY8 | `protocol/model.ts` `ModelSelectionSchema.reasoning_effort`（`min(1)`）与 `ReasoningEffortSchema`（`/\S/`）；`ReasoningEffort` 未从 `protocol/index.ts` 导出；模型 + effort 成对传递处：`ExecuteInput`、`TaskMeta`、`modelDefaults()`（mesh 与 acp 各一份）、`selectModel`、`setModelCatalog` | 同一概念两条规则：选择里的全空白 effort 能过，单独的不行（zod 迁移时引入）。→ `ModelSelectionSchema` 复用 `ReasoningEffortSchema`；导出 `ReasoningEffort` 替换各处 `string \| null`；命名 `ModelDefaults`/`ModelChoice`；"model X and reasoning effort Y" 描述在 `echo.ts` 与 `acp/executor.ts` 各拼一次，合一 |
| TY9 | 节点 id / 工作组 id | `OrcaNodeId` 有别名但大多数签名写 `string`，`WorkgroupId` 未导出。→ 导出并用于 `NodeIdentity`、`BusyState.origin_orca_node`、`Grant.*_orca_node`、`PersistedTask.origin_orca_node` 等；可选 `.brand()` |
| TY10 | `security/grants.ts` `checkGrant`/`grantCovers` 返回 `string \| null` | 失败集合是有限的。→ `GrantFailure = "grant_invalid" \| "grant_expired" \| "grant_replayed"` 等字面量联合 |
| TY11 | 存储：`storage/fs.ts` `Meta`（即 `Omit<BlobRecord, "blob_id">`，读盘 `as Meta`）与三处同样的四字段字面量；`BlobStore.put` 的内联 options；`storage/sqlite.ts` 行类型重写 `FileBlob`、`as T`；`security/identity.ts` 身份文件字面量写、`as Record` 读，`NodeIdentity.publicKey` 恒等于 `orcaNodeId`；`execution/acp/session-store.ts` `readSessions` 手工检查后 `as SessionBindings` | → `BlobMeta`/`BlobLabel` 与 `blobMeta()` 构造函数；sqlite 行直接用 `FileBlob`；`IdentityFileSchema`（读写共用），去掉冗余的 `publicKey`；`SessionBindingsSchema = z.record(z.string(), z.string())` |
| TY12 | 传输小件：`"GET" \| "POST"` 写三次；`peer-client.ts` `send` 7 个位置参数；`"x-pod-body-sha256"` 字面量 4 处；`gateway/auth.ts` 对 query/params/header 的断言、`blob-routes.ts` 内联 `Params` 类型；`membership/screening.ts` 内联的判定联合；`Workgroup.leave()` 的内联返回 | → `HttpMethod`；`SignedRequest` 对象参数；`BODY_SHA256_HEADER` 常量；auth/blob 路由用 `parseInput` 与共享的 `BlobParams`；`ScreenVerdict`、`LeaveResult` |
| TY13 | CLI：`cli/send.ts` 上传结果 `{ blob_id, size, name }` 写三次（且少了网关返回的 `expires_at`）；`cli/escalate.ts` `escalateToOrigin` 6 个位置参数、返回冗余的 `state`，`wait.ts` 把截止时间转秒再转回；`cli/install.ts` `checkDsh` 内联返回、`(path) => boolean` 写四次、`PromptQuestion.option` 与 `ANSWER_FIELD` 键重复；签名 blob URL 在 `node/orca-node.ts`、`cli/publish.ts`、`blob-routes.ts` 各拼一次；`{ parentTaskId?, signal? }` 写三次；`orca-node.ts` `workspacePaths()` 内联返回 | → `BlobUploadResponse`（protocol）；`EscalationTarget` + `deadlineMs`，只返回 `TaskView`；`DshCheck` 判别联合、`PathExists`、`AnswerOption = keyof typeof ANSWER_FIELD`；`blobUrl()` 放 `security/` 并命名 `PublishedBlob`；`SendTaskOptions extends TaskCallOptions`；`WorkspacePaths`（`Workspace = WorkspacePaths & { inputDir }`） |
| TY14 | 执行：`requested: Record<string, unknown>`（`Suspension`、`PermissionRequest`、`TaskRelay` 三处）；`execution/acp/permissions.ts` `"allow" \| "reject"` 重复，本地 `PermissionRequest` 与协议同名异义；`FAILED_STOP_REASONS` 键是 `string` | → `RequestedAccess`（`tool_call_id?`、`tool_kind?` 加开放键）；`PermissionDecision`，本地类型改名 `AcpPermissionAsk`；`Partial<Record<StopReason, string>>` |
| TY15 | 插件面板 API：`plugin/web.ts` `readJsonBody`/`stringField`；`client/store.ts` `api<T = unknown>`/`act(path, body?: unknown)`；`{ peer, task_id }` 等请求体与 `{ recent }`/`{ task }` 响应都是匿名的 | → `plugin/panel-api.ts`：请求体 zod schema（服务端 `parseSchema`）、响应类型，客户端只做类型导入；`act<K>(path: K, body: PodActions[K])` |
| TY16 | 面板配置补丁：`Record<string, unknown>` 一路到底（`web.ts` 保存、`admin.ts` `saveConfig`、`lifecycle.ts` `reconfigure`、`client/settings.tsx` `buildPatch`），口令在两处用不同规则手工复查；`plugin/stores.ts` `RawConfig` 靠 `as` 得来 | → `node/settings.ts` 从 `panel: true` 字段派生 `PanelPatch` 与 `PanelPatchSchema`，解析一次；`RawConfig` 改成设置输入类型 |
| TY17 | 插件工具：`plugin/tools.ts` 参数手工解析（`asRecord`/`requiredString`/`methodOf`），`parameters` JSON schema 另写一份，权限模式枚举写两次；各 `run*` 返回 `Promise<unknown>` 与内联字面量，`{ ...view, terminal }` 两次 | → 按 `method` 判别的 zod 参数联合（复用 protocol schema 与 `EchoScript`）；`parameters` 能否用 `z.toJSONSchema` 生成需确认宿主支持的子集（中等把握）；命名 `PeerSummary`/`SendResult`/`TaskStatusResult`/`MembersResult`/`ConnectResult` |
| TY18 | 插件杂项：`` `${peer}\|${taskId}` `` 拼在 4 处（只有 `broker.ts` 命名为 `keyOf`）；`admin.ts` `approvals()` 的内联 `waiting` 值类型；`PodAdvancedConfig.executor` 内联联合（`ExecutorKind` 未导出）、`PodTaskRow.state: string`；`client/settings.tsx` `LimitKey`/`SelectKey` 手抄键、权限模式第三份；`plugin/catalog.ts` `selectionOf` 手工校验（已有 `parseModelSelection`）；`plugin/tracker.ts` 对 `status`/`code` 的断言；`client/` 里 `modelText`/`provider/model` 拼接重复 | → 导出 `taskKey()`；`PendingApproval`；导出 `ExecutorKind`、用 `TaskState \| "unknown"`；从 `PodAdvancedConfig` 派生键；`selectionOf` 改调 `parseModelSelection`（先核对空白规则）；`instanceof PodError`；`modelText`/`modelId` 放 `client/primitives.tsx` |
| TY19 | `node/config.ts` `validateConfig` 的 `as Record<string, unknown>` 与 `as OrcaNodeConfig` | → 身份字段用小 schema（`orca_node_id: OrcaNodeIdSchema`、`key_base64`）解析后组装，去掉断言 |

### 9.2 减少嵌套（NE）

| # | 位置 | 建议 |
|---|---|---|
| NE1 | `plugin/web.ts` `createPodApiHandler` | 三道闸门抽 `rejection(request)`；GET/POST 分成 `handleGet`/`handlePost`，POST 用动作表；`sendJson` 只在 try/catch 出口调用一次。与 TY15 一起做 |
| NE2 | `plugin/catalog.ts` `discoverModelCatalog` | 抽 `listProviders`/`listModels`/`defaultSelection`（各自 catch 返回空），主循环变成两层 for 加守卫，去掉两处 `Awaited<ReturnType<...>> = []` 预声明与重复的上限 `break` |
| NE3 | `membership/membership.ts` `evaluate()` | 深度 4。抽 `reassess(record, nowMs)`（早返回）与 `shouldPrune(record, nowMs)` |
| NE4 | `membership/mesh.ts` `pulse()`、`leave()`、`dropPeer()` | `pulse` 内层"被修剪则 join 后重发"抽成 `heartbeatWithRejoin`；"claimed X but Y was expected" 在 `join`/`pulse` 各写一次，合成 `assertAnsweredBy`；`leave` 抽 `notifyLeave(peer)`；`remove`/`preferredEndpoints.delete`/`client.forget` 三连在 `leave` 与 `dropPeer` 重复 |
| NE5 | `plugin/index.ts`、`plugin/catalog.ts` 的可选服务注入 | `inject` → 赋值 → `effect` → 比较清空的模式写了 4 次（agents、permissionPresets、llm、agentDefaultModel）。→ `optionalService(ctx, key, label, onChange?)` |
| NE6 | `plugin/tracker.ts` `poll`/`deliver`；`plugin/lifecycle.ts` `startNode`/`boot`/`reconfigure`/`reset`；`plugin/admin.ts` `recent`/`approvals` | `pollEntry` 返回是否变化、`wake(agent, message)` 早返回；`startListening`/`joinPeers`/`readPassword`/`toError`（`error instanceof Error ? ... : new Error(String(...))` 写了两次）/`removeQuietly`；`localRow`/`dispatchRow` 与 `waitingApprovals()` |
| NE7 | `client/tasks.tsx` `TaskDetail`/`AllTasks`；`client/panel.tsx` `StatusPage`/`Panel`；`client/members.tsx` `NodeDetail`；`client/settings.tsx` `initialForm`/`buildPatch`/`ConfigForm` | 早返回替代 `let body`/`let content` 覆写；抽 `TaskFacts`/`ArtifactLinks`（制品链接渲染重复两次）/`ConnectForm`/`RuntimeFacts`/`ModelList` 组件，去掉手写 `key=`；`triText`/`triValue` 成对；`limitValue` |
| NE8 | `storage/fs.ts` `gc()` | 两轮目录遍历各带 if/else-if。→ `sweepPartFiles(at)` 与 `sweepBlobs(at)` |
| NE9 | `transport/net.ts` `normalizePeerUrl`、`detectLocalEndpoints` | 抽 `splitHostPort` 早返回；网卡枚举用 `Object.values(...).flat()` 过滤后按族划分 |
| NE10 | `transport/gateway/auth.ts` preValidation；`security/crypto.ts` `verifyAuth` 开头；`gateway/cluster-routes.ts` `profileOf` | 拆 `authenticate(request, access)` 与 `authorize(access, caller)`；`verifyAuth` 先判 header 缺失再解析，不在一次 throw 里两次判断同一条件；`profileOf` 的 `reuseScreening && fresh` 算了两次，提成一个变量 |
| NE11 | `cli/wait.ts` 主循环；`cli/send.ts` `run`（约 90 行，`parentLocalTask` 判空两次）；`cli/orca-pod.ts` `main` | `wait`：`refresh()` 加守卫，深度 4 → 2；`send`：先规范 `parentLocalTask`，抽 `buildPod`/`parseEchoFlag`/`registerChildLink`；`main`：提示语用三元后只 `writeError` 一次，抽 `printPlan`，失败命令用 `find` |
| NE12 | `execution/acp/executor.ts` `run`；`delegation/delegation.ts` `tick`、`approveTask`；`node/orca-node.ts` `joinRoster`、`endpointsFrom`；`node/config.ts` `profileDirFrom` | 抽 `makeRoute`/`armAbort`；`watchChild` 返回 keep/drop；`signTopLevelGrant`；`joinAny`；守卫式改写 |
| NE13 | `plugin/tools.ts` `runSend`；`plugin/web.ts` `isSameOriginPanelRequest` | `parseSendArgs`（随 TY17）；用 `URL.canParse` 去掉嵌套 try |

### 9.3 内联或删除超短函数（IN）

| # | 位置 | 建议 |
|---|---|---|
| IN1 | `plugin/web.ts` `podApiRoute` | 只用一次且 handler 是纯转发，内联进 `registerPodWeb` |
| IN2 | `plugin/index.ts` 局部 `configured` | 重写了 `lifecycle.ts` `needsSetup` 的规则；改用 `handle.configured`（先确认它在 `reconfigure` 后同步） |
| IN3 | `plugin/lifecycle.ts` `createRuntime`；`plugin/tools.ts` `asRecord`；`plugin/tracker.ts` `TrackerMessage` 别名；`plugin/admin.ts` `config()` 包装 | 内联 / 直接用 `AgentNotice` / `config: configView` |
| IN4 | `cli/shared.ts` `sleep`；`node/harness.ts` 手写的同款 Promise | 用 `node:timers/promises` 的 `setTimeout`（`echo.ts` 已这样用） |
| IN5 | `cli/orca-pod.ts` `missingAnswerFlags` | 4 分支 if 链只做 `--${option}`，改成一行 `map` |
| IN6 | `transport/gateway/auth.ts` `requireLoopback` | 只用一次，且与随后 `local` 分支抛同一个 `local_only`，合并 |
| IN7 | `storage/sqlite.ts`、`storage/memory.ts` 的 dispatch store：`const store = {...}; return store;` | 对象内不引用 `store`，直接返回字面量（`createMemoryBlobStore` 里 `putStream` 调 `store.put`，那处保留） |
| IN8 | `protocol/model.ts` 私有 `fail`；`storage/blob-common.ts` `sha256Hex` 与 `security/crypto.ts` `bodySha256` 重复 | 前者内联；后者导出 `bodySha256` 供 storage 用 |
| IN9 | `node/config.ts` `workgroupKey` | 一行、一处使用；可内联（低把握，名字有说明编码的作用） |
| IN10 | 生产代码已不用、只剩测试在用：`protocol/peer.ts` `normalizeOrcaNodeId`；`protocol/model.ts` `validateModelOffers`、`validateModelSelection` | 删除（测试改测 schema），或挪到真正需要的地方 |

考虑过但不建议内联：`markInFlightUnknown`、`childPodMetadata`、`candidateEndpointAllowed`、`permissionModeRank`、`newTaskId`、`isMethod`、`stopReasonOf`、`isReasoningEffort`/`isPermissionMode`（同族守卫）——命名了概念或被测试直接使用。

### 9.4 合并单一使用者的短文件（MG）

按"运行期只有一个使用者、行数很少"筛出；测试直接 import 的，合并后改 import 路径即可。同时更新 §9.1 模块表、README 目录树与引用这些文件名的章节。

| # | 文件 | 唯一使用者 | 建议 |
|---|---|---|---|
| MG1 | `delegation/dispatch-log.ts`（31 行，`markInFlightUnknown`） | `delegation/delegation.ts` | 所有者举的例子。并入 `delegation.ts`，文件头的 §8.3 说明随函数一起搬；`test/dispatches.test.ts` 改 import |
| MG2 | `delegation/chain.ts`（21 行，`childPodMetadata`） | `delegation/delegation.ts`（TY5 之后 `cli/send.ts` 也会用，经 `delegation/index.ts`） | 并入 `delegation.ts`；`test/chain.test.ts`、`test/permission-mode.test.ts` 改 import。合并后 `delegation/` 只剩 `delegation.ts` 与 `index.ts` |
| MG3 | `execution/acp/session-store.ts`（35 行） | `execution/acp/session.ts` | 并入 `session.ts`（`sessions.json` 的读写本来就只服务会话绑定） |
| MG4 | `execution/acp/permissions.ts`（50 行） | `execution/acp/executor.ts` | 可并入 `executor.ts`；但 §6、§7.14 以文件名引用它作为自动应答规则的出处，保留也说得通（中等把握） |
| MG5 | `kernel/guards.ts`（5 行，`isRecord`） | 经 `kernel/index.ts` | 并入 `kernel/schema.ts`（同属输入检查） |
| MG6 | `protocol/constants.ts`（3 行，`DEFAULT_PORT`） | 经 `protocol/index.ts`，`scripts/cross.ts` 直接引用 | 若 TY12 加入 `BODY_SHA256_HEADER` 则保留为常量文件；否则并入 `peer.ts` |
| MG7 | `transport/gateway/error-handler.ts`（44 行） | `transport/gateway/index.ts` | 可并入 `gateway/index.ts`（低把握：文档把它描述为"唯一的错误出口"，单独成文件便于找） |

不建议合并：`cli/*` 子命令（一命令一文件是约定，见 R4）、`storage/blob-common.ts`（两个存储实现共用）、`plugin/config.ts`（两个使用者）、`transport/gateway/input.ts`（三个路由用）、`tasks/record.ts`（唯一使用者是 `runner.ts`，但 470 行）。
