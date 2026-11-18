# 09 实现

> 本章给出模块划分、DSH 组合入口、面板、测试夹具与工程约定。

## 9. 实现

### 9.1 单包内的模块划分

整个项目**就是一个 npm 包**（仓库根目录）。DSH 插件规范就是一个 npm 包（`package.json` + `dsh.bundle.patch`），拆成多个私有包会让安装物不自包含：内部依赖在仓库外解析不到。因此用目录和 import 纪律维持模块边界，不再用包边界。

```text
orca-pod/
  package.json        运行时依赖见 §9.7；dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    DSH 行：id orca-pod、name 'orca-pod'
  client/             DSH 客户端（面板）的 TSX 源码；构建到 lib/client.js
  biome.json          lint + format（一个工具）
  src/                见下表
  scripts/            cross.ts、build-client.ts、harness_run.ts、e2e-acp.mjs
  skills/orca-node/   标准 skill bundle（SKILL.md + references/add-machine.md）
  test/               vitest，按模块一份 *.test.ts；test/fixtures/fake-acp.mjs 是假 ACP server
```

`src/` 按功能分成 8 个目录（D41），目录内没有聚合导出文件（不设 `index.ts`）：谁用到什么，就直接 import 定义它的文件，所以目录内部移动代码时，调用方跟着改。

| 上下文        | 文件                                                                                                     | 职责                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `core/`       | `errors` / `schema` / `entry` / `events` / `serial-queue` / `constants` / `net` / `identity` / `signing` / `sqlite` / `blobs` / `model-catalog` / `wire/`（`peer` / `model` / `permission` / `grant` / `reply`） | 公共底座：`PodError` 与错误码 → HTTP 状态表（唯一一张）；`isRecord` 与 `parseSchema`（不可信输入的唯一入口）；包内入口路径（按当前模块扩展名解析 `cli/main.ts`/`cli/main.js`）；进程内通知 `EventBus`、`ChangeSignal` 与 `NodeLogger`；串行队列 `SerialQueue`；默认端口；地址归一化、回环判定、端口；Ed25519 身份；请求签名与验签、`NonceCache`、scrypt 派生；`SqliteDb` 与 `JsonTable`；发布文件（名字 `<orca_node_id>/<sha256>`、`FileBlobStore` 与 `DiskBlobRegistry`）；模型目录 `ModelCatalog`；跨模块共用的线上词汇（成员目录与 digest、orca node id 格式、模型路由、权限模式、grant、错误体与 ack） |
| `mesh/`       | `membership` / `self-profile` / `dialer` / `workgroup` / `heartbeat` / `peer-client` / `blob-fetcher` / `admission` / `screening` / `wire` | 组网：成员表与看门狗（`Membership`）；自述（`SelfProfile`，`busy` 由节点推送，mesh 不认识任务）；拨号顺序与端点筛查缓存（`EndpointDialer`）；join、心跳、leave、`joinAll`（`Workgroup`）；心跳循环（`HeartbeatLoop`）；**唯一的出站客户端**（`HttpPeerClient`：签名、超时、响应上限；陌生 URL 抛 `unknown_peer`，不隐式 join）；取成员发布的文件（`BlobFetcher`）；准入证明；端点筛查（候选拨号前、入站 join 登记前）与地址分类；join / 心跳请求体与 `members` 事件 |
| `executor/`   | `executor` / `kinds` / `echo` / `acp/`                                                       | 执行器契约（含 echo 脚本 schema）；执行器种类枚举（`kinds`：acp/echo）；Echo；ACP（`config` 配置类型、`connection` 按 sessionId 路由，并负责子进程的派生与杀进程树、`session` 一个 ACP 会话（`AcpSession`，选模型 / 发 prompt / 挂接路由）与绑定、`sessions.json`（`AcpSessionPool`）、`permissions` 自动应答、`executor`（`AcpExecutor` 与一次运行 `AcpRun`）） |
| `task/`       | `wire` / `runner` / `record` / `quota` / `workspace` / `grants` / `meta` / `prompt` / `task-store` / `dispatch-store` / `dispatch-log` / `delegation` | 任务线上形状（任务视图与元数据、A2A 方法参数与 JSON-RPC 外壳、派发日志条目、`task` / `dispatch` 事件）；单槽运行器（`SingleSlotTaskRunner`：槽位、存储、事件、账本）与一个任务的状态机、执行循环与计时器（`TaskRecord`，不认识 runner，经 `changes` 通知）；工作区配额（`WorkspaceQuota`）；工作区路径、目录创建、用量测量与 notes 列表（`Workspace`）；grant 签名、校验与已消费账本（`GrantLedger.accept` 验证通过即记账）；元数据一次性解析；任务书（可信前言在前、远端文本在最后的不可信块）；任务与派发日志的内存 / sqlite 存储；发起侧：`Delegation`（`sendTask`/`getTask`/`cancelTask`/审批签 grant）与 `DispatchLog`（`markInFlightUnknown`，重启后在途条目记为 `unknown`） |
| `api/`        | `gateway` / `access` / `cluster-routes` / `a2a-routes` / `blob-routes` / `input`                          | 入站 HTTP：`Gateway`（装配、body 解析、`listen` 与 `close`、唯一的错误出口）、`AccessPolicy`（`access` 声明与唯一的 preValidation 钩子）、`ClusterRoutes`、`A2aRoutes`、`BlobRoutes`、`parseInput` |
| `node/`       | `orca-node` / `config` / `settings` / `events`                                                           | **组合根**：一个进程 = 一个 orca node，只装配，子系统以只读字段公开；**唯一的设置字段表与解析器**（`config.json`、插件 `Config`、面板覆盖、install、CLI 都走它）；`config.json` 读写（身份 + 派生密钥，0600）；节点事件联合类型；测试夹具在 `test/support/harness.ts`（§9.4） |
| `cli/`        | `main` + 每个子命令一个文件（`serve`/`send`/`status`/`wait`/`publish`/`fetch`/`log`/`members`）、`shared`；`orca-pod` / `install` | `orca-node` CLI（`main` 只做参数分派）；`orca-pod install`；install 计划与 systemd unit 渲染 |
| `plugin/`     | 见 §9.5                                                                                                  | DSH bundle                                                                                   |

模块依赖单向向下，由 `test/architecture.test.ts` 固化（解析 `src/` 的 import）：

```text
core ← { mesh, executor } ← task ← api ← node ← { cli, plugin }
```

- 运行期 import 图无环，**仅类型的 import 也不许成环**（目录内的两个文件互相 `import type` 也算）；
- 运行期 import 只允许指向严格更低的一层；同层（`mesh` / `executor`、`cli` / `plugin`）一律互不引用；
- SQLite 存储（`Sqlite*`）只在装配点（`node/`、`plugin/`、`cli/`）构造，业务层通过构造参数拿到存储，参数类型是接口。

没有依赖注入：没有容器、没有 `XDeps` 类型、没有专为解耦设的端口接口。私有协作者由拥有者自己 `new`（`Workgroup` 创建 `EndpointDialer`，`SingleSlotTaskRunner` 创建 `TaskSlot`、`WorkspaceQuota` 与 `GrantLedger`，`Gateway` 创建 `NonceCache`、`AccessPolicy` 与三个路由对象……），共享对象由创建者传入（`OrcaNode`、`PodPlugin`），子系统之间的通知用各自持有的 `events`（`EventBus` / `ChangeSignal`），由订阅方决定怎么响应。接口只在存在多个实现时才写（`TaskStore`、`DispatchStore`、`FileBlobStore`、`FileBlobRegistry`、`LocalExecutor`、`PodStores`）。`node/orca-node.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。没有聚合导出，引入一个文件只会加载它自己依赖的部分（例如 `node/settings.ts` 只用 `core/net.ts`，不会连带加载 gateway）。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、错误处理都用它现成的，不手写 http server。路由不向 Fastify 注册 schema：处理器先用 `api/input.ts` 的 `parseInput` 按 zod schema 解析自己的输入（失败即 `400 bad_request`，信息带出错路径，如 `body.models.0.provider`），解析结果才是处理器用的值。**每条路由必须声明 `config.access`**（`public|join|member|local`），缺了启动即失败；验签与授权只在一个钩子里做；错误只从一个错误处理器出去。

### 9.2 面板

面板需要的每个数字都从 Host 侧同步取到，而不是先让模型调一次工具再转述。`OrcaNode` 把子系统作为只读字段公开，面板读的四个入口都在它们上面，插件再把它们打包成 `PodAdmin`：

| 入口                              | 位置                         | 内容                                                                                 |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `node.tasks.list(limit?)`         | `task/runner.ts`             | 本机任务（inbound），内存记录在前，持久 store 回填历史                               |
| `node.events.subscribe(listener)` | `node/orca-node.ts` → `node/events.ts` | `task`（每次状态/权限变化）、`members`（名单、state、busy、endpoints、模型目录变化，按签名去重）、`dispatch`（origin 侧派发落库）；由节点汇总 `tasks.events` / `mesh.events` / `delegation.events` |
| `node.blobs.fetch(node, blobId)`  | `mesh/blob-fetcher.ts`       | 取任一成员发布的文件（自己的读盘，别人的按拨号顺序拉取），面板经 `/orca-api/blob` 下载产物 |
| `node.workspace`                  | `node/orca-node.ts`          | workgroup 根、`notes/`、`state/` 路径                                                |

`new PodAdmin(lifecycle, tracker, broker, catalog)` 组合出面板 API（`catalog` 给出宿主模型目录的 reasoning effort 列表，宿主没有 `llm` 时为空）：`self()`、`members()`（不含 offline）、`recent(limit)`（本机任务与派发到 peer 的任务合并）、`approvals()`（broker 与 tracker 里挂着的权限请求）、`task(peer, id)`、`approve/deny/cancel`、`workspace()`（路径 + notes 文件名）、`blob(node, blobId)`、`config()`（去敏视图，**永不返回密码**，只给 `password_set`）、`state()`（面板一次轮询要渲染的全部）、`saveConfig(patch)`、`connect(peer)`、`disconnect()`、`reset()`。面板靠轮询 `/orca-api/state`，没有变化推送入口。审批只有一个 `ApprovalBroker`（`plugin/broker.ts`）：tracker 把看到的权限请求 park 进去，UI 三个落点读它、答复它，答复直接调 `node.delegation.approveTask/denyTask`（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

**UI 改配置与连接 peer**（`plugin/lifecycle.ts` 的 `PodLifecycle`，存放见 `plugin/stores.ts`，运行期 peer 见 `plugin/peers-file.ts`）：

- **三处各管一样**：设置就是插件配置，面板经 `ctx.configEditor.edit` 写回本 profile 的条目（文件 0600），由 Loader 用新配置重启插件；密码是 DSH 凭据（`ctx.credentials`，引用名见 [§7.1](07-security.md#71-workgroup-与密码)）；运行期 `connect` 记住的 peer 是 `<data_root>/peers.json` 里的状态（`RememberedPeers`）。设置与密码经 `PodStores` 接口访问（`HostPodStores` / `MemoryPodStores`；宿主会在写配置后自行重启插件的，`restartsOnWrite` 为 true，否则由 `PodLifecycle` 自己 `adopt`），测试与无宿主运行用内存实现。没有任何“覆盖层”文件。
- **启动门禁**：`workgroup_id` 为空，或凭据库里取不到密码时，节点保持空闲（不启动、不监听、不报错），首屏是向导；向导填好后 `saveConfig` → `reconfigure` 才启动。换 `workgroup_id` 时省略密码会把当前密码写到新 workgroup 的引用名下；显式传空串被拒绝。
- `reconfigure`：只取面板可改的字段（`null` 表示删除该键、回到默认），先用合并结果整体复验；有新密码先写凭据库（插件重启后要能读到），再写插件配置。配置有变化时由宿主重启插件；只改了密码时就地重启节点。写配置不进生命周期的串行队列：宿主重启插件时要等这条队列排空，放进去会互相等待。节点身份（`identity.json`）不变。
- `connect(peer)`：地址先归一化（裸 host/IP 补 `http://` 与默认端口 `11811`；`host:port`；完整 URL；裸 IPv6 加方括号；拒绝带路径/查询串），立即 `join` 一次，成功才记进 `peers.json`（不改配置、不重启）；失败只回错误、不落盘。`orca_pod` 工具的 `connect` 方法走同一条路径。启动时 join 插件配置里的 `peers` 与 `peers.json` 的并集。
- `disconnect()`：`OrcaNode.leave()` 通知已知 peer，清空 `peers.json`；插件配置里写了 `peers` 时一并删掉。`reset()`：删除 `config.json`、`identity.json`、`peers.json`，从凭据库删掉该 workgroup 的密码（同一 DSH home 下同一 workgroup 的其他 profile 也会失去它），并从插件配置删掉 `workgroup_id`，节点回到首启向导（不动 `state/`、blob、工作区）。
- 设置视图的“高级设置”：任务超时、审批等待超时、结果简报上限、工作区配额、公网/回环候选端点、本机权限上限、默认 reasoning effort、执行器。

#### 9.2.1 同源桥（`plugin/web.ts`）

第三方 bundle 不能 import Host 包，所以面板不声明 RPC，而是在已经运行的 DSH web 服务上注册一条同源前缀路由：

| 路由                                    | 方法       | 内容                                                                                                                  |
| --------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `/orca-api/state`                       | GET        | 一次轮询拿全量：`self`、`config`、`members`、`mesh`、`approvals`、`approval_count`、`recent`（最近 5 条）、`workspace` |
| `/orca-api/task?peer=&task=`            | GET        | 单任务详情（任务视图、origin 标签、派发日志条目、产物及其发布节点）                                                   |
| `/orca-api/tasks?limit=`                | GET        | `{recent}`：全部任务视图（`limit` 默认 500、钳 1–1000）                                                               |
| `/orca-api/blob?node=&blob=`            | GET        | 本节点取来的文件，流式返回；面板用带 `X-Orca-Pod` 头的 `fetch` 读出再交给浏览器保存                                   |
| `/orca-api/config`                      | POST       | `saveConfig`：密码进凭据库、设置写回插件配置，插件随之重启                                                            |
| `/orca-api/connect` / `disconnect` / `reset` | POST  | `{peer}` / `{}` / `{}`                                                                                                |
| `/orca-api/approve` / `deny` / `cancel` | POST       | `{peer, task_id, reason?}`，直接调 `PodAdmin`，不经模型                                                               |

注册走 `ctx.inject(['webServer'], …)`；没有 web 服务的宿主（ACP/CLI）直接跳过，不影响启动。路由闸门依次是：**回环**（`socket.remoteAddress` 是回环且没有 `x-forwarded-for`/`forwarded`/`x-real-ip`，否则 403 `local_only`）；**同源**（CSRF / DNS rebinding：`Host` 只接受 `localhost` 与 DSH `isLoopbackHost` 认定的回环地址（127/8、`::1` 及其映射形式），带 `Origin` 时必须与 `Host` 同源，带 `Sec-Fetch-Site` 时必须 `same-origin`，每个请求必须带 `X-Orca-Pod: 1` 自定义头，否则 403 `cross_origin`）；写请求必须 `Content-Type: application/json`（否则 403 `json_required`）。因此面板不会因为反向代理或多网卡把审批面暴露出去，也不能被别的网页跨站驱动。

#### 9.2.2 客户端 bundle（`client/` → `lib/client.js`）

源码在 `client/`，按职责分模块（`i18n`、`format`、`store`、`constants`、`types`、`primitives`、`approvals`、`tasks`、`members`、`settings`、`panel`，入口 `index.tsx`；样式在 `*.module.css`，`ui.module.css` 是共享样式、其余与模块同名），用 React 18 的 TSX 编写、`strict` 类型检查（`tsc -p client`）。面板读到的数据类型直接从宿主一半导入（`src/plugin/admin.ts`、`src/plugin/panel-api.ts`，仅类型、构建时擦除），路由返回什么与面板画什么不会走样。`npm run build` 用 esbuild（`scripts/build-client.ts`）把它打成 CommonJS，平台模块留作外部依赖，外面套上 `window.__ModuleLoader__.load({id:"orca-pod", factory: require => …})`——与 DSH 自带客户端插件的产物同一形状；工厂的 `require` 只解析壳的平台模块表（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`）。按钮、输入框、标签、状态点、对话框、提示与图标都用 DSH 共享的 `dsh-client-ui-primitives`，外观与 DSH 自带页面一致；这些 primitive 的类型由 devDependency `@deepseek-ai/dsh-client-ui-primitives` 提供（`client/types.ts` 只做类型导入）；`client/css-modules.d.ts` 只声明 `*.module.css`。布局写在 CSS Modules 里，构建时类名按文件加 `orca-pod-<文件>_` 前缀，样式表在模块实例化时以 `<style data-plugin="orca-pod" data-plugin-css="orca-pod/<文件>.module.css">` 注入——与 DSH 自带插件同一约定，壳的模块系统据此认领，停用插件时一并移除。导出 `{inject:["slots","locale"], apply}`；`apply` 注册五个 Slot：

| Slot                      | id                        | 作用                                                                                          |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `settings.section`        | `orca-pod`                | 设置页里的一页面板                                                                            |
| `sidebar.footer.action`   | `orca-pod`                | 侧边栏底部按钮，图标带状态角标：有挂起审批为橙黄（并显示件数）、有在线成员为绿、未连接无角标 |
| `shell.overlay`           | `orca-pod.panel`          | 居中模态浮层，点侧边栏按钮打开，Esc/遮罩/× 关闭                                               |
| `conversation.input.dock` | `orca-pod.approval-dock`  | **当前会话**里的审批聊天卡（按任务的发起会话 id 匹配）：允许/拒绝/在面板中处理                |
| `shell.overlay`           | `orca-pod.approval-popup` | **后台会话**的审批弹窗（不受当前会话过滤）                                                    |

设置页与浮层共用同一份 `Panel`，按状态分三视图：未完成设置时是**首启向导**（workgroup、必填密码、显示名、监听地址、本地节点地址）；之后第一屏是**集群状态**（自身、成员、待审批、最近任务、工作区），右上进入**设置视图**，另有**连接/断开**。浮层用 DSH 的 `Modal`，设置页里则自带标题与吸底的操作栏；状态页依次是身份与连接标签、未加入 mesh 时的连接卡片、四个概览数字（在线节点、待审批、进行中任务、本机）、待审批（有才显示）、最近任务，以及并排的成员与工作区；设置视图按 DSH 设置页的行式布局分组（工作组与身份、网络、可折叠的高级设置、危险操作）。整个客户端**只有一个共享 store 与一个轮询器**：每 2s `fetch('/orca-api/state')`，所有 slot 组件读同一份快照；审批与取消按钮直接 POST；文案跟随 DSH 桌面语言（中/英）；颜色、圆角、描边只用 DSH 的 `--dsw-*` 主题 token；卸载时清理定时器。

清单接线：`package.json` 的 `exports["./client"] = "./lib/client.js"`、`dsh.client = {platform:"web", immediately:true}`、`files` 含 `lib`。`lib/` 是构建产物、不进仓库；`test/client-bundle.test.ts` 构建一次并在假壳里执行，检查工厂只请求平台模块、`apply` 注册了词典与 Slot。

### 9.3 每个模块怎么测

约定：每个模块有自己的夹具测试，进程内测试不依赖网络和真实时钟；`npm run check`（`biome check . && tsc --noEmit && tsc --noEmit -p client && vitest run`）是唯一的验收入口。`test/architecture.test.ts` 守住 §9.1 的依赖方向。

| 模块                              | 夹具                                                              | 断言                                                                                   |
| --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `core/wire/` / `node/settings.ts` | 固定 JSON 样本                                                    | schema 通过/拒绝、错误信息指向具体字段                                                 |
| `core/signing.ts`                 | 冻结的签名样本                                                    | 换密钥/时间/body/查询串/接收方 id 任一字节即变；重启前签发的请求被 `stale_request` 拒绝 |
| `core/` 的类（`EventBus`、`ChangeSignal`、`SerialQueue`、`ModelCatalog`） | 纯对象                                    | 订阅与退订、抛异常的监听器不影响其他、失败不堵后续操作、钉选值胜过宿主上报                  |
| `task/grants.ts` / `task/delegation.ts` | 纯函数 + 多 orca node 真实 HTTP                             | grant 校验/过期/重放/工具不符；执行器会话内 `send` 被拒（D39 单跳）                       |
| `task/` 的存储与派发日志          | 内存与 sqlite 实现                                                 | 实现行为一致；登记过期；关闭重开仍在；`DispatchLog` 只在发送时建条目                       |
| `task/workspace.ts` / `task/quota.ts` | 临时目录                                                      | 路径只命名不创建、目录可重复创建、用量测量（`Workspace.measure`，不阻塞事件循环）、超额拒绝 |
| `api/`                            | 进程内真实 HTTP，真实 `SingleSlotTaskRunner`（需要时 `vi.spyOn`）、注入时钟 | 路由、401/403/429/507、签名与成员闸门                                                  |
| `executor/` 契约与 echo           | echo 脚本样本                                                     | 状态时序、`input-required`、resume                                                     |
| `executor/acp/`                   | 假 ACP server（`test/fixtures/fake-acp.mjs`）                     | 完成文本、cwd、权限挂起→grant→继续、`session/cancel`、session 复用与 resume、崩溃后重建连接 |
| `task/runner.ts`                  | `EchoExecutor` 或自定义 executor + 内存存储                       | 单槽、TTL、取消、重启恢复                                                              |
| `test/support/harness.ts`（测试专用） | 多 orca node mesh + 可注入时钟/传输                            | 成员收敛、故障、任务往返                                                               |
| `cli/install.ts`                  | 临时目录 + 注入 `CommandRunner`                                   | systemd plan 与引号、`dsh --version` 检查、配置只生成一次且 0600、`--dry-run` 不执行   |
| `plugin/`                         | 假 DSH host；真实、未启动的 `PodLifecycle`（需要节点时 `vi.spyOn`） | 工具注册、tracker 投递与退避、broker、面板路由闸门、配置存放（`PodStores`）与生命周期     |

### 9.4 进程内多 orca node

`node/orca-node.ts` 的 `new OrcaNode(config, options)` 构造一个节点：构造器很轻，只读 `identity.json`，不写盘、不联网；`start()` 才创建工作区目录、监听端口、开始心跳。子系统以只读字段公开，调用方直接用它们：`node.mesh`（`join`/`heartbeat`/`joinAll`/`leave`/`digest`）、`node.membership`、`node.profile`（`endpoints`）、`node.client`（`idOf`）、`node.tasks`（`list`/`get`）、`node.delegation`（`sendTask`/`getTask`/`cancelTask`/`approveTask`/`denyTask`，`log.list`/`log.annotate`）、`node.models`（`update`）、`node.events`（`subscribe`）、`node.workspace`（`Workspace` class）、`node.blobs`（`fetch`/`open`）；节点自己只保留 `orcaNodeId`/`config`、`start()`/`stop()`。本节点的成员记录读 `node.profile.record()`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 的 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, approvalTimeoutS, fetch })` 返回 `{ orcaNodes, urls, dataRoot, ownsDataRoot, stop() }`：启动后让每个 orca node join 第一个、用 `mesh.joinAll` 按返回目录补 join，再对 bootstrap 发一轮心跳。它住在 `test/support/harness.ts`（不进 `lib/`、不是包导出），只是对本文件上面那些生产 API 的组装，不复制实现。手工拼节点的测试用 `connectAll` 互相 join（出站调用只到成员，陌生 URL 是 `unknown_peer`）。
- 可注入时钟（`new OrcaNode(config, { clock })`）、可注入 transport（`new OrcaNode(config, { fetch })`，模拟丢包、延迟、单向阻断）、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给，不按绝对毫秒。
- 跨进程：`npm run harness`（先 `npm run build`，再由 `scripts/harness_run.ts` 起两个真实 `orca-node serve` 子进程，跑的是 `lib/cli/main.js`；第二个用 `serve --peer <url1>` 在启动时 join），用 CLI 观察 members 收敛、派一个 Echo 任务并等到终态，最后清理临时数据根；退出码即结果。
- `waitFor(probe, done, { timeoutMs, intervalMs, label })` 与 `createMesh` 同在 `test/support/harness.ts`，进程内与真实进程 smoke 共用；场景用 vitest 的普通 async 函数写，不引入第二套场景描述语言。

```ts
const mesh = await createMesh({ orcaNodes: 3, password: "test" });
const [origin] = mesh.orcaNodes;
const task = await origin.delegation.sendTask(mesh.urls[1], {
  message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
  metadata: { echo: { final: { state: "completed", text: "hi" } } },
});
// 轮询 delegation.getTask 直到终态；真实断言见 test/a2a.test.ts
```

### 9.5 组合入口：库根在 `node/orca-node.ts`，安装根是整个包

“组合根”有两层，别混：

| 层     | 文件                                          | 谁调用它                           | 职责                                                                                                  |
| ------ | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 库根   | `src/node/orca-node.ts` → `new OrcaNode(config, options)` | harness、plugin、`orca-node serve` | 装配一个 orca node：存储 → 模型目录 → 成员表 → 自述 → 出站客户端 → 执行器 → 任务运行器 → workgroup → 心跳 → delegation → gateway，再注册事件订阅。不读 argv、不读 DSH |
| 安装根 | 仓库根目录本身（bundle 名 `orca-pod`）        | DSH 的 Loader                      | `apply(ctx, config)` 里创建 orca node、注册工具/面板路由，cleanup 里 `stop()`                         |

DSH 加载一个 bundle 靠包清单里的 `dsh.bundle.patch` 行，不是 `main`：

```text
package.json       "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }, "./client": "./lib/client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg", … }
                   "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true } }
cordis.patch.yml   - insert: { id: orca-pod, name: 'orca-pod', config: { port: 11811, peers: [] } }
src/index.ts       export { Config, apply, inject } from './plugin/bundle.ts' + 库导出（`OrcaNode` 等）；构建产物是 lib/index.js + .d.ts
src/plugin/        bundle / lifecycle / peers-file / stores / catalog / services / broker / tracker / tools / admin / web / panel-api / skill / config
```

`src/plugin/` 各文件：`bundle.ts` 是 `apply` 与导出（`apply` 只有一句 `new PodPlugin(ctx, config)`，`PodPlugin` 创建下面这些对象并挂到宿主上）；`lifecycle.ts` 的 `PodLifecycle` 管 orca node 的启停与面板改配置（`start()`/`stop()`、`reconfigure`/`addPeer`/`disconnect`/`reset`/`adopt`，状态只经只读 getter 读：`node`、`url`、`port`、`startedAt`、`error`、`config`、`configured`、`ready`，所有重启与状态写入过一条 `SerialQueue`）；`peers-file.ts` 是运行期记住的 peer（`RememberedPeers`、`peers.json`）；`stores.ts` 是设置与密码的存放（`PodStores` 接口及其宿主与内存实现）；`catalog.ts` 的 `ModelCatalogFeed` 从 Host 采集模型目录并公布到运行中的节点；`broker.ts` 是审批注册表（`ApprovalBroker`）；`tracker.ts` 是后台跟踪与投递（`Tracker`，内部是 `PollLoop` 与 `NoticeDelivery`）；`tools.ts` 是唯一的 `orca_pod` 工具（`PodTool`）；`services.ts` 跟踪宿主可选服务（`OptionalService`，构造时 `ctx.inject`，这是 Cordis 的惯用法，也是构造器唯一碰外部的地方）；`admin.ts` / `web.ts` 是面板数据面（`PodAdmin`）与同源路由（`PodApi`），`panel-api.ts` 是路由的请求体 schema 与响应类型（客户端只做类型导入）；`skill.ts` 把随包的 skill bundle 解析成 `ctx.skills.register` 的注册对象；`config.ts` 是 Standard Schema 外壳（校验就是 `node/settings.ts` 的解析器）。

宿主类型全部来自真实包，没有任何本地镜像：`Context` 及 `ctx.tools`/`credentials`/`configEditor`/`webServer`/`agents`/`skills`/`settings`/`llm`/`agentDefaultModel`/`sandboxPolicy` 的增补由 `@deepseek-ai/cordis` 与各 `@deepseek-ai/dsh-*` 服务包自己声明，`import type` 它们即进入类型图；`ctx.settings`、`ctx.configEditor` 这类本插件自己 inject 的服务，在调用点补一行 `import type {} from "<服务包>"` 即可。依赖按 `package.json` 分两类（D40）：`dependencies` 里有 11 个 `@deepseek-ai/dsh-*` 基建包（`agent`、`atomic-write`、`brand`、`credentials`、`error`、`home-paths`、`llm`、`sandbox-policy`、`timeout`、`tools`、`util-values`，版本 `^0.2.2-rc.3`）与 `cross-spawn`（其余运行时依赖见 §9.7）——错误基类 `HarnessError`、工具 schema DSL、原子写、`deadline`/`timeoutOf`、凭据引用、模型与 sandbox 枚举、品牌类型等被值导入（`dsh-agent` 只做类型导入），所以 `lib/` 产物会真实 `import` 它们；其余宿主包（`cordis`、`dsh-client-ui-primitives`、`dsh-config-editor`、`dsh-host-webserver`、`dsh-sandbox`、`dsh-settings`、`dsh-skill`、`dsh-agent-default-model` 等）仍是 devDependency，只做类型导入。客户端 bundle 对 `dsh-client-ui-primitives` 的 `require` 是宿主平台模块，由壳提供。

`apply` 只做几件事，其余都在 `PodPlugin` 的构造器里创建，共享对象由创建者往下传：

```ts
export function apply(ctx, config) {
  new PodPlugin(ctx, config);
}

class PodPlugin {
  constructor(ctx, config) {
    // 数据目录在入口一次解析：data_root > ORCA_POD_HOME > DSH_PROFILE_DIR / loader baseUrl > DSH home；
    // 环境变量从 DSH 的启动环境快照读（launchEnvironmentOf，含 .env 层），DSH home 取宿主解析的 ctx.dshHomePath()
    const logger = ctx.logger("orca-pod");
    const feed = new ModelCatalogFeed(ctx, logger); // 模型目录：每次节点启动、首次 join 之前公布
    const lifecycle = new PodLifecycle(config, logger, new HostPodStores(ctx), feed, defaultRoot);
    lifecycle.start(); // 非阻塞启动
    feed.watch(lifecycle); // llm 与 agentDefaultModel 各自一道 ctx.inject 围栏：只提供其一也能公布目录
    const broker = new ApprovalBroker(lifecycle);
    const tracker = new Tracker(lifecycle, broker, logger);
    // agents 服务出现：按派发日志恢复宿主里已有会话的追踪（tracker.restore；已在追踪、本进程已放弃的任务都跳过）
    // agent/created：agent.ctx.effect 挂 tracker.forget(agent.id)；只恢复该会话自己的派发
    // 用户发新消息（agent/inbox/claimed, source.kind === "user"）→ tracker.resetWakes(agent.id)
    ctx.effect(() => () => this.dispose(), "orca-pod.orca-node"); // broker.clear()、tracker.stop()、lifecycle.stop()
    // 工具在 workgroup 配置完成前不出现（{ when }）；exec.signal 透传到出站请求
    const sandbox = new OptionalService(ctx, "sandboxPolicy", "orca-pod.sandbox-policy");
    ctx.tools.register(new PodTool(lifecycle, tracker, sandbox).definition(), { when: () => lifecycle.configured });
    new PodApi(new PodAdmin(lifecycle, tracker, broker, feed)).register(ctx); // 内部 inject(["webServer"])
    // 可选服务一律用 ctx.inject 声明，每个服务单独一道围栏；注册挂在回调拿到的子作用域上，
    // 服务被替换时随子作用域一起撤销，不会叠加
    if (config.skill_injection) ctx.inject(["skills"], (scope) => scope.effect(() => scope.skills.register(skillRegistration())));
    ctx.inject(["settings"], (scope) => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)));
  }
}
```

约束：

- `apply` 必须快速返回：`start()` 异步，端口占用等问题写日志与状态页，不能让 DSH 启动卡在网络监听上；工具在调用时才 `await lifecycle.ready`。
- 进程内嵌、不开子进程（ACP 子进程由执行器管）；DSH 退出 → cleanup → listener 关闭、ACP 子进程退出。
- 唯一的工具 `orca_pod`（`method` 分派 `send`/`status`/`cancel`/`members`/`connect`，没有 approve）；工具注册用 `inject: ['tools']`。
- 硬依赖 `inject: ['tools', 'credentials', 'configEditor']`（都在 DSH base 组合里）：密码只在凭据库，插件配置拒绝明文 `workgroup_password`（[§7.1](07-security.md#71-workgroup-与密码)）。

CLI 入口：包内 bin `orca-node`（`src/cli/main.ts`，每个子命令一个文件）有 `serve` 与客户端子命令 `send`/`status`/`wait`/`publish`/`fetch`/`log`/`members`——`serve` 加载配置 → `new OrcaNode(config, …)` → `start()`（`--peer` 启动即 join，`--bind`/`--port` 一次性覆盖）；客户端子命令读同一份 `config.json`（`--config` 或 `--data-root`），用本 orca node 身份签 `Pod` 头，经 `mesh/peer-client.ts` 的 `HttpPeerClient`（与 `task/delegation.ts` 的 `rpc()`）打本机或成员的 `/a2a`；`--text -` 从 stdin 读任务文本，`--json` 输出结构化结果，`wait` 的退出码 0/1/2/3 分别表示终态成功/失败/仍在跑/需权限；环境里有 `ORCA_POD_IN_TASK=1`（执行器会话）时 `send` 拒绝（[§7.9](07-security.md#79-权限跟随发起-orca-node)）。`orca-pod install` 见 §9.6。`scripts/cross.ts` 提供 serve/join/task 跨进程、跨机联调命令，复用同一个 `OrcaNode`，不依赖 DSH。个人开发环境专用的快速脚本放在仓库根的 `tmp/`（不进版本库）。

一句话：**装进 DSH desktop 的东西 = `orca-pod` 这一个包；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是构造 `PodPlugin`（它创建 `PodLifecycle`，后者再按配置构造 `OrcaNode`）。**

### 9.6 工程约定

- TypeScript、ESM、Node ≥ 24（用内置 `node:sqlite`；发布的是 `tsc -p tsconfig.build.json` 编译出的 `lib/`，相对 import 由 `rewriteRelativeImportExtensions` 改写；`npm run build` 先清空 `lib/`，搬过的文件不会留下旧产物）；npm（单包，`npm install` 在仓库根目录一次装齐）；vitest；biome（lint + format，`biome.json` 在根目录）；`tsc --noEmit`。
- **`src/` 不再由裸 `node` 直接运行**：服务用 class 并用构造器参数属性，Node 的类型剥离不认这种写法（`erasableSyntaxOnly` 因此关闭，Node 26 也已移除 `--experimental-transform-types`）。开发时用 vitest（测试）或 `node --import tsx`（`scripts/cross.ts`、`scripts/harness_run.ts`）；`test/cli.test.ts` 也用 `--import tsx` 起 CLI；`npm run harness` 先 build，再让被 spawn 的 CLI 跑 `lib/cli/main.js`（ACP 会话里的 agent 用裸 `node "$ORCA_POD_CLI"` 调它，tsx 的 loader 传不到那一层）。`enum` 与 `namespace` 仍然不用（Biome `noEnum` / `noNamespace`），`scripts/**` 仍只写可擦除语法（`noParameterProperties`）。
- **发布形态是编译产物，不是 `.ts`**：`main`/`exports`/`types`/`bin` 都指向 `lib/`，`files` 不含 `src/`，`prepare` 即 `npm run build`。DSH 的插件加载器用原生 `import()` 加载入口，没有转译钩子，发行版（Electron 内置 Node 24）里也没有任何 TS 转译器，所以不需要也不能依赖 tsx。Node 的类型剥离对 `node_modules` 下的文件直接报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，tarball 安装的包里放 `.ts` 必然加载失败。`dsh plugin add <本地路径>` 装的是 `link:`，链接前必须先 `npm run build`，加载的是 `lib/`。加载器会把说明符里的 `.ts` 改写成 `.js`，那只是对源码风格写法的兼容，不是编译。客户端 bundle（`dsh.client`、`platform: web`）另由 esbuild 产出，与此无关但同样必需。
- **验收入口：`npm run check`** = `biome check . && tsc --noEmit && tsc --noEmit -p client && vitest run`。另有 `npm run format`、`npm run typecheck`、`npm test`、`npm run harness`。
- 服务用 class，不做依赖注入（D41）：没有容器（awilix、inversify 等）、没有 `XDeps` 依赖类型、没有专为解耦设的端口接口和 Provider。协作者用构造器参数属性（`private readonly x: X`），参数写具体的 class；私有协作者由拥有者自己 `new`，共享对象由创建者传入；子系统对外的通知用自己持有的 `readonly events`，不往构造器里塞回调。构造器不写盘、不联网、不启计时器（读 `identity.json` 这类同步只读除外；SQLite 存储与 `OptionalService` 是两个例外：前者就是它的连接，后者的构造就是向 Cordis 订阅），创建目录、监听端口、首次测量放到 `start()`。私有成员用 TS 的 `private`，不用 `#`。不传未绑定的方法（`foo(obj.method)` 会丢 `this`），要么传对象本身，要么写箭头函数。无状态的纯计算（签名验签、schema 解析、地址筛查、任务书拼装）、线上形状与 DTO、一次性过程（CLI 子命令的 `run()`）保持函数或纯数据。
- 模块级函数的去留（D42）：参数里带着某个 class 的状态或协作者的函数，就是那个 class 的方法；只在一个 class 里用的函数是它的 `private` 方法，不读 `this` 的写成 `private static`；只有被多个模块用的无状态纯计算、导出后有独立单元测试的纯契约、CLI 子命令的一次性过程才保持为函数。只为测试存在的公开面（公开方法与字段、选项字段、`Pick` / 结构参数类型、依赖袋）不留，测试经真实入口走；一个默认值、一个检查、一个派生值只在拥有者那里算一次；不用 `ReturnType` 给已有类型换写法。可调参数和协议常量留在模块顶层，不改 `static readonly`，不允许模块级可变状态。
- 存储：task store 用 `node:sqlite`（`<data_root>/tasks.db`，WAL，单进程写；不引 ORM）；成员表是内存；文件只登记映射、不复制字节；工作区路径、目录创建与用量测量在 `task/workspace.ts`（`new Workspace(dataRoot, workgroupId)` 只命名，`ensure()` 在 `start()` 创建）。内存实现只给单测与 harness 用（[§5.5](05-tasks.md#55-任务存储)）。
- 本地联调命令：

  ```bash
  npm run check
  node --import tsx scripts/cross.ts serve --workgroup orca-dev --password change-me
  node --import tsx scripts/cross.ts join --peer http://127.0.0.1:11811 --workgroup orca-dev --password change-me
  node --import tsx scripts/cross.ts task --config <config.json> --peer http://127.0.0.1:11811 --text hello
  ```

  `task` 支持 `--echo '<json>'` 传入自定义 Echo 脚本；`--auto-resume` 是布尔开关，`input-required` 后自动补发恢复消息。跨机时把可达地址写进 config 的 `endpoints`（有序列表，可再加公网 URL）；`serve` 不会覆盖显式配置。

- `orca-pod install`：检查 `dsh --version`，生成 `<data_root>/config.json`（0600、`executor: "acp"`），写 systemd unit 并 `daemon-reload` + `enable --now`；unit 常驻 `orca-node serve`。裸 `install` 或只带 `--dry-run` 是交互式向导（workgroup id、密码隐藏输入、监听地址、端口）；**带任何其他参数即进入参数分支、完全不提问**（缺 workgroup/密码直接报错退出，适合 agent 通过 SSH 调用；密码用 `-p`/`--password`，程序不读 stdin）。`--peer`/`--endpoint`/`--env-file`/`--env` 可重复，`--system` 装系统级、默认用户级，`--skip-dsh-check` 跳过检查，`--force` 重写，`--no-start` 只写不启动。命令不提供 web 模式——要面板的用户自己装 dsh 再从 Web UI 装插件。

### 9.7 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、CLI、原子写这类“基础功能”直接用成熟包或 Node 内置；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、grant、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 依赖                                  | 类别 | 理由                                                                                                |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `fastify`                             | 运行时 | 路由、body 解析与限额、错误处理；不手写 http server                                                   |
| `ulid`                                | 运行时 | 任务 id（`task/wire.ts` 的 `newTaskId`）：规范实现、零依赖，随机部分取自 `crypto.getRandomValues`                 |
| `@agentclientprotocol/sdk`            | 运行时 | ACP v1 客户端：`executor/acp/connection.ts` 不再手写 JSON-RPC；类型化的请求、响应与处理器（`McpServer` 等形状由它约束）。子进程的派生与生命周期仍归本项目 |
| `zod`                                 | 运行时 | 唯一的 schema 写法：协议线上形状、网关输入、设置字段表都用它声明，类型由 `z.infer` 推导，规范化（endpoints、peer 地址）写成 `.transform`。不可信输入经 `core/schema.ts` 的 `parseSchema`：`z.object` 丢弃未描述的键并返回新值，报第一处问题及其路径；只看外形的地方（A2A 的 message、metadata）用 `z.looseObject` 保留其余字段。`@agentclientprotocol/sdk` 也依赖它（必需 peer），所以它本来就在运行期里。不调用 `z.config()`：全局配置会波及 SDK |
| `@deepseek-ai/dsh-*`（`agent` / `atomic-write` / `brand` / `credentials` / `error` / `home-paths` / `llm` / `sandbox-policy` / `timeout` / `tools` / `util-values`） | 运行时 | 与宿主同一套基建（D40）：错误基类 `HarnessError`、工具 schema DSL、原子写、`deadline`/`timeoutOf`、凭据引用、模型与 sandbox 枚举、品牌类型；这些不再自写，随包发布 |
| `cross-spawn` | 运行时 | ACP 子进程的跨平台派生：Windows `.cmd` shim 解析与命令行引号（`executor/acp/connection.ts`）；杀进程树同在该文件（`AcpConnection` 的私有方法） |
| `typescript`                          | 开发 | 类型检查（`tsc --noEmit`）与构建（`tsc -p tsconfig.build.json` → `lib/`）                           |
| `esbuild`                             | 开发 | 把 `client/` 的 TSX 打成 `lib/client.js`（`scripts/build-client.ts`）                               |
| `@types/react`                        | 开发 | 客户端 TSX 的类型；React 运行时由 DSH 壳提供，不随包发布                                           |
| `vitest`                              | 开发 | 测试                                                                                                |
| `@types/node`                         | 开发 | Node 类型                                                                                           |
| `@biomejs/biome`                      | 开发 | lint + format，一个工具                                                                             |

其余能力大多用 Node 内置：`node:crypto`（Ed25519、scrypt、HMAC）、`node:sqlite`、全局 `fetch`、`node:util` 的 `parseArgs`、`node:fs`、`node:stream`；跨平台基础件（错误基类、原子写、deadline、工具 schema、模型与 sandbox 枚举）用上面的 DSH 基建包，不再自写。不引 pino、commander、ORM、DI 容器、消息队列，也不再引第二个校验库：集群只有十台机器，这些是负资产；也没有比 `node:crypto` 里几十行更合适的认证/签名框架。

---
