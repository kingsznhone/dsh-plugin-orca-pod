# orca-pod 审计：未完成事项

本文只列尚未完成的事项；条目编号用于交叉引用。

---

## 1. 缺陷

| # | 位置 | 问题 |
|---|---|---|
| B6 | `security/identity.ts` `loadIdentity` | `identity.json` 损坏或无法读取时返回 null，身份被**静默重新生成**；应只在 ENOENT 时返回 null，其他情况报错 |
| B19 | `security/identity.ts` `saveIdentity` | 同步 `writeFileSync`，不是原子写，两个进程同时首启可能生成两份不同的身份。它挂在 `loadOrCreateIdentity` → `createOrcaNodeConfig` 的同步调用链上，改用 `writeFileAtomic` 需要把整条链改成异步；可与 B6 一起改，并用 `dsh-atomic-write` 的 `withFileLock` 串行化首启 |
| B20 | `plugin/tools.ts` `withSignal` | 调用一被中止就立刻返回，而方法的工作还在后台继续；dsh-tools 的约定（`contracts.d.ts` `ToolDefinition.execute`）要求工具在自己的工作停下之后才结束 |
| B21 | `node/orca-node.ts:206`；`cli/shared.ts:83` | 拼 URL 时 IPv6 字面量不加方括号（`http://${bind_host}:${port}`），只特判了 `::1`；`dsh-host-webserver` 有 `bindUrlHost`、`isWildcardHost` |
| B22 | `security/grants.ts:32` `GrantFailure` | 注释说每个值都是 `PodErrorCode`，但 `grant_replayed` 不在 `kernel/errors.ts` 的错误码表里；类型是手写的，应从 `PodErrorCode` 推导 |
| B24 | `membership/membership.ts`、`membership/mesh.ts` | 从别人目录里学到、一直连不上的候选（`unknown`）每一拍都去拨，失败不退避，也永不修剪（退避与修剪只作用于曾经 online 又 offline 的记录） |
| B17 | `scripts/sync-guest.ps1` | 硬编码私网 IP `192.168.86.252` 与 `root` 用户，属于个人开发环境脚本 |

## 2. 架构一致性

| # | 位置 | 问题 |
|---|---|---|
| R3 | 插件侧工厂的签名 | 核心服务都是 `createX(deps)`；插件侧仍是位置参数：`startPod(config, logger, stores, hooks, defaultRoot)`、`createTracker(getNode, broker, logger, options)`、`createPodAdmin(handle, tracker, broker, reasoningEfforts)`、`createPodTools(handle, tracker, policy)`。应按 §9.6 的约定改成单个 deps 对象 |
| R4 | `cli/*` 子命令 | 每个子命令导出 `run(args)`，没有 I/O 依赖参数，直接写 `process.stdout`；CLI 测试因此只能起子进程。需要进程内测 CLI 时，给 `run` 加一个 `{ stdout, stderr, stdin, env }` 参数 |

## 3. 工具链

- `esbuild` 的 postinstall 被本机 npm 配置拦下（`npm install-scripts`），但平台二进制来自可选依赖 `@esbuild/win32-x64`，构建不受影响；换机器安装时留意这条警告。

## 4. 文档

- **§4.2 错误码表有过时的码**：`blob_digest_mismatch`、`input_blob_missing`、`too_many_inputs`、`inputs_too_large`、`blob_too_large` 已不在 `kernel/errors.ts` 里。

## 5. 尚未验证的事项

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

## 6. 有意保留

- **IN9** `workgroupKey`：一行、一处使用，但名字说明了编码的作用，不内联。
- **MG4** `execution/acp/permissions.ts`：§6、§7.14 以文件名引用它作为自动应答规则的出处。
- **MG6** `protocol/constants.ts`：只有 `DEFAULT_PORT` 一个常量，但被协议、CLI、插件与面板多处引用，保留。
- **MG7** `transport/gateway/error-handler.ts`：文档把它描述为“唯一的错误出口”，单独成文件便于找。

## 7. 已有结论、不再跟踪

- **挂起的权限请求默认无限等待**：`input-required` 期间 TTL 暂停，不设 `approval_timeout_s` 就一直等，由人决定。
- **发起会话被销毁后不处理远端挂起**：tracker 撤回审批卡片，远端任务保持 `input-required`。
- **DNS rebinding 窗口**：候选端点的校验与 `fetch` 各解析一次 DNS，两次之间仍有窗口；所有者接受，不自写传输层。
- **完全重置会删除共用的工作组口令**：凭据库按 workgroup 存口令（整个 DSH home 共用一份），所以在一个 profile 里"完全重置"，同机同一 workgroup 的其他 profile 下次启动也会回到向导。按"重置即忘掉这个工作组的秘密"处理。
