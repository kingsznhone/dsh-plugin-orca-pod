# 09 实现

> 本章给出模块划分、DSH 组合入口、面板、测试夹具与工程约定。

## 9. 实现

### 9.1 单包内的模块划分

整个项目**就是一个 npm 包**（仓库根目录）。DSH 插件规范就是一个 npm 包（`package.json` + `dsh.bundle.patch`），拆成多个私有包会让安装物不自包含：内部依赖在仓库外解析不到。因此用目录和 import 纪律维持模块边界，不再用包边界。

```text
orca-pod/
  package.json        唯一运行时依赖 fastify；dsh.bundle.patch -> cordis.patch.yml
  cordis.patch.yml    DSH 行：id orca-pod、name 'orca-pod'
  client.js           DSH 客户端 bundle（面板）
  biome.json          lint + format（一个工具）
  src/                见下表
  scripts/            cross.ts、harness_run.ts、e2e-acp.mjs、sync-guest.ps1
  skills/orca-node/   标准 skill bundle（SKILL.md + references/add-machine.md）
  test/               vitest，按模块一份 *.test.ts；test/fixtures/fake-acp.mjs 是假 ACP server
```

| 模块                                           | 职责                                                                                         |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `protocol.ts`                                  | 线上类型、id/digest、权限模式、任务视图（叶子模块）                                          |
| `errors.ts`                                    | `PodError` 与错误码 → HTTP 状态表（唯一一张）                                                |
| `identity.ts` / `crypto.ts`                    | Ed25519 身份；请求签名、准入证明、nonce、grant 与直链签名、scrypt 派生                       |
| `settings.ts` / `config.ts`                    | **唯一的设置字段表与解析器**（`config.json`、插件 `Config`、面板覆盖、install、CLI 都走它）；`config.json` 读写（身份 + 派生密钥，0600） |
| `membership.ts` / `mesh.ts`                    | 成员记录与看门狗；join、心跳循环、leave、自述记录与模型目录                                  |
| `peer_client.ts`                               | **唯一的出站客户端**：签名、超时、响应上限；陌生 URL 抛 `unknown_peer`，不隐式 join          |
| `delegation.ts`                                | 发起侧：`sendTask`/`getTask`/`cancelTask`/审批/上交、派发日志、child-link 轮询               |
| `gateway/`                                     | `index`（装配、body 解析）、`auth`（`access` 声明与唯一的 preValidation 钩子）、`error_handler`（唯一的错误出口）、`cluster_routes`、`a2a_routes`、`blob_routes` |
| `tasks.ts` / `task_record.ts` / `task_meta.ts` | 单槽运行器与查找；一个任务的状态机与计时器；元数据一次性解析                                 |
| `task_inputs.ts` / `grants.ts` / `chain.ts`    | 任务书（可信前言在前、远端文本在最后的不可信块）与输入物化；grant 解析与校验；子任务元数据与 grant 转发 |
| `executor.ts` / `echo.ts` / `acp/`             | 执行器契约；Echo；ACP（`connection` 按 sessionId 路由、`session` 绑定、`permissions` 自动应答、`executor`） |
| `workspace.ts` / `session_store.ts` / `process.ts` | 工作区与配额测量；`sessions.json`；子进程公共件（Windows shim、杀进程树）                |
| `storage.ts` / `sqlite.ts` / `blobs.ts` / `blob_files.ts` / `dispatches.ts` | task store 接口 + 内存实现；`node:sqlite` 实现（tasks/dispatches/file_blobs）；blob store（内存 + fs，含配额与 GC）；`publish` 的文件映射；origin 派发日志 |
| `events.ts` / `net.ts`                         | 进程内事件总线（task / members / dispatch）；候选端点筛查、端口、回环判定、地址归一化       |
| `orca_node.ts`                                 | **组合根**：一个进程 = 一个 orca node；只装配，不含业务逻辑                                  |
| `harness.ts`                                   | 测试用进程内多 orca node（`createMesh`、`connectAll`、`waitFor`）                            |
| `cli.ts` / `orca_pod.ts` / `install.ts`        | `orca-node` CLI；`orca-pod install`；install 计划与 systemd unit 渲染                        |
| `plugin/`                                      | DSH bundle，见 §9.5                                                                          |

模块依赖方向单向，禁止反向（靠 review 与 import 检查，不靠包边界）：

```text
protocol, errors, identity          叶子
crypto                              ← peer_client, gateway, grants, delegation
settings                            ← config, cli, install, plugin
membership                          ← mesh, delegation, gateway（gateway 只见 PeerStore 门面）
peer_client                         ← mesh, delegation, cli
executor（接口）                    ← echo, acp, tasks
gateway                             ← orca_node（只依赖 protocol/crypto/接口，不 import tasks 或执行器实现）
mesh, delegation, tasks, acp        ← orca_node
orca_node                           ← harness, cli, plugin, scripts
```

`gateway` 通过构造参数拿到 `TaskRunner` 接口实例，而不是 import 执行器或任务实现——这是“gateway 能单独测”的前提。`orca_node.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、schema 校验、错误处理都用它现成的，不手写 http server。**每条路由必须声明 `config.access`**（`public|join|member|link|local`），缺了启动即失败；验签与授权只在一个钩子里做；错误只从一个错误处理器出去。

### 9.2 面板

面板需要的每个数字都从 Host 侧同步取到，而不是先让模型调一次工具再转述。库根暴露四个只读入口，插件再把它们打包成 `PodAdmin`：

| 入口                      | 位置                         | 内容                                                                                 |
| ------------------------- | ---------------------------- | ------------------------------------------------------------------------------------ |
| `listTasks(limit?)`       | `orca_node.ts`               | 本机任务（inbound），内存记录在前，持久 store 回填历史                               |
| `subscribe(listener)`     | `orca_node.ts` → `events.ts` | `task`（每次状态/权限变化）、`members`（名单、state、busy、endpoints、模型目录变化，按签名去重）、`dispatch`（origin 侧派发落库） |
| `blobLink(blobId, ttlS?)` | `orca_node.ts`               | 签名直链（`?exp&sig`），默认 300 秒，面板直接 `<a href>` 下载产物                    |
| `workspacePaths()`        | `orca_node.ts`               | workgroup 根、`notes/`、`inputs/`、`state/` 路径                                     |

`createPodAdmin(handle, tracker, broker)` 组合出面板 API：`self()`、`members()`（不含 offline）、`recent(limit)`（本机任务与派发到 peer 的任务合并）、`approvals()`（broker 与 tracker 里挂着的权限请求）、`task(peer, id)`、`approve/deny/cancel`、`workspace()`（路径 + notes 文件名 + 最近的 inputs 目录）、`config()`（去敏视图，**永不返回密码**，只给 `password_set`）、`saveConfig(patch)`、`connect(peer)`、`disconnect()`、`reset()`、`subscribe()`。审批只有一个 `ApprovalBroker`（`plugin/broker.ts`）：tracker 把看到的权限请求 park 进去，UI 三个落点读它、答复它，答复直接调 `OrcaNode.approveTask/denyTask`（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

**UI 改配置与连接 peer**（`plugin/lifecycle.ts`）：

- 有效配置 = bundle 配置 + `<data_root>/ui-config.json` 覆盖层；覆盖层只含设置字段表里标了 `panel` 的字段加 `setup_complete`；`null` 表示清除该字段、回到默认。覆盖层不改 profile 的 `cordis.patch.yml`，只由回环闸门后的面板路由写入。
- **启动门禁**：`setup_complete` 不是 `true`，或 `workgroup_id`/密码为空时，节点保持空闲（不启动、不监听、不报错），首屏是向导；向导填好后 `saveConfig` → `reconfigure` 才启动。换 `workgroup_id` 时省略密码沿用当前密码；显式传空串被拒绝。
- `reconfigure`：合并覆盖层、复验、写盘，串行地停掉旧节点、用新配置重启；节点身份（`identity.json`、`config.json`）不变。生命周期操作走一条串行队列，一次失败不会堵住后面的。
- `connect(peer)`：地址先归一化（裸 host/IP 补 `http://` 与默认端口 `11811`；`host:port`；完整 URL；裸 IPv6 加方括号；拒绝带路径/查询串），立即 `join` 一次，成功才把 peer 记进覆盖层（不重启）；失败只回错误、不落盘。`orca_pod` 工具的 `connect` 方法走同一条路径。
- `disconnect()`：`OrcaNode.leave()` 通知已知 peer，再清空本地 peers 并落盘。`reset()`：删除 `ui-config.json`、`config.json`、`identity.json`，节点回到首启向导（不动 `state/`、blob、工作区）。
- 设置视图的“高级设置”：任务超时、审批等待超时、结果简报上限、单任务输入文件数与大小、工作区与 blob 存储配额、公网/回环候选端点、本机权限上限、默认 reasoning effort、执行器。

#### 9.2.1 同源桥（`plugin/web.ts`）

第三方 bundle 不能 import Host 包，所以面板不声明 RPC，而是在已经运行的 DSH web 服务上注册一条同源前缀路由：

| 路由                                    | 方法       | 内容                                                                                                                  |
| --------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `/orca-api/state`                       | GET        | 一次轮询拿全量：`self`、`config`、`members`、`mesh`、`approvals`、`approval_count`、`recent`（最近 5 条）、`workspace` |
| `/orca-api/task?peer=&task=`            | GET        | 单任务详情（任务视图、origin 标签、派发日志条目、产物直链、本任务 inputs 文件名）                                     |
| `/orca-api/tasks?limit=`                | GET        | `{recent}`：全部任务视图（`limit` 默认 500、钳 1–1000）                                                               |
| `/orca-api/config`                      | POST       | `saveConfig`：写覆盖层并重启节点                                                                                      |
| `/orca-api/connect` / `disconnect` / `reset` | POST  | `{peer}` / `{}` / `{}`                                                                                                |
| `/orca-api/approve` / `deny` / `cancel` | POST       | `{peer, task_id, reason?}`，直接调 `PodAdmin`，不经模型                                                               |

注册走 `ctx.inject(['webServer'], …)`；没有 web 服务的宿主（ACP/CLI）直接跳过，不影响启动。路由闸门依次是：**回环**（`socket.remoteAddress` 是回环且没有 `x-forwarded-for`/`forwarded`/`x-real-ip`，否则 403 `local_only`）；**同源**（CSRF / DNS rebinding：`Host` 只接受 `localhost`/`127.0.0.1`/`[::1]`，带 `Origin` 时必须与 `Host` 同源，带 `Sec-Fetch-Site` 时必须 `same-origin`，每个请求必须带 `X-Orca-Pod: 1` 自定义头，否则 403 `cross_origin`）；写请求必须 `Content-Type: application/json`（否则 403 `json_required`）。因此面板不会因为反向代理或多网卡把审批面暴露出去，也不能被别的网页跨站驱动。

#### 9.2.2 客户端 bundle（`client.js`）

包根 `client.js` 是 DSH 客户端 lazy-CJS 工厂（`window.__ModuleLoader__.load({id:"orca-pod", …})`），返回 `{inject:["slots","locale"], apply}`；`apply` 注册五个 Slot：

| Slot                      | id                        | 作用                                                                                          |
| ------------------------- | ------------------------- | --------------------------------------------------------------------------------------------- |
| `settings.section`        | `orca-pod`                | 设置页里的一页面板                                                                            |
| `sidebar.footer.action`   | `orca-pod`                | 侧边栏底部按钮，同时是状态灯：有挂起审批为橙黄、有在线成员为绿、未连接为灰                    |
| `shell.overlay`           | `orca-pod.panel`          | 居中模态浮层，点侧边栏按钮打开，Esc/遮罩/× 关闭                                               |
| `conversation.input.dock` | `orca-pod.approval-dock`  | **当前会话**里的审批聊天卡（按任务的发起会话 id 匹配）：允许/拒绝/在面板中处理                |
| `shell.overlay`           | `orca-pod.approval-popup` | **后台会话**的审批弹窗（不受当前会话过滤）                                                    |

设置页与浮层共用同一份 `Panel`，按状态分三视图：未完成设置时是**首启向导**（workgroup、必填密码、显示名、监听地址、本地节点地址）；之后第一屏是**集群状态**（自身、成员、待审批、最近任务、工作区），右上进入**设置视图**，另有**连接/断开**。整个客户端**只有一个共享 store 与一个轮询器**：每 2s `fetch('/orca-api/state')`，所有 slot 组件读同一份快照；审批与取消按钮直接 POST；文案跟随 DSH 桌面语言（中/英）；样式只用内联对象与 `--dsw-alias-*` 主题 token；卸载时清理定时器。

清单接线：`package.json` 的 `exports["./client"] = "./client.js"`、`dsh.client = {platform:"web", immediately:true}`、`files` 含 `client.js`。

### 9.3 每个模块怎么测

约定：每个模块有自己的夹具测试，进程内测试不依赖网络和真实时钟；`npm run check`（`biome check . && tsc --noEmit && vitest run`）是唯一的验收入口。

| 模块                              | 夹具                                                              | 断言                                                                                   |
| --------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `protocol.ts` / `settings.ts`     | 固定 JSON 样本                                                    | schema 通过/拒绝、错误信息指向具体字段                                                 |
| `crypto.ts`                       | 冻结的签名样本                                                    | 换密钥/时间/body/查询串/接收方 id 任一字节即变；重启前签发的请求被 `stale_request` 拒绝 |
| `chain.ts` / `grants.ts`          | 纯函数 + 多 orca node 真实 HTTP                                   | 祖先禁调、grant 校验/转发/过期/重放/工具不符                                           |
| `storage.ts` / `blobs.ts` / `sqlite.ts` | 一套 contract test，跑内存、fs 与 sqlite                    | 实现行为一致；过期/GC/去重/配额；关闭重开仍在                                          |
| `workspace.ts`                    | 临时目录                                                          | 目录一次创建、`inputDir` 拒绝路径穿越、用量测量                                        |
| `gateway/`                        | 进程内真实 HTTP，假 executor、注入时钟                            | 路由、401/403/429/507、签名与成员闸门                                                  |
| `executor.ts` / `echo.ts`         | echo 脚本样本                                                     | 状态时序、`input-required`、resume                                                     |
| `acp/`                            | 假 ACP server（`test/fixtures/fake-acp.mjs`）                     | 完成文本、cwd、权限挂起→grant→继续、`session/cancel`、session 复用与 resume、崩溃后重建连接 |
| `tasks.ts`                        | 假 executor + 注入时钟                                            | 单槽、TTL、取消、重启恢复                                                              |
| `harness.ts`                      | 多 orca node mesh + 可注入时钟/传输                               | 成员收敛、故障、任务往返                                                               |
| `install.ts`                      | 临时目录 + 注入 `CommandRunner`                                   | systemd plan 与引号、`dsh --version` 检查、配置只生成一次且 0600、`--dry-run` 不执行   |
| `plugin/`                         | 假 DSH host                                                       | 工具注册、tracker 投递与退避、broker、面板路由闸门、配置覆盖层与生命周期               |

### 9.4 进程内多 orca node

`orca_node.ts` 的 `createOrcaNode({ config })` 返回 handle：`start()`/`stop()`、`self()`/`members()`/`membersDigest()`、`join`/`heartbeat`/`leave`、`sendTask`/`getTask`/`cancelTask`/`approveTask`/`denyTask`/`escalateTask`、`listDispatches`、`listTasks`、`subscribe`、`blobLink`、`workspacePaths`、`setModelCatalog`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 的 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, approvalTimeoutS, fetch })` 返回 `{ orcaNodes, urls, stop() }`：启动后让每个 orca node join 第一个、用 `joinRoster` 按返回目录补 join，再对 bootstrap 发一轮心跳。手工拼节点的测试用 `connectAll` 互相 join（出站调用只到成员，陌生 URL 是 `unknown_peer`）。
- 可注入时钟（`createOrcaNode({ clock })`）、可注入 transport（`createOrcaNode({ fetch })`，模拟丢包、延迟、单向阻断）、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给，不按绝对毫秒。
- 跨进程：`npm run harness`（`scripts/harness_run.ts`）起两个真实 `orca-node serve` 子进程（第二个用 `serve --peer <url1>` 在启动时 join），用 CLI 观察 members 收敛、派一个 Echo 任务并等到终态，最后清理临时数据根；退出码即结果。
- `waitFor(probe, done, { timeoutMs, intervalMs, label })` 从 `src/harness.ts` 导出，进程内与真实进程 smoke 共用；场景用 vitest 的普通 async 函数写，不引入第二套场景描述语言。

```ts
const mesh = await createMesh({ orcaNodes: 3, password: "test" });
const [origin] = mesh.orcaNodes;
const task = await origin.sendTask(mesh.urls[1], {
  message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
  metadata: { echo: { final: { state: "completed", text: "hi" } } },
});
// 轮询 getTask 直到终态；真实断言见 test/a2a.test.ts
```

### 9.5 组合入口：库根在 `orca_node.ts`，安装根是整个包

“组合根”有两层，别混：

| 层     | 文件                                          | 谁调用它                           | 职责                                                                                                  |
| ------ | --------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 库根   | `src/orca_node.ts` → `createOrcaNode(config)` | harness、plugin、`orca-node serve` | 装配一个 orca node：存储 → 任务运行器 → workgroup/delegation → gateway。不读 argv、不读 DSH             |
| 安装根 | 仓库根目录本身（bundle 名 `orca-pod`）        | DSH 的 Loader                      | `apply(ctx, config)` 里创建 orca node、注册工具/面板路由，cleanup 里 `stop()`                         |

DSH 加载一个 bundle 靠包清单里的 `dsh.bundle.patch` 行，不是 `main`：

```text
package.json       "exports": { ".": "./src/index.ts", "./testing": "./src/harness.ts", "./client": "./client.js", … }
                   "dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true } }
cordis.patch.yml   - insert: { id: orca-pod, name: 'orca-pod', config: { port: 11811, peers: [] } }
src/index.ts       export { Config, apply, inject } from './plugin/index.ts' + 库导出（createOrcaNode 等）
src/plugin/        index / lifecycle / broker / tracker / tools / admin / web / models / skill / config / dsh / util
```

`src/plugin/` 各文件：`index.ts` 是 `apply` 与导出；`lifecycle.ts` 管 orca node 的启停与覆盖层；`broker.ts` 是审批注册表；`tracker.ts` 是后台跟踪与投递；`tools.ts` 是唯一的 `orca_pod` 工具；`admin.ts` / `web.ts` 是面板数据面与同源路由；`models.ts` 从 Host 采集模型目录；`skill.ts` 可选地把 skill bundle 复制到 user 根；`config.ts` 是 Standard Schema 外壳（校验就是 `settings.ts` 的解析器）；`dsh.ts` 是最小 DSH 类型；`util.ts` 是小工具。

`apply` 只做几件事，其余都靠注入：

```ts
export function apply(ctx, config) {
  const handle = createPodRuntime(ctx, config); // 非阻塞启动，失败只记日志/状态
  const broker = createApprovalBroker(node);
  const tracker = createTracker(node, broker, ctx.logger);
  // 宿主重启：按派发日志恢复仍在宿主里的会话的追踪
  // 用户发新消息（agent/inbox/claimed, source.kind === "user"）→ tracker.resetWakes(agent.id)
  ctx.effect(() => async () => { broker.clear(); tracker.stop(); await stopPod(handle, ctx.logger); }, "orca-pod.orca-node");
  for (const tool of createPodTools(handle, tracker, permissionPresets)) ctx.tools.register(tool);
  registerPodWeb(ctx, createPodAdmin(handle, tracker, broker));
  if (config.skill_injection) void installSkill(); // 默认关
}
```

约束：

- `apply` 必须快速返回：`start()` 异步，端口占用等问题写日志与状态页，不能让 DSH 启动卡在网络监听上；工具在调用时才 `await handle.ready`。
- 进程内嵌、不开子进程（ACP 子进程由执行器管）；DSH 退出 → cleanup → listener 关闭、ACP 子进程退出。
- 唯一的工具 `orca_pod`（`method` 分派 `send`/`status`/`cancel`/`members`/`connect`，没有 approve）；工具注册用 `inject: ['tools']`。
- 口令目前明文放在插件配置或面板覆盖层里（[§7.1](07-security.md#71-workgroup-与密码)），不走 DSH credentials（[§11](11-open-questions.md#11-未决问题)“口令与配置的存放”）。

CLI 入口：包内 bin `orca-node`（`src/cli.ts`）有 `serve` 与客户端子命令 `send`/`status`/`wait`/`escalate`/`publish`/`log`/`members`——`serve` 加载配置 → `createOrcaNode` → `start()`（`--peer` 启动即 join，`--bind`/`--port` 一次性覆盖）；客户端子命令读同一份 `config.json`（`--config` 或 `--data-root`），用本 orca node 身份签 `Pod` 头，经 `peer_client.ts` 打本机或成员的 `/a2a`；`--text -` 从 stdin 读任务文本，`--json` 输出结构化结果，`wait` 的退出码 0/1/2/3 分别表示终态成功/失败/仍在跑/需权限，`escalate` 的 0/1/2 表示已批准/被拒绝/超时。`orca-pod install` 见 §9.6。`scripts/cross.ts` 提供 serve/join/task/blob 跨进程、跨机联调命令；`scripts/sync-guest.ps1` 把当前提交（`git archive HEAD` + `scp`）同步到 Hyper-V guest 并在远端 `npm install`，保证跨机验证的两端代码一致（只同步已提交内容）。两者都复用同一个 `createOrcaNode`，不依赖 DSH。

一句话：**装进 DSH desktop 的东西 = `orca-pod` 这一个包；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是 `createOrcaNode()`。**

### 9.6 工程约定

- TypeScript、ESM、Node ≥ 24（用内置 `node:sqlite` 与类型剥离，源码直接以 `.ts` 发布）；npm（单包，`npm install` 在仓库根目录一次装齐）；vitest；biome（lint + format，`biome.json` 在根目录）；`tsc --noEmit`。
- **验收入口：`npm run check`** = `biome check . && tsc --noEmit && vitest run`。另有 `npm run format`、`npm run typecheck`、`npm test`、`npm run harness`。
- 不引入框架级 DI 容器：构造函数注入足够，装配只在 `orca_node.ts`。
- 存储：task store 用 `node:sqlite`（`<data_root>/tasks.db`，WAL，单进程写；不引 ORM）；成员表是内存；blob 用内容寻址的 fs 目录 + GC；工作区目录由 `workspace.ts` 管理。内存实现只给单测与 harness 用（[§5.5](05-tasks.md#55-任务存储)）。
- 本地联调命令：

  ```bash
  npm run check
  node scripts/cross.ts serve --workgroup orca-dev --password change-me
  node scripts/cross.ts join --peer http://127.0.0.1:11811 --workgroup orca-dev --password change-me
  node scripts/cross.ts task --config <config.json> --peer http://127.0.0.1:11811 --text hello
  ```

  `task` 支持 `--echo '<json>'` 传入自定义 Echo 脚本；`--auto-resume` 是布尔开关，`input-required` 后自动补发恢复消息。跨机时把可达地址写进 config 的 `endpoints`（有序列表，可再加公网 URL）；`serve` 不会覆盖显式配置。

- `orca-pod install`：检查 `dsh --version`，生成 `<data_root>/config.json`（0600、`executor: "acp"`），写 systemd unit 并 `daemon-reload` + `enable --now`；unit 常驻 `orca-node serve`。裸 `install` 或只带 `--dry-run` 是交互式向导（workgroup id、密码隐藏输入、监听地址、端口）；**带任何其他参数即进入参数分支、完全不提问**（缺 workgroup/密码直接报错退出，适合 agent 通过 SSH 调用；密码用 `-p`/`--password`，程序不读 stdin）。`--peer`/`--endpoint`/`--env-file`/`--env` 可重复，`--system` 装系统级、默认用户级，`--skip-dsh-check` 跳过检查，`--force` 重写，`--no-start` 只写不启动。命令不提供 web 模式——要面板的用户自己装 dsh 再从 Web UI 装插件。

### 9.7 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、CLI、原子写这类“基础功能”直接用成熟包或 Node 内置；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、grant、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 依赖                                  | 类别 | 理由                                                                                                |
| ------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- |
| `fastify`                             | 运行时 | 路由、body 解析与限额、schema 校验、错误处理；不手写 http server。**唯一的运行时依赖**             |
| `typescript`                          | 开发 | 类型检查（`tsc --noEmit`），源码不编译、直接以 `.ts` 发布                                           |
| `vitest`                              | 开发 | 测试                                                                                                |
| `@types/node`                         | 开发 | Node 类型                                                                                           |
| `@biomejs/biome`                      | 开发 | lint + format，一个工具                                                                             |

其余能力都用 Node 内置：`node:crypto`（Ed25519、scrypt、HMAC）、`node:sqlite`、全局 `fetch`、`node:util` 的 `parseArgs`、`node:fs`、`node:stream`。不引 zod、pino、commander、ORM、DI 容器、消息队列：集群只有十台机器，这些是负资产；也没有比 `node:crypto` 里几十行更合适的认证/签名框架。

---
