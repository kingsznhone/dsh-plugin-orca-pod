# orca-pod 审计：未完成事项

本文只列尚未完成的事项；条目编号用于交叉引用。

---

## 1. 架构一致性

| # | 位置 | 问题 |
|---|---|---|
| R4 | `cli/*` 子命令 | 每个子命令导出 `run(args)`，没有 I/O 依赖参数，直接写 `process.stdout`；CLI 测试因此只能起子进程。需要进程内测 CLI 时，给 `run` 加一个 `{ stdout, stderr, stdin, env }` 参数 |

## 2. 工具链

- `esbuild` 的 postinstall 被本机 npm 配置拦下（`npm install-scripts`），但平台二进制来自可选依赖 `@esbuild/win32-x64`，构建不受影响；换机器安装时留意这条警告。

## 3. 尚未验证的事项

- 没有在真实的 DSH 桌面或浏览器中运行。客户端只有构建冒烟测试（`test/client-bundle.test.ts`：在假壳里执行工厂、调用 `apply`），没有在 React 里实际渲染过。需要在真实面板里点一遍所有视图：状态页、首启向导、设置（含高级设置与完全重置）、全部任务、任务详情、节点详情、审批停靠卡与后台弹窗，以及设置页里的那一页。
- 宿主接口：`credentials`（`resolve`/`set`/`unset`）、`configEditor.edit(entry, change)`、`ctx.fiber.entry`、客户端 `locale.register`/`bind` 与 `__ModuleLoader__` 产物格式，都已对照本机 DSH 0.2.2-rc.3 安装包里的源码核对过，但没有实际跑通。尤其需要实测：面板保存配置 → `configEditor.edit` 写回 profile → Loader 重启插件 → 新实例从凭据库读到口令并启动，这条链路。
- 宿主类型来自 npm 上 `@deepseek-ai/cordis@4.1.0` 与 `@deepseek-ai/dsh-*@0.2.2-rc.3` 发布的包。下面这些有类型依据，但未在运行时验证：
  - `ctx.inject` 回调拿到的子作用域是否带 `effect`，服务替换时是否先销毁再重跑（插件注册不叠加依赖这一点）；
  - `agent/created` 的载荷与 `agent.ctx`；
  - `tools.register(def, { when })` 与 `exec.signal`；
  - `skills.register` 的字段（`resourceBase`、`source: "runtime"`）；
  - `settings.configure({ auto: false }, ctx.fiber)`；
  - `ctx.baseUrl` 是否为 profile 目录；
  - `ctx.sandboxPolicy.resolve({ session }).mode` 是否真的返回会话的 sandbox 模式（`dsh-base` 的 `cordis.patch.yml` compose 了 `@deepseek-ai/dsh-sandbox-policy`，见第 243-246 行）；
  - `package.json` 的 `icon` 字段与 `locale/*.json` 的 `meta`。
- **插件自带一份 DSH 运行时包**：插件从自己的 `node_modules` 加载 `dsh-llm`、`dsh-tools`、`dsh-error` 等，与宿主进程里的那份不是同一个模块实例。纯函数（`createUserMessage`、`boundContextSummary`、`deadline`、`writeFileAtomic`）不受影响；带身份的类会受影响：DSH 按 `instanceof` 读错误码（`dsh-llm` 的 `harnessErrorCode`、`isHarnessError`，注释写明“跨 realm 的错误不收窄”），所以插件那份 `dsh-error` 造出的 `PodError`、`ToolArgsError` 到宿主侧可能被读成 `UNKNOWN`。只有当 npm 把插件的依赖和宿主的去重到同一份时才没事。需要在真实宿主里看一次工具参数错误、节点错误是怎么呈现的；若确实判不出，就把 `dsh-error`（以及依赖它的 `dsh-llm`、`dsh-tools`）改成 peer 依赖，由宿主提供。
- **按 category 选模型**：ACP 执行器从会话的 `configOptions` 里按 `category`（`model`/`thought_level`）找配置项。dsh-acp 的这两个 category 来自本机安装包源码，只在假 ACP 上跑过；面板的 effort 选项来自 `llm.resolveModelInfo(默认模型).reasoning.efforts`，也没有在真实宿主里看过。
- DSH 是否向插件进程设置 `DSH_PROFILE_DIR`：仓库中没有依据，目前靠 `baseUrl` 兜底。
- 一次 `ctx.slots.inject("shell.overlay", …)` 回调里注册两个 slot 条目，是否被 DSH 支持。
- tracker 判断"用户消息"所依据的 `message.source.kind === "user"`，只能从 README 示例中确认。
- 跨机场景（Windows ↔ Linux、IPv6、`https` 端点）没有用 `scripts/cross.ts` 实测。
- 真实模型的端到端：`scripts/e2e-acp.mjs` 在本机 dsh 0.2.2-rc.3 上能走通 `initialize`、`session/new` 与 `session/prompt`，但没有 API key 时 dsh 会以“没有 `deepseek-official` 的 API key”失败。需要在有 `DEEPSEEK_API_KEY`（或凭据库里有 key）的环境跑一次，看到 `state: completed`、`text: pong`。权限挂起（`session/request_permission`）与 `session/resume` 只在假 ACP 上测过。

## 4. 有意保留

- **IN9** `workgroupKey`：一行、一处使用，但名字说明了编码的作用，不内联。
- **MG4** `executor/acp/permissions.ts`：§6、§7.14 以文件名引用它作为自动应答规则的出处。
- **MG6** `core/constants.ts`：只有 `DEFAULT_PORT` 与 `DEFAULT_TASK_TIMEOUT_S` 两个常量，但被协议、CLI、插件与面板多处引用；面板前端要读它，所以不并进依赖 `node:net` 的 `net.ts`。
- **MG7** `api/gateway.ts` 的 `handleError`：文档把它描述为“唯一的错误出口”，是 `Gateway` 里唯一的私有错误方法，便于找。

