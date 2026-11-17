# orca-pod 审计：未完成事项

> 日期：2026-11-17
> 基线：`3b1dbc5 refactor` 加上工作区未提交的改动。
> 验证：`biome check .`、`tsc --noEmit`、`tsc --noEmit -p client`、`npm run build` 均通过；vitest 在 `--pool=vmThreads` 下 48 个文件、424 个用例全部通过（默认池的问题见 §6）。
> 架构重组（按限界上下文分目录，[§9.1](docs/09-implementation.md#91-单包内的模块划分)）完成后：49 个文件、427 个用例（新增 `test/architecture.test.ts`）全部通过；文中路径已改为新位置。
> R0 完成后（`ulid`、`typebox`、`@agentclientprotocol/sdk`）：50 个文件、435 个用例全部通过（新增 `test/gateway-schema.test.ts`）。
> 本文**只列尚未完成的事项**；已完成的项不再记录。编号沿用历次审计，便于对照。

---

## 1. 留待讨论（所有者决定）

| ID | 事项 | 现状 |
|---|---|---|
| G2 | 远端任务中的 agent 与节点密钥的隔离；子任务的 hop/chain 由 CLI 在客户端拼装 | agent 以同一个 OS 用户运行，读得到 `<data_root>`（`identity.json` 私钥、`config.json` 的 `key_base64`），也读得到 DSH 凭据文件 `$DSH_HOME/.credentials.yaml` 里的工作组口令。CLI 用本节点身份签名。`ORCA_POD_PARENT_TASK` 只在 `cli/send.ts` 读取，没有任何地方设置。由此导致 **N11**：agent 运行 CLI 时不带 `--local-task`，发出的就是一个全新的根任务，既没有 `chain` 也没有 `root_origin`，祖先禁调拦不住它回调整棵树的发起方。方向：密钥目录与工作区分离；CLI 改为调用回环控制端点，由节点代签，并强制注入父链与收窄后的权限；执行器按任务注入父任务 id |
| P1 | `orca_pod` `send` 的显式 `permission_mode` 可以**放宽**会话模式 | `plugin/tools.ts`：`explicitMode ?? sessionSandboxMode(...)`。需要确认这是否有意为之；若不是，应改为只能在会话模式之下收窄，读不到会话模式时按 `read-only` |

## 2. 延后实施（所有者决定）

| ID | 事项 | 现状 |
|---|---|---|
| G5 | 可观测性指标（`pod_*`） | 未做 |
| G9 | `message/stream` / SSE / `tasks/resubscribe` | 未做，任务进度只能轮询 |
| D5 | 工具 schema 中删除测试用的 `echo` 参数 | `echo` 仍在 schema 和 `METHODS_HELP` 里 |
| R0b | `write-file-atomic` 替换三处“写临时文件再 rename”（`storage/fs.ts`、`node/config.ts`、`execution/acp/session-store.ts`） | 收益小，R0 时未做 |

## 3. 待决策的设计缺口

| ID | 事项 | 现状 |
|---|---|---|
| G13 | 节点自述变更的传播 | `profilePatch`（`membership/membership.ts`）在重新 join 时不刷新 `models`/`default_model`/`default_reasoning_effort`；`membersDigest` 只覆盖 `id\|endpoints\|runtime_digest`。节点启动后才拿到 Host 模型目录时，已认识它的 peer 看不到变化 |
| G15 | `idempotency_key` | 类型中有字段（`protocol/task.ts`），没有任何逻辑使用；同一条 `message/send` 提交两次就是两个任务 |
| G16 | 预授权与可派发者白名单；不可达候选的处理 | 没有 origin 侧预授权，也没有按 `orca_node_id` 限制谁能派任务；候选（`unknown`）每一拍都去拨，失败不退避，也永不修剪 |

## 4. 延后修复的缺陷

| # | 位置 | 问题 |
|---|---|---|
| B6 | `security/identity.ts` `loadIdentity` | `identity.json` 损坏或无法读取时返回 null，身份被**静默重新生成**；应只在 ENOENT 时返回 null，其他情况报错 |
| B17 | `scripts/sync-guest.ps1` | 硬编码私网 IP `192.168.86.252` 与 `root` 用户，属于个人开发环境脚本 |

## 5. 架构重组中发现、不在本次范围内的问题

| # | 位置 | 问题 |
|---|---|---|
| R2 | 只在类型层面的逆向依赖 | 架构测试按约定不计 `import type`，以下几条在运行期被擦除，但归属是反的：`delegation/delegation.ts`、`membership/mesh.ts` → `transport` 的 `PeerClient`；`membership/mesh.ts` → `node` 的 `OrcaNodeConfig`；`execution/acp/executor.ts`、`execution/acp/session.ts` → `node` 的 `AcpExecutorConfig`/`AcpMcpServer`；`kernel/events.ts` → `protocol` 的 `PeerView`/`TaskView` 与 `storage` 的 `DispatchEntry`。方向：ACP 配置类型归 `execution/`，由 `node/settings.ts` 引用；`mesh` 只收它用到的配置字段；出站客户端的接口下沉到使用方或 `protocol/`；事件载荷类型随事件总线一起重新定位。另外 `NodeLogger` 定义在 `membership/mesh.ts`，却被 tasks、execution、node 共用，应归 `kernel/` |
| R3 | 插件侧工厂的签名 | 核心服务都是 `createX(deps)`；插件侧仍是位置参数：`startPod(config, logger, stores, hooks, defaultRoot)`、`createTracker(node, broker, logger)`、`createPodAdmin(handle, tracker, broker)`、`createPodTools(handle, tracker, presets)`。重组只搬家、不改签名，按 §9.6 的约定逐个改成单个 deps 对象 |
| R4 | `cli/*` 子命令 | 每个子命令导出 `run(args)`，没有 I/O 依赖参数，仍直接写 `process.stdout`；CLI 测试因此只能起子进程。需要进程内测 CLI 时，再给 `run` 加一个 `{ stdout, stderr, stdin, env }` 参数 |

## 6. 工具链

- **`npm run check` 不能作为验收入口**：Node v26.13.0 下，vitest 5.1.0 的默认 `forks`/`threads` 池连只有一条断言的测试文件都跑不起来（`TypeError: Cannot read properties of undefined (reading 'config')`）。这与代码无关，`--pool=vmThreads` 可以正常运行。处理方式：升级或降级 vitest/Node，或在 `vitest.config.ts` 中固定 `pool: "vmThreads"`。
- `esbuild` 的 postinstall 被本机 npm 配置拦下（`npm install-scripts`），但平台二进制来自可选依赖 `@esbuild/win32-x64`，构建不受影响；换机器安装时留意这条警告。

## 7. 尚未验证的事项

- 没有在真实的 DSH 桌面或浏览器中运行。客户端只有构建冒烟测试（`test/client-bundle.test.ts`：在假壳里执行工厂、调用 `apply`），没有在 React 里实际渲染过；TSX 改写之后需要在真实面板里点一遍所有视图。
- 宿主接口：`credentials`（`resolve`/`set`/`unset`）、`configEditor.edit(entry, change)`、`ctx.fiber.entry`、客户端 `locale.register`/`bind` 与 `__ModuleLoader__` 产物格式，都已对照本机 DSH 0.2.2-rc.3 安装包里的源码核对过，但没有实际跑通。尤其需要实测：面板保存配置 → `configEditor.edit` 写回 profile → Loader 重启插件 → 新实例从凭据库读到口令并启动，这条链路。
- 其余仍只来自本地镜像类型（`src/plugin/dsh.ts`）、没有对照源码确认的：
  - `ctx.inject` 回调拿到的子作用域是否带 `effect`，服务替换时是否先销毁再重跑（插件注册不叠加依赖这一点）；
  - `agent/created` 的载荷与 `agent.ctx`；
  - `tools.register(def, { when })` 与 `exec.signal`；
  - `skills.register` 的字段（`resourceBase`、`source: "runtime"`）；
  - `settings.configure({ auto: false }, ctx.fiber)`；
  - `ctx.baseUrl` 是否为 profile 目录；
  - 服务名 `agentDefaultModel`；
  - `package.json` 的 `icon` 字段与 `locale/*.json` 的 `meta`。
- DSH 是否向插件进程设置 `DSH_PROFILE_DIR`：仓库中没有依据，目前靠 `baseUrl` 兜底。
- 一次 `ctx.slots.inject("shell.overlay", …)` 回调里注册两个 slot 条目，是否被 DSH 支持。
- tracker 判断"用户消息"所依据的 `message.source.kind === "user"`，只能从 README 示例中确认。
- 跨机场景（Windows ↔ Linux、IPv6、`https` 端点）本轮改动后没有用 `scripts/cross.ts` 实测。
- ACP SDK 换上后，`scripts/e2e-acp.mjs` 在本机 dsh 0.2.2-rc.3 上走通了 `initialize`、`session/new`（dsh 返回真实 session id，绑定写入 `state/<workgroup>/sessions.json`）与 `session/prompt`，但这一轮被 dsh 以“没有 `deepseek-official` 的 API key”失败，没有拿到模型回答。需要在有 `DEEPSEEK_API_KEY`（或凭据库里有 key）的环境再跑一次，看到 `state: completed`、`text: pong`。权限挂起（`session/request_permission`）与 `session/resume` 只在假 ACP 上测过。

## 8. 已有结论、不再跟踪

- **挂起的权限请求默认无限等待**（原 P3）：`input-required` 期间 TTL 暂停，不设 `approval_timeout_s` 就一直等，由人决定。
- **发起会话被销毁后不处理远端挂起**（原 N8）：tracker 撤回审批卡片，远端任务保持 `input-required`。
- **DNS rebinding 窗口**（B9 余项）：候选端点的校验与 `fetch` 各解析一次 DNS，两次之间仍有窗口；所有者接受，不自写传输层。
- **完全重置会删除共用的工作组口令**：凭据库按 workgroup 存口令（整个 DSH home 共用一份），所以在一个 profile 里"完全重置"，同机同一 workgroup 的其他 profile 下次启动也会回到向导。按"重置即忘掉这个工作组的秘密"处理。
