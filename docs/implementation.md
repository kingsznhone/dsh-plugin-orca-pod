# Orca Pod 实现

> Status: 与 `src/` 一致（2026-11-21）。设计、取舍与未决项见 [design.md](design.md)。

## 1. 形态

单 npm 包 `dsh-plugin-orca-pod`，ESM，Node ≥ 24，TypeScript。装进 DSH profile 后由 Cordis 加载：一个 bundle 补丁插入一行 `orca-pod`，客户端 bundle 挂上面板，主模块在自己进程里起 HTTPS 监听、A2A 端点与本机执行器。

```text
src/
├─ index.ts                 入口，只再导出 apply
├─ core/                    ids、net（URL/地址）、schema 边界、signing、certificate、blobs、sqlite、stream、errors、events、constants、identity
├─ mesh/                    peer 表、hello、心跳、目录合并、出站客户端、TLS 路由、端点筛查、计时参数
├─ executor/                LocalExecutor 接口、ACP 子进程与 session/permission 适配、模型目录、模型选择
├─ task/                    任务视图与状态机、任务书、派发日志、回报与唤醒、配额、工作区、文件登记、wire 形状
├─ api/                     Fastify 网关、路由与准入、A2A、blob 下载、hello、入站校验、/orca-api 同源桥
├─ node/                    Orca（单节点总装）、设置文件读写
├─ plugin/                  DSH 侧：bundle（组合根）、pod（生命周期）、tools、tracker、panel 路由、skill、catalog、stores
└─ client/                  面板 React 代码与浏览器 store（不 import 任何 Node 模块）
```

依赖只能向下，方向 `core ← executor ← task ← mesh ← api ← node ← plugin`，`client` 只依赖 `core` 的类型；`test/architecture.test.ts` 固化这条规则（如 `core` 不 import `fastify`/`undici`）。目录按限界上下文分，跨目录直接引用定义文件，不设纯转发的 `index.ts` 层。

## 2. 装配与生命周期

组合根是 `src/plugin/bundle.ts` 的 `apply(ctx, config)`，`src/index.ts` 只再导出：

1. `ctx.inject(['tools', 'credentials'], …)`：全局工具与凭据库必须存在。`agents`、`sandboxPolicy` 以 `OptionalService` 方式注入，缺了也能跑（只是权限继承与执行器受限）。
2. 建 `Orca`（绑定 `ctx`、凭据、数据根 `$DSH_HOME/orca-pod`、配置与事件）、`Tracker`、`PodTool`、`PanelRoutes`。
3. 注册 `ctx.effect` dispose：停节点、关 tracker、摘路由；`agent/inbox`、`agent/claimed` 监听器在会话关闭时重置唤醒预算。
4. 监听 `credentials/reference-updated`、`credentials/record-updated`：外部换身份或密码时排队重启一次节点。
5. `tools.register` 只在已配置时注册 `orca_pod`；未配置时工具不存在（不是返回错误）。
6. `PanelRoutes` 需 `webServer` 与 `connection`；`skills` 注册 `orca-node`（配置项 `skill_injection` 默认开，任务会话 `ORCA_POD_IN_TASK=1` 时跳过）。
7. `settings.configure({ auto: false })`：面板保存才生效，不在输入时热应用。
8. `pod.start()` 快速返回，不阻塞 apply。

`Pod`（`src/plugin/pod.ts`）是唯一状态机：

```text
unconfigured ──configure──► starting ──► running
     ▲                         │  │         │
     └─────────stop────────────┘  └──► failed
```

- 状态：`unconfigured`（没有 workgroup/password）、`starting`、`running`、`failed`（带原因）、`stopped`。
- start 顺序：解析身份与证书 → 网关 `listen`（端口被占即失败，不动其他状态）→ 打开 SQLite → 启动 mesh 与心跳 → 置 `running`。
- 所有 start/stop/reconfigure 经 `SerialQueue` 串行，面板连续点击不会并发起两份节点。
- `Orca` 每次 start 重建，stop 时释放全部 socket/定时器/子进程；进程重启后 task 表里的非终态任务标 `failed(node_restart)`。

设置文件是 `<data_root>/settings.json`，`writeFileAtomic` + 0600；密码不落在文件里（凭据库），节点私钥也不在文件里。设置只被 `Pod` 与面板读。

## 3. 控制面（/orca-api）

`PanelRoutes` 把路由挂到 DSH web server，同源桥的后端就是 `Orca` 内存状态。准入在 DSH 侧完成（Host/Origin + 浏览器会话 cookie → `connection.admit`），插件再加 owner 校验与 `X-Orca-Pod` 头；非 GET 且 `Content-Type` 不含 `application/json` 的请求拒绝。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/orca-api/state` | 自己、成员、待审批、最近任务、工作区用量；面板一次轮询拿全 |
| GET | `/orca-api/tasks` | 任务列表（可带 `state`/`limit`） |
| GET | `/orca-api/tasks/{task_id}` | 单任务详情 |
| GET | `/orca-api/blobs/{blob_id}` | 面板下载本机 blob |
| POST | `/orca-api/config` | 改端口/监听/上限/模型与推理强度等可热改项 |
| POST | `/orca-api/connect` | 用 host:port（或 URL）+ 密码加入/联系一个 peer |
| POST | `/orca-api/approve` | 批准挂起的权限请求（`request_id`） |
| POST | `/orca-api/deny` | 拒绝权限请求 |
| POST | `/orca-api/cancel` | 取消任务 |
| POST | `/orca-api/reset` | 完全重置（停节点、清设置、删身份记录与状态） |

错误统一为 `{ code, message }`，HTTP 状态来自 `core/errors` 的 code 表；面板请求体 64 KiB 上限。审批与取消都直接调 `Orca` 方法，不经过模型、不写聊天历史。

`Orca` 是唯一把 mesh、执行器、tracker、SSE 无关的轮询状态拼起来的地方：面板只读它，`orca_pod` 工具只调它。

## 4. 客户端 bundle 与面板

`rolldown.config.ts` 把 `src/client/index.tsx` 打成 CJS 的 `lib/client.js`，外层是

```js
window.__ModuleLoader__.load({ id: "dsh-plugin-orca-pod", factory: … })
```

`id` 必须等于 npm 包名，否则宿主 `dsh.client` 与面板路由对不上。externals 只有 `react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives`（由 shell 提供）；CSS Modules 走 Lightning CSS，产物里 `<style data-plugin-css="dsh-plugin-orca-pod/…">` 供主题与卸载使用。

面板入口 `src/client/index.tsx` 注入 `['slots', 'locale']`，注册四处：

| Slot | 注册项 |
| --- | --- |
| `settings.section` | 设置页主面板（`id = NS`，order 60） |
| `sidebar.footer.action` | 侧栏成员/状态入口（`id = NS`，order 10） |
| `shell.overlay` | 面板浮层、审批弹窗、音效层（`NS.panel` / `NS.approval-popup` / `NS.sounds`，order 60–62） |
| `conversation.input.dock` | 聊天输入区下方的审批条（`NS.approval-dock`，order 60） |

`NS = "dsh-plugin-orca-pod"`（`src/client/constants.ts`）。浏览器 store 轮询 `baseURI + "orca-api/state"`：只有存在订阅者时轮询，payload 摘要不变就不触发重渲染；断线/401 只在面板显示，不弹全局提示。

i18n 只有中英两份 `locale/{en,zh}.json`；数值按用户 locale 格式化。组件只用 primitives，不引第三方 UI 库。

## 5. 测试

Vitest（`vitest.config.ts`），按模块一份 `*.test.ts`：

- 支持层：`test/support/harness.ts` 在进程内起多个真实节点（假 ACP 执行器、可控时钟、`port: 0`）；`test/support/net.ts` 分配端口/URL；`test/support/node.ts` 造身份与自述；`test/support/script.ts` 是测试专用脚本执行器；`test/support/fake-acp.ts` 是 stdio 假 ACP server。
- 夹具：`test/fixtures/{gateway,ids,pod,runner,credentials}`。
- 覆盖：`core`（ids/signing/certificate/blobs/sqlite/stream）、`mesh`（hello/心跳/看门狗/目录合并/端点筛查/TLS 钉扎）、`api`（准入/签名/错误码/blob/hello/A2A）、`task`（tracker/notice/取消/配额/文件登记）、`executor`（ACP 映射/权限模式/模型选择）、`node`/`plugin`（装配、生命周期、/orca-api、工具）、`client` 逻辑（store/format）、`test/architecture.test.ts`（依赖方向）、`test/acceptance.test.ts`（多节点验收）、`test/multi-endpoint.test.ts`（真实端口）。

`npm run check` 是唯一验收入口：`biome check . && tsc --noEmit && tsc --noEmit -p src/client && vitest run`。真实回环与多节点都在 `test/` 里，没有 `scripts/` 目录，也没有 `npm run harness`。

## 6. 构建、打包与依赖

- `npm run build`：`tsc -p tsconfig.build.json` 出 `lib/`（JS + `.d.ts` + sourcemap），`rolldown -c` 出 `lib/client.js`；`prepare` = `npm run build`，npm publish/`npm pack` 时自动跑。`npm run watch:client` 只重建客户端 bundle。
- `files`：`lib`、`cordis.patch.yml`、`locale`、`icon.png`、`icon-full.webp`、`skills`、`README.md`、`LICENSE`。`npm pack` 约 240 个文件、660 kB 级。
- 依赖三类：
  - `dependencies`：7 个独立第三方包（`@agentclientprotocol/sdk`、`bs58`、`cross-spawn`、`fastify`、`ulid`、`undici`、`zod`），随包安装。
  - `peerDependencies`：18 个 `@deepseek-ai/dsh-*`（全部 `^0.2.2-rc.5`，`peerDependenciesMeta` 全 optional），由宿主提供同一实例、不随包发布；`devDependencies` 留一份供本地构建与类型检查。
  - `engines`：`node >=24`、`dsh >=0.2.2-rc.5 <0.3.0`；不满足时 DSH 拒绝安装/启动。
- 许可证 GPL-3.0-only；bundle 补丁在 `cordis.patch.yml`，行 `id/name` 都是 `dsh-plugin-orca-pod`，配置只有 `port`、`peers`、`skill_injection`。
- 客户端与服务端同包：`dsh.client` 声明 `platform: "web"`、`immediately: true`；`exports` 暴露 `.`、`./client`、`./cordis.patch.yml`、`./locale/*.json`、`./icon`、`./package.json`。

## 7. 阅读顺序

排障或接手时按数据流读：`core/identity`（身份）→ `core/net`（地址/URL）→ `mesh`（谁能连谁）→ `api`（请求怎么进来）→ `task`（任务怎么跑、怎么回报）→ `executor`（怎么落到 ACP）→ `node/orca`（总装）→ `plugin/bundle`（怎么进 DSH）。面板先看 `client/store.ts`，再看 `panel.tsx`。
