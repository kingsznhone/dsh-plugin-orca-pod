# orca-pod 架构重组计划

> 日期：2026-11-17
> 读者：接手执行重组的 agent。本文自足：动手前读完它、`audit.md` 和 `docs/09-implementation.md`。
> 状态：计划已获所有者认可方向；**第 4 步（引入第三方包）尚待所有者拍板**，在明确批准前不要做。

---

## 1. 为什么要重组

所有者的观察：项目缺乏按职责划分的服务边界，到处是零散文件和函数，模块组合与依赖方向不清晰。

审计后的结论是：**服务对象其实存在，缺的是边界**。

- 已经有的：32 个 `createX(deps)` 工厂，每个返回一个接口；依赖靠参数显式传入；`src/orca_node.ts` 是唯一装配根；运行期 import 图**没有循环**。这本身就是不用容器的依赖注入（pure DI）。
- 缺的：

| 问题 | 证据 |
|---|---|
| 目录不体现边界 | `src/` 根目录平铺约 35 个文件；`chain`、`grants`、`task_meta`、`task_inputs`、`entry`、`process`、`session_store`、`dispatches`、`blob_files` 都是某个服务的内部零件，却和服务并列 |
| 杂物堆模块 | `protocol.ts` 有 42 个导出、被 24 个模块依赖：线上协议类型、类型守卫、任务 id、模型串解析、权限等级混在一起；`net.ts` 同时管端点筛查、URL 归一化、端口挑选、回环判定 |
| 单文件多职责 | `cli.ts` 567 行、0 个导出，全部子命令挤在一起；`plugin/lifecycle.ts` 541 行，混着存储（`PodStores`）、节点启停、模型目录 |
| 存储接口分散 | `storage.ts`、`dispatches.ts`、`blob_files.ts`、`blobs.ts` 各定义一套存储接口，`sqlite.ts` 又实现其中三套 |
| 校验三种写法 | fastify 路由里手写的 JSON Schema（`gateway/*`）、`settings.ts` 的字段表解析器、`protocol.ts` 的手写类型守卫 |
| 风格不统一 | 多数服务是工厂函数；`TaskRecord`、`AcpConnection`、`EchoExecutor`、`NonceCache` 是 class |
| 依赖方向已有逆流 | `gateway/cluster_routes.ts`（传输层）import `settings.ts`（装配层）只为拿 `MAX_MODEL_OFFERS`；`task_inputs.ts`（任务层）import `entry.ts`（CLI 入口路径） |

## 2. 决策

1. **按限界上下文分目录**，每个目录只通过自己的 `index.ts` 对外暴露公共接口。
2. **依赖只能向下**，并用架构测试固化（见 §4）。
3. **不引入 DI 容器**（awilix、inversify 等）。理由：
   - 服务图只有约 20 个节点、一个装配根，容器只会带来字符串 key 查找和生命周期上的隐式行为；
   - 装饰器或运行时反射与 `tsconfig` 的 `erasableSyntaxOnly` 冲突；
   - 插件侧已运行在 Cordis 里，Cordis 本身就是 DI 容器，不要再叠一层。
4. **规范化现有的纯 DI**：
   - 服务统一写成 `createX(deps: XDeps): X`；`X` 是接口，`XDeps` 只依赖其他上下文的接口，不依赖实现；
   - 只有装配根（`node/`、`plugin/`、`cli/`）可以 import 具体实现（sqlite、fs、fastify、acp 子进程）；
   - 新代码不再新增 class 形式的服务。现有 class 可以保留，`TaskRecord` 这类有状态实体本来就适合 class，不要为统一而重写。
5. **引包（待所有者批准，见 §6）**：原则沿用 `docs/09-implementation.md` §9.7 的"基础能力用成熟包，只自己写协议语义"，但它把清单收得太死，需要重新评估。

## 3. 目标结构

```
src/
  index.ts       公共入口（库导出 + DSH 插件 apply/Config/inject），保持对外 API 不变
  kernel/        errors、ids（任务 id）、guards（isRecord）、events（进程内事件总线）、entry（包内入口路径）
  protocol/      线上协议，按领域拆：peer、task、grant、model、permission、constants（DEFAULT_PORT）
  security/      identity（节点密钥）、crypto（请求签名、准入证明、blob 链接签名、NonceCache）、grants（checkGrant、deriveChildGrant、grantCovers、GrantLedger）
  storage/       接口：TaskStore、BlobStore、FileBlobStore、DispatchStore；实现：memory、fs（blobs）、sqlite
  membership/    membership（成员表、看门狗、墓碑）、mesh（心跳循环、join/leave）、screening（候选/入站端点筛查）
  tasks/         runner（原 tasks.ts）、record（原 task_record.ts）、meta、inputs、workspace
  execution/     executor（接口）、echo、process（子进程公共件）、acp/（connection、session、session_store、permissions、executor）
  delegation/    delegation（发起侧派发、审批、上交、child-link 轮询）、chain（childPodMetadata）、dispatch-log（markInFlightUnknown 等派发日志语义）
  transport/     peer-client（出站）、net（URL 归一化、回环判定、端口、本机地址）、gateway/（入站路由）
  node/          orca-node（装配根 createOrcaNode）、config（config.json 读写、派生密钥）、settings（字段表）、harness（测试用多节点）
  plugin/        DSH 适配层：index、lifecycle、stores（PodStores + 内存实现 + host 实现）、catalog（模型目录）、tracker、broker、tools、admin、web、skill、config、dsh（宿主类型镜像）
  cli/           main（分派）、每个子命令一个文件（serve、send、status、wait、escalate、publish、log、members）、shared（peerClient、输出格式）、install（orca-pod install）、orca-pod（bin 入口）
```

### 3.1 依赖方向

```
kernel ← protocol ← security ← storage(接口) ← { membership, tasks, execution, delegation } ← transport ← node ← { plugin, cli }
```

- 同层上下文之间如需协作，依赖对方 `index.ts` 导出的**接口**。`delegation` 需要 `tasks` 的 `TaskRunner` 接口就是这种情况。
- `storage/` 的**实现**（sqlite、fs）只允许被 `node/`、`cli/`（以及测试）import；业务层只认 `storage/` 的接口。
- `transport/gateway` 通过构造参数拿到 `TaskRunner`、`PeerStore` 等接口，不 import 业务实现。这条已经是现状，保持住。
- `client/`（DSH 面板，TSX）不在 `src/` 里，只能 `import type` 从 `src/plugin/admin.ts`、`src/plugin/web.ts`、`src/protocol/*` 取类型。重组后同步更新 `client/types.ts` 的路径。

### 3.2 文件归属表（现有 → 目标）

| 现有 | 目标 | 备注 |
|---|---|---|
| `errors.ts` | `kernel/errors.ts` | |
| `events.ts` | `kernel/events.ts` | |
| `entry.ts` | `kernel/entry.ts` | 修复 `tasks → cli` 的逆流；`siblingEntry` 依赖调用模块自身的位置，搬家后 `CLI_PATH` 的相对路径要改成指向 `cli/main` 的实际产物，并保持 `test/entry.test.ts` 的守卫 |
| `protocol.ts` | `protocol/{peer,task,grant,model,permission,constants}.ts` + `kernel/ids.ts`（`newTaskId`）+ `kernel/guards.ts`（`isRecord`） | 见 §5 第 3 步的拆分清单 |
| `identity.ts`、`crypto.ts`、`grants.ts` | `security/` | `chain.ts` 中的 `deriveChildGrant`、`grantCovers` 并入 `security/grants.ts` |
| `chain.ts` 的 `childPodMetadata` | `delegation/chain.ts` | |
| `storage.ts`、`sqlite.ts`、`blobs.ts`、`blob_files.ts` | `storage/` | `dispatches.ts` 的 `DispatchStore` 接口与内存实现也放这里 |
| `dispatches.ts` 的 `markInFlightUnknown` | `delegation/dispatch-log.ts` | 派发日志的语义归发起侧 |
| `session_store.ts` | `execution/acp/session-store.ts` | |
| `membership.ts`、`mesh.ts` | `membership/` | |
| `net.ts` 的 `DialPolicy`、`EXPLICIT_DIAL_POLICY`、`candidateEndpointAllowed`、`screenEndpoint` | `membership/screening.ts` | |
| `net.ts` 其余（`normalizePeerUrl`、`isLoopbackEndpoint`、`isDirectLoopbackRequest`、`detectLocalEndpoints`、`bindChoices`、`pickFreePort`、`isBlockedFetchPort`） | `transport/net.ts` | `settings.ts` 依赖 `normalizePeerUrl`；`node → transport` 是允许的方向 |
| `tasks.ts`、`task_record.ts`、`task_meta.ts`、`task_inputs.ts`、`workspace.ts` | `tasks/{runner,record,meta,inputs,workspace}.ts` | |
| `executor.ts`、`echo.ts`、`process.ts`、`acp/*` | `execution/` | |
| `delegation.ts` | `delegation/delegation.ts` | |
| `peer_client.ts`、`gateway/*` | `transport/` | |
| `orca_node.ts`、`config.ts`、`settings.ts`、`harness.ts` | `node/` | `settings.ts` 的 `MAX_MODEL_OFFERS`、`validateModelOffers`、`validateModelSelection` 移到 `protocol/model.ts`，修复 `gateway → settings` 的逆流 |
| `cli.ts`、`orca_pod.ts`、`install.ts` | `cli/` | `cli.ts` 按子命令拆开 |
| `plugin/lifecycle.ts` | `plugin/{lifecycle,stores,catalog}.ts` | `PodStores`、`createMemoryStores`、peer 状态文件读写归 `stores.ts`；`createPodRuntime` 里的模型目录刷新归 `catalog.ts`（与现有 `models.ts` 合并） |
| `plugin/index.ts` 的 `createHostStores` | `plugin/stores.ts` | |
| `plugin/util.ts` | 并入使用方或 `kernel/errors.ts` | 只有 14 行 |

`package.json` 的 `bin`、`exports`（`./testing` → `lib/node/harness.js` 等）、`tsconfig.build.json` 和 `scripts/*` 的 import 要随搬家同步修改。

## 4. 架构测试

新建 `test/architecture.test.ts`：

- 解析 `src/**/*.ts` 的**运行期** import（`import type` 不计），得到模块图；
- 断言：
  - 没有循环；
  - 层与层之间只存在 §3.1 允许的边；
  - 跨上下文 import 只能指向对方的 `index.ts`（`node/`、`plugin/`、`cli/` 这三个装配点除外）；
  - `storage/` 的实现只被装配点 import。
- 可以直接参考本次审计用的分析脚本：它按正则读取 import、跳过 `import type`、用 Tarjan 算法找强连通分量。脚本当时放在临时目录，可能已经不在了，按这个描述重写即可。
- 第 1 步落地时**先只禁止新增违规**：把当时已存在的违规边列成白名单，写在测试里；每完成一处修复就从白名单删掉一条。第 3 步结束时白名单应为空。

## 5. 实施步骤

每一步都单独提交，每一步结束时 §7 的验收必须全部通过。

### 第 0 步：先提交当前工作区（需所有者确认）

当前工作区有约 80 个未提交的文件（G6/D1、客户端 TSX 化、N1–N7、B2/B3/B4/B8/B9、P2、G12 等）。重组会大量 `git mv`，在这之上叠加会让 diff 无法审阅。**请所有者先提交或明确授权提交**；不要在未提交的改动上直接开始第 2 步。

### 第 1 步：架构测试 + 白名单

按 §4 实现，记录现有违规边，至少包括 `gateway/cluster_routes → settings` 和 `task_inputs → entry`。

### 第 2 步：只搬文件、不改逻辑

- 用 `git mv` 搬到 §3.2 的位置，保留文件历史；
- 补每个目录的 `index.ts`，只导出本上下文对外的接口与工厂；
- 修正所有 import 路径（仓库使用带扩展名的相对 import `./x.ts`，`tsconfig.build.json` 的 `rewriteRelativeImportExtensions` 会在构建时改写）；
- 这一步不拆文件、不改函数体；`git diff -M` 应基本只显示重命名。

### 第 3 步：拆分与归位

1. **拆 `protocol.ts`**，按导出逐个归位：
   - `peer.ts`：`OrcaNodeId`、`PeerState`、`RuntimeInfo`、`BusyState`、`PeerView`、`SelfRecord`、`JoinResponse`、`HeartbeatResponse`、`MembersResponse`、`normalizeOrcaNodeId`、`isOrcaNodeId`、`isWorkgroupId`、`runtimeDigest`、`membersDigest`、`isHttpEndpoint`、`normalizeEndpoints`
   - `task.ts`：`TaskState`、`isTerminal`、`A2AMessage`、`TaskView`、`PodTaskMetadata`、`TaskInputRef`、`SubmitTaskInput`、`TaskRunner`、`permissionRequestOf`
   - `grant.ts`：`PermissionRequest`、`GrantMode`、`Grant`、`SignedGrant`、`TaskRelay`
   - `model.ts`：`ModelOffer`、`ModelSelection`、`isModelSelection`、`parseModelSpec`、`isReasoningEffort`，以及从 `settings.ts` 移来的 `MAX_MODEL_OFFERS`、`validateModelOffers`、`validateModelSelection`
   - `permission.ts`：`PermissionMode`、`isPermissionMode`、`permissionModeRank`、`narrowPermissionMode`
   - `constants.ts`：`DEFAULT_PORT`
   - `isRecord` → `kernel/guards.ts`；`newTaskId` → `kernel/ids.ts`
2. **拆 `net.ts`**：按 §3.2 分到 `membership/screening.ts` 与 `transport/net.ts`。
3. **拆 `cli.ts`**：`cli/main.ts` 只做参数分派；每个子命令一个文件，导出 `run(args, deps)`；公共部分（读 config、建 peer client、`--json` 输出）放 `cli/shared.ts`。退出码语义（`wait` 的 0/1/2/3，`escalate` 的 0/1/2）不能变，`test/cli.test.ts` 覆盖它们。
4. **拆 `plugin/lifecycle.ts`**：`PodStores` 及其内存实现、`createHostStores`、peer 状态文件读写 → `plugin/stores.ts`；模型目录刷新 → `plugin/catalog.ts`（并入 `models.ts`）。`lifecycle.ts` 只保留 `startPod`、`stopPod`、节点启停。
5. **集中存储接口**：`TaskStore`、`BlobStore`、`FileBlobStore`、`DispatchStore` 的接口统一放在 `storage/index.ts`。
6. 清空架构测试的白名单。

### 第 4 步：替换手写轮子（**待所有者批准**，未批准不要做）

一次只换一个，每次单独提交，并更新 `docs/09-implementation.md` §9.7（该节已经过时：仍写着"源码不编译、直接以 .ts 发布"，依赖表里也没有 esbuild、`@types/react`）。

| 顺序 | 包 | 替换 | 说明 |
|---|---|---|---|
| 1 | `ulid`（3.x，零依赖） | `kernel/ids.ts` 的 `newTaskId` | 改动最小。上一轮刚在这里修过时间戳编码 bug；保留 `test/protocol.test.ts` 里对照 ULID 规范参考值的用例 |
| 2 | `typebox`（1.x） | 三套校验 | 一份定义同时产出 fastify 路由 schema、静态类型、运行时校验（`Value.Parse`/`Check`）。先迁移 `gateway/*` 的路由 schema，再迁移 `protocol/*` 的守卫，最后迁移 `node/settings.ts` 的字段表（字段表里的 `panel`/`local` 元数据要保留，可以用 schema 的自定义关键字或旁路表）。fastify 已经自带 ajv |
| 3 | `@agentclientprotocol/sdk`（2.x） | `execution/acp/connection.ts` 手写的 ACP JSON-RPC over stdio | ACP 不是本项目的协议，官方 SDK 会跟着规范演进。替换后必须用真实 `dsh --profile acp` 跑 `scripts/e2e-acp.mjs` 回归，`test/fixtures/fake-acp.mjs` 也可能要跟着调整 |

明确不引入：DI 容器（理由见 §2）、zod（与 TypeBox 二选一，TypeBox 更贴合 fastify）、commander（`node:util` 的 `parseArgs` 够用，`cli` 该做的是按子命令拆文件）、pino（fastify 的日志器本身就是 pino）、`p-queue`（lifecycle 里只有 10 行的串行队列）。`write-file-atomic`（替换 `blobs.ts`、`config.ts`、`session_store.ts` 三处"写临时文件再 rename"）收益小，可做可不做。

## 6. 不能改变的东西

- **对外行为**：`/a2a`、`/cluster/*`、`/blobs`、`/orca-api/*` 的路由与报文，错误码与 HTTP 状态（`src/errors.ts` 的 `POD_ERROR_STATUS`），CLI 子命令、参数与退出码，DSH 插件的 `Config`、`inject`、`apply`。
- **包的公共导出**：`src/index.ts` 导出的符号与 `package.json` 的 `exports` 子路径（`.`、`./testing`、`./client`、`./cordis.patch.yml`、`./locale/*.json`、`./icon`），只允许改它们指向的文件。
- **不加兼容层**：`docs/README.md` 约定"不写版本与兼容"。搬家时不要留"从旧路径转导出"的过渡文件。
- **注释与文档的语言**：代码注释用英文；`docs/`、`README.md`、`audit.md` 用中文。

## 7. 验收

每一步结束时都要通过：

```bash
npx biome check .
npx tsc --noEmit
npx tsc --noEmit -p client
npm run build                      # tsc -p tsconfig.build.json + 客户端 esbuild，产出 lib/
node lib/cli.js --help             # 搬家后按新入口路径调整
npx vitest run --pool=vmThreads    # 48 个文件 / 424 个用例全部通过（重组前的基线），外加新的架构测试
```

- 测试数量只能增加；搬家时迁移测试的 import 路径，不要删测试。
- `lib/` 里不能残留指向 `.ts` 的运行时路径（`test/entry.test.ts` 有守卫）。

## 8. 环境注意事项（踩过的坑）

- **`npm run check` 现在不能用**：Node v26.13.0 下，vitest 5.1.0 的默认 `forks`/`threads` 池连一个空测试都跑不起来，必须加 `--pool=vmThreads`。vm 池里 `instanceof` 跨 realm 不可靠，判断错误类型请用 `error.name`。
- **`test/formation.test.ts` 在高负载下会偶发超时**：并发跑多个套件时可能出现，单独重跑通过即可；不要为此改生产时序参数。
- **TypeScript 7 是原生（Go）版本**，没有 JS 编译器 API。需要 AST 工具时，在仓库外单独装 `typescript@5`，不要动项目依赖。
- **换行符**：仓库是 LF（`.gitattributes` 为 `eol=lf`）。在 Windows 上用 Python 改文件时，要用 `open(..., newline='')` 读写，否则会被写成 CRLF。
- **Bash heredoc**：内容里含撇号时，`<<'EOF'` 曾被工具层解析失败。复杂脚本请先写成文件再执行。
- **可能有并行会话**：本仓库曾有另一个 Claude 会话同时修改同一批文件。动手前先跑 `git status`，修改前先读最新内容，不要整文件覆盖别人的改动。
- **DSH 源码参考**：本机 DSH 安装在 `%LOCALAPPDATA%\Programs\DeepSeek Harness\resources\app.asar`。需要核对宿主接口时，可以只读解出 `@deepseek-ai/*` 包的 `src/` 与 `README.md`；解到仓库外的空目录，不要执行其中任何代码。

## 9. 完成后

- 更新 `docs/09-implementation.md`：模块表（§9.1）、依赖方向图、§9.7 依赖选型；更新 `README.md` 的目录树。
- 在 `audit.md` 里记录重组中发现、但不在本计划范围内的问题。
- 删除本文件，或把它改成一条已完成的决策写进 `docs/DECISIONS.md`。
