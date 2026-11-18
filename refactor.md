# 重构方案（第三轮）：插件侧按人的直觉重排

> 状态：**已实施**（2026-11-18 起草并实施，分支 `refactor/classes`，基于 `ea0e3ab`；提交 `refactor3(0)`–`refactor3(7)`，与方案的出入见文末“实施记录”）。
> 前两轮已完成：第一轮（D41）做目录重组，把闭包工厂改成 class；第二轮（D42）处理自由函数、包装、只为测试存在的公开面，以及单一来源。两轮的规则继续有效，摘要见 §1。
> 范围：`src/plugin/` 全部文件、`src/task/delegation.ts` 与 `dispatch-log.ts` 各一处、`test/` 跟着改、`client/types.ts` 的一行 import 路径、文档。线上协议、zod schema、错误码、HTTP 路由（`/orca-api/*` 的路径与响应形状）和存储表结构都**不变**；行为上的细小变化逐条列在 §7。

## 0. 为什么还要一轮

两轮重构之后，每个 class 单独读都干净，但插件侧整体仍然不符合直觉：读者心里的模型是"插件有一个节点"，代码里的现实是"插件有一个槽位，里面时有时无一个节点，节点每次重启都换一个"。这个差别没有进类型，于是每个协作者各自处理。问题分五类：

| 类别 | 证据 |
| --- | --- |
| **两种生命期没进类型** | 插件 fiber 是长命的，`OrcaNode` 每次改配置、reset 都会换一个新的。`plugin/` 里有 17 处读 `lifecycle.node` / `requireNode()` / `ready`，各自用一种空值策略：返回 `[]` / `null`（`admin.ts:186`）、`?.` 静默跳过（`tracker.ts:339`，没有节点时派发记录就少写一个 session，宿主重启后恢复不了跟踪）、抛错（`broker.ts:109`）、先等 `ready` 再抛错（`tools.ts:263`） |
| **一个状态拆成了多个可空字段** | `runningNode`、`listenUrl`、`listenPort`、`startedAtIso` 总是一起赋值、一起清空；再加上 `isConfigured`、`failure`、`disposed`，等于用 7 个字段表示一个状态机。`ready` 只在 `start()` 里赋值（`lifecycle.ts:132`），原地重启（只改密码、`adopt`、reset 后没写入东西）时它早已 resolve，可 `boot()` 已经把节点置空，于是工具调用拿到 "orca node is not running"，而节点其实正在启动 |
| **同一件事有两条路径** | 模型目录装到节点上有两条路：`lifecycle.startNode` 调 `catalog.advertise(node)`，`feed.refresh` 也推给 `host.node`；`ModelCatalogFeed` 与 `PodLifecycle` 互相持有。待审批有两个来源：broker 的 `parked` 和 tracker 的 `view.request`，由 `admin.waitingApprovals()` 合并；用户批准后 broker 删掉提示，tracker 手里的旧视图里请求还在，于是这张卡片以 `agent_id: null` 重新出现，直到下一轮轮询 |
| **控制流照搬宿主机制，顺序只写在注释里** | `reconfigure` 的后半段取决于 `restartsOnWrite`，宿主可能在 `await persist()` 还没返回时就销毁了当前实例；"Outside the queue on purpose"、"The secret goes first"、"before the first join" 这些顺序约束只在注释里。`reconfigure` / `disconnect` / `reset` 各写一遍"写配置 → 没变就原地 boot"，写法还不一样。`reconfigure` 先把密码从 `effective` 里解构掉，才能得到可以持久化的配置 |
| **名字说机制，不说是什么；`new` 只为副作用** | `PodLifecycle` 实际就是"这个 pod"；`PodAdmin` 实际是面板的 view-model；面板的契约类型一半在 `admin.ts`、一半在 `panel-api.ts`。`new PodPlugin(ctx, config)` 创建后就丢弃，它的构造器里还调用了 `lifecycle.start()`、注册钩子和工具，违反了 §1 "构造器不碰外部"。`Tracker.track(…, { record: false })` 是布尔开关参数 |

## 1. 继续有效的约束

- 8 个上下文 `core ← {mesh, executor} ← task ← api ← node ← {cli, plugin}`，同层互不引用，**仅类型的环也算违规**，`test/architecture.test.ts` 的两个允许清单保持为空。
- 服务用 class，协作者用构造器参数属性；私有协作者由拥有者 `new`，共享对象由创建者传入；子系统对外通知用自己的 `readonly events` / `changes`。不做依赖注入：没有容器、`XDeps`、端口接口、`createX` 工厂。
- 构造器不写盘、不联网、不启计时器（SQLite store 与 `OptionalService` 是写明的例外；订阅一个 `ChangeSignal` 不算碰外部）。
- 第二轮的 R1–R10（D42）照旧：单处使用的小函数内联，class 专用的写成 `private` / `private static`，不留只为测试存在的公开面，默认值和检查只有一个来源，类型不转手。
- 测试使用真实对象和 `vi.spyOn`，**设计不为测试让步**，必要时重写测试。

第二轮 §1 里的一条出入在本轮撤回：

| 出入 | 本轮 |
| --- | --- |
| `ModelCatalogFeed.watch(host: { node, ready })` 用结构类型（直接写 `PodLifecycle` 会形成类型环） | **撤回**（K3）：feed 不再认识 pod，`CatalogHost` 与 `watch` 一起删除 |

## 2. 本轮的判定规则

| 规则 | 内容 |
| --- | --- |
| **H1 一个状态一个值** | 总是一起赋值、一起清空的字段合成一个对象；用几个布尔或可空字段划分出来的状态，改成判别联合 |
| **H2 生命期写进类型** | 跨重启存在的对象（插件 fiber 级）和一次运行的对象（节点级）在类型上分开；每个消费者"没有节点时怎么办"必须写得出来，并且只能从 §3 K1 的四种策略里选 |
| **H3 一个事实一个所有者、一条路径** | 同一份数据只有一个登记处；把 A 装到 B 上只有一条代码路径；所有者之间的引用是单向的 |
| **H4 顺序约束进结构** | 必须先做 X 再做 Y 的地方，由一个方法按顺序做完（或者让 Y 拿着 X 的结果），而不是靠调用方读注释。要用 "on purpose" / "must … first" 注释来解释的顺序，都是本轮要消除的对象 |
| **H5 名字说是什么** | class 名是领域名词（pod、面板模型），不是机制（lifecycle、admin）；一个契约放在一个文件里 |
| **H6 构造只组装** | 构造器只建对象和订阅；启动、注册钩子是显式的方法调用；`new` 出来的对象要么被持有，要么立刻被调用 |

验收时的 grep：`rg -n "on purpose|must .* first|before the first" src/plugin` 剩下的每一条都要能说明，为什么不能改由结构保证。

## 3. 重点设计变更

### K1 `PodLifecycle` → `Pod`：状态机进类型

文件 `plugin/lifecycle.ts` → `plugin/pod.ts`，class `PodLifecycle` → `Pod`。

```ts
/** One started node; replaced as a whole on every restart, never mutated. */
export type PodRun = { readonly node: OrcaNode; readonly port: number };

export type PodStatus =
  | { kind: "unconfigured" }              // no workgroup or no stored password: the panel shows the wizard
  | { kind: "starting" }                  // a (re)start is queued or running
  | { kind: "running"; run: PodRun }
  | { kind: "failed"; error: Error }
  | { kind: "stopped" };                  // the plugin fiber unloaded

export class Pod {
  get status(): PodStatus;
  /** The current run, or null in every other status. Read-only projections use this. */
  get run(): PodRun | null;
  /** Settles when no (re)start is queued or running — every restart, not only the first. */
  settled(): Promise<void>;
  /** The current run, or an error that names the status (not set up / failed: … / stopped / starting). */
  requireRun(): PodRun;

  /** The stored plugin config with `data_root` fixed; never holds the password. */
  get settings(): RootedSettings;
  get configured(): boolean;              // settings.workgroup_id && a stored password
  get passwordSet(): boolean;
  get rememberedPeers(): readonly string[];

  start(): void;
  stop(): Promise<void>;
  reconfigure(patch: PanelPatch): Promise<void>;   // K2
  addPeer(peer: string): Promise<void>;
  disconnect(): Promise<void>;
  reset(): Promise<void>;
}
```

- 删除的字段：`runningNode`、`listenUrl`、`listenPort`、`startedAtIso`、`failure`、`disposed`、`readyPromise`、`effective`，换成 `status: PodStatus` 和 `booting: Promise<void>`。`isConfigured` 由 `settings` 与 `password` 推出，不再单独存。
- 删除的 getter：`node`、`url`（只有测试读，改读 `run.node.profile.endpoints[0]`）、`port`（并进 `PodRun`）、`startedAt`（没有读者）、`error`（并进 `status`）、`config`（K2）、`ready`（改为 `settled()`）。
- 所有重启都经由一个私有方法 `restart()`：同步地把 `status` 设成 `starting`，再把 `boot()` 排进队列，并把 `booting` 指向它。`settled()` 返回 `booting`。这样修好了 §0 里的 `ready` 漏洞：工具在原地重启期间会等重启结束，而不是立即报"没在运行"。

**消费者的四种策略（H2）**，每一处读取都标明用的是哪一种：

| 策略 | 写法 | 用在 |
| --- | --- | --- |
| 展示：没有就是空 | `pod.run?.node` | `PanelModel` 的 `self` / `members` / `recent` / `workspace` / `approvals` 的标签 |
| 动作：等重启结束，失败要说出原因 | `await pod.settled()` → `pod.requireRun()` | `PodTool`（带 abort）、`ApprovalBroker.decide`、`PanelModel` 的 `task` / `cancel` / `blob` |
| 后台：没有就跳过这一轮 | `const run = pod.run; if (run === null) return;` | `Tracker.poll`、`Pod` 内部安装模型目录（K3） |
| 写副作用 | 不允许依赖"碰巧有节点" | 原来 `tracker.ts:339` 的 `annotate`，由 K5 消除 |

`PanelModel` 的面板动作是否也要等 `settled()`：要，否则面板在保存设置后立即点"取消任务"会碰到同样的问题。`settled()` 不等 `addPeer` 的 join（join 不是重启）。

### K2 配置提交只有一条路径

现状：`reconfigure`、`disconnect`、`reset` 各自调 `persist()`，`persist` 在宿主不会重启插件时调 `adopt()`，调用方再根据返回值决定是否原地 `boot()`。三处写法不同，密码要先从 `effective` 里解构掉才能持久化。

改法：

```ts
/**
 * Make a panel action durable, then run the pod on the result. When the host
 * restarts the plugin on a config write, this instance is about to be disposed
 * and does nothing more; otherwise it restarts in place on what was stored.
 */
private async commit(change: (raw: RawConfig) => RawConfig): Promise<void> {
  const written = await this.stores.writeConfig(change);       // outside the queue: a host restart drains it
  if (written !== null && this.stores.restartsOnWrite) return;
  if (written !== null) this.saved = this.rooted(parseSettings(written));
  await this.restart();
}
```

- `reconfigure(patch)`：先校验合并后的结果，再写密码，最后 `commit`。"密码先于配置"由方法内的顺序保证，注释只说明原因，不再承担约束。
- `disconnect()`：`commit` 只在插件配置里确实有 `peers` 时调用（现状如此）。
- `reset()`：清密码 → `commit`。
- `adopt()` 删除：只有 `persist` 调用它（R7），其职责并进 `commit`。
- 密码不再塞进设置对象里：`Pod` 持有 `saved: RootedSettings`（`workgroup_password` 恒为 `""`）和 `password: string | undefined`，只在 `startNode` 里合成一次 `{ ...saved, workgroup_password: password }` 交给 `createOrcaNodeConfig`。`reconfigure` 里的 `const { workgroup_password: _password, ...persisted } = this.effective` 随之消失。
- `PanelModel.config()` 读 `pod.settings`、`pod.passwordSet`、`pod.status`，不再读 `config.workgroup_password.length`。

### K3 模型目录单向流动

现状：bundle 先 `new PodLifecycle(…, feed)`，再 `feed.watch(lifecycle)`；目录装到节点上有两条路。

改法：**feed 只管从宿主读，pod 只管往节点上装。**

```ts
export class ModelCatalogFeed {
  /** Bumps when a refresh produced a new catalog. */
  readonly changes: ChangeSignal;
  constructor(ctx: Pick<Context, "inject">, logger: Logger);   // follows `llm` / `agentDefaultModel` (OptionalService, §1 的例外)
  current(): HostModelCatalog;
  refresh(): Promise<void>;
}
```

- 删除 `watch`、`advertise`、`reasoningEfforts()`、`CatalogHost`、`host` 字段。面板改读 `feed.current().reasoningEfforts`。
- `Pod` 在构造器里订阅 `catalog.changes`，回调里调用私有方法 `advertise()`：有 run 就 `run.node.models.update(…)`，没有就跳过（后台策略）。
- `startNode` 在第一次 join 之前调用同一个 `advertise(node)`，这是唯一的安装路径。启动成功后调用 `void this.catalog.refresh()`，保留现在"节点起来后再读一次目录"的行为（宿主的 provider 可能在 `apply` 之后才加载完）。读的结果经由 `changes` 回到 `advertise`。
- `test/fixtures/pod.ts` 的 `catalogFeed()` 不变（假 ctx 的 `inject` 什么也不做）。

### K4 待审批只有一个登记处

现状：tracker 每次看到请求都会 `broker.park`，broker 本来就有完整列表；`admin.waitingApprovals()` 再把 `tracker.list()` 里 broker 没有的请求补进来，补进来的只可能是刚刚被批准或拒绝、还没轮询到的那一个（§0 里的卡片重现）。

改法：

- `PanelModel.approvals()` 只读 `broker.list()`；删除 `waitingApprovals` 和 `PendingApproval`。
- `PodApproval.agent_id` 由 `string | null` 收窄为 `string`（client 里 `approval.agent_id !== null` 的过滤仍能编译，只是恒为真）。
- `Tracker.list()` 与 `TrackedTask` 删除：生产代码里唯一的读者没了（R7）。`tracker.test.ts`、`plugin.test.ts` 改为观察 agent 收到的通知、`broker.list()`，以及 `getTask` 的调用次数。

### K5 派发时就记下会话；tracker 不再碰 pod

现状：`PodTool.send` → `delegation.sendTask` 写派发记录 → `tracker.track` 再经 `lifecycle.node?.delegation.log.annotate` 补写 `agent_id`；为了让恢复时不再写一次，`track` 多了 `{ record: false }` 开关。`NoticeDelivery` 只为了算出发布者 id 才持有 lifecycle。

改法：

- `Delegation.sendTask(peerUrl, input, options?: { signal?: AbortSignal; agentId?: SessionId })`，由 `DispatchLog.recordSend(peerUrl, view, agentId?)` 在创建条目时一并写入；删除 `DispatchLog.annotate`。派发记录里的 `agent_id` 从此和条目同时存在，不再依赖"碰巧有节点"。
- `Tracker.track(agent, peer, taskId)`：没有开关。任务 id 是 ulid，新派发不可能撞上已放弃的键，所以"跳过本进程已放弃的任务"对两条入口都成立，`abandoned.delete` 删除。
- `Tracker.restore(dispatches, resolveAgent)`：删除 `onlyAgentId`。bundle 为新建 session 恢复时传 `(id) => (id === agent.id ? agent : undefined)`，两种调用的语义相同。
- 发布者 id 在轮询时就算好：`pollEntry` 拿到终态时调用 `node.client.idOf(entry.peer)`，结果放进 `FinishedTask`；`NoticeDelivery` 的构造参数去掉 lifecycle。`Tracker` 对 pod 的读取只剩 `poll` 里那一处（后台策略）。

### K6 组装读起来是一个故事

文件 `plugin/bundle.ts` 保留（`cordis.patch.yml` 与 `src/index.ts` 指向它），`PodPlugin` → `PodBundle`：

```ts
export function apply(ctx: Context, config: Settings): void {
  const bundle = new PodBundle(ctx, config);   // builds the pod, feed, broker, tracker, tool, panel; touches nothing outside
  bundle.attach(ctx);                          // agent hooks, tool, panel route, skill, settings page, disposer
  bundle.pod.start();                          // boot in the background; apply returns at once
}
```

- 构造器只建对象（`OptionalService` 照 §1 例外），不调 `start()`，不调 `ctx.on` / `ctx.tools.register` / `ctx.effect`。
- `attach(ctx)` 按"宿主里会发生什么"的顺序注册：卸载时的 disposer → agent 生命周期钩子 → 工具 → 面板路由 → skill → 设置页。每一段的注释说明宿主的行为，不说明本包内部的顺序。
- `new PanelRoutes(…).register(ctx)` 这种"建了马上用"的写法保留（H6 允许）。

### K7 命名与面板契约

| 现在 | 之后 | 原因 |
| --- | --- | --- |
| `PodLifecycle`（`lifecycle.ts`） | `Pod`（`pod.ts`） | 它就是这个 pod：设置、密码、peers、当前运行 |
| `PodPlugin` | `PodBundle` | 与文件名和 DSH 的"bundle"说法一致 |
| `PodAdmin`（`admin.ts`） | `PanelModel`（`panel.ts`） | 面板的数据与动作，没有"管理员"的含义 |
| `PodApi`（`web.ts`） | `PanelRoutes`（`panel-routes.ts`） | 它是 `/orca-api` 的路由 |
| 面板响应类型分在 `admin.ts` 与 `panel-api.ts` | 全部在 `panel-api.ts` | 一个契约一个文件；`panel.ts` 单向 import 它 |
| `test/fixtures/pod.ts` 的 `idleLifecycle` / `lifecycleWithNode` | `idlePod` / `podRunning(node)` | 后者 spy `status` getter，返回 `{ kind: "running", run: { node, port } }` |

`client/types.ts` 只改一行 import 路径（`admin.ts` → `panel-api.ts`），导出的类型名全部不变；这是本轮对 `client/` 唯一的改动。

**术语表**（写进 `docs/09-implementation.md` §9.2，代码注释照用）：

| 词 | 指的是 | 不要用来指 |
| --- | --- | --- |
| pod | 一个 DSH profile 里的这个插件：`Pod` 加上它的 tracker、broker、工具、面板，跨节点重启存在 | 节点 |
| node / orca node | 一个 `OrcaNode` 实例，即一次运行（`PodRun.node`） | 插件、机器 |
| run | 一次成功启动：节点加上实际监听端口 | |
| member | 本节点成员表里的一条记录（`Membership`） | 地址 |
| peer | 一次调用所指向的对方，按 URL 称呼（`peer` 参数） | 成员记录 |
| host | 宿主 DSH 进程及其服务（`ctx.*`） | 远端节点 |
| settings / raw config / panel patch / node config | 解析后的插件配置 / profile 里存的原样配置 / 面板发来的增量 / 节点自己的 `config.json` | 互相混用 |

## 4. 逐文件清单

| 编号 | 位置 | 改法 | 规则 | 级 |
| --- | --- | --- | --- | --- |
| P1 | `lifecycle.ts` → `pod.ts` | K1：`PodStatus` / `PodRun` / `settled()` / `requireRun()`；删 7 个字段、6 个 getter | H1、H2 | P1 |
| P2 | `pod.ts` | K2：`commit()`；`adopt` 删除；`saved` 与 `password` 分开 | H3、H4、R7 | P1 |
| P3 | `catalog.ts` | K3：`changes` / `current()` / `refresh()`；删 `watch`、`advertise`、`reasoningEfforts`、`CatalogHost` | H3 | P1 |
| P4 | `admin.ts` → `panel.ts` | K4：`approvals()` 只读 broker；K1 的展示 / 动作策略；类 `PanelModel`；响应类型搬到 `panel-api.ts` | H2、H3、H5 | P1 |
| P5 | `tracker.ts` | K5：`track` 无开关、`restore` 无 `onlyAgentId`、`list` / `TrackedTask` 删除、发布者 id 在轮询时算好、`NoticeDelivery` 去掉 lifecycle | H2、H3、开关参数、R7 | P2 |
| P6 | `task/delegation.ts`、`task/dispatch-log.ts` | K5：`sendTask` 收 `{ signal, agentId }`；`recordSend` 收 `agentId`；`annotate` 删除 | H4 | P2 |
| P7 | `tools.ts` | `requireNode(signal)` → 等 `pod.settled()` 再 `pod.requireRun()`；`send` 把 `exec.agent?.id` 交给 `sendTask` | H2 | P2 |
| P8 | `broker.ts` | `decide` 先等 `settled()` 再 `requireRun()`；构造参数类型 `Pod` | H2 | P2 |
| P9 | `bundle.ts` | K6：`PodBundle` 的构造 / `attach` / `pod.start()` 三段；`restore` 用新的 `Tracker.restore` | H6 | P2 |
| P10 | `web.ts` → `panel-routes.ts` | 类 `PanelRoutes`，读 `panel-api.ts` 的类型 | H5 | P3 |
| P11 | `panel-api.ts` | 接收 `PodArtifact`、`PodPeer`、`PodApproval`、`PodTaskRow`、`PodTaskDetail`、`WorkspaceView`、`PodAdvancedConfig`、`PodConfigView`、`PodState` | H5 | P3 |
| P12 | `client/types.ts` | import 路径一行 | | P3 |
| P13 | `test/fixtures/pod.ts` 与 6 个测试文件 | 跟随 K1 / K4 / K5 / K7 改写，断言不减少 | | 随各步 |

## 5. 考察过但保留的

| 对象 | 为什么保留 |
| --- | --- |
| `Tracker` / `ApprovalBroker` 活在插件 fiber 级，而不是每次运行一个 | 它们跟踪的是派发记录里的远端任务，派发记录在 `<data_root>` 的 SQLite 里，跨节点重启存在；节点换了，下一轮用新节点继续轮询。reset 删掉 identity 之后，旧任务的轮询会得到 401/403，tracker 按现有逻辑放弃并发出通知，行为不变 |
| `Tracker`、`ApprovalBroker`、`ModelCatalogFeed`、`RememberedPeers` 这几个名字 | 已经是领域名词，说的就是"是什么" |
| `PodStores` / `HostPodStores` / `MemoryPodStores` | 名字一般，但改名的收益只是措辞，K2 之后它的职责（密码 + 原样配置 + `restartsOnWrite`）已经单一 |
| `Settings` / `RootedSettings` / `RawConfig` / `ConfigFields` / `PanelPatch` / `OrcaNodeConfig` / `Config` | 各自对应真实存在的不同形状（解析后、定了根目录、存储原样、可清空的增量、面板子集、节点 `config.json`、Standard Schema 外壳）。问题出在没有地方把它们并排说清，用 §3 的术语表解决，不合并类型 |
| `SerialQueue`、`OptionalService` | 机制本身清楚；问题出在使用方 |
| `withBody` / `POST_ACTIONS` | 第二轮的理由不变 |
| `core/`、`mesh/`、`executor/`、`api/`、`node/` | 本轮没有发现同类问题；K5 只碰 `task/` 的两个方法签名 |

## 6. 迁移顺序

每一步结束时 `npm run check` 全绿（用 PowerShell 跑），并单独提交；涉及 plugin 的步骤另跑 `npm run harness`。**改名（第 5 步）单独成一个提交**，不和设计变更混在一起，方便评审。

| 步 | 内容 | 编号 |
| --- | --- | --- |
| 0 | 先补测试，暴露现有漏洞：原地重启期间的工具调用应等到新节点；批准之后 `approvals()` 不应再出现同一个任务 | （测试先红） |
| 1 | `Pod` 状态机，但暂时保留旧文件名与类名 | P1、P7、P8（K1） |
| 2 | 配置提交单一路径 | P2（K2） |
| 3 | 模型目录单向 | P3（K3） |
| 4 | 审批单一来源、派发时记会话、tracker 去掉 pod | P4 的 K4 部分、P5、P6 |
| 5 | 改名与搬家：`pod.ts`、`panel.ts`、`panel-routes.ts`、类型并入 `panel-api.ts`、fixtures、`client/types.ts` | P4 余下部分、P10、P11、P12、P13 |
| 6 | 组装：`PodBundle` 三段 | P9（K6） |
| 7 | 文档同步（§8） | |

每步的检查清单：

- [ ] `npm run check` 全绿，架构测试的两个允许清单仍然为空；
- [ ] 第 1 步之后：`rg -n "lifecycle\.node|\.node\?\.|requireNode|\.ready\b" src/plugin` 为空；每一处 `pod.run` / `pod.requireRun()` 都对得上 K1 表里的一种策略；
- [ ] 第 3 步之后：`rg -n "models\.update" src/plugin` 只剩 `Pod.advertise` 一处；
- [ ] 第 4 步之后：`rg -n "annotate|record: false|onlyAgentId|waitingApprovals|tracker\.list" src` 为空；
- [ ] 第 5 步之后：`rg -n "PodLifecycle|PodAdmin|PodApi\b|PodPlugin|lifecycleWithNode|idleLifecycle" src test docs client` 为空，也没有留下别名；
- [ ] 收尾：`rg -n "on purpose|must .* first|before the first" src/plugin`，逐条确认无法改由结构保证。

## 7. 行为变化与风险

行为变化（都不涉及线上协议）：

1. **K1**：原地重启期间，工具调用、批准 / 拒绝、面板的取消 / 详情 / 下载会等重启结束，而不是立即报 "orca node is not running"。错误文案按状态区分：未设置 / 启动失败：原因 / 已停止。
2. **K3**：每次启动成功后都会重新读一次宿主的模型目录（现在只在第一次启动后读）。
3. **K4**：批准或拒绝之后，这张卡片立即消失，不会以 `agent_id: null` 重新出现到下一轮轮询。
4. **K5**：派发记录里的 `agent_id` 在创建条目时就写入；没有 `exec.agent` 的调用（CLI 或无 session 的宿主）照旧不写。
5. **K2**：插件配置里没有 `peers` 键、但继承层里有 peers 时，`disconnect` 的写入是空操作，现在不重启，之后会原地重启（随后会按继承层的 `peers` 重新加入）。这种情况现在就不一致，本轮不另作处理，只记录在案。

风险：

- **K1 的 `starting` 状态**：`restart()` 必须同步设置 `status` 和 `booting`，否则在"排进队列"和"开始执行"之间进来的调用会看到旧状态。第 0 步的测试覆盖这一点。
- **`stop()` 与重启的竞争**：`stop()` 先等 `queue.drain()`，再把状态设成 `stopped`；`boot()` 开头检查 `stopped` 后直接返回。语义与现在的 `disposed` 相同，只是并进了状态。
- **宿主重启路径**：`commit` 在 `restartsOnWrite` 时直接返回，之后不能再碰 `this`（实例即将被销毁）。`plugin-apply.test.ts` 与 `panel-config.test.ts` 要覆盖两种 stores。
- **测试改写面**：`panel-config.test.ts`（26 处读 lifecycle 的 getter）、`tracker.test.ts`（8 处 `list()`）、`broker.test.ts`、`plugin.test.ts`、`ui-surface.test.ts`、`web.test.ts`。每条测试原来断言的东西，改写后都要有对应的断言。

## 8. 文档同步

- `docs/DECISIONS.md`：新增 **D43**：插件侧的状态是判别联合 `PodStatus`，`Pod` 之外的消费者只能按四种策略读取当前运行；每个事实只有一个所有者、一条路径；顺序约束由结构保证。理由写 §0 的五类症状。同时把头部的"编号 D1–D42"改为 D1–D43。
- `docs/09-implementation.md`：
  - §9.2 插件段落（`:163`）按新文件名、新类名重写，并加入 §3 的术语表；
  - §9.2 的设置 / 密码 / peers 那一条（`:65`）：`adopt` 改为 `commit` 的描述；
  - 组装示例（`:180`）改成 `apply` 的三行；
  - 测试表（`:122`）：`PodLifecycle` → `Pod`。
- `docs/07-security.md` 里出现的旧类名、旧文件名逐个替换（`rg "PodLifecycle|PodAdmin|PodApi\b|PodPlugin|lifecycle\.ts|admin\.ts|web\.ts" docs README.md` 只命中它和 09）。
- 完成后更新记忆 `class-refactor-direction`：第三轮（D43）已完成，以及 H1–H6 的要点。

## 9. 不做的事

- 不改线上协议、zod schema、错误码、HTTP 路由与响应形状、存储表结构；
- 不新增依赖，不改目录划分和分层；
- 不动 `core/`、`mesh/`、`executor/`、`api/`、`node/`；`task/` 只改 K5 的两个签名；
- 不把 tracker / broker 改成每次运行一个（§5）；
- 不合并配置相关的类型（§5），只用术语表说清；
- 不改 `client/` 的代码，除了 `types.ts` 的一行 import 路径。

## 10. 实施记录（与方案的出入）

每一步结束时 `npm run check` 全绿，涉及 plugin 的步骤另跑了 `npm run harness`（PASS）。出入如下，行为都没有超出 §7：

1. **`Pod` 内部不是单个 `status` 字段。** `status` 对外仍是 K1 的判别联合，但内部是 `outcome`（上一次启动的结果，只在串行队列里写）加 `restarting` 计数，`status` 由它们推导：`restarting > 0` 即 `starting`。原因：`restart()` 要同步变成 `starting`，而排队中的旧节点还得有人拆，单字段会把它弄丢。`restarting` 在节点开始监听、目录装好之后就减掉，rejoin peers 留在同一条队列里，所以启动时面板在慢 join 期间仍然看得到节点（与原行为一致）；`settled()` 则等到 rejoin 结束。
2. **`stop()` 排进队列**，而不是“先 drain 再置 `stopped`”：队列里排在它后面的重启在 `bringUp()` 开头看到 `stopped` 就什么都不做，比方案的写法少一个竞争窗口。
3. **K3 与步骤 1 之间有一个临时垫片**（`feed.watch` 的适配对象，在 `bundle.ts` 里，步骤 3 删掉），因为 `Pod` 不再有 `node` / `ready`。
4. **K6：`bundle.start()` 而不是 `bundle.pod.start()`。** 启动之后还要恢复已在运行的会话（必须在节点起来后做；`agents` 服务在构造时就可能出现，那一次是空操作），所以启动入口放在 `PodBundle` 上，`pod` 不对外。
5. **第 0 步的审批测试**在步骤 1 的提交里临时标成 `it.fails`，步骤 4 翻回 `it`，让每个提交都是绿的。
6. **已知小出入（K5）**：调用方取消了正在发送的 `send`、而随后的 `cancelTask` 也失败时，派发记录里这一条现在带着 `agent_id`（以前没有），宿主重启后会被当作该会话的派发恢复追踪。
7. 测试文件名未改（`web.test.ts` 等），只改了内容与夹具名。
