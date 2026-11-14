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
    blobs.ts          内容寻址 blob store（内存 + fs，含 TTL GC）
    sqlite.ts         TaskStore 的 node:sqlite 实现（WAL，单进程写）
    workspace.ts      group 工作区目录：work/notes/inputs/.pod
    membership.ts     成员记录、心跳看门狗、墓碑与修剪
    gateway.ts        HTTP：/health、Agent Card、/cluster/*、/a2a、/blobs
    executor.ts       LocalExecutor 接口 + EchoExecutor
    headless.ts       HeadlessExecutor（dsh headless 子进程，一次性任务）
    acp.ts            AcpExecutor（dsh acp stdio：流式事件、权限挂起、session resume）
    process.ts        子进程公共件：命令解析（Windows shim）、killTree、abort 错误
    session-store.ts  `.pod/sessions.json` 读写（按 origin+context 绑 ACP/headless session）
    tasks.ts          单槽任务运行器
    orca_node.ts      组合根：一个进程 = 一个 orca node
    harness.ts        进程内多 orca node，测试用
    cli.ts            `orca-node` CLI：serve / send / status / wait / members
    plugin/           DSH bundle：Config、apply、pod_* 工具、后台 tracker、skill.ts（安装期技能注入）
  test/               vitest 套件（protocol/crypto/membership/mesh/a2a/blobs/plugin/tracker/skill/approval/watchdog）
```

当前代码状态：

| 模块 | 状态 | 说明 |
|---|---|---|
| `protocol.ts` | 已实现 | 类型、错误码、任务视图、orca_node_id、digest、签名规范化 |
| `crypto.ts` | 已实现 | HKDF、请求签名、nonce cache、grant 签名/校验 |
| `chain.ts` | 已实现 | 多跳元数据（hop/chain/root）校验、祖先禁调、child grant 派生（含 Echo relay 原型的下发） |
| `config.ts` | 已实现 | 配置校验、密钥派生、JSON 读写 |
| `storage.ts` / `blobs.ts` | 已实现 | PeerStore/TaskStore 接口 + 内存实现；blob 另有 fs 实现（内容寻址、临时文件+rename、TTL GC） |
| `sqlite.ts` | 已实现 | `node:sqlite` TaskStore：`<data_root>/tasks.db`、WAL、`synchronous=NORMAL`、整条记录 JSON 存储 |
| `workspace.ts` | 已实现 | `<data_root>/workgroups/<workgroup_id>/{work,notes,inputs,.pod}`，orca node 启动时创建一次 |
| `membership.ts` | 已实现 | 双向看门狗、单调时钟、suspect(unreachable)、墓碑与 record_ttl 修剪 |
| `gateway.ts` | 已实现 | `/health`、Agent Card、`/a2a`、`/cluster/*`、`/blobs`（上传/下载/直链） |
| `executor.ts` | 已实现 | `LocalExecutor` 事件流接口 + EchoExecutor；真实实现在 `headless.ts` / `acp.ts` |
| `headless.ts` | 已实现 | `dsh headless --json` 子进程、NDJSON→状态机、取消杀进程树、session 复用 |
| `acp.ts` | 已实现 | `dsh --profile acp` stdio（NDJSON JSON-RPC）：initialize/session/prompt/update/permission/cancel，权限挂起映射为 `input-required`，grant 回 allow-once |
| `process.ts` / `session-store.ts` | 已实现 | Windows `.cmd` shim 解析、进程树终止；`.pod/sessions.json` 原子读写 |
| `tasks.ts` | 已实现 | 单槽状态机；TaskStore 可注入（默认内存，CLI/插件用 SQLite），启动时把非终态标 `failed(node_restart)` |
| `orca_node.ts` | 已实现 | 组合根；启动/停止心跳循环，装配 PeerStore 门面与任务运行器 |
| `harness.ts` | 已实现 | `createMesh`、`joinRoster`（按目录 best-effort 加入）；mesh/A2A/discovery/formation/transport 测试 |
| `plugin/` | 部分实现 | `apply` 启动 orca node、注册 5 个 `pod_*` 工具（含 `pod_approve`）；后台 tracker 轮询终态并 `inject`/`followup`，权限请求强制唤醒；审批卡片已接线（reason 显示来源链）；安装期幂等写 user skill `orca-node/SKILL.md`；client bundle、credentials 读取未做 |
| `ui`（未建） | 未开始 | 将来仍放在同一包内（`src/ui/` 或独立包都可，发布物不增加依赖） |

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
session-store ← headless, acp   （只读写 .pod/sessions.json）
tasks     ← orca_node
orca_node ← harness, plugin
```

`gateway` 通过构造参数拿到 `TaskRunner` 接口实例，而不是 import executor 或具体实现——这是“gateway 能单独测”的前提。

`orca_node.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、`trustProxy`、错误处理都用它现成的，不手写 http server。

### 9.2 每个模块怎么测

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

实际跑通的测试：protocol 30 个、crypto 15 个、membership 5 个、mesh 1 个、a2a 7 个、blobs 8 个、blobs-fs 5 个、storage-sqlite 3 个、workspace 4 个、persistence 2 个、plugin 12 个、tracker 10 个、skill 3 个、approval 12 个、chain 13 个、headless 7 个、acp 7 个、cli 8 个、escalation 4 个、watchdog 2 个、discovery 2 个、formation 6 个、transport 4 个、permission-mode 8 个、acceptance 4 个，共 182 个（`npm test`）。gateway 与 executor 的行为由 `test/a2a.test.ts` 经真实 HTTP 覆盖，插件配置/工具注册契约由 `test/plugin.test.ts` 覆盖，orca node 重启后的持久化与恢复由 `test/persistence.test.ts` 覆盖。

### 9.3 进程内多 orca node

`orca_node.ts` 的 `createOrcaNode({ config })` 返回 handle：`start() / stop() / self() / members() / membersDigest() / join(peerUrl) / heartbeat(peerUrl) / sendTask(peerUrl, input) / getTask(peerUrl, id) / cancelTask(peerUrl, id)`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 目前有 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, fetch })`，返回 `{ orcaNodes, urls, stop() }`。它启动 orca node 后让每个 orca node join 第一个 orca node、用 `joinRoster` 按返回目录 best-effort 补 join，再对 bootstrap 发一轮心跳。
- 已支持：可注入时钟（`createOrcaNode({ clock })`）、可注入 transport（`createOrcaNode({ fetch })`，模拟丢包、延迟、单向阻断）、orca node 启停（`start()` / `stop()`）、进程内 mesh、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给（延迟 0.3–2.5 个间隔、丢包 30 个间隔、单向阻断 15 个间隔、全断 5 个间隔），不按绝对毫秒。
- 未支持：跨进程 harness；`waitFor` 仍是各测试文件内的本地 helper。
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

### 9.4 组合入口：库根在 `orca_node.ts`，安装根是整个包

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

### 9.5 工程约定

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

  `task` 支持 `--echo '<json>'` 传入自定义 Echo 脚本，`--auto-resume true` 在 `input-required` 后自动补发恢复消息。跨机时 `serve` 需加 `--endpoint http://<可达 IP>:<port>`，或直接改 config 里的 `endpoint`。

### 9.6 依赖选型：基础能力不自己写

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
| 限流（Phase 4） | `@fastify/rate-limit` | 代理后按 IP；现在不装 |
| SSE（Phase 4） | `fastify-sse-v2` | 只在做 `message/stream` 时引 |

**Phase 0 实际依赖**：运行时只有 `fastify`（在一个包里，随包发布）；开发依赖只有 `typescript`、`vitest`、`@types/node`。表中的 `zod`、`pino`、`lowdb`、`better-sqlite3`、`commander`、`tsup`、`biome` 等是目标选型，尚未安装。

明确不引的：认证/签名框架（没有比 30 行 Node `crypto` 更合适的）、DI 容器、ORM、消息队列、服务网格。集群只有十台机器，这些是负资产。

### 9.7 与路线图的对应

- Phase 0：单包内 protocol、crypto、config、storage、gateway、executor(echo)、tasks、orca_node、harness、plugin。
- Phase 1：harness 覆盖成员收敛与故障场景（vitest 用例）。
- Phase 2：持久化底座（SQLite task store、fs blob + GC、group 工作区与 cwd 绑定）、HeadlessExecutor、AcpExecutor。
- Phase 3：plugin 的审批卡片、权限。
- Phase 4：10 个 orca node 压测复用 harness。

**实际状态**：protocol、crypto、config、storage（内存 + SQLite/fs）、workspace、gateway（含 blob 路由）、tasks、orca_node、harness、plugin（含后台 tracker/唤醒）、executor（Echo + Headless + ACP）已实现；InProcess executor、ui 未开始。Phase 1 的心跳循环、双向看门狗、单调时钟、墓碑修剪与候选端点扩散（摘要差异回目录、404 重 join）已实现；传输注入（丢包/分区）已用于 test。Phase 2 的持久化底座（`node:sqlite` task store、fs blob store + TTL GC、group 工作区与 `work/` cwd 绑定、重启恢复）已实现；HeadlessExecutor 已用假 `dsh` 验证协议映射，并在 Windows 本机用真实 `dsh` + 模型凭据跑通端到端（`scripts/e2e-headless.ts`：两个任务 `completed`、第二个复用 session）；AcpExecutor 已用假 ACP server 验证协议映射、权限挂起→grant→继续、取消与 session 复用/重启 `session/resume`，并在 Windows 本机用真实 `dsh --profile acp` + 模型凭据跑通端到端（`scripts/e2e-acp.mjs`：一个任务 `completed`、文本 `pong`）；`orca-node` CLI 的 send/status/wait/members 与 ACP prompt preamble 已实现（`test/cli.test.ts` 7 条）；跨进程 harness 未开始。Phase 3 的审批回路第一版（grant 用 workgroup key 做 HMAC 签发/校验、`permission_request` 载荷、`pod_approve` 在 open turn 内调 DSH approval、批准/拒绝/篡改/过期/非 origin 测试）已实现；链式逐跳升级与收窄未开始。

---
