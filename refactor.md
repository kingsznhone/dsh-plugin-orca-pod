# 重构方案（第二轮）：自由函数、包装、类型转发

> 状态：**已实施**（2026-11-18，分支 `refactor/classes`，基于 `64a453f`；提交 `refactor2(0)`–`refactor2(7)` 与文档同步）。第 8 步的 C10、L4 随后也做了（`parseOrThrow` 的回调收 `SchemaIssue` 而不是字符串，因为 echo 脚本与网关输入要用 path；`parseSchema` 留给 settings 与测试；`core/stream.ts` 的 `readAll` 返回 null 表示超限）；§5.8 G12 的 `withBody` 因被模块常量 `POST_ACTIONS` 在加载时使用而保留为模块函数；`Pick<Context, …>` 的宿主上下文参数（catalog / services / stores / web）保留。K5 选了“删除”。
> 第一轮（目录重组 + 闭包工厂改 class，D41）已完成，§1 只保留它留下的约束和出入记录。
> 范围：`src/` 的全部运行期代码、`test/` 跟着改、`biome.json` 一处。线上协议、zod schema、错误码、HTTP 路由、存储表结构都**不变**；行为上的细小变化逐条列在 §8。

## 0. 为什么还要一轮

第一轮把 `createX(deps)` 闭包工厂换成了 class，但不少地方只换了外壳。这一轮逐个读完 `src/` 的 85 个文件（56 个 class、132 个导出函数、107 个模块私有函数），问题集中在五类：

| 类别 | 典型例子 |
| --- | --- |
| **自由函数其实是某个 class 的方法** | `plugin/catalog.ts` 的六个函数都把 `logger` 当参数传；`checkGrant(grant, expected, ledger)` 带着 `GrantLedger`；`selectModel(session, …)` 回写 `session.configOptions` |
| **数据袋 + 一组操作它的函数** | `Membership` 的 `PeerRecord` 加 `profilePatch` / `reassess` / `shouldPrune` / `toView`；`WorkspacePaths` 加三个自由函数；ACP 的 `OpenSession` 加 `selectModel` |
| **封装被打开** | `SingleSlotTaskRunner` 公开 8 个字段和 `settle()` / `recover()`，只为同文件的 `TaskRecord` 能读 |
| **转发与包装** | `OrcaNode.self()` → `Workgroup.self()` → `profile.record()`；`Tracker.subscribe` / `ApprovalBroker.subscribe` 包一层私有 `ChangeSignal`，而唯一的订阅者只有测试在用；`callOptions()` 是空操作 |
| **同一件事算好几遍、类型被转手** | `task_timeout_s ?? DEFAULT_TASK_TIMEOUT_S` 算三次；"节点没在运行"判断写四遍；`busy` 有两个来源；`ReturnType<PodAdmin["self"]>`、为测试设的 `Pick<…>` |

模块级的**可变状态**为零（`rg "^(export )?let |^const \w+ = new (Map|Set)" src` 只找到 `cli/orca-pod.ts` 一个不可变的查找表），"自由变量"这一项只涉及常量，规则见 R6。

## 1. 第一轮留下的约束（继续有效）

- 8 个上下文 `core ← {mesh, executor} ← task ← api ← node ← {cli, plugin}`，同层互不引用，**仅类型的环也算违规**，`test/architecture.test.ts` 的两个允许清单保持为空。
- 服务用 class，协作者用构造器参数属性；私有协作者由拥有者 `new`，共享对象由创建者传入；子系统对外通知用自己的 `readonly events` / `changes`。
- 不做依赖注入：没有容器、`XDeps`、端口接口、Provider；只有多实现时才设接口。
- 构造器不写盘、不联网、不启计时器（SQLite store 与 `OptionalService` 是写明的例外）。
- 测试使用真实对象和 `vi.spyOn`，**设计不为测试让步**。

第一轮与方案的出入（D41 引用了这里），本轮逐条复核：

| 第一轮的出入 | 本轮 |
| --- | --- |
| `DEFAULT_PORT` 留在 `core/constants.ts`（面板前端要读，`net.ts` 依赖 `node:net`） | 保留 |
| `TaskRecord` 并进 `task/runner.ts`（记录读 runner 公开字段，拆文件就成类型环） | **撤回**：K1 让记录不再认识 runner，回到 `task/record.ts` |
| `Gateway(profile, membership, tasks, files, key)`，新增 `mesh/BlobFetcher` | 保留 |
| `rpc()` 是导出函数，`Delegation` 与 CLI 共用 | 保留（CLI 在没有节点的进程里也要发这个调用） |
| `PodStores.writeConfig` 返回写入后的 `RawConfig \| null` | 保留 |
| `ModelCatalogFeed.watch(host: { node, ready })` 结构类型 | 保留（直接写 `PodLifecycle` 会和 `lifecycle.ts` 互相 `import type`） |
| `PodTool` 的 `sandbox` 是 `{ current(): SandboxReader \| undefined }` | **撤回**（G5）：只为测试能传字面量，而测试照样在做类型断言 |
| SQLite store 在构造时打开数据库 | 保留 |

## 2. 判定规则

### 2.1 模块级函数的去留（按顺序判断，先命中的生效）

| 规则 | 条件 | 处理 |
| --- | --- | --- |
| **R1 内联** | 只有一个调用点，且函数体不超过三行，或只是给一个表达式起名 | 内联到调用点 |
| **R3 搬成方法** | 参数里带着某个 class 的状态或协作者（`logger`、`services`、`ledger`、`session`），或连续调用同一个对象的多个方法（feature envy） | 成为那个 class 的方法，**导出的也一样**，测试经 class 测 |
| **R4 收成 class** | 一个类型加上一组以它为参数的函数 | 新 class，函数成为方法 |
| **R2 收为私有方法** | 未导出，所有调用方都在同一个 class 里 | 该 class 的 `private` 方法；不读 `this` 的写成 `private static` |
| **R5 保留为函数** | 被 ≥ 2 个模块调用的无状态纯计算（签名验签、解析、筛查、摘要、线上形状工具）；或导出后有独立单元测试的纯契约（`taskNoticeLine`、`systemdQuote`、`parseAuthHeader`）；CLI 子命令的一次性过程 | 不动 |

R2 的理由：一个文件读起来就是"这个 class 和它的常量"，只为它服务的行为放在它里面，从 class 就能找全；也避免同一个概念散成"class + 旁边几个看似通用、其实只此一家的函数"。

### 2.2 其余规则

| 规则 | 内容 |
| --- | --- |
| **R6 常量** | 可调参数和协议常量留在模块顶层，不改成 `static readonly`（只有改名的收益，没有别的收益）。不允许出现模块级可变状态 |
| **R7 只为测试存在的公开面** | 只有测试在读的公开方法、公开字段、返回值、选项字段、`Pick<…>` / 结构参数类型、依赖袋，一律删除或改为私有；测试改走真实入口。R5 里有独立契约的纯函数不算 |
| **R8 转发** | 一行转发，且目标本身已经公开可达的，删除，调用方直接用目标。转发是在隐藏一个私有协作者，或附带了空值检查、组合等逻辑（门面）的，保留 |
| **R9 单一来源** | 同一个默认值、同一个检查、同一个派生值只在拥有者那里算一次，再把结果传下去；调用方已经保证了的事，被调用方不再检查 |
| **R10 类型不转手** | 不用 `ReturnType<…>` / `Awaited<ReturnType<…>>` 给已有类型换个写法；不用 `X & { 偷带字段 }` 把一个参数塞进另一个配置对象；不为测试对外部类型做 `Pick`。只有描述一个线上子集时才保留 `Pick`（`PeerSummary`、`ModelOffer`、`Profile`） |

另外三条面向对象的检查项，散落在 §5 的清单里：**迪米特**（`a.b.c()` 穿过别人的协作者）、**tell, don't ask**（先问状态再替对方做事）、**布尔开关参数**（一个参数切换两种行为）。

## 3. 重点设计变更

### K1 `TaskRecord` 与 `SingleSlotTaskRunner` 解耦

现状（`task/runner.ts`）：`TaskRecord(runner, init)` 读 `runner.options` 的 7 个字段，调用 `runner.slot.claim/release`、`runner.ledger`、`runner.events.emit`（4 处）、`runner.store.save`、`runner.blobs.register`、`runner.workspace.*`、`runner.executor.run` 和 `runner.settle()`。为此 runner 公开了 `slot`、`ledger`、`quota`、`options`、`executor`、`blobs`、`store`、`workspace` 八个字段，外加 `settle()`。全仓库除 `TaskRecord` 外没有任何人读这些字段（`recover()` 另有一个测试）。

改法：**记录只管"这一个任务的状态机和执行循环"，账本、槽位、存储、事件归 runner。**

```ts
// task/record.ts —— 不 import runner
export class TaskRecord {
  readonly id: string;
  readonly origin: OrcaNodeId;
  readonly createdAt: string;
  /** 每次可观察的变化 notify 一次；runner 订阅。 */
  readonly changes: ChangeSignal;

  constructor(
    init: RecordInit,
    private readonly executor: LocalExecutor,
    private readonly blobs: FileBlobRegistry,
    private readonly workspace: Workspace,      // K2
    private readonly settings: TaskSettings,    // selfOrcaNodeId、dataRoot、permissionCeiling、permissionTtlS、resultMaxBytes
  ) { … }

  get state(): TaskState;
  get waiting(): PermissionRequest | null;      // 停在哪个权限请求上
  snapshot(): TaskView;
  begin(): void;
  grant(mode: SandboxMode): void;               // 原 resume 的成功分支 → proceed
  deny(reason: string): void;                   // permission_denied
  reject(failure: GrantFailure): void;          // grant 未通过
  cancel(): void;
}
```

```text
SingleSlotTaskRunner（全部字段 private；对外只剩 events、start、submit、get、originOf、list、resume、cancel、busy）
  submit：new TaskRecord(...)，订阅 record.changes，每次变化依次：
    ① 按状态同步槽位：submitted / working 占槽；input-required 与终态释放（只释放自己占着的）
    ② 落盘（失败记一条 warning，即原来的 attempt）
    ③ events.emit({ type: "task", view })
    ④ 终态：从 live 删除、取消订阅、quota.measure()（原 settle）
  resume(taskId, message, caller)：原有前置检查 → parseResume(message)
    denied → record.deny(reason)
    grant  → ledger.accept(grant, { taskId, self, workgroup, origin: record.origin, pending: record.waiting })
             失败 → record.reject(failure)；成功 → record.grant(grant.permission_mode)
```

连带：`TaskSlot` 只剩 runner 自己用，并进 runner 成为 `private holder: string | null`，删除 `task/slot.ts`（T2）；`checkGrant` 变成 `GrantLedger.accept`，验证通过就记账（T4），记录不再需要 `ledger`、`selfOrcaNodeId`、`workgroupId`；`recover()`、`settle()` 变私有。

顺序约束：① 必须在 ③ 之前。`OrcaNode` 订阅 `tasks.events` 后会读 `tasks.busy()`，这和现在 `finish` / `park` / `proceed` 里"先动槽位再发事件"的顺序一致。`ChangeSignal` 会吞掉监听器的异常（记日志）；①–④ 本身不抛（② 已经包了 try），所以不改变现有语义。

### K2 `Workspace` class

现状：`task/workspace.ts` 是类型 `WorkspacePaths` 加 `workspacePathsOf`、`ensureWorkspace`、`measureWorkspace` 三个自由函数；"列出 notes 目录"写了两遍（`task/prompt.ts:19` 异步，`plugin/admin.ts:140` 同步）；artifact 路径在 `TaskRecord.addArtifact` 里手拼。

```ts
export class Workspace {
  readonly root: string;    // agent 的 cwd
  readonly notes: string;
  readonly state: string;   // 网关自己的状态，agent 碰不到
  constructor(dataRoot: string, workgroupId: WorkgroupId) {}   // 只算路径
  ensure(): void;                                 // 原 ensureWorkspace，由 OrcaNode.start() 调用
  measure(): Promise<WorkspaceUsage>;             // 原 measureWorkspace
  noteFiles(): string[];                          // notes/ 顶层文件名，排好序；目录不存在时为 []
  artifactPath(taskId: string, index: number): string;
}
```

使用方：`OrcaNode.workspace: Workspace`；`WorkspaceQuota(workspace, limits, logger)`；`prompt.ts` 用 `noteFiles()`，再套自己的 `SAFE_NOTE_NAME` 过滤和 `MAX_NOTES` 上限（这是提示词的策略，留在 `prompt.ts`），`listNotes` 删除；`PodAdmin.workspace()` 用 `noteFiles()`，`entries()` 删除。

### K3 `Membership` 的成员记录变成 class

现状（`mesh/membership.ts`）：`PeerRecord` 有 10 个字段；状态迁移分散在 `toView`、`profilePatch`、`reassess`、`shouldPrune` 四个自由函数，`createRecord`、`markOnline` 两个私有方法，以及 `observeOutboundOk` / `observeOutboundFail` 里的十几行内联赋值。

改法：模块私有的 `class PeerEntry`，持有原记录的全部字段：

| 方法 | 来源 |
| --- | --- |
| `static explicit(view, nowMs, wallIso)` / `static candidate(view)` | `createRecord` |
| `snapshot(): PeerView` | `toView` |
| `describe(view)` | `profilePatch` |
| `heard(nowMs, wallIso)` | `markOnline` |
| `answered(nowMs, wallIso)` | `observeOutboundOk` 的主体 |
| `missed(nowMs, timings): "drop" \| "kept"` | `observeOutboundFail` 的主体；从未联系上的候选达到上限时返回 `drop`，由 `Membership` 删除并立墓碑 |
| `reassess(nowMs, timings)` | `reassess` |
| `expired(nowMs, timings)` | `shouldPrune` |
| `due(nowMs)` | `needsProbe` 的判断 |

`Membership` 只留两张 Map（记录、墓碑）、时钟和节奏。同时做 M2（`touch` 并入 `observeInbound`）和 M3（`Membership.due()` 取代 `now()` + `needsProbe(id, nowMs)`）。

### K4 `AcpSession` class

现状：`OpenSession = { connection, sessionId, configOptions }` 是数据形状；自由函数 `selectModel(session, …)` 回写 `session.configOptions`；`AcpRun` 穿过 `session.connection` 调 `request("session/prompt")`、`attach`、`cancel`、`isAttached`、`close`。

```ts
export class AcpSession {
  constructor(private readonly connection: AcpConnection, readonly id: string, private options: SessionConfigOption[]) {}
  selectModel(model, effort): Promise<string | null>;   // 原自由函数；失败时返回原因
  prompt(text: string): Promise<PromptResponse>;
  attach(route: SessionRoute): () => void;
  isAttached(route: SessionRoute): boolean;
  cancel(): void;
  forceClose(): Promise<void>;                            // 中止宽限期过后强关子进程
}
```

`AcpSessionPool` 存 `Map<string, AcpSession>`；`AcpRun(input, session)` 只调用 `session` 自己的方法。

### K5 插件侧只为测试存在的变化通知

现状：`Tracker` 和 `ApprovalBroker` 各持一个私有 `ChangeSignal`，再用 `subscribe()` 转发。唯一的订阅者是 `PodAdmin.subscribe`，而 `PodAdmin.subscribe` 只有 `test/ui-surface.test.ts:295` 在用：面板靠轮询 `/orca-api/state`，没有推送通道。`PodAdmin.subscribe` 还有一个潜在错误：它只挂在调用那一刻的节点上，节点重启后就收不到了。

改法（推荐）：删除 `Tracker` 和 `ApprovalBroker` 的 `changes` 与 `subscribe`，删除 `PodAdmin.subscribe`，`ApprovalBroker` 的构造参数去掉 `logger`。`broker.test.ts:143` 和 `ui-surface.test.ts:295` 改成在操作之后读 `broker.list()` / `admin.approvals()`。`ChangeSignal` 本身保留（`ModelCatalog.changes` 在生产中有订阅者）。

如果打算近期做推送：保留信号，但按 §1 的约定公开为 `readonly changes`，删掉 `subscribe` 转发，并让 `PodAdmin` 跟随节点重启重新挂接。**需要你拍板选哪一种。**

### K6 `ModelCatalogFeed` 收回发现逻辑

现状（`plugin/catalog.ts:39-109`）：`listProviders`、`listModels`、`discoverOffers`、`defaultSelection`、`defaultEfforts`、`discoverModelCatalog` 六个函数，每个都收 `logger`，后两个还收 `services`，而这两样都是 `ModelCatalogFeed` 自己的字段。`listProviders` 用 `async` + `try` 包了一个同步调用（`LlmRuntime.listProviders(): LlmProviderInfo[]`）。

改法：两个服务成为字段 `private llm?: LlmRuntime`、`private defaultModel?: AgentDefaultModelConfig`；六个函数成为私有方法，`listProviders` 去掉 `async`；`CatalogServices` 类型和 `discoverModelCatalog` 导出删除。`model-selection.test.ts:194` 改为构造 feed，用一个会同步回调 `inject` 的假 `ctx` 驱动 `watch()`。顺带 C9：`advertise()` 不再传多余的第三个参数。

### K7 单一来源（汇总）

| 重复的事实 | 现在 | 之后 | 编号 |
| --- | --- | --- | --- |
| 任务时限默认值 | `orca-node.ts:159`、`runner.ts:447`、`self-profile.ts:40` 各 `?? DEFAULT_TASK_TIMEOUT_S` 一次 | `OrcaNode` 算一次，把数值传给两者 | T9 |
| 出站超时默认值 | `orca-node.ts:169`、`cli/shared.ts:106` 各写一次 `?? 30_000` | `core/constants.ts` 的 `DEFAULT_REQUEST_TIMEOUT_MS` | N3 |
| 本节点 busy | `tasks.busy()`（`cluster-routes.ts:153`、`gateway.ts:113`）和 `profile.busy`（心跳请求）两个来源 | 只读 `profile.busy` | A1 |
| 读 identity.json 并核对 id | `orca-node.ts:145`、`cli/shared.ts:87`，错误文案一字不差 | `core/identity.ts` 的 `requireIdentity(dataRoot, expected)` | N2 |
| "节点没在运行" | `lifecycle.ts:218`、`admin.ts:395`、`broker.ts:124`、`tools.ts:401` | `PodLifecycle.requireNode()` | G3 |
| 消息里的文字 | `task/wire.ts:62` 用 `\n` 拼，`cli/shared.ts:122` 只取第一段，`tracker.ts:103` 用空格拼 | 都用 `messageText` | L2 |
| 启动失败 | `lifecycle.ts` 里 `startListening` 和 `boot` 各写一次 `failure` | 只在 `boot` 写 | G8 |

### K8 只为测试存在的公开面（汇总）

| 位置 | 只为测试存在的东西 | 编号 |
| --- | --- | --- |
| `cli/install.ts`、`cli/orca-pod.ts` | `PathExists`、`ConfigDeps`、`InstallDeps`、`MainDeps` 依赖袋——正是 D41 禁止的 `XDeps` | L1 |
| `plugin/tools.ts`、`plugin/tracker.ts` | `SandboxReader`、`SandboxSource`、`TrackerAgent` 三个 `Pick` / 结构类型 | G5 |
| `plugin/tools.ts` | 公开的 `send` / `status` / `cancel` / `members` / `connect`，以及导出的 `sessionSandboxMode` | G6 |
| `plugin/admin.ts`、`tracker.ts`、`broker.ts` | `subscribe` 与背后的 `ChangeSignal` | K5 |
| `plugin/tracker.ts` | `size()` | G14 |
| `task/delegation.ts`、`src/index.ts` | `ApprovalOptions.ttlS` | T7 |
| `task/runner.ts`、`task/dispatch-log.ts` | 公开的 `recover()`，以及两个只给测试读的返回计数 | T10 |
| `mesh/membership.ts` | `now()`、`evaluate()` 的返回值 | M3、M4 |

## 4. 总览

| 类别 | 编号 |
| --- | --- |
| 设计变更（新 class / 解耦） | K1–K4、K6（T1、T3、M1、E1、G4） |
| 删除转发与包装 | M2、M6、M12、N1、T2、T6、G1/K5、G11 |
| 单一来源 / 过度检查 | K7 全表、C8、C9、M5、L3 |
| 只为测试的公开面 | K8 全表 |
| 类型转手 | M9、M10、E6、T6、G5、G10、N5 |
| 自由函数内联或收为私有方法（机械） | C7、M7、M11、E2–E5、T5、T8、A2、N4、G2、G9、G12、G15 |
| 死代码、注释、配置 | C1–C6、C11、N5、X1 |

优先级：**P1** 设计上的问题，先做；**P2** 明显的冗余或封装缺口；**P3** 机械整理，可以批量做，也可以跳过。

## 5. 逐模块清单

### 5.1 core

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| C1 | `core/net.ts:74-90` | `detectLocalEndpoints` 的文档注释被插到 `bindUrl` 上方：`bindUrl` 头上叠了两段，`detectLocalEndpoints` 一段都没有 | 挪回原位 | 文档 | P3 |
| C2 | `core/blobs.ts:133-146` | "File-backed blob registry" 整段注释悬在 `sha256Tap` 前面 | 挪到 `DiskBlobRegistry` 上 | 文档 | P3 |
| C3 | `core/wire/peer.ts:10-16` | `OrcaNodeId` 头上叠了两段 JSDoc，第一段不归属任何声明 | 合并 | 文档 | P3 |
| C4 | `task/wire.ts:148`、`:181` | 两段悬空注释，后面紧跟空行 | 删除或并入下面的声明 | 文档 | P3 |
| C5 | `core/entry.ts:4-9` | 还写着"源码检出靠 Node 类型剥离直接跑 `.ts`"，D41 之后已经不成立 | 改成"vitest / tsx 加载 `src/`，发布包跑 `lib/`" | 文档 | P3 |
| C6 | `executor/process.ts:1-5` | 头注释说本文件有 abort errors，但 `abortError` 早已在 `core/errors.ts` | 随 E5 删除整个文件 | 文档 | P3 |
| C7 | `core/blobs.ts:166` `hashFile` | 模块私有，只有 `DiskBlobRegistry.register` 调用 | `private static` | R2 | P3 |
| C8 | `core/identity.ts:68` | 参数已经是品牌类型 `OrcaNodeId`，函数里又 `isOrcaNodeId` 一次；两个调用方（`verifyAuth`、`verifyGrant`）传进来的都是校验过的 id | 删掉这次检查（保留解码外面的 `try`） | R9 | P3 |
| C9 | `plugin/catalog.ts:140` → `core/model-catalog.ts:44` | 唯一的生产调用方传 `defaultModel?.reasoningEffort ?? null` 当第三个参数，而 `update` 内部本来就会回退到它 | 调用方不传第三个参数 | R9 | P3 |
| C10 | `core/schema.ts:17` `parseSchema` | 把 zod 的 `safeParse` 结果再包一层；12 个调用方里有 11 个拿到 `issue` 就 `describeIssue` 然后抛错，只有 `node/settings.ts` 用结构化的 issue | 加 `parseOrThrow(schema, raw, fail: (detail: string) => Error)`，11 处改用；`parseSchema` 只留给 settings | 包装 | P3（可选） |
| C11 | `core/sqlite.ts:79`、`task/dispatch-store.ts:11` | `JsonTable.remove`、`DispatchStore.remove` 和两个实现都没有调用方 | 删除 | 死代码 | P2 |

### 5.2 mesh

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| M1 | `membership.ts:77-152`、`:270-313`、`:352-376` | 成员记录是数据袋，迁移逻辑散在自由函数和内联赋值里 | K3 | R4 | P1 |
| M2 | `membership.ts:239` `touch` / `:262` `observeInbound` | 同一件事有两个入口，区别只在 `observeInbound` 对自己返回 true；`cluster-routes.ts:139` 已经先排除了自己 | 并成 `observeInbound` | R8 | P2 |
| M3 | `membership.ts:175` `now()`、`:344` `needsProbe(id, nowMs)`；`heartbeat.ts:45-48` | 调用方从 membership 取时钟，再原样传回给它；`HeartbeatLoop.tick` 用 membership 的谓词去过滤 membership 的列表 | `Membership.due(): PeerView[]`（有端点且该探测了的成员）；删除 `now()` | R3、R7 | P2 |
| M4 | `membership.ts:332` `evaluate()` | 返回值只有测试在读 | 返回 `void`，测试读 `list()` | R7 | P3 |
| M5 | `membership.ts:316` `mergeRemote(members \| null \| undefined)` | 允许传空，而唯一可能传空的调用方（`workgroup.ts:248`）已经判过一次 | 参数改为 `readonly PeerView[]` | R9 | P3 |
| M6 | `workgroup.ts:90` `self()`、`:94` `members()`；`node/orca-node.ts:223` `self()` | `OrcaNode.self()` → `Workgroup.self()` → `profile.record()` 两跳转发；`Workgroup.members()` 没有调用方 | 三个都删；21 处 `node.self()`（src 4 处、test 17 处）改成 `node.profile.record()`，只取 id 的直接用 `node.orcaNodeId` | R8 | P2 |
| M7 | `workgroup.ts:32`、`:41`、`:48` | `isAdmissionRejection`、`assertAnsweredBy`、`signatureOf` 只服务 `Workgroup` | `private static` | R2 | P3 |
| M8 | `workgroup.ts:242` `pulse(…, observeFailure: boolean)` | 布尔开关参数，两个调用方各传一个常量 | `pulse` 不再记失败；`heartbeat()` 自己 catch，调用 `observeOutboundFail` 后重抛（`dropPeer` 分支不变） | 开关参数 | P3 |
| M9 | `workgroup.ts:22` `WorkgroupOptions` | 把 config 的 snake_case 字段原样搬进来，构造器里再改名成 `DialPolicy`，`logger` 也混在里面 | `options: { logger; dial: DialPolicy }`，由 `OrcaNode` 从 config 转换一次 | R10 | P3 |
| M10 | `workgroup.ts:29` `LeaveResult` | 导出的类型只有一处使用 | 内联 | R10 | P3 |
| M11 | `peer-client.ts:73-143`、`:207-273` | `unwrap`、`expectReply` 各只被 `call` 用一次，`Reply` 只是两者之间的中转形状；`readCapped`、`parseJson`、`unwrapError`、`trimSlash` 只服务这个 class；`download` 照抄了 `send` 里构造签名头的代码 | `unwrap`、`expectReply` 内联进 `call`；其余改 `private static`；抽出 `private authorization(method, url, target, body?)` 供两者共用 | R1、R2 | P2 |
| M12 | `screening.ts:74` `candidateEndpointAllowed` | 一行包装 `screenEndpoint(…) === "allowed"`，生产中只有 `EndpointDialer` 调用 | 内联进 `EndpointDialer`；`ssrf.test.ts` 改测 `screenEndpoint` | R1 | P3 |

### 5.3 executor

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| E1 | `acp/session.ts:55`、`acp/executor.ts:89` | `OpenSession` 加 `selectModel`；`AcpRun` 穿过 `session.connection` 调用 | K4 | R3、R4、迪米特 | P1 |
| E2 | `acp/session.ts:32`、`:46`、`:58` | `readSessions`、`writeSessions`、`toAcpMcpServers` 只服务 `AcpSessionPool` | 前两个改成私有方法 `loadBindings(podDir)` / `saveBindings(podDir, map)`；`toAcpMcpServers` 内联进构造器 | R1、R2 | P2 |
| E3 | `acp/executor.ts:71`、`:76`、`:113` | `textOf`、`stopReasonOf` 各只有一处调用；`suspensionFor` 只给 `AcpRun` 用 | 前两个内联；`suspensionFor` 改为 `AcpRun` 的私有方法 | R1、R2 | P3 |
| E4 | `acp/connection.ts:47`、`:66`、`:87` | 导出的 `spawnAcpChild` 只有一处 `new AcpConnection(spawnAcpChild(spec))`；`childOutput`、`childInput` 只服务构造器 | `static AcpConnection.spawn(spec)`（构造器仍然接收子进程，保持无副作用）；两个流适配改 `private static` | R2 | P3 |
| E5 | `executor/process.ts` | 只剩 `terminateChild` / `killTree`，唯一的调用方是 `AcpConnection.fail`；`KILL_GRACE_MS` 由 connection 和 `acp/executor.ts` 共用 | 并进 `acp/connection.ts`（`private static terminate`，`KILL_GRACE_MS` 从那里导出），删除 `process.ts` | R2 | P3 |
| E6 | `acp/executor.ts:39` `AcpExecutorOptions = AcpExecutorConfig & { data_root?: string }` | 节点把 `data_root` 塞进 ACP 配置对象，只是为了在构造器里再取出来放进环境变量 | `AcpExecutor(config, dataRoot, models, logger)` | R10 | P3 |

### 5.4 task

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| T1 | `runner.ts:102-455` | runner 为 `TaskRecord` 公开 8 个字段和 `settle()` | K1 | 封装、迪米特 | P1 |
| T2 | `task/slot.ts` | 一个可空字符串包成了 class；K1 之后只有 runner 自己用 | 并进 runner，删除文件 | 包装 | P2（随 K1） |
| T3 | `workspace.ts:16-58`、`prompt.ts:19`、`plugin/admin.ts:140`、`runner.ts:311` | 路径袋加自由函数；notes 列表写了两遍；artifact 路径手拼 | K2 | R4 | P1 |
| T4 | `grants.ts:40` `checkGrant(grant, expected, ledger, now)` | 参数里带着账本，调用方先 check 再 `consume`，分两步 | `GrantLedger.accept(grant, expected): GrantFailure \| null`，验证通过就记账 | R3 | P2 |
| T5 | `grants.ts:17` `parseSignedGrant` | 唯一的调用方是 `meta.ts:52` | 内联 | R1 | P3 |
| T6 | `delegation.ts:34`、`:50` | `TaskCallOptions` 只是 `{ signal? }`；`callOptions()` 把 `{ signal: undefined }` 变成 `{}`，对 `CallOptions` 来说没有区别 | `getTask(peer, id, signal?)` 等方法直接收 `signal`，删除这两个 | R1、R10 | P3 |
| T7 | `delegation.ts:28` `ApprovalOptions`（`src/index.ts` 也导出了它） | 只有 `approval.test.ts:195` 传 `ttlS: -1`，用来造过期的 grant | 删除参数和导出；测试用 `signGrant` 自己签一个过期 grant，经 `rpc` 发出 | R7 | P3 |
| T8 | `runner.ts:84`、`:89`、`:423` | `nowIso` 和同文件里直接写的 `new Date().toISOString()` 混用；`truncateMessage`、`busyError` 只服务本文件的 class | `nowIso` 内联；另两个改 `private static` | R1、R2 | P3 |
| T9 | `orca-node.ts:159`、`runner.ts:447`、`self-profile.ts:40` | 任务时限默认值算了三次 | K7 | R9 | P2 |
| T10 | `runner.ts:555`、`dispatch-log.ts:74` | `recover()` 为测试公开；两个返回计数只有测试读 | 改为 `void`，`recover` 私有，测试走 `start()` | R7 | P3 |

### 5.5 api

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| A1 | `cluster-routes.ts:85`、`:153`；`gateway.ts:113` | `ClusterRoutes` 收 runner 只为调 `busy()`；`profile.busy` 已经由 `OrcaNode` 在每个任务事件里同步成同一个值 | 读 `profile.busy`；`ClusterRoutes` 去掉 `tasks` 参数 | R9 | P2 |
| A2 | `cluster-routes.ts:62`、`gateway.ts:25`、`blob-routes.ts:12` | `dialableEndpoints`、`toPodError`、`send` 各只服务一个 class | `private` / `private static` | R2 | P3 |

### 5.6 node

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| N1 | `orca-node.ts:218`、`:254` | `workgroupId` getter 没有调用方；`fetchBlob()` 是转发给私有字段 `files` 的一行代码 | 删除 `workgroupId`；把 `files` 公开为 `readonly blobs: BlobFetcher`，删除 `fetchBlob`（`plugin/admin.ts`、`ui-surface.test.ts` 改为 `node.blobs.fetch`） | R8 | P2 |
| N2 | `orca-node.ts:145-148`、`cli/shared.ts:87-93` | identity 校验写了两遍 | K7 | R9 | P2 |
| N3 | `orca-node.ts:169`、`cli/shared.ts:106` | 出站超时默认值是两份字面量 | K7。不给 settings 字段加 `default`：那样会写进 `config.json`，也会改变面板上"未覆盖 = null"的语义 | R9 | P3 |
| N4 | `orca-node.ts:32`、`:89` | `collectRuntime`、`endpointsFrom` 只服务 `OrcaNode` | `private static` | R2 | P3 |
| N5 | `node/events.ts:13` `PodEventListener` | 没有任何地方使用 | 删除 | 死代码 | P3 |

### 5.7 cli

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| L1 | `install.ts:88`、`:220`、`:311`；`orca-pod.ts:133` | 为测试替换 `existsSync`、`mkdir`、`writeFile`、`prompt` 和输出流而设的依赖袋；`PathExists` 还要穿过四个函数 | 文件操作在测试里用临时目录；只保留碰不得的外部进程：`installService(plan, options, run = runNativeCommand)`；`main` 的提示和输出用 `vi.spyOn(process.stdout, "write")` 或明确的参数 | R7 | P2 |
| L2 | `shared.ts:122`、`plugin/tracker.ts:103` | 第二、第三种取消息文字的写法 | K7 | R9 | P3（多段文字时输出会变成换行分隔） |
| L3 | `log.ts:17` | 又按 `updated_at` 排了一次序，而 `SqliteDispatchStore.list()` 已经 `ORDER BY updated_at` | 删掉这次排序 | R9 | P3 |
| L4 | `send.ts:46`、`plugin/web.ts:90`、`mesh/peer-client.ts:79` | "读完一个字节流（带上限）"写了三份 | `core` 加 `readAll(source: AsyncIterable<Uint8Array>, maxBytes?)`，三处共用，各自包装错误 | R9 | P3（可选） |

### 5.8 plugin

| 编号 | 位置 | 问题 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- | --- |
| G1 | `tracker.ts:311`、`:418`；`broker.ts:44`、`:114`；`admin.ts:384` | 只为测试存在的变化通知 | K5 | R7、R8 | P2 |
| G2 | `admin.ts:140-209`、`web.ts:108` | 投影层由 8 个自由函数组成；`labeller()` 返回闭包，是一个没有名字的对象；`podState(admin)` 连着调用 admin 的六个方法 | 新增 `RosterLabels` class（`label(key)`）；`localRow`、`dispatchRow`、`artifactsOf`、`preview`、`podOf`、`isActive` 改为 `PodAdmin` 的私有方法；`podState` → `PodAdmin.state()`；`entries()` 由 K2 取代 | R2、R3、R4 | P2 |
| G3 | `lifecycle.ts:218`、`admin.ts:395`、`broker.ts:124`、`tools.ts:401` | "节点没在运行"写了四遍 | K7：`PodLifecycle.requireNode()`；`PodTool` 先等 `ready` 再调用它 | R9、tell-don't-ask | P2 |
| G4 | `catalog.ts:39-109` | 发现逻辑的六个自由函数 | K6 | R3 | P2 |
| G5 | `tools.ts:37`、`:267`；`tracker.ts:39` | `SandboxReader`、`SandboxSource`、`TrackerAgent`：为测试设的 `Pick` / 结构类型，而测试仍然在写 `as unknown as SandboxReader` | 参数直接写 `SandboxPolicyService`、`OptionalService<"sandboxPolicy">`、`Agent`；测试照旧做类型断言 | R7、R10 | P2 |
| G6 | `tools.ts:50-264`、`:302-375` | `send` / `status` / `cancel` / `members` / `connect` 是公开方法，但只经 `run()` 调用；`describeError` 导出了却只在本文件用；`sessionSandboxMode` 为测试导出；另有 `renderJson`、`optional`、`need`、`parseCall`、`taskStatus`、`peerSummary`、`taskMode`、`throwIfAborted`、`waitUnlessAborted`、`json` 十个只服务 `PodTool` 的函数 | 五个方法改为 `private`；其余改 `private static`；测试经 `definition().execute` 走 | R2、R7 | P3 |
| G7 | `lifecycle.ts:246-249`、`peers-file.ts:26`、`:61` | `reset` 先问出 `peers.path` 去删文件，再调用 `peers.forgetInMemory()` | `RememberedPeers.remove()` 一次删文件并清内存；`path`、`forgetInMemory` 删除 | tell-don't-ask | P3 |
| G8 | `lifecycle.ts:299-304`、`:355-368` | 启动失败记两次；`startNode` 又把 `boot` 刚清过的 `failure` 清了一次 | K7 | R9 | P3 |
| G9 | `lifecycle.ts:39-67` | `toError`、`applyPanelFields`、`withoutSecret`、`needsSetup` | `needsSetup`、`withoutSecret` 内联；另两个改 `private static` | R1、R2 | P3 |
| G10 | `panel-api.ts:39-48`、`web.ts:257` | `PodState` 的字段写成 `ReturnType<PodAdmin["self"]>` 等；`Awaited<ReturnType<PodAdmin["blob"]>>` 其实就是 `OpenedBlob` | 直接写类型名（`PodPeer<SelfRecord> \| null`、`PodConfigView`……）；`client/` 用到的类型名不变 | R10 | P3 |
| G11 | `plugin/config.ts:22`、`:38` | `createConfigSchema()` 只调用一次，用来造常量 `Config`；`validatePluginConfig` 导出了却只在本文件用 | 直接导出常量 `Config`；`validatePluginConfig` 不再导出 | R1 | P3 |
| G12 | `web.ts:39-150` | `headerOf`、`isLocalHostHeader`、`isSameOriginPanelRequest`、`hasJsonContentType`、`sendJson`、`readJsonBody`、`rejection`、`withBody` 只服务 `PodApi` | `private static`；`POST_ACTIONS` 表留作模块常量 | R2 | P3 |
| G13 | `bundle.ts:130`、`:140`、`:145` | 模块私有 class `PodPlugin` 的 `restore`、`onAgentCreated`、`onInboxClaimed` 是公开方法 | 改为 `private` | 封装 | P3 |
| G14 | `tracker.ts:403` `size()` | 注释写着"tests and diagnostics"，生产代码不调用 | 删除；测试改为观察 agent 收到的通知和 `list()` | R7 | P3 |
| G15 | `tracker.ts:97`、`:138` | `denyUntrustedBlockBreak` 只有一处调用；`trackingInterruptedLine` 只服务 `NoticeDelivery` | 前者内联进 `taskNoticeLine`；后者改为 `NoticeDelivery` 的 `private static` | R1、R2 | P3 |

### 5.9 其他

| 编号 | 位置 | 问题 | 改法 | 级 |
| --- | --- | --- | --- | --- |
| X1 | `biome.json:51` | override 指向已经不存在的 `src/transport/gateway/a2a-routes.ts` | 删除这条 override | P3 |

## 6. 考察过但保留的

| 对象 | 为什么保留 |
| --- | --- |
| 签名验签、准入证明、grant 签名、地址筛查、摘要、`core/wire/*` 的工具函数 | R5：无状态的纯计算，多个模块共用，或者本身就是协议契约 |
| `admissionProof` / `verifyAdmissionProof` 只为测试导出 | 这是 HMAC 原语，测试要用固定的 `ts` / `nonce` 伪造请求（重放、时钟偏差），走 `createAdmission` 做不到 |
| `taskNoticeLine`、`systemdQuote`、`parseSkillDocument`、`parseAuthHeader`、`siblingEntry`、`validateConfig` | R5：导出的纯契约，有独立的单元测试 |
| `rpc()`、`remoteError` | CLI 在没有节点的进程里也要发 A2A 调用 |
| `BlobFetcher.open` 一行转发 | 如果让 `BlobRoutes` 直接拿 registry，`Gateway` 就需要第 6 个构造参数 |
| `PodAdmin.approve` / `deny` / `cancel` / `connect` 等 | 面板的门面：`PodApi` 只认 `PodAdmin`，其中不少方法附带了"返回最新配置"的组合 |
| `PollLoop(round, hasWork)`、`OptionalService(onChange)` 的构造回调 | 一个是私有协作者，一个是 Cordis 订阅；§1 的"不传回调"约束管的是子系统之间的通知 |
| `HttpPeerClient` 的 `SelfEndpoints` / `Roster` 结构参数 | 生产代码里有两种调用方（节点、CLI） |
| `ModelCatalogFeed.watch(host: CatalogHost)` | 见 §1 |
| `settings.ts` 的 `FIELDS` 表、`field()`、`fromFields()` | 字段表是唯一真源，类型断言集中在一处，正是它的设计 |
| CLI 子命令的 `run()`、`install.ts` 的计划与渲染函数 | 一次性过程加纯计算 |
| 模块级常量 | R6 |
| `newTaskId(now?, prng?)` | 纯函数上的可选参数，不影响任何 class 的设计 |

## 7. 迁移顺序

每一步结束时 `npm run check` 全绿（用 PowerShell 跑：Bash 工具下 vitest 会出错），并单独提交。**机械整理（R1 / R2）和设计变更不放在同一个提交里**，方便评审。

| 步 | 内容 | 编号 | 另跑 |
| --- | --- | --- | --- |
| 0 | 死代码、注释、配置 | C1–C6、C11、M10、N5、X1，以及 `Workgroup.members`、`OrcaNode.workgroupId` | |
| 1 | mesh 设计 | K3（M1）、M2、M3、M4、M5、M6、M8、M9 | |
| 2 | executor 设计 | K4（E1）、E2、E6 | `npm run harness`，`scripts/e2e-acp.mjs` 能跑的话也跑一遍 |
| 3 | task 设计 | K2（T3）→ T4 → K1（T1、T2）→ T6、T7、T9、T10 | `npm run harness` |
| 4 | api 与 node | A1、N1、N2、N3 | |
| 5 | plugin 设计 | K5（先确认选哪一种）、K6、G2、G3、G5、G7、G8 | `npm run harness` |
| 6 | cli | L1、L2、L3 | |
| 7 | 机械整理：R1 / R2 全部条目 | C7、C8、C9、M7、M11、M12、E3、E4、E5、T5、T8、A2、N4、G6、G9、G10、G11、G12、G13、G14、G15 | |
| 8 | 可选项 | C10、L4 | |
| 9 | 文档同步（§9） | | |

每步的检查清单：

- [ ] `npm run check` 全绿，架构测试的两个允许清单仍然为空；
- [ ] 用 `rg` 确认旧名字已经没有引用，也没有留下别名；
- [ ] 跑第一轮那三条丢失 `this` 的 grep（对象字面量里的 `obj.method`、实参位置的 `obj.method`、解构实例方法），逐条确认；
- [ ] 第 7 步之后：`rg -n "^(async )?function " src` 剩下的每一个都能对上 R5，`rg -n "ReturnType<|Pick<" src` 剩下的每一个都能对上 R10；
- [ ] K7 收尾：`rg -n "orca node is not running|DEFAULT_TASK_TIMEOUT_S|30_000" src` 每一项都只剩一个来源。

## 8. 行为变化与风险

行为变化（都不涉及线上协议）：

1. **L2**：`orca-node status` / `wait` 的文本输出改为显示所有 text part、用换行分隔（现在只显示第一段）；tracker 通知里多段文字也改为换行分隔。如果不想改输出，就跳过 L2。
2. **K2**：组装提示词时列 notes 目录从异步 `readdir` 改为同步，只读一个目录的顶层，开销可以忽略。
3. **K5**：生产行为不变（面板本来就靠轮询）。
4. **A1**：busy 的值不变，只是来源变了：`profile.busy` 在每个任务事件里都会和 `tasks.busy()` 同步。

风险：

- **K1 的顺序**：槽位同步必须在 `events.emit` 之前，否则 `OrcaNode` 发出的成员事件会带着旧的 busy。`a2a.test`、`approval.test` 已经覆盖了"占槽 → 挂起让槽 → 恢复抢槽"，改动后必须全绿。
- **K1 的异常**：记录的变化改走 `ChangeSignal`，监听器里抛的异常会被吞掉并记日志。runner 的监听器只做赋值、带 try 的落盘、`emit` 和 `measure`，都不会抛；但以后往里加逻辑时要记住这一点。
- **R2 的改动量**：大量函数改成 `private static`，纯属机械操作，单独成一个提交（第 7 步）。转换时不要把方法当回调传出去（第一轮 §11.1 的规则）。
- **测试改写面**：K5、K6、G5、G6、L1、T7 都会改测试的写法，但不减少被测的行为；每条测试原来断言的东西，改写后都要有对应的断言。

## 9. 文档同步

- `docs/DECISIONS.md`：
  - D41 的"与方案的出入"删掉"`TaskRecord` 并进 `task/runner.ts`"那一条；
  - 新增 **D42**：模块级函数的去留规则（R1–R5）；只为测试存在的公开面一律删除（R7）；默认值和检查只有一个来源（R9）；类型不转手（R10）。理由写"第一轮只换了外壳"，以及 §0 的五类症状。
- `docs/09-implementation.md`：
  - §9.1 文件表：新增 `task/record.ts`，删除 `task/slot.ts`、`executor/process.ts`；
  - §9.2 读入口表（`09-implementation.md:58`）：`node.fetchBlob` → `node.blobs.fetch`；
  - `OrcaNode` 那一段（`:126`）：去掉 `workgroupId`、`self()`、`fetchBlob`，加上 `node.blobs`，`node.workspace` 改为 `Workspace` class；
  - 存储那一条（`:219`）：`workspacePathsOf` / `ensureWorkspace` 改写为 `Workspace` 的构造器和 `ensure()`；
  - §9.6 工程约定补上 R1–R10。
- `README.md` 和 `scripts/` 里没有用到这一轮要删的 API（已用 `rg` 核实），不需要改。
- 完成后更新记忆 `class-refactor-direction`：第二轮已完成，以及 D42 的要点。

## 10. 不做的事

- 不改线上协议、zod schema、错误码、HTTP 路由、存储表结构；
- 不新增依赖，不改目录划分和分层；
- 不把模块级常量改成 `static readonly`；
- 不把 DTO（`PeerView`、`TaskView`、`DispatchEntry`……）做成富领域对象：`PeerEntry` 和 `AcpSession` 是模块内部的状态对象，不出现在线上；
- 不重写 CLI 子命令的结构；
- 不合并三个 SQLite 连接（第一轮就留到以后，理由不变）；
- 不改 `client/` 的代码：面板只做类型导入，`panel-api.ts` 导出的类型名保持不变。
