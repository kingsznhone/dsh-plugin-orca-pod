# 09 实现

> 本章给出仓库结构、测试夹具、DSH 组合入口与工程约定。

## 9. 实现

### 9.1 单包内的模块划分

整个项目**就是一个 npm 包**（仓库根目录）。DSH 插件规范就是一个 npm 包（`package.json` + `dsh.bundle.patch`），拆成多个私有包会让安装物不自包含：内部依赖在仓库外解析不到。因此用目录和 import 纪律维持模块边界，不再用包边界。

```text
orca-pod/（仓库根目录）
  package.json        唯一依赖 fastify；dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    DSH 行：id orca-pod、name 'orca-pod'
  src/
    protocol.ts       类型、错误码、orca_node_id、成员 digest、签名规范化（零依赖）
    crypto.ts         HKDF、请求签名、nonce cache、grant 签名/校验
    config.ts         配置校验、默认值、密钥派生、JSON 读写
    storage.ts        PeerStore / TaskStore 接口 + 内存实现（+ 重导出 blobs）
    blobs.ts          内容寻址 blob store（内存 + fs，含 TTL GC，流式上传/下载）
    blob-files.ts     本地文件 blob 映射（CLI 登记，网关按签名 URL 流式读取）
    dispatches.ts     origin 侧派发日志（派给谁、最后知道什么；重启标 unknown）
    events.ts         进程内变更事件总线（task / members / dispatch），面板订阅用
    sqlite.ts         TaskStore、file_blobs 与 dispatches 的 node:sqlite 实现（WAL，单进程写）
    workspace.ts      workgroup 工作区（根 = agent cwd）与网关状态目录
    membership.ts     成员记录、心跳看门狗、墓碑与修剪
    gateway.ts        HTTP：/health、Agent Card、/cluster/*、/a2a、/blobs
    executor.ts       LocalExecutor 接口 + EchoExecutor
    headless.ts       HeadlessExecutor（dsh headless 子进程，一次性任务）
    acp.ts            AcpExecutor（dsh acp stdio：流式事件、权限挂起、session resume）
    process.ts        子进程公共件：命令解析（Windows shim）、killTree、abort 错误
    preamble.ts       编排 preamble（task id、CLI 路径、send/wait/escalate/publish 用法）
    session-store.ts  `state/<workgroup_id>/sessions.json` 读写（按 origin+context 绑 ACP/headless session）
    tasks.ts          单槽任务运行器
    orca_node.ts      组合根：一个进程 = 一个 orca node
    harness.ts        进程内多 orca node + `waitFor` 断言 helper，测试用
    harness-run.ts    真实进程 smoke test（`npm run harness`：两个 serve、join、任务往返）
    cli.ts            `orca-node` CLI：serve / send / status / wait / members / escalate / publish / log
    plugin/           DSH bundle：Config、apply、pod_* 工具、后台 tracker、admin.ts（面板数据面）、web.ts（面板同源路由）、skill.ts（安装期技能注入）
  client.js           DSH 客户端 bundle：设置页 + 侧栏按钮 + 停靠式浮层（轮询 /orca-api；首启向导 / 状态 / 设置三视图）
  test/               vitest 套件（protocol/crypto/membership/mesh/a2a/blobs/plugin/tracker/skill/approval/watchdog）
```

当前代码状态：

| 模块 | 状态 | 说明 |
|---|---|---|
| `protocol.ts` | 已实现 | 类型、错误码、任务视图、orca_node_id、digest、签名规范化 |
| `crypto.ts` | 已实现 | HKDF、请求签名、nonce cache、grant 签名/校验 |
| `chain.ts` | 已实现 | 多跳元数据（hop/chain/root）校验、祖先禁调、child grant 派生（含 Echo relay 原型的下发） |
| `config.ts` | 已实现 | 配置校验、密钥派生、JSON 读写 |
| `storage.ts` / `blobs.ts` | 已实现 | PeerStore/TaskStore 接口 + 内存实现；blob 另有 fs 实现（内容寻址、临时文件+rename、TTL GC、流式 `putStream`/`openRead`） |
| `sqlite.ts` | 已实现 | `node:sqlite`：TaskStore 与 `file_blobs` 映射都在 `<data_root>/tasks.db`，WAL、`synchronous=NORMAL`、整条记录 JSON 存储 |
| `workspace.ts` | 已实现 | `<data_root>/workgroups/<workgroup_id>/`（根 = agent cwd，含 `notes/`、`inputs/<task_id>/`）与 `<data_root>/state/<workgroup_id>/`（sessions、任务目录）；启动 `ensure()` + `purgeInputs()` |
| `membership.ts` | 已实现 | 双向看门狗、单调时钟、suspect(unreachable)、墓碑与 record_ttl 修剪 |
| `gateway.ts` | 已实现 | `/health`、Agent Card、`/a2a`、`/cluster/*`、`/blobs`（上传/下载/直链） |
| `executor.ts` | 已实现 | `LocalExecutor` 事件流接口 + EchoExecutor；真实实现在 `headless.ts` / `acp.ts` |
| `headless.ts` | 已实现 | `dsh headless --json` 子进程、NDJSON→状态机、取消杀进程树、session 复用 |
| `acp.ts` | 已实现 | `dsh --profile acp` stdio（NDJSON JSON-RPC）：initialize/session/prompt/update/permission/cancel，权限挂起映射为 `input-required`，grant 回 allow-once |
| `process.ts` / `session-store.ts` | 已实现 | Windows `.cmd` shim 解析、进程树终止；`state/<workgroup_id>/sessions.json` 原子读写 |
| `tasks.ts` | 已实现 | 单槽状态机；inputs 物化/附录/终态清理、硬 TTL、简报截断、usage/错误码；TaskStore 可注入（默认内存，CLI/插件用 SQLite），启动时把非终态标 `failed(node_restart)` |
| `blob-files.ts` | 已实现 | 本地文件 sha256→路径映射（SQLite 持久化），`GET /blobs/:id` 按映射流式读取 |
| `dispatches.ts` | 已实现 | origin 侧派发日志（`dispatches` 表）：记录 peer/状态/父任务链接，重启把非终态标 `unknown`，`orca-node log` 可读 |
| `events.ts` | 已实现 | 进程内事件总线：`task`（每次状态变更）、`members`（名单/状态/busy 变化，按签名去重）、`dispatch`（派发落库）；listener 抛错被隔离 |
| `orca_node.ts` | 已实现 | 组合根；启动/停止心跳循环，装配 PeerStore 门面与任务运行器；origin 日志 upsert 与 child-link 轮询（自动上升）；`listTasks`/`subscribe`/`blobLink`/`workspacePaths` 供面板读 |
| `harness.ts` | 已实现 | `createMesh`、`joinRoster`（按目录 best-effort 加入）、`waitFor`；mesh/A2A/discovery/formation/transport 测试 |
| `harness-run.ts` | 已实现 | 真实进程 smoke：两个 `orca-node serve`、`--peer` 引导 join、CLI members 收敛、Echo 任务到终态、清理临时目录 |
| `plugin/` | 部分实现 | `apply` 启动 orca node、注册 5 个 `pod_*` 工具（含 `pod_approve`）；后台 tracker 轮询终态并 `inject`/`followup`，权限请求强制唤醒；审批卡片已接线（reason 显示来源链）；`admin.ts` 提供面板数据面（成员/任务/审批/工作区/产物直链，审批不经模型）；`web.ts` 在 DSH web 同源注册 `/orca-api`（仅回环）；`lifecycle.ts` 支持 UI 保存配置与重启（`<data_root>/ui-config.json` 覆盖层）和 UI 直连 peer；`client.js` 是注册设置页/侧栏按钮/停靠浮层的客户端 bundle；安装期幂等写 user skill `orca-node/SKILL.md`；credentials 读取未做 |
| `ui`（独立前端） | 未开始 | 目前面板是 DSH Settings 里的一页；将来若要独立窗口/路由，仍放在同一包内（`src/ui/` 或独立 client 入口），发布物不增加依赖 |

“已实现”指当前可运行、有测试或用例覆盖；未列出的目标能力属于后续里程碑。

模块依赖方向单向，禁止反向（靠 review 与 import 检查，不靠包边界）：

```text
protocol  ← crypto, config, storage, gateway, executor, tasks, orca_node
crypto    ← config, gateway, chain, orca_node
chain     ← config, tasks, orca_node   （多跳元数据与 grant 派生，不 import executor）
storage   ← gateway, orca_node, sqlite, workspace
sqlite    ← orca_node   （只实现 storage.TaskStore 接口）
workspace ← orca_node   （只提供路径与 ensure，不 import 网关）
membership ← orca_node   （gateway 只见 PeerStore 门面）
gateway   ← orca_node   （gateway 只依赖 protocol + storage 接口，不 import executor/tasks 实现）
executor  ← tasks, headless, acp
headless  ← orca_node   （Headless 实现只依赖 executor 的接口）
acp       ← orca_node   （AcpExecutor 同样只依赖 executor 的接口）
process   ← headless, acp   （命令解析与杀进程树，不知道 ACP 协议）
session-store ← headless, acp   （只读写 state/<workgroup_id>/sessions.json）
tasks     ← orca_node
orca_node ← harness, plugin
```

`gateway` 通过构造参数拿到 `TaskRunner` 接口实例，而不是 import executor 或具体实现——这是“gateway 能单独测”的前提。

`orca_node.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、`trustProxy`、错误处理都用它现成的，不手写 http server。

### 9.2 面板（数据面 + 同源桥 + 设置页）

将来 UI 面板需要的每个数字都应该从 Host 侧同步取到，而不是先让模型调一次工具再转述。为此库根暴露四个只读入口，插件再把它们打包成 `PodAdmin`：

| 入口 | 位置 | 内容 |
|---|---|---|
| `listTasks(limit?)` | `orca_node.ts` | 本机任务（inbound），内存记录按新到旧在前，持久 store 回填历史；返回完整 `TaskView` |
| `subscribe(listener)` | `orca_node.ts` → `events.ts` | `task`（每次状态/权限变化）、`members`（名单、state、busy 持有者、endpoints 变化；按签名去重，心跳周期内不重复）、`dispatch`（origin 侧派发落库） |
| `blobLink(blobId, ttlS?)` | `orca_node.ts` | 与 `POST /blobs/:id/link` 同形的签名直链（`?exp&sig`），面板直接 `<a href>` 下载产物 |
| `workspacePaths()` | `orca_node.ts` | workgroup 根、`notes/`、`inputs/`、`state/` 路径；`admin.workspace()` 再附一层浅列表 |

`createPodAdmin(handle, tracker)` 组合出面板 API：`members()`（完整 `PeerView`，含 busy/runtime/last_recv_at/max_task_ttl_s）、`tasks()`、`dispatches()`、`task(peer, id)`、`approvals()`（tracker 里正挂权限请求的任务）、`approve(peer, id)` / `deny(peer, id, reason?)`（直接走 `OrcaNode.approveTask`，不经过模型与工具轮次）、`artifacts(view)`（附 `blobLink` URL）、`workspace()`、`subscribe()`（合并节点事件与 tracker 更新）。

面板用轮询兜底即可，事件只是降低延迟：`pod_members` 工具现在也返回 busy/runtime/last_recv_at/max_task_ttl_s，不再裁剪成四个字段。审批仍以 DSH 审批卡片为第一入口；`PodAdmin.approve` 是给面板的直通路径，两者共用同一套 grant 校验。

**UI 改配置与连接 peer**：`PodAdmin.config()` 给出去敏视图（`workgroup_id`、`display_name`、`port`、`endpoints`、`peers`、`running`、`password_set`，**永不返回密码**）；`saveConfig(patch)` 把可编辑项写进 `<data_root>/ui-config.json`（`{setup_complete, workgroup_id, workgroup_password?, display_name, port, endpoints, peers}`），再按“bundle 配置 + override”合并并复验，串行地停掉旧节点、用合并后的配置重启——orca node 身份（`config.json`，按 workgroup 复用）不变。换 `workgroup_id` 时必须显式给新密码，否则拒绝（`changing the workgroup requires its password`）。`connect(peer)` 立即 `join` 一次并把 peer 记入 override（不需要重启），失败只回错误、不落盘。`ui-config.json` 只由回环闸门后的面板路由写入，不改 profile 的 `cordis.patch.yml`；`setup_complete=true` 之前面板首屏是向导。

#### 9.2.1 同源桥（`plugin/web.ts`）

第三方 bundle 不能 import Host 包，也没有 Typert Remote 的生成流程，所以面板不声明 RPC，而是在已经运行的 DSH web 服务上注册一条同源前缀路由（与 `billion-context` 的做法一致）：

| 路由 | 方法 | 内容 |
|---|---|---|
| `/orca-api/state` | GET | 一次轮询拿全量：`self`、`config`、`members`、`tasks`（最近 50）、`dispatches`、`approvals`、`artifacts`（按任务）、`workspace`、`now` |
| `/orca-api/task?peer=&task=` | GET | 单任务详情 + 该任务的产物直链 |
| `/orca-api/config` | GET / POST | GET 返回去敏配置视图；POST `{workgroup_id?, workgroup_password?, display_name?, port?, endpoints?, peers?}` → `PodAdmin.saveConfig`（写 override 并重启节点） |
| `/orca-api/connect` | POST | `{peer}` → `PodAdmin.connect`：立即 join 并把 peer 记入 override，不重启 |
| `/orca-api/approve` / `deny` / `cancel` | POST | `{peer, task_id, reason?}` → 直接调 `PodAdmin` 对应方法，不经模型 |

注册走 `ctx.inject(['webServer'], sub => sub.effect(() => sub.webServer.register({kind:'prefix', path:'/orca-api', handler})))`；没有 web 服务的宿主（headless/ACP/CLI）直接跳过，不影响启动。路由只接受回环连接（`socket.remoteAddress` 必须是 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`）且拒绝带 `x-forwarded-for`/`forwarded`/`x-real-ip` 的请求，因此面板不会因为反向代理或多网卡把审批面暴露出去——和 `/cluster/child-link` 同一原则：本地能力信传输层，不信任签名身份。

#### 9.2.2 客户端 bundle（`client.js`）

包根 `client.js` 是 DSH 客户端 lazy-CJS 工厂：`window.__ModuleLoader__.load({id:"orca-pod", factory(require){…}})`，factory 内只 `require('react')`，返回 `{inject:['slots'], apply}`；`apply` 注册三个 Slot：

| Slot | id | 作用 |
|---|---|---|
| `settings.section` | `orca-pod` | 一页设置面板（order 60，排在 Plugins 之后） |
| `sidebar.footer.action` | `orca-pod` | 侧边栏底部 Settings 旁的动作按钮（面板收起时只显示 `◈` 图标，`wide` 时带文字） |
| `shell.overlay` | `orca-pod.panel` | 停靠在右下角的浮层卡片；点侧边栏按钮打开，按 Esc 或 `×` 关闭 |

设置页与浮层共用同一份 `Panel`，面板按状态分三视图：`ui-config.json` 未完成设置时是**首启向导**（必须填 workgroup 与密码）；否则第一屏是**集群状态**（自身/成员/待审批/最近任务/工作区），右上 `⚙` 进入**设置视图**（workgroup/密码/显示名/监听端口/自报 endpoints/peers + 单独的“连接 peer”输入）。浮层不铺满背景、不遮住底部工具区（`padding-bottom: 56px`，外层 `pointer-events: none`，卡片自身可交互）。面板每 2s `fetch('/orca-api/state')`；审批与取消按钮直接 POST，保存配置后自动回到状态页。样式只用内联对象与 `--dsw-alias-*` 主题 token，不写 `document.body`，卸载时清理定时器。

清单接线：`package.json` 的 `exports["./client"] = "./client.js"`、`dsh.client = {platform:"web", immediately:true}`、`files` 含 `client.js`；Host 侧 `apply` 把 `createPodAdmin(handle, tracker)` 传给 `registerPodWeb`。

### 9.3 每个模块怎么测

| 模块 | 夹具 | 断言 |
|---|---|---|
| `protocol.ts` | 固定 JSON 样本 + 签名向量 | schema 通过/拒绝、MAC 与向量一致 |
| `crypto.ts` | RFC 5869 向量 + 冻结的 MAC | 换密钥/时间/body 任一字节即变 |
| `chain.ts` | 纯函数 + 三 orca node 真实 HTTP | hop 限制、祖先禁调、child grant 派生/过期/工具不符 |
| `config.ts` | 合法/非法配置样本 | 错误信息指向具体字段 |
| `storage.ts` / `blobs.ts` | 一套 contract test，跑内存、fs 与 sqlite | 两实现行为一致；过期/GC/去重 |
| `workspace.ts` | 临时目录 | 目录一次创建、跨调用稳定、`taskDir` 拒绝路径穿越 |
| `sqlite.ts` | 临时 db 文件 | 关闭重开仍在、意外中断的 task 恢复为 `failed(node_restart)` |
| `gateway.ts` | 进程内 `fetch`，假 executor、注入时钟 | 路由、401/403/429、签名 |
| `executor.ts` | echo 脚本样本 | 状态时序、`input-required`、resume |
| `headless.ts` | 假 `dsh`（`test/fixtures/fake-dsh.mjs`）；真实 `dsh` 用 `scripts/e2e-headless.ts` 手动冒烟（需凭据） | NDJSON 事件映射、取消、session 复用 |
| `acp.ts` | 假 ACP server（`test/fixtures/fake-acp.mjs`，模式 ok/permission/hang/resume-fail） | 完成文本、cwd、权限挂起→grant→继续、`session/cancel`、session 复用与重启 `session/resume`、启动失败即 `failed` |
| `tasks.ts` | 假 executor + 注入时钟 | 单槽、TTL、取消 |
| `harness.ts` | 多 orca node mesh + 可注入时钟 | 成员收敛、故障、任务往返 |
| `plugin/` | 假 DSH host 的 smoke | 工具注册、生命周期 |
| `plugin/web.ts` / `client.js` | 假 `PodAdmin` + 假 req/res | 状态/配置快照、回环与转发头拒绝、approve/deny/cancel 直通、config 保存与 connect、路由注册与 `effect` 清理 |
| `lifecycle.ts` + `plugin/admin.ts` | 临时 `data_root` 起真实 orca node（port 0） | 首启未配置→reconfigure 写 `ui-config.json` 并重启保身份、重启后加载 override、live join 持久化、失败 peer 不落盘、admin 不返回密码、换组需密码、peer 归一化 |

实际跑通的测试：protocol 33 个、crypto 15 个、membership 5 个、mesh 1 个、a2a 8 个、blobs 12 个、blobs-fs 5 个、storage-sqlite 3 个、workspace 5 个、inputs 7 个、persistence 2 个、plugin 12 个、tracker 10 个、skill 3 个、approval 12 个、chain 12 个、headless 9 个、acp 7 个、cli 10 个、escalation 4 个、watchdog 2 个、discovery 2 个、formation 7 个、transport 4 个、permission-mode 8 个、acceptance 4 个、ssrf 8 个、limits 6 个、dispatches 4 个、relay-auto 2 个、endpoint 4 个、multi-endpoint 2 个、heartbeat-adaptive 5 个、ui-surface 4 个、web 10 个、panel-config 7 个，共 254 个、36 个测试文件（`npm test`）。gateway 与 executor 的行为由 `test/a2a.test.ts` 经真实 HTTP 覆盖，插件配置/工具注册契约由 `test/plugin.test.ts` 覆盖，orca node 重启后的持久化与恢复由 `test/persistence.test.ts` 覆盖，面板配置/override/连接 peer 由 `test/panel-config.test.ts` 覆盖。

### 9.4 进程内多 orca node

`orca_node.ts` 的 `createOrcaNode({ config })` 返回 handle：`start() / stop() / self() / members() / membersDigest() / join(peerUrl) / heartbeat(peerUrl) / sendTask(peerUrl, input) / getTask(peerUrl, id) / cancelTask(peerUrl, id)`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 目前有 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, fetch })`，返回 `{ orcaNodes, urls, stop() }`。它启动 orca node 后让每个 orca node join 第一个 orca node、用 `joinRoster` 按返回目录 best-effort 补 join，再对 bootstrap 发一轮心跳。
- 已支持：可注入时钟（`createOrcaNode({ clock })`）、可注入 transport（`createOrcaNode({ fetch })`，模拟丢包、延迟、单向阻断）、orca node 启停（`start()` / `stop()`）、进程内 mesh、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给（延迟 0.3–2.5 个间隔、丢包 30 个间隔、单向阻断 15 个间隔、全断 5 个间隔），不按绝对毫秒。
- 跨进程：`npm run harness` 起两个真实 `orca-node serve` 子进程（第二个用 `serve --peer <url1>` 在启动时 join），用 CLI 观察 members 收敛、派一个 Echo 任务并等到终态，最后清理临时数据根；退出码即结果。
- 公共 helper：`waitFor(probe, done, { timeoutMs, intervalMs, label })` 从 `src/harness.ts` 导出，进程内与真实进程 smoke 共用。
- 场景用 vitest 的普通 async 函数写：`await waitFor(() => ...)`、`orcaNode.stop()`、`sendTask` 组合，不引入第二套场景描述语言。

```ts
const mesh = await createMesh({ orcaNodes: 3, password: "test" });
const [origin] = mesh.orcaNodes;
const targetUrl = mesh.urls[1];
const task = await origin.sendTask(targetUrl, {
  message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
  metadata: { echo: { final: { state: "completed", text: "hi" } } },
});
// 轮询 tasks/get 直到终态；真实断言见 test/a2a.test.ts
```

### 9.5 组合入口：库根在 `orca_node.ts`，安装根是整个包

“组合根”有两层，别混：

| 层 | 文件 | 谁调用它 | 职责 |
|---|---|---|---|
| 库根 | `src/orca_node.ts` → `createOrcaNode(config)` | harness、plugin、将来的独立服务 | 装配一个 orca node：config → storage → gateway → executor。不读 argv、不读 DSH |
| 安装根 | 仓库根目录本身（bundle 名 `orca-pod`） | DSH 的 Loader | `apply(ctx, config)` 里 createOrcaNode、注册工具/审批/UI，cleanup 里 `stop()` |

DSH 加载一个 bundle 靠包清单里的 `dsh.bundle.patch` 行，不是 `main`：

```text
orca-pod/（仓库根目录）
  package.json       "exports": { ".": "./src/index.ts", "./testing": "./src/harness.ts" },
                     "dsh": { "bundle": { "patch": "./cordis.patch.yml" } },
                     "dependencies": { "fastify": "^5.6.0" }        # 唯一运行时依赖
  cordis.patch.yml   - insert: { id: orca-pod, name: 'orca-pod' }  # Host 行
  src/index.ts       export { Config, apply, inject } from './plugin/index.ts'
                     + 全部库导出（createOrcaNode 等），DSH 与库共用一个入口
  src/plugin/        apply / config / lifecycle（orca node 生命周期）/ tools / tracker（后台终态跟踪） / skill（安装 orca-node 技能） / 最小 DSH 类型
```

`apply` 只做五件事，其余都靠注入（实际实现见 `src/plugin/index.ts`）：

```ts
export function apply(ctx, config) {
  const handle = startPod(config, ctx.logger)          // 非阻塞启动，失败只记日志/状态
  const tracker = createTracker(() => handle.runtime.orcaNode, { logger })
  if (config.skill_injection) void installSkill({ cliPath, dataRoot })  // 幂等写 user skill
  ctx.effect(() => async () => { tracker.stop(); await stopPod(handle) }, "orca-pod.orca-node")
  for (const tool of createPodTools(handle, tracker, { approval: ctx.approval })) ctx.tools.register(tool)
  // 密码：原型阶段从 patch config 读；生产应改为 ctx.credentials.readRecord('orca-pod')
}
```

三条约束：

- `apply` 必须快速返回：`start()` 异步，端口占用/证书问题写日志与状态页，不能让 DSH 启动卡在网络监听上。
- 配置分两类：`workgroup_id` / `port` / `display_name` 走普通 config（Plugin manager 可改，`configEditor.edit` 持久化）；**密码生产上应进 `ctx.credentials` 记录，不进 config**，也不写进 bundle patch。Phase 0 为了能跑，密码暂在 patch 里（见 README 的安全提示）。
- 进程内嵌、不开子进程；DSH 退出 → cleanup → listener 关闭。工具注册用 `inject: ['tools']`；审批走 DSH 的 approval 服务（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）：tracker 看到 `permission_request` 强制 `followup`，模型调用 `pod_approve`，工具在 open turn 内弹卡，再把决定回成同一 task 的后续 message。

harness / CLI 是第三个入口：包内 bin `orca-node`（`src/cli.ts`）有 `serve` 与客户端子命令 `send`/`status`/`wait`/`members`——`serve` 加载配置 → `createOrcaNode` → `start()`；客户端子命令读同一份 `config.json`（`--config` 或 `--data-root`），用本 orca node 身份签 `Pod` 头，直接打本机或对端的 `/a2a`（`--peer`），`--text -` 从 stdin 读任务文本，`--json` 输出结构化结果，`wait` 的退出码 0/1/2/3 分别表示终态成功/失败/仍在跑/需权限，供 ACP/headless 会话里的 agent 用 shell 调用；`AcpExecutor` 在 prompt 前注入的 preamble 就指向这个 CLI。`scripts/cross.ts` 提供 serve/join/task/blob 跨进程、跨机联调命令。两者都复用同一个 `createOrcaNode`，不依赖 DSH。`--nodes` / `--scenario` 这类 harness CLI 尚未实现。

一句话：**装进 DSH desktop 的东西 = `orca-pod` 这一个包；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是 `createOrcaNode()`。**

**Phase 0 现状**：库根 `createOrcaNode` 与安装根 `orca-pod` bundle 都已可用。bundle 有 `cordis.patch.yml`、`Config`（Standard Schema）、`apply(ctx, config)`：非阻塞启动 orca node、`ctx.effect` 清理、注册 `pod_send`/`pod_status`/`pod_cancel`/`pod_approve`/`pod_members` 五个不阻塞工具。`pod_send` 成功后在插件侧登记任务，`createTracker` 每 1s 拉一次 `tasks/get`，终态在 2s 窗口合并成一条 notice；`agent.status === "running"` 时 `inject()`，idle 时 `followup()` 唤醒，连续唤醒预算 3；`permission_request` 不受预算限制强制 `followup`，`pod_approve` 在 open turn 内弹 DSH approval 卡片并回 grant/deny（[§5.2](05-tasks.md#52-任务回报)、[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。已用 DSH 自带 Node 运行时做过两个 orca node smoke（join、send、status、cancel、重启后 orca_node_id 不变）。包自包含（运行时只依赖 `fastify`），`npm pack` 产物不含任何内部私有依赖。未做：client bundle/locale、`ctx.credentials` 读取（原型阶段密码暂放配置）、“用户发过新消息就重置唤醒预算”（当前只看 agent 当前状态）。

### 9.6 工程约定

- TypeScript、ESM、Node ≥ 22（开发机为 26 LTS）；npm（不用 pnpm；单包，`npm install` 在仓库根目录一次装齐）；vitest；`tsc --noEmit` 进 CI。
- 构建/开发的目标选型是 `tsup` + `tsx` + `biome` + `commander` + `pino`；Phase 0 尚未安装，仓库目前只有 `typescript`、`vitest`、`@types/node`。
- 不引入框架级 DI 容器：构造函数注入足够，装配只在 `orca_node.ts`。
- 存储：task store 用 `node:sqlite`（`<data_root>/tasks.db`，WAL，单进程写；不引 ORM/`better-sqlite3`）；peer store 仍是内存；blob 用内容寻址的 fs 目录 + TTL GC；工作区目录由 `workspace.ts` 管理。内存实现只给单测与 harness 用（[§5.5](05-tasks.md#55-任务存储)）。
- 本地命令（当前可用）：

  ```bash
  npm run typecheck
  npm test
  node scripts/cross.ts serve --workgroup orca-dev --password change-me
  node scripts/cross.ts join --peer http://127.0.0.1:11811 --workgroup orca-dev --password change-me
  node scripts/cross.ts task --config <config.json> --peer http://127.0.0.1:11811 --text hello
  ```

  `task` 支持 `--echo '<json>'` 传入自定义 Echo 脚本，`--auto-resume true` 在 `input-required` 后自动补发恢复消息。跨机时把可达地址写进 config 的 `endpoints`（有序列表，例如 `["http://192.168.1.11:11811"]`，可再加公网 URL）；`serve` 不会覆盖显式配置。

### 9.7 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、CLI、原子写、id 生成这类“基础功能”直接用成熟包；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、grant、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 能力 | 选型 | 说明 |
|---|---|---|
| HTTP 服务 | `fastify` | 成熟、插件生态、schema 校验、`trustProxy`、`bodyLimit`；不手写 http server 与路由 |
| 参数校验 | `zod` + `fastify-type-provider-zod` | `protocol` 包统一用 zod，服务端复用同一套 schema |
| 结构化日志 | `pino` / `pino-pretty` | 低开销、字段化；测试里可静音 |
| 小 JSON 状态 | `lowdb` + `steno` | 原子写、无数据库；存成员缓存、配置、GC 标记 |
| 任务存储 | `better-sqlite3` | 同步 API、稳定；替代方案 `node:sqlite` |
| 文件原子写 | `write-file-atomic` | blob 落盘与 manifest；避免手写 rename+fsync |
| id 生成 | `ulid` | `task_id` 单调可排序；`orca_node_id` 仍需自写（6 字符 Crockford） |
| HTTP 客户端 | 内置 `fetch`（undici） | 不引 axios；测试用 `undici` MockAgent 或 `msw` |
| 重试/退避 | `p-retry` | 只在客户端（模型/UI）用；服务端仍然不自动重试 |
| 假时钟 | `@sinonjs/fake-timers` | 心跳阈值与 `at_ms` 的单测；配合注入的 `Clock` 接口 |
| 构建/开发 | `tsup`、`tsx` | ESM 输出 + 直接跑 TS |
| Lint/format | `biome` | 一个工具，配置在根目录 |
| CLI | `commander` | harness 与 orca node 启动参数 |
| MIME/文件名 | `mime-types`、`sanitize-filename` | blob 下载 `Content-Type` 与 `Content-Disposition` |
| 限流 | 不做（局域网自用） | 若暴露公网，在代理层（Caddy/nginx）做 |
| SSE（Phase 4） | `fastify-sse-v2` | 只在做 `message/stream` 时引 |

**Phase 0 实际依赖**：运行时只有 `fastify`（在一个包里，随包发布）；开发依赖只有 `typescript`、`vitest`、`@types/node`。表中的 `zod`、`pino`、`lowdb`、`better-sqlite3`、`commander`、`tsup`、`biome` 等是目标选型，尚未安装。

明确不引的：认证/签名框架（没有比 30 行 Node `crypto` 更合适的）、DI 容器、ORM、消息队列、服务网格。集群只有十台机器，这些是负资产。

### 9.8 与路线图的对应

- Phase 0：单包内 protocol、crypto、config、storage、gateway、executor(echo)、tasks、orca_node、harness、plugin。
- Phase 1：harness 覆盖成员收敛与故障场景（vitest 用例）。
- Phase 2：持久化底座（SQLite task store、fs blob + GC、group 工作区与 cwd 绑定）、HeadlessExecutor、AcpExecutor。
- Phase 3：plugin 的审批卡片、权限。
- Phase 4：10 个 orca node 压测复用 harness。

**实际状态**：protocol、crypto、config、storage（内存 + SQLite/fs）、workspace、gateway（含 blob 路由）、tasks、orca_node、harness、plugin（含后台 tracker/唤醒）、executor（Echo + Headless + ACP）已实现；面板已实现（数据面 `events.ts` + `plugin/admin.ts`、同源桥 `plugin/web.ts` 的 `/orca-api` 含 config/connect、客户端 `client.js` 的三 Slot 与首启向导/状态/设置三视图、`lifecycle.ts` 的 `<data_root>/ui-config.json` 覆盖层与 UI 改配置/连接 peer；`test/ui-surface.test.ts`、`test/web.test.ts`、`test/panel-config.test.ts`）；InProcess executor、独立风格的前端（`src/ui/`）未开始。Phase 1 的心跳循环、双向看门狗、单调时钟、墓碑修剪与候选端点扩散（摘要差异回目录、404 重 join）已实现；传输注入（丢包/分区）已用于 test。Phase 2 的持久化底座（`node:sqlite` task store、fs blob store + TTL GC、workgroup 根（agent cwd）与 `state/` 分离、任务 inputs 物化、流式 blob、重启恢复）已实现；HeadlessExecutor 已用假 `dsh` 验证协议映射，并在 Windows 本机用真实 `dsh` + 模型凭据跑通端到端（`scripts/e2e-headless.ts`：两个任务 `completed`、第二个复用 session）；AcpExecutor 已用假 ACP server 验证协议映射、权限挂起→grant→继续、取消与 session 复用/重启 `session/resume`，并在 Windows 本机用真实 `dsh --profile acp` + 模型凭据跑通端到端（`scripts/e2e-acp.mjs`：一个任务 `completed`、文本 `pong`）；`orca-node` CLI 的 send/status/wait/members/escalate/publish/log 与 ACP/headless 共享 preamble 已实现（`test/cli.test.ts` 10 条，`publish` 直写本机 SQLite、无 HTTP 登记路由，`send --file` 上传附件，`send --local-task` 登记自动上升）；跨进程 harness 已实现（`npm run harness`：两个真实进程、join、任务往返）；origin 侧任务日志已实现（`dispatches` 表、重启标 `unknown`、CLI `log`）。Phase 3 的审批回路第一版（grant 用 workgroup key 做 HMAC 签发/校验、`permission_request` 载荷、`pod_approve` 在 open turn 内调 DSH approval、批准/拒绝/篡改/过期/非 origin 测试）已实现；链式逐跳升级、收窄与自动上升已实现（`chain.ts` + `tasks.escalate` + origin 侧 child-link 轮询，`test/chain.test.ts`、`test/escalation.test.ts`、`test/relay-auto.test.ts`），`permission_mode`/`limits` 收窄仍未开始。

---
