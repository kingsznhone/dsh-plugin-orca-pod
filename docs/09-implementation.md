# 09 实现

> 本章给出仓库结构、测试夹具、DSH 组合入口与工程约定。

## 9. 实现

### 9.1 包划分

```text
packages/
  protocol/    类型 + schema + 签名规范化 + 错误码（零依赖）
  crypto/      HKDF、请求签名
  config/      schema、默认值、加载、环境覆盖
  storage/     接口 + 实现（fs / sqlite）+ GC
  gateway/     HTTP 路由、鉴权、槽位、心跳、成员表
  executor/    LocalExecutor 接口 + EchoExecutor + AcpExecutor
  orca_node/   组合根：一个进程 = 一个节点
  harness/     进程内多节点 + 场景 DSL + CLI
  ui/          与框架无关的 view-model + 组件
  dsh-plugin/  DSH 适配：工具、审批卡片、状态页
```

当前代码状态（Phase 0）：

| 包 | 状态 | 说明 |
|---|---|---|
| `protocol` | 已实现 | 类型、错误码、任务视图、node_id、digest、签名规范化 |
| `crypto` | 已实现 | HKDF、请求签名、nonce cache |
| `config` | 已实现 | 配置校验、密钥派生、JSON 读写 |
| `storage` | 部分实现 | 内存 `PeerStore` / `BlobStore`；fs、SQLite、GC 未实现 |
| `gateway` | 已实现 | `/health`、Agent Card、`/a2a`、`/cluster/*`、`/blobs`（上传/下载/直链） |
| `executor` | 部分实现 | EchoExecutor；ACP、Headless、InProcess 未实现 |
| `orca_node` | 已实现 | 组合根；task store 为进程内内存，无后台心跳与看门狗 |
| `harness` | 已实现 | `createMesh` + mesh/A2A 测试；场景 DSL 未实现 |
| `ui` | 未实现 | 占位包 |
| `dsh-plugin` | 部分实现 | `@orca/pod` host bundle：`apply` 启动节点、注册 4 个 `pod_*` 工具；client bundle、审批卡片、credentials 读取未做 |

“已实现”指当前可运行、有测试或用例覆盖；未列出的目标能力属于后续里程碑。

依赖方向单向，禁止反向：

```text
protocol  ← crypto, config, storage, gateway, executor, ui
crypto    ← gateway, orca_node
storage   ← gateway, executor, orca_node
gateway   ← orca_node  （gateway 只依赖 protocol + storage 接口，不 import executor 实现）
executor  ← orca_node
orca_node ← harness, dsh-plugin
ui        ← dsh-plugin
```

`gateway` 通过构造参数拿到 `TaskRunner` 接口实例，而不是 import executor 或具体实现——这是“gateway 能单独测”的前提。

包名刻意避开 `node`：`orca_node` 是“orca 的节点”，跟 Node.js 运行时没有关系，import 时也不容易看错。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、`trustProxy`、错误处理都用它现成的，不手写 http server。

### 9.2 每个模块怎么测

| 模块 | 夹具 | 断言 |
|---|---|---|
| protocol | 固定 JSON 样本 + 签名向量 | schema 通过/拒绝、MAC 与向量一致 |
| crypto | RFC 5869 向量 + 冻结的 MAC | 换密钥/时间/body 任一字节即变 |
| config | 合法/非法配置样本 | 错误信息指向具体字段 |
| storage | 一套 contract test，跑 fs 与 sqlite | 两实现行为一致 |
| gateway | 进程内 `fetch`，假 executor、注入时钟 | 路由、401/403/429、签名 |
| executor | echo 脚本样本；假 ACP 子进程 | 状态时序、`input-required`、resume |
| harness | 场景 DSL | 成员收敛、任务往返 |
| ui | view-model 纯函数 | 忙闲、任务列表的渲染数据 |
| dsh-plugin | 假 DSH host 的 smoke | 工具注册、生命周期 |

Phase 0 实际跑通的测试：protocol 30 个、crypto 15 个、harness mesh 1 个、harness a2a 7 个、gateway blobs 8 个、dsh-plugin 12 个，共 73 个（`npm test`）。storage、executor、ui 还没有独立夹具；gateway 与 executor 的行为由 `packages/harness/test/a2a.test.ts` 经真实 HTTP 覆盖，插件配置/工具注册契约由 `packages/dsh-plugin/test/plugin.test.ts` 覆盖。

### 9.3 进程内多节点

`orca_node` 的 `createNode({ config })` 返回 handle：`start() / stop() / self() / members() / membersDigest() / join(peerUrl) / heartbeat(peerUrl) / sendTask(peerUrl, input) / getTask(peerUrl, id) / cancelTask(peerUrl, id)`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 目前只有 `createMesh({ nodes, workgroupId, password, basePort, displayNamePrefix, dataRoot })`，返回 `{ nodes, urls, stop() }`。它启动节点后让每个节点 join 第一个节点、按返回目录逐条补 join，再对 bootstrap 发一轮心跳。
- 注入时钟、日志 ring buffer、场景 DSL（`until` / `assertTaskState`）尚未实现；后台心跳与看门狗也没有，测试直接轮询 `getTask`。

```ts
const mesh = await createMesh({ nodes: 3, password: "test" });
const [origin] = mesh.nodes;
const targetUrl = mesh.urls[1];
const task = await origin.sendTask(targetUrl, {
  message: { role: "user", parts: [{ kind: "text", text: "hi" }] },
  metadata: { echo: { final: { state: "completed", text: "hi" } } },
});
// 轮询 tasks/get 直到终态；真实断言见 packages/harness/test/a2a.test.ts
```

### 9.4 组合入口：库根在 `orca_node`，安装根在 `dsh-plugin`

“组合根”有两层，别混：

| 层 | 文件 | 谁调用它 | 职责 |
|---|---|---|---|
| 库根 | `packages/orca_node/src/index.ts` → `createNode(config)` | harness、dsh-plugin、将来的独立服务 | 装配一个节点：config → storage → gateway → executor。不读 argv、不读 DSH |
| 安装根 | `packages/dsh-plugin/`（bundle `@orca/pod`） | DSH 的 Loader | `apply(ctx, config)` 里 createNode、注册工具/审批/UI，cleanup 里 `stop()` |

DSH 加载一个 bundle 靠包清单里的 patch 行，不是 `main`：

```text
packages/dsh-plugin/
  package.json       "exports": { ".": "./index.js", "./client": "./client.js" },
                     "dsh": { "bundle": { "patch": "./cordis.patch.yml" },
                              "client": { "platform": "web", "immediately": true } }
  cordis.patch.yml   - insert: { id: orca-pod, name: '@orca/pod' }          # Host 行
                     - insert: { id: orca-pod-client, name: '@orca/pod/client' }  # Client 行
  index.js           export const inject = ['tools']
                     export const Config = ...
                     export function apply(ctx, config) { ... }
  client.js          UI（状态页、审批视图），只消费 view-model
  locale/{en,zh}.json  meta.title / meta.description / meta.detail
```

`apply` 只做四件事，其余都靠注入：

```ts
export function apply(ctx, config) {
  const node = createNode({
    workgroupId: config.workgroup_id,
    displayName: config.display_name,
    port: config.port,                        // 默认 0：系统分配，启动后写回 config
    dataRoot: config.data_root ?? defaultDataRoot(),
    password: () => ctx.credentials.readRecord('orca-pod'),  // 签名时取，不缓存
  })
  ctx.effect(() => () => node.stop())
  void node.start().catch(err => ctx.logger.error(err))
  for (const tool of podTools(node)) ctx.tools.register(tool)
}
```

三条约束：

- `apply` 必须快速返回：`start()` 异步，端口占用/证书问题写日志与状态页，不能让 DSH 启动卡在网络监听上。
- 配置分两类：`workgroup_id` / `port` / `display_name` 走普通 config（Plugin manager 可改，`configEditor.edit` 持久化）；**密码进 `ctx.credentials` 记录，不进 config**，也不写进 bundle patch。
- 进程内嵌、不开子进程；DSH 退出 → cleanup → listener 关闭。工具注册用 `inject: ['tools']`；审批走 DSH 的 approval/卡片（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)），插件只把 `permission_request` 转成卡片数据、把人的操作回成后续 message。

harness / CLI 是第三个入口：`packages/orca_node` 提供 bin `orca-node`，目前只有 `orca-node serve --config <path>`（加载配置 → `createNode` → `start()` → 打印监听地址）；`scripts/cross.ts` 提供 serve/join/task 三个跨进程、跨机联调命令。两者都复用同一个 `createNode`，不依赖 DSH。`--nodes` / `--scenario` 这类 harness CLI 尚未实现。

一句话：**装进 DSH desktop 的东西 = `dsh-plugin` 这个 bundle；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是 `createNode()`。**

**Phase 0 现状**：库根 `createNode` 与安装根 `dsh-plugin` 都已可用。`@orca/pod` bundle 有 `cordis.patch.yml`、`Config`（Standard Schema）、`apply(ctx, config)`：非阻塞启动节点、`ctx.effect` 清理、注册 `pod_send`/`pod_status`/`pod_cancel`/`pod_members` 四个不阻塞工具；已用 DSH 自带 Node 运行时做过两节点 smoke（join、send、status、cancel、重启后 node_id 不变）。未做：client bundle/locale、审批卡片接线、`ctx.credentials` 读取（原型阶段密码暂放配置）、后台 tracker 与 `inject`/`followup` 唤醒（[§5.2](05-tasks.md#轮询归-host不归-agent)）。

### 9.5 工程约定

- TypeScript、ESM、Node ≥ 22（开发机为 26 LTS）；npm workspaces（不用 pnpm）；vitest；`tsc --noEmit` 进 CI。
- 构建/开发的目标选型是 `tsup` + `tsx` + `biome` + `commander` + `pino`；Phase 0 尚未安装，仓库目前只有 `typescript`、`vitest`、`@types/node`。
- 不引入框架级 DI 容器：构造函数注入足够，装配只在 `orca_node` 包。
- 存储目标：默认 fs（`lowdb` + `steno` 原子写），SQLite 用 `better-sqlite3`（或 `node:sqlite`）作为后续里程碑；Phase 0 只有内存实现（[§5.5](05-tasks.md#55-任务存储)）。
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
| id 生成 | `ulid` | `task_id` 单调可排序；`node_id` 仍需自写（6 字符 Crockford） |
| HTTP 客户端 | 内置 `fetch`（undici） | 不引 axios；测试用 `undici` MockAgent 或 `msw` |
| 重试/退避 | `p-retry` | 只在客户端（模型/UI）用；服务端仍然不自动重试 |
| 假时钟 | `@sinonjs/fake-timers` | 心跳阈值与 `at_ms` 的单测；配合注入的 `Clock` 接口 |
| 构建/开发 | `tsup`、`tsx` | ESM 输出 + 直接跑 TS |
| Lint/format | `biome` | 一个工具，配置在根目录 |
| CLI | `commander` | harness 与节点启动参数 |
| MIME/文件名 | `mime-types`、`sanitize-filename` | blob 下载 `Content-Type` 与 `Content-Disposition` |
| 限流（Phase 4） | `@fastify/rate-limit` | 代理后按 IP；现在不装 |
| SSE（Phase 4） | `fastify-sse-v2` | 只在做 `message/stream` 时引 |

**Phase 0 实际依赖**：运行时只有 `fastify`（gateway）；其余包零第三方依赖，开发依赖只有 `typescript`、`vitest`、`@types/node`。表中的 `zod`、`pino`、`lowdb`、`better-sqlite3`、`commander`、`tsup`、`biome` 等是目标选型，尚未安装。

明确不引的：认证/签名框架（没有比 30 行 Node `crypto` 更合适的）、DI 容器、ORM、消息队列、服务网格。集群只有十台机器，这些是负资产。

### 9.7 与路线图的对应

- Phase 0：protocol、crypto、config、storage、gateway、executor(echo)、node、harness。
- Phase 1：harness 场景覆盖成员收敛与故障注入。
- Phase 2：AcpExecutor、ui 基本视图。
- Phase 3：dsh-plugin、审批卡片、权限。
- Phase 4：10 节点压测复用 harness。

**Phase 0 实际状态**：protocol、crypto、config、gateway（含 blob 路由）、orca_node、harness 已实现；storage 只有内存实现；executor 只有 EchoExecutor；SQLite、fs 存储、ui、dsh-plugin、ACP 均未开始。Phase 1 的心跳/看门狗与故障注入也尚未实现。

---
