# 09 实现

> 本章给出模块划分、DSH 组合入口、面板、测试夹具与工程约定。

## 9. 实现

### 9.1 单包内的模块划分

整个项目**就是一个 npm 包**（仓库根目录）。DSH 插件规范就是一个 npm 包（`package.json` + `dsh.bundle.patch`），拆成多个私有包会让安装物不自包含：内部依赖在仓库外解析不到。因此用目录和 import 纪律维持模块边界，不再用包边界。

```text
orca-pod/
  package.json        运行时依赖见 §9.7；dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    DSH 行：id orca-pod、name 'orca-pod'
  biome.json          lint + format（一个工具）
  rolldown.config.ts  客户端 bundle（src/client → lib/client.js）
  src/                见下表
  scripts/            cross.ts、harness_run.ts（进程内两个节点走真实回环网络）、e2e-acp.ts
  skills/orca-node/   标准 skill bundle（SKILL.md + references/add-machine.md）
  test/               vitest，按模块一份 *.test.ts；test/fixtures/fake-acp.mjs 是假 ACP server
```

`src/` 里 host 按功能分成 7 个目录（D41、D44），另有 `client/` 是浏览器端面板（§9.2.2，构建到 `lib/client.js`，不由 tsc 输出）；目录内没有聚合导出文件（不设 `index.ts`）：谁用到什么，就直接 import 定义它的文件，所以目录内部移动代码时，调用方跟着改。

| 上下文        | 文件                                                                                                     | 职责                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `core/`       | `errors` / `schema` / `events` / `constants` / `ids` / `net` / `identity` / `signing` / `sqlite` / `stream` / `blobs` | 公共底座，只放两个以上上下文都用、又没有更低归属的东西（D52）：`PodError` 与错误码 → HTTP 状态表（唯一一张）；`isRecord` 与 `parseOrThrow`（不可信输入的唯一入口）；进程内通知 `ChangeSignal` 与 `NodeLogger`；默认端口（`DEFAULT_PORT`）；orca node id 与 workgroup id；peer 地址归一化；Ed25519 签名与验签；请求签名（`buildAuthHeader`、`parseAuthHeader`、`signatureInput`、`hmacOf`）与答复签名；`SqliteDb`；有上限的流读取；发布文件（名字 `<orca_node_id>/<sha256>`、`FileBlobRegistry`）；错误码与消息文本 |
| `mesh/`       | `mesh` / `orca-node` / `context` / `peer-client` / `screening` / `timings` / `wire` | 组网（D44）：节点表 `Mesh`（`Map<节点 id, OrcaNode>`，**本机自己也在表里**；目录与摘要、墓碑、合并他人目录、`probe` / `seed` / `greeted`、心跳循环）；表里的一行 `OrcaNode`（自述、状态机证据、候选/显式来源、可拨地址与上次收到消息的时间，以及 `hello` / `sendTask` / `getTask` / `cancelTask` / `approve` / `deny` / `fetchBlob` / `publish`）；一个 orca 实例里所有节点共用的 `MeshContext`；出站客户端 `HttpPeerClient`（只负责签名、截止时间、读取上限、验答复签名，不知道有哪些节点）；`EndpointScreen`（候选与自报端点的筛查结论缓存）与纯策略 `screenEndpoint`；时序常量与时钟 `timings`；节点表的线上形状 `wire`（节点记录 `PeerView` / `SelfRecord` 与摘要、`hello` 的请求与应答、成员列表） |
| `executor/`   | `executor` / `model` / `model-catalog` / `permission` / `acp/`                                                       | 执行器契约（含权限请求里的 `RequestedAccess`）；模型路由的线上形状 `model` 与本机的模型目录 `ModelCatalog`；权限模式 `permission`；ACP（`connection` 按 sessionId 路由，并负责子进程的派生与杀进程树、`session` 一个 ACP 会话（`AcpSession`，选模型 / 发 prompt / 挂接路由）与绑定、`sessions.json` 的会话缓存（`AcpExecutor` 自己持有）、`permissions` 自动应答、`executor`（`AcpExecutor`、它的配置 `AcpExecutorConfig` 与一次运行 `AcpRun`）） |
| `task/`       | `wire` / `runner` / `record` / `quota` / `workspace` / `prompt` / `dispatch-log` / `json-table` | 本机执行：任务线上形状（任务视图与元数据、A2A 方法参数与 JSON-RPC 外壳、派发日志条目、权限请求与恢复消息的批准/拒绝、忙碌状态 `BusyState`）；单槽运行器（含恢复消息的校验）与每个任务一个的 `TaskRecord`；工作区与配额；任务书；派发日志。任务表归 runner、派发表归派发日志，各自直接用 `JsonTable`（`json-table`），没有单独的存储层。派发是“对一个节点做的事”，所以在 `mesh/`，不在这里 |
| `api/`        | `gateway` / `access` / `cluster-routes` / `a2a-routes` / `blob-routes` / `input`         | 入站 HTTP：`Gateway`（装配、body 解析、`listen` 与 `close`、唯一的错误出口）、`AccessPolicy`（`access` 声明与唯一的 preValidation 钩子）、`ClusterRoutes`、`A2aRoutes`、`BlobRoutes`、`parseInput` |
| `node/`       | `orca` / `settings`                                                                                      | **组合根**：一个进程里的这一个 orca 实例 `Orca`，只装配，子系统以只读字段公开（`mesh`、`tasks`、`dispatches`、`models`、`workspace`）；**唯一的设置 schema 与解析器**；`Orca` 直接拿解析后的 `Settings`，节点 id 取自身份，`data_root` 单独传入 |
| `plugin/`     | 见 §9.5                                                                                                  | DSH bundle                                                                                   |
| `client/`     | 见 §9.2.2                                                                                                | 浏览器端面板（TSX + CSS Modules，提示音 `sounds/*.mp3` 构建时内联）                          |

模块依赖单向向下，由 `test/architecture.test.ts` 固化（解析 `src/` 的 import）：

```text
core ← executor ← task ← mesh ← api ← node ← plugin
core ← client
```

- 运行期 import 图无环，**仅类型的 import 也不许成环**（目录内的两个文件互相 `import type` 也算）；
- 运行期 import 只允许指向严格更低的一层；mesh 在 task 之上（D44）：派发任务是对一个节点做的事；
- `client/` 在最上面：谁都不 import 它；它运行期只 import `core/`（打进浏览器 bundle），线上形状（`plugin/panel-api`、`mesh/wire`、`task/wire` 等）只用 `import type`，构建时擦除；
- SQLite 存储（`SqliteDb`、`DispatchLog`、`FileBlobRegistry`）只在装配点（`node/`、`plugin/`）构造，业务层通过构造参数拿到具体对象，不另设存储接口。

没有依赖注入：没有容器、没有 `XDeps` 类型、没有专为解耦设的端口接口。私有协作者由拥有者自己 `new`（`Mesh` 创建本机这一行 `OrcaNode`，`SingleSlotTaskRunner` 创建 `WorkspaceQuota` 与任务表 `JsonTable`，`Gateway` 创建 `NonceCache`、`AccessPolicy` 与三个路由对象……），共享对象由创建者传入（`Orca` 把同一个 `MeshContext` 交给表里的每个 `OrcaNode`；一个资源一份、按 orca 实例划作用域，**不用模块级全局变量**，D44），子系统之间的通知用各自持有的 `changes`（`ChangeSignal`，只说“变了，再读一次”），由订阅方决定怎么响应。接口只在存在多个实现时才写（现在只有 `LocalExecutor`）。`node/orca.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。没有聚合导出，引入一个文件只会加载它自己依赖的部分（例如 `node/settings.ts` 只用 `core/net.ts`，不会连带加载 gateway）。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、错误处理都用它现成的，不手写 http server。路由不向 Fastify 注册 schema：处理器先用 `api/input.ts` 的 `parseInput` 按 zod schema 解析自己的输入（失败即 `400 bad_request`，信息带出错路径，如 `body.models.0.provider`），解析结果才是处理器用的值。**每条路由必须声明 `config.access`**（`public|hello|member|local`），缺了启动即失败；验签与授权只在一个钩子里做；错误只从一个错误处理器出去。

### 9.2 面板

面板需要的每个数字都从 Host 侧同步取到，而不是先让模型调一次工具再转述。`Orca` 把子系统作为只读字段公开，面板读的几个入口都在它们上面，插件再把它们打包成 `PanelModel`：

| 入口                                                    | 位置                         | 内容                                                                                 |
| ------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `orca.tasks.list(limit?)`                               | `task/runner.ts`             | 本机任务（inbound），内存记录在前，持久 store 回填历史                               |
| `orca.dispatches.list()`                                | `task/dispatch-log.ts`       | 本机派发出去的任务（origin 侧），最近任务与任务详情读它                              |
| `orca.workspace`                                        | `node/orca.ts`               | workgroup 根与 `state/` 路径                                                         |

`new PanelModel(pod, tracker, catalog)` 组合出面板 API（`catalog` 给出宿主模型目录的 reasoning effort 列表，宿主没有 `llm` 时为空；响应形状全在 `plugin/panel-api.ts`）：`state()`（面板一次轮询要渲染的全部：本机记录、可达成员（不含 offline）、最近任务、待审批（只读 tracker：待审批只有这一个登记处，答复后卡片立即消失）、工作区路径 `workspace_root`、配置）、`recent(limit)`（本机任务与派发到 peer 的任务合并）、`task(peer, id)`、`config()`（去敏视图，**永不返回密码**，也没有“有没有设密码”的标志）。动作不经 `PanelModel`：`PanelRoutes` 直接调 `Pod`（`reconfigure`、`addPeer`、`reset`、经 `pod.orca()` 取消任务）和 `Tracker`（`approve`、`deny`），答复都是 `{}`，面板靠下一次轮询 `/orca-api/state` 拿新状态，没有变化推送入口。面板读取当前运行只有两种方式：展示（`state`、`recent`）读 `pod.run`，没有节点就是空；动作（`task`、取消、批准与拒绝）先 `await pod.orca()`，所以保存设置后立即点“取消任务”会等重启结束，而不是报“没在运行”。审批只在 `Tracker`（`plugin/tracker.ts`）一处：它在轮询中看到的权限请求留在自己手里，UI 三个落点读它、答复它，答复直接调目标节点的 `OrcaNode.approve/deny`（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

**UI 改配置与连接 peer**（`plugin/pod.ts` 的 `Pod`，存放见 `plugin/stores.ts`）：

- **一台机器一个节点，所有 profile 共用**（D44）：`data_root` 固定为 `$DSH_HOME/orca-pod`，身份、密码、设置、任务库、工作区整台机器只有一份；profile 只切换这台机器的能力组合。四样东西各有一处：**设置**是 `<data_root>/settings.json`（不含机密、原子写入，面板写它，`Pod` 原地重启；运行期加入的 peer 也写进它的 `peers`，不重启——DSH 的 `configEditor` 只能写当前 profile 的 patch，没法让所有 profile 共用，所以不再经它，这推翻了 D43 K2“设置就是插件配置”）；**密码**是凭据 `ORCA_POD_PASSWORD`；**节点私钥**是凭据记录 `orca-pod/node`（[§7.1](07-security.md#71-workgroup-与密码)）；**数据**是同一目录下的 `tasks.db`、`workgroups/<workgroup_id>/` 与 `blobs/`。插件配置（profile 的 `cordis.patch.yml`）只剩 `skill_injection`，profile 里残留的旧节点字段被忽略。
- **同时只有一个进程跑节点**：两个 DSH 进程同时开着时，后启动的在监听时遇到 `EADDRINUSE`，`Pod` 把它映射成 `failed`，消息是 `an orca node is already running on this machine, in another DSH process (port 11811 is in use)`，它的工具不可用。端口本身就是锁，所以**绑定端口是 `Orca.start()` 的第一步**：绑定成功后才打开 SQLite、恢复任务与派发记录，后启动的进程不会改动正在运行的那个进程的任务。
- **启动门禁**：`workgroup_id` 为空，或凭据库里取不到密码时，节点保持空闲（不启动、不监听、不报错），首屏是向导；向导填好后 `POST /orca-api/config` → `Pod.reconfigure` 才启动。换 `workgroup_id` 时密码保持（它是整台机器的，不是某个 group 的）；没有存过密码时拒绝。
- `reconfigure`：只取面板可改的字段（`null` 表示删除该键、回到默认），先用合并结果整体复验；有新密码先写凭据库，再写设置文件，然后原地重启。设置文件读不出或不是 JSON 时启动失败并点名该文件，**不会**当成空设置覆盖它。
- **外部改了凭据**：订阅 `credentials/reference-updated`（密码）与 `credentials/record-updated`（私钥）；涉及这两个名字且与本次运行所用的值不同时，经 `Pod` 的串行队列重启一次（`Pod.credentialsChanged`）；`Pod` 自己的写入不会引起重启。
- `connect(peer)`：地址先归一化（一律是 `https://`：裸 host/IP 补默认端口 `11811`；`host:port`；`https://` 不带端口时是 443（代理后面的节点）；`http://` 按 `https://` 读，不带端口时补 `11811`；裸 IPv6 加方括号；拒绝带路径/查询串），立即 `mesh.probe`，成功才加进 `settings.json` 的 `peers`（不重启：节点已经连上了）；启动时设置里的 `peers` 作为**种子**交给 `mesh.seed`，没应答的由心跳循环按 `recover_probe` 退避继续重试，直到连上。
- `reset()`：**整台机器的节点回到初始状态，没有分支**：删密码、私钥记录、`settings.json`，回首启向导。
- 设置视图的“高级设置”：任务超时（`task_timeout_s`）、工作区配额（`max_workspace_bytes`，按 GiB 显示）、本机权限上限（`permission_mode`）、默认 reasoning effort（取自宿主默认模型的 efforts）；执行器与审批超时不是设置项。

#### 9.2.1 同源桥（`plugin/panel-routes.ts`）

第三方 bundle 不能 import Host 包，所以面板不声明 RPC，而是在已经运行的 DSH web 服务上注册一条同源前缀路由：

| 路由                                    | 方法       | 内容                                                                                                                  |
| --------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `/orca-api/state`                       | GET        | 一次轮询拿全量：`self`、`config`、`members`（不含 offline，人数就是可达的成员数）、`approvals`、`recent`（最近 5 条）、`workspace_root` |
| `/orca-api/task?peer=&task=`            | GET        | 单任务详情（任务视图、origin 标签、派发日志条目）；`peer` 是节点 id、唯一的显示名或 URL                              |
| `/orca-api/tasks`                       | GET        | `PodTaskRow[]`：全部任务视图（固定 500 条上限，没有 `limit` 参数）                                                    |
| `/orca-api/config`                      | POST       | `Pod.reconfigure`：密码进凭据库、设置写进 `settings.json`，节点原地重启                                                 |
| `/orca-api/connect` / `reset` | POST  | `{peer}` / `{}`                                                                                                |
| `/orca-api/approve` / `deny` / `cancel` | POST       | `{peer, task_id}`（`deny` 另带 `reason?`）：批准/拒绝经 `Tracker`，取消经 `Pod`，都不经模型                              |

注册走 `ctx.inject(['webServer', 'connection'], …)`；没有 web 服务的宿主（ACP）直接跳过，不影响启动。路由闸门依次是：**DSH 准入**（`connection.admit(request)`，与 DSH 自己的 `/api` 同一套：`Host` 必须是回环、监听地址或 `trustedHosts` 里的主机，带 `Origin` 时必须同一 authority，`Sec-Fetch-Site: cross-site` 拒绝，这几项不过是 403 `forbidden`；之后验签名的浏览器会话 cookie，没有或无效是 401 `unauthorized`）；**owner**（准入得到的 Peer 的 `principal.kind` 必须是 `owner`，否则 403 `forbidden`）；**面板头**（每个请求必须带 `X-Orca-Pod: 1`，否则 403 `cross_origin`：DSH 只拒 `cross-site`，`SameSite=Strict` 的 cookie 在同站请求里照样带上，自定义头让同站的别的源也得先过 CORS 预检，而预检永远不放行）；写请求必须 `Content-Type: application/json`（否则 403 `json_required`）。因此谁能登录 DSH web，谁就能用面板，远程访问与本机一样；没登录的、别的网页都驱动不了它。客户端按 `document.baseURI` 解析 `orca-api/…`（DSH 解析自己 `/api` 的方式），DSH 挂在反向代理的子路径下也能用。

#### 9.2.2 客户端 bundle（`src/client/` → `lib/client.js`）

源码在 `src/client/`，按职责分模块（`i18n`、`format`、`store`、`constants`、`types`、`primitives`、`approvals`、`tasks`、`members`、`settings`、`panel`，入口 `index.tsx`；样式在 `*.module.css`，`ui.module.css` 是共享样式、其余与模块同名），用 React 18 的 TSX 编写、`strict` 类型检查（`tsc -p src/client`）。面板读到的数据类型直接从宿主一半导入（`src/plugin/panel-api.ts`，仅类型、构建时擦除），路由返回什么与面板画什么不会走样。`npm run build` 用 Rolldown（`rolldown.config.ts`，与 DSH 自带插件同一工具链）把它打成 CommonJS，平台模块留作外部依赖，外面套上 `window.__ModuleLoader__.load({id:"orca-pod", factory: require => …})`——与 DSH 自带客户端插件的产物同一形状；工厂的 `require` 只解析壳的平台模块表（`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`）。按钮、输入框、标签、状态点、对话框、提示与图标都用 DSH 共享的 `dsh-client-ui-primitives`，外观与 DSH 自带页面一致；这些 primitive 的类型由 devDependency `@deepseek-ai/dsh-client-ui-primitives` 提供（`src/client/types.ts` 只做类型导入）；`src/client/css-modules.d.ts` 只声明 `*.module.css`。布局写在 CSS Modules 里，由 Lightning CSS 编译（支持 `:global`、`composes`、`@keyframes`），类名按文件加 `orca-pod-<文件>_` 前缀，样式表在模块实例化时以 `<style data-plugin="orca-pod" data-plugin-css="orca-pod/<文件>.module.css">` 注入——与 DSH 自带插件同一约定，壳的模块系统据此认领，停用插件时一并移除。导出 `{inject:["slots","locale"], apply}`；`apply` 注册五个 Slot：

| Slot                      | id                        | 作用                                                                                          |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `settings.section`        | `orca-pod`                | 设置页里的一页面板                                                                            |
| `sidebar.footer.action`   | `orca-pod`                | 侧边栏底部按钮，同时是状态灯：菱形图标 ◈ 有挂起审批为橙黄（宽模式另显示件数）、有在线成员为绿、未连接为灰 |
| `shell.overlay`           | `orca-pod.panel`          | 居中模态浮层，点侧边栏按钮打开，Esc/遮罩/× 关闭                                               |
| `conversation.input.dock` | `orca-pod.approval-dock`  | **当前会话**里的审批聊天卡（按任务的发起会话 id 匹配）：允许/拒绝/在面板中处理                |
| `shell.overlay`           | `orca-pod.approval-popup` | **后台会话**的审批弹窗（不受当前会话过滤）                                                    |

设置页与浮层共用同一份 `Panel`，按状态分三视图：未完成设置时是**首启向导**（workgroup、必填密码、显示名、监听地址、本地节点地址）；之后第一屏是**集群状态**（自身、成员、待审批、最近任务、工作区），右上进入**设置视图**，另有**连接**。浮层用 DSH 的 `Modal`，设置页里则自带标题与吸底的操作栏；状态页依次是身份与连接标签、未加入 mesh 时的连接卡片、四个概览数字（在线节点、待审批、进行中任务、本机）、待审批（有才显示）、最近任务，以及并排的成员与工作区；设置视图按 DSH 设置页的行式布局分组（工作组与身份、网络、可折叠的高级设置、危险操作）。整个客户端**只有一个共享 store 与一个轮询器**：每 2s `fetch('/orca-api/state')`，所有 slot 组件读同一份快照；审批与取消按钮直接 POST；文案跟随 DSH 桌面语言（中/英）；颜色、圆角、描边只用 DSH 的 `--dsw-*` 主题 token；卸载时清理定时器。

清单接线：`package.json` 的 `exports["./client"] = "./lib/client.js"`、`dsh.client = {platform:"web", immediately:true}`、`files` 含 `lib`。`lib/` 是构建产物、不进仓库；`test/client-bundle.test.ts` 构建一次并在假壳里执行，检查工厂只请求平台模块、`apply` 注册了词典与 Slot。

### 9.3 每个模块怎么测

约定：每个模块有自己的夹具测试，进程内测试不依赖网络和真实时钟；`npm run check`（`biome check . && tsc --noEmit && tsc --noEmit -p src/client && vitest run`）是唯一的验收入口。`test/architecture.test.ts` 守住 §9.1 的依赖方向。

| 模块                              | 夹具                                                              | 断言                                                                                   |
| --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 各上下文的 `wire.ts` / `node/settings.ts` | 固定 JSON 样本                                                    | schema 通过/拒绝、错误信息指向具体字段                                                 |
| `core/signing.ts`                 | 冻结的签名样本                                                    | 换密钥/时间/body/查询串/接收方 id/workgroup 任一字节即变；密码不对 `bad_proof`、签名不对 `bad_signature`（两样缺一不可）；重启前签发的请求被 `stale_request` 拒绝；答复签名绑定请求 nonce、status 与 body |
| `core/events.ts` 的 `ChangeSignal`、`plugin/pod.ts` 的 `SerialQueue`、`executor/model-catalog.ts` 的 `ModelCatalog` | 纯对象                                    | 订阅与退订、抛异常的监听器不影响其他、失败不堵后续操作、设置里的 effort 胜过宿主上报                  |
| `task/runner.ts`（恢复）/ `mesh/orca-node.ts` | 多 orca node 真实 HTTP                           | 恢复消息的校验（非 origin、不在等待、槽被占、非批准/拒绝、请求 id 不符，任务不失败）；节点对象的 `sendTask` / `approve` / `deny` / `fetchBlob`；任务会话里的 `orca_pod` 只有 `fetch`/`publish`（D39 单跳） |
| `task/` 的存储与派发日志          | 内存与 sqlite 实现                                                 | 实现行为一致；登记过期；关闭重开仍在；`DispatchLog` 只在发送时建条目                       |
| `task/workspace.ts` / `task/quota.ts` | 临时目录                                                      | 路径只命名不创建、目录可重复创建、用量测量（`Workspace.measure`，不阻塞事件循环）、超额拒绝 |
| `api/`                            | 进程内真实 HTTP，真实 `SingleSlotTaskRunner`（需要时 `vi.spyOn`）、注入时序 | 路由、401/403/429/507、签名与成员闸门                                                  |
| `executor/` 契约与 `ScriptExecutor` | `test/support/script.ts` 的脚本（任务文本里的 `SCRIPT <json>`）    | 状态时序、`input-required`、resume                                                     |
| `executor/acp/`                   | 假 ACP server（`test/fixtures/fake-acp.mjs`）                     | 完成文本、cwd、权限挂起→批准→继续、`session/cancel`、session 复用与 resume、崩溃后重建连接 |
| `task/runner.ts`                  | `ScriptExecutor` 或自定义 executor + 临时目录上的 SQLite         | 单槽、TTL、取消、重启恢复                                                              |
| `mesh/mesh.ts` / `mesh/orca-node.ts` | `test/support/net.ts` 的进程内工作组（真 mesh 加真 gateway，出站经 Fastify `inject`，假计时器推进时间，可断开任意两点）；多 orca node 真实 HTTP | 状态从静默推出、目录只转发亲耳听到的、墓碑；`resolve` 的 id/名字/URL；种子重试；改密码即被拒、答复被改即拒 |
| `test/support/harness.ts`（测试专用） | 多 orca node mesh + 可注入时序/传输                            | 成员收敛、故障、任务往返                                                               |
| `plugin/`                         | 假 DSH host；真实、未启动的 `Pod`（需要节点时 `vi.spyOn` 它的 `status`） | 工具注册、tracker 投递与退避、broker、面板路由闸门、配置存放（`PodStores`）与生命周期     |

### 9.4 进程内多 orca node

`node/orca.ts` 的 `new Orca(settings, identity, key, dataRoot, options?)` 构造一个 orca 实例：身份、workgroup key 与数据根都由调用者给（测试用 `test/support/node.ts` 的 `nodeParts` / `newNode` 造内存身份），构造器很轻，不写盘、不联网；`start()` 才创建工作区目录、监听端口、开始心跳。子系统以只读字段公开，调用方直接用它们：`orca.models`（模型目录）、`orca.mesh`（节点表，本机是 `mesh.self`）、`orca.dispatches`（派发日志）、`orca.tasks`（本机任务）、`orca.workspace`（工作区路径）；`options` 只有 `runtime`、`timings`、`fetch`、`executor`、`logger`，一次运行一个 `Orca`。ACP 子进程固定用 `acp` profile（D60），所以没有 profile 选项。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 的 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, taskTimeoutS, fetch })` 返回 `{ orcaNodes, urls, dataRoot, ownsDataRoot, stop() }`：启动后让每个 orca node join 第一个、用同文件的 `connectAll` 按返回目录补 join，再对 bootstrap 发一轮心跳。它住在 `test/support/harness.ts`（不进 `lib/`、不是包导出），只是对本文件上面那些生产 API 的组装，不复制实现；每个节点都注入 `ScriptExecutor`。手工拼节点的测试用 `connectAll` 互相 join（出站调用只到成员，陌生 URL 是 `unknown_peer`）。
- 可注入时序（`timings`，见 `mesh/timings.ts` 的 `MeshTimings` / `MeshClock`）、可注入 transport（`fetch`，模拟丢包、延迟、单向阻断）、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给，不按绝对毫秒。
- 真实网络冒烟：`npm run harness`（`node --no-warnings --import tsx scripts/harness_run.ts`）在一个进程里起两个 `Orca`，走真实的 loopback 端口与签名 HTTP、`ScriptExecutor`，探测互见、派一个脚本任务、等终态；没有子进程，也不先 build。
- `waitFor(probe, done, { timeoutMs, intervalMs, label })` 与 `createMesh` 同在 `test/support/harness.ts`，进程内与真实进程 smoke 共用；场景用 vitest 的普通 async 函数写，不引入第二套场景描述语言。

```ts
const mesh = await createMesh({ orcaNodes: 3, password: "test" });
const [origin] = mesh.orcaNodes;
// scriptTask 来自 test/support/script.ts：脚本写在任务文本的 `SCRIPT <json>` 行里，节点用 ScriptExecutor（new Orca 的 options.executor）
const task = await origin.mesh.resolve(mesh.urls[1]).sendTask(scriptTask({ final: { state: "completed", text: "hi" } }));
// 轮询 node.getTask 直到终态；真实断言见 test/a2a.test.ts
```

### 9.5 组合入口：库根在 `node/orca.ts`，安装根是整个包

“组合根”有两层，别混：

| 层     | 文件                                          | 谁调用它                           | 职责                                                                                                  |
| ------ | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 库根   | `src/node/orca.ts` → `new Orca(settings, identity, key, dataRoot, options?)` | harness、plugin | 装配一个 orca 实例：存储（一个 data_root 一个 `SqliteDb`，在 `start()` 里绑定端口之后才打开）→ 模型目录 → `MeshContext`（身份、key、出站客户端、派发日志、本机文件、端点筛查、时钟）→ 节点表 `Mesh`（本机一行）→ 任务运行器 → 网关；本机记录的 busy 直接读 `ctx.tasks.busy()` |
| 安装根 | 仓库根目录本身（bundle 名 `orca-pod`）        | DSH 的 Loader                      | `apply(ctx, config)` 里创建 orca node、注册工具/面板路由，cleanup 里 `stop()`                         |

DSH 加载一个 bundle 靠包清单里的 `dsh.bundle.patch` 行，不是 `main`：

```text
package.json       "exports": { ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" }, "./client": "./lib/client.js", "./locale/*.json": "./locale/*.json", "./icon": "./icon.svg", … }
                   "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true } }
cordis.patch.yml   - insert: { id: orca-pod, name: 'orca-pod' }
src/index.ts       export { Config, apply, inject } from './plugin/bundle.ts' + 构建产物是 lib/index.js + .d.ts（只有 DSH 插件这一个入口，没有库导出，也没有 bin）
src/plugin/        bundle / pod / settings-file / stores / catalog / services / tracker / tools / panel / panel-routes / panel-api / skill
```

`src/plugin/` 各文件：`bundle.ts` 是 `apply` 与导出（`apply` 自上而下三段：创建下面这些对象、把它们挂到宿主上、后台启动 pod）；`pod.ts` 的 `Pod` 就是“这个 pod”——设置、密码、peers 与当前一次运行（`start()`/`stop()`、`reconfigure`/`addPeer`/`reset`；状态只经只读成员读：`status`、`run`、`orca()`、`settings`、`configured`，所有重启与状态写入过一条 `SerialQueue`，面板的改动与它触发的重启在同一轮里；`PodStores` 由它自己创建，凭据事件是不是它那两个名字也由它判断）；`stores.ts` 是密码与节点私钥在凭据库里的存放，以及私钥的生成与 base58 编码；`catalog.ts` 的 `ModelCatalogFeed` 只管从 Host 读模型目录并在变化时发 `changes`，往节点上装只经 `Pod` 私下那一条路径；`tracker.ts` 是后台跟踪、待审批的权限请求与投递（`Tracker`，投递交给内部的 `NoticeDelivery`）；`tools.ts` 是唯一的 `orca_pod` 工具（`PodTool`），以及任务进程经本机节点收发文件的 `LocalNode`；`services.ts` 跟踪宿主可选服务（`OptionalService`，构造时 `ctx.inject`，这是 Cordis 的惯用法；与 `ModelCatalogFeed` 同为构造器碰外部的写明例外）；`panel.ts` 是面板的读侧投影（`PanelModel`），`panel-routes.ts` 是 `/orca-api` 的同源路由（`PanelRoutes`，它自己创建 `PanelModel`，动作直接调 `Pod` 与 `Tracker`），`panel-api.ts` 是这条通道的整份契约——请求体 schema 与全部响应类型（客户端只做类型导入）；`skill.ts` 把随包的 skill bundle 解析成 `ctx.skills.register` 的注册对象；插件配置 `Config` 是 `bundle.ts` 里的一个 zod schema（只有 `skill_injection`，Cordis 走它的 Standard Schema 接口）。

**`Pod` 的状态与读取它的四种策略（D43）**：插件 fiber 级的 pod 长命，`Orca` 一次运行一个，每次改设置、reset 都整个换掉。`PodStatus` 是判别联合——`unconfigured`（缺 workgroup 或密码，面板显示向导）/ `starting`（有重启排队或在跑，到节点开始监听为止）/ `running`（带这一次运行的 `Orca`，它知道自己监听的端口）/ `failed`（带错误）/ `stopped`（插件 fiber 已卸载）。`restart()` 一调用就同步进入 `starting`，所以排队中的旧节点不会再被交给任何人。`Pod` 之外读取当前运行只有四种写法：

| 策略 | 写法 | 用在 |
| --- | --- | --- |
| 展示：没有就是空 | `pod.run`（一次回答只读一次） | `PanelModel.state()` 的全部内容、`recent()` |
| 动作：等重启结束，失败要说出原因 | `await pod.orca()` | `PodTool`（可被 abort）、`Tracker` 的 `approve` / `deny`、`PanelModel.task`、面板路由的取消 |
| 后台：没有就跳过这一轮 | `const run = pod.run; if (run === null) return;` | `Tracker.poll`、`Pod` 内部安装模型目录 |
| 写副作用 | 不依赖“碰巧有节点” | 派发时就把会话写进派发日志（`OrcaNode.sendTask(…, { agentId })`），不再事后补写 |

`orca()` 先等队列里排在它前面的事做完（重启、重启后的种子接触、正在加入的 peer），再拿当前运行；没有运行时的报错按状态区分（未设置 / 启动失败：原因 / 已停止 / 仍在启动）。

**术语**（代码注释照用）：

| 词 | 指的是 | 不要用来指 |
| --- | --- | --- |
| pod | 一个 DSH 进程里的这个插件：`Pod` 加上它的 tracker、工具、面板，跨节点重启存在 | 节点 |
| orca node（节点） | **表里的一行**：`OrcaNode`，包括本机自己；一台机器一个，所有 profile 共用 | 插件、进程 |
| `Orca` | 本进程里的这个实例：装配出 `Mesh`、任务运行器、网关，一次运行一个（`pod.run`） | 表里的一行 |
| run | 一次成功启动的 `Orca`（`Orca.port` 是实际监听端口） | |
| member | 节点表里的一行（`mesh.list()`，含自己；`mesh.peers()` 不含） | 地址 |
| peer | 一次调用所指向的对方，用 `mesh.resolve(ref)` 找到（`peer` 参数是节点 id、唯一的显示名或 URL） | 地址 |
| host | 宿主 DSH 进程及其服务（`ctx.*`） | 远端节点 |
| settings / raw settings / panel patch / plugin config | 解析后的节点设置（`Settings`，节点就用它运行）/ `settings.json` 里的原样内容 / 面板发来的增量（`PanelPatch`，含要存进凭据库的密码）/ profile 里的插件配置（只有 `skill_injection`） | 互相混用 |

宿主类型全部来自真实包，没有任何本地镜像：`Context` 及 `ctx.tools`/`credentials`/`webServer`/`agents`/`skills`/`settings`/`llm`/`agentDefaultModel`/`sandboxPolicy` 的增补由 `@deepseek-ai/cordis` 与各 `@deepseek-ai/dsh-*` 服务包自己声明，`import type` 它们即进入类型图；`ctx.settings`、`ctx.configEditor` 这类本插件自己 inject 的服务，在调用点补一行 `import type {} from "<服务包>"` 即可。依赖按 `package.json` 分两类（D40）：`dependencies` 里有 18 个 `@deepseek-ai/dsh-*` 基建包（`agent`、`app-boot`、`atomic-write`、`brand`、`credentials`、`error`、`home-paths`、`host-webserver`、`launch-environment`、`llm`、`native-command`、`sandbox`、`sandbox-policy`、`session`、`skill`、`timeout`、`tools`、`util-values`，除 `error` 停在 `^0.2.2-rc.2` 外都是 `^0.2.2-rc.5`）与 `cross-spawn`（其余运行时依赖见 §9.7）——错误基类 `HarnessError`、工具 schema DSL、原子写、`deadline`/`timeoutOf`、凭据引用、模型与 sandbox 枚举、品牌类型、DSH home 与启动环境快照、原生命令解析等被值导入（`dsh-agent` 只做类型导入），所以 `lib/` 产物会真实 `import` 它们；其余宿主包（`cordis` 与 `cordis-plugin-loader`、`dsh-client-ui-primitives`、`dsh-config-editor`、`dsh-agent-default-model`、`dsh-settings`）仍是 devDependency，只做类型导入或由宿主壳提供。客户端 bundle 对 `dsh-client-ui-primitives` 的 `require` 是宿主平台模块，由壳提供。

`apply` 自上而下读是一个故事：先建对象，再挂到宿主上，最后启动（没有中间类，D56）：

```ts
export function apply(ctx, config) {
  // 任务进程（IN_TASK_ENV）只注册只有 fetch/publish 的 orca_pod，经 LocalNode 走本机节点
  // 建：数据目录固定为 $DSH_HOME/orca-pod：整台机器一个节点，不看 profile（D44）；
  // DSH home 取宿主解析的 ctx.dshHomePath()，环境变量从 DSH 的启动环境快照读（launchEnvironmentOf，含 .env 层）
  const feed = new ModelCatalogFeed(ctx, logger); // llm 与 agentDefaultModel 各自一道 ctx.inject 围栏
  const pod = new Pod(logger, ctx, feed, dataRoot); // 自己创建 PodStores；订阅 feed.changes
  // tracker 轮询派发日志里未结束的任务，并留着等用户作答的权限请求；会话只在交付 notice 时按 agent_id 查（D45）
  const tracker = new Tracker(pod, logger, (id) => agents.current()?.get(id));
  // 挂：卸载 disposer（tracker.stop()、pod.stop()）、agent 钩子（用户发消息 → tracker.resetWakes）、
  // 凭据事件原样转给 pod.credentialsChanged(name)、工具（workgroup 配置完成前不出现）、
  ctx.tools.register(new PodTool({ kind: "host", pod }, sandbox).definition(), { when: () => pod.configured });
  new PanelRoutes(pod, tracker, feed).register(ctx); // 内部 inject(["webServer"])，自己创建 PanelModel
  // 可选服务一律用 ctx.inject 声明，每个服务单独一道围栏；注册挂在回调拿到的子作用域上，
  // 服务被替换时随子作用域一起撤销，不会叠加
  if (config.skill_injection) ctx.inject(["skills"], (scope) => scope.effect(() => scope.skills.register(skillRegistration())));
  ctx.inject(["settings"], (scope) => scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber)));
  // 启：后台启动 pod，apply 立即返回
  pod.start();
  tracker.start();
}
```

约束：

- `apply` 必须快速返回：`start()` 异步，端口占用等问题写日志与状态页，不能让 DSH 启动卡在网络监听上；工具在调用时才 `await pod.orca()`。
- 进程内嵌、不开子进程（ACP 子进程由执行器管）；DSH 退出 → cleanup → listener 关闭、ACP 子进程退出。
- 唯一的工具 `orca_pod`（`method` 分派 `send`/`fetch`/`publish`/`status`/`cancel`/`members`/`connect`；任务进程里只有 `fetch`/`publish`，没有 approve；`peer` 是节点 id、唯一的显示名或 URL；`send` 的 `files` 与 `fetch` 见 [§5.6](05-tasks.md#56-文件交换blob-通道)）；工具注册用 `inject: ['tools']`。
- 硬依赖 `inject: ['tools', 'credentials']`（都在 DSH base 组合里）：密码与节点私钥只在凭据库（[§7.1](07-security.md#71-workgroup-与密码)）；插件配置只有 `skill_injection`。

一句话：**装进 DSH desktop 的东西 = `orca-pod` 这一个包；它被 Loader 激活后执行 `apply()`，`apply()` 创建 `Pod`，后者再按设置构造 `Orca`。**

### 9.6 工程约定

- TypeScript、ESM、Node ≥ 24（用内置 `node:sqlite`；发布的是 `tsc -p tsconfig.build.json` 编译出的 `lib/`，相对 import 由 `rewriteRelativeImportExtensions` 改写；`npm run build` 先清空 `lib/`，搬过的文件不会留下旧产物）；npm（单包，`npm install` 在仓库根目录一次装齐）；vitest；biome（lint + format，`biome.json` 在根目录）；`tsc --noEmit`。
- **`src/` 不再由裸 `node` 直接运行**：服务用 class 并用构造器参数属性，Node 的类型剥离不认这种写法（`erasableSyntaxOnly` 因此关闭，Node 26 也已移除 `--experimental-transform-types`）。开发时用 vitest（测试）或 `node --import tsx`（`scripts/cross.ts`、`scripts/harness_run.ts`）；`npm run harness` 就是直接这样跑 `scripts/harness_run.ts`，不先 build，也不 spawn 子进程。`enum` 与 `namespace` 仍然不用（Biome `noEnum` / `noNamespace`），`scripts/**` 仍只写可擦除语法（`noParameterProperties`）。
- **发布形态是编译产物，不是 `.ts`**：`main`/`exports`/`types` 都指向 `lib/`（没有 `bin`），`files` 只含 `lib/`、`cordis.patch.yml`、`locale/`、`icon.svg`、`skills/` 与 `README.md`，不含 `src/`，`prepare` 即 `npm run build`。DSH 的插件加载器用原生 `import()` 加载入口，没有转译钩子，发行版（Electron 内置 Node 24）里也没有任何 TS 转译器，所以不需要也不能依赖 tsx。Node 的类型剥离对 `node_modules` 下的文件直接报 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`，tarball 安装的包里放 `.ts` 必然加载失败。`dsh plugin add <本地路径>` 装的是 `link:`，链接前必须先 `npm run build`，加载的是 `lib/`。加载器会把说明符里的 `.ts` 改写成 `.js`，那只是对源码风格写法的兼容，不是编译。客户端 bundle（`dsh.client`、`platform: web`）另由 Rolldown 产出，与此无关但同样必需。
- **验收入口：`npm run check`** = `biome check . && tsc --noEmit && tsc --noEmit -p src/client && vitest run`。另有 `npm run format`、`npm run typecheck`、`npm test`、`npm run harness`，以及 `npm run watch:client`（源码一改就重建 `lib/client.js`，DSH 的 `client-hmr` 发现新 bundle 后在页面里自动重载插件）。
- 服务用 class，不做依赖注入（D41）：没有容器（awilix、inversify 等）、没有 `XDeps` 依赖类型、没有专为解耦设的端口接口和 Provider。协作者用构造器参数属性（`private readonly x: X`），参数写具体的 class；私有协作者由拥有者自己 `new`，共享对象由创建者传入；子系统对外的通知用自己持有的 `ChangeSignal`；只有一个固定接收方的（任务记录通知运行器）是构造时传入的回调。构造器不写盘、不联网、不启计时器（读 `settings.json` 这类同步只读除外；SQLite 存储与 `OptionalService` 是两个例外：前者就是它的连接，后者的构造就是向 Cordis 订阅），创建目录、监听端口、首次测量放到 `start()`。私有成员用 TS 的 `private`，不用 `#`。不传未绑定的方法（`foo(obj.method)` 会丢 `this`），要么传对象本身，要么写箭头函数。无状态的纯计算（签名验签、schema 解析、地址筛查、任务书拼装）、线上形状与 DTO 保持函数或纯数据。
- 模块级函数的去留（D42）：参数里带着某个 class 的状态或协作者的函数，就是那个 class 的方法；只在一个 class 里用的函数是它的 `private` 方法，不读 `this` 的写成 `private static`；只有被多个模块用的无状态纯计算、导出后有独立单元测试的纯契约才保持为函数。只为测试存在的公开面（公开方法与字段、选项字段、`Pick` / 结构参数类型、依赖袋）不留，测试经真实入口走；一个默认值、一个检查、一个派生值只在拥有者那里算一次；不用 `ReturnType` 给已有类型换写法。可调参数和协议常量留在模块顶层，不改 `static readonly`，不允许模块级可变状态。
- 插件侧的状态与归属（D43）：总是一起赋值、一起清空的字段合成一个值，用几个布尔或可空字段划分出的状态写成判别联合（`PodStatus`）；跨重启的对象（`Pod`）与一次运行的对象（`Orca`）在类型上分开，读取当前运行只用 §9.2 表里的四种写法；同一份数据只有一个登记处、把 A 装到 B 只有一条路径、所有者之间的引用单向；必须先做 X 再做 Y 的地方由一个方法按顺序做完，而不是靠调用方读注释；class 名是领域名词；构造器只组装，启动与注册钩子是显式的方法调用。
- 存储：任务、文件映射与派发日志共用一个 SQLite 文件（`<data_root>/tasks.db`，WAL，单进程写；不引 ORM）：一个 data_root 一个 `SqliteDb`，由 `Orca` 在绑定端口之后打开、`stop()` 时关一次，三个 store 共用这一个连接；节点表是内存；发布的文件复制进 `<data_root>/blobs/<sha256>`，过期时连同映射一起由 blob 登记处清扫（[§5.6](05-tasks.md#56-文件交换blob-通道)）。
- 本地联调命令：

  ```bash
  npm run check
  npm run harness                    # 进程内两个节点、真实回环网络、一个脚本任务
  node --import tsx scripts/cross.ts serve --workgroup orca-dev --password change-me
  node --import tsx scripts/cross.ts join --peer http://127.0.0.1:11811 --workgroup orca-dev --password change-me
  node --import tsx scripts/cross.ts task --peer http://127.0.0.1:11811 --workgroup orca-dev --password change-me --text hello
  ```

  `cross.ts`（跨机器手测）在进程内构造 `Orca`，每次运行用新的内存身份，密码由命令行给；两边都跑 `ScriptExecutor`；`task` 支持 `--script '<json>'` 传入自定义脚本（写进任务文本）。它们是开发脚本，不随包发布。

### 9.7 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、原子写这类“基础功能”直接用成熟包或 Node 内置；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、恢复消息的批准校验、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 依赖                                  | 类别 | 理由                                                                                                |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `fastify`                             | 运行时 | 路由、body 解析与限额、错误处理；不手写 http server                                                   |
| `ulid`                                | 运行时 | 任务 id（runner 里的 `ulid()`）：规范实现、零依赖，随机部分取自 `crypto.getRandomValues`                 |
| `bs58`                                | 运行时 | 节点 id（`core/ids.ts`）与私钥种子的存储形式（`plugin/stores.ts`），都是 base58、Bitcoin 字母表：规范实现，唯一依赖是同作者的 `base-x`，不手写进位换算 |
| `@agentclientprotocol/sdk`            | 运行时 | ACP v1 客户端：`executor/acp/connection.ts` 不再手写 JSON-RPC；类型化的请求、响应与处理器（`McpServer` 等形状由它约束）。子进程的派生与生命周期仍归本项目 |
| `zod`                                 | 运行时 | 唯一的 schema 写法：协议线上形状、网关输入、设置都用它声明，类型由 `z.infer` 推导，规范化（endpoints、peer 地址）写成 `.transform`。不可信输入经 `core/schema.ts` 的 `parseOrThrow`（网关里是它的一行包装 `parseInput`）：`z.object` 丢弃未描述的键并返回新值，失败时把第一处问题写成“路径 + 原因”一句话交给调用方造错误；需要按值收窄类型的地方直接用 schema 的 `safeParse` 结果（如品牌 id），不另设 `isX` 守卫；A2A 请求是按 `method` 区分的一个联合 schema，路由 `switch` 时 `params` 即已定型；只看外形的地方（A2A 的 message、metadata）用 `z.looseObject` 保留其余字段。`@agentclientprotocol/sdk` 也依赖它（必需 peer），所以它本来就在运行期里。不调用 `z.config()`：全局配置会波及 SDK |
| `@deepseek-ai/dsh-*`（`agent` / `app-boot` / `atomic-write` / `brand` / `credentials` / `error` / `home-paths` / `host-webserver` / `launch-environment` / `llm` / `native-command` / `sandbox` / `sandbox-policy` / `session` / `skill` / `timeout` / `tools` / `util-values`） | 运行时 | 与宿主同一套基建（D40）：错误基类 `HarnessError`、工具 schema DSL、原子写、`deadline`/`timeoutOf`、凭据引用、模型与 sandbox 枚举、品牌类型、DSH home 与启动环境快照；版本跟宿主 `^0.2.2-rc.5`（`dsh-error` 仍 `^0.2.2-rc.2`），随包发布 |
| `cross-spawn` | 运行时 | ACP 子进程的跨平台派生：Windows `.cmd` shim 解析与命令行引号（`executor/acp/connection.ts`）；杀进程树同在该文件（`AcpConnection` 的私有方法） |
| `undici` | 运行时 | 节点间（和任务会话到本机节点）的 HTTPS 客户端：自定义 connector 在握手后、请求发出前按节点 id 钉住自签证书，`sigalgs` 列出 Ed25519（BoringSSL 默认不列），关掉 TLS 会话缓存（[§7.4](07-security.md#74-tls)）。Node 内置的 `fetch` 两样都做不到 |
| `typescript`                          | 开发 | 类型检查（`tsc --noEmit`）与构建（`tsc -p tsconfig.build.json` → `lib/`）                           |
| `rolldown` + `lightningcss`           | 开发 | 把 `src/client/` 的 TSX 与 CSS Modules 打成 `lib/client.js`（`rolldown.config.ts`），与 DSH 自带插件同一工具链；版本跟 vitest 带的 vite 走（`rolldown` 用 `~`，避免装出两份） |
| `@types/react`                        | 开发 | 客户端 TSX 的类型；React 运行时由 DSH 壳提供，不随包发布                                           |
| `vitest`                              | 开发 | 测试                                                                                                |
| `@types/node`                         | 开发 | Node 类型                                                                                           |
| `@biomejs/biome`                      | 开发 | lint + format，一个工具                                                                             |

其余能力大多用 Node 内置：`node:crypto`（Ed25519、scrypt、HMAC）、`node:sqlite`、全局 `fetch`、`node:fs`、`node:stream`；跨平台基础件（错误基类、原子写、deadline、工具 schema、模型与 sandbox 枚举）用上面的 DSH 基建包，不再自写。不引 pino、commander、ORM、DI 容器、消息队列，也不再引第二个校验库：集群只有十台机器，这些是负资产；也没有比 `node:crypto` 里几十行更合适的认证/签名框架。

---
