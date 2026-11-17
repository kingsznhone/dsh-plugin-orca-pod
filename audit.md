# orca-pod 审计：未完成事项

> 日期：2026-11-17
> 基线：`3b1dbc5 refactor` 加上工作区未提交的改动。
> 验证：`biome check .`、`tsc --noEmit`、`tsc --noEmit -p client`、`npm run build` 均通过；vitest 在 `--pool=vmThreads` 下 48 个文件、424 个用例全部通过（默认池的问题见 §6）。
> 架构重组（按限界上下文分目录，[§9.1](docs/09-implementation.md#91-单包内的模块划分)）完成后：49 个文件、427 个用例（新增 `test/architecture.test.ts`）全部通过；文中路径已改为新位置。
> R0 完成后（`ulid`、`@agentclientprotocol/sdk`，校验统一用 `zod`，先用过的 `typebox` 已移除）：50 个文件、437 个用例全部通过（新增 `test/gateway-schema.test.ts`）。
> §9 代码整理候选实施后（含顺带修复的 R2）：51 个文件、437 个用例全部通过（`normalizeOrcaNodeId` 的 3 个测试随函数删除）；`biome check`、`tsc --noEmit`、`tsc --noEmit -p client`、`npm run build` 通过。
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
| G15 | `idempotency_key` | 类型中有字段（`protocol/task.ts`），没有任何逻辑使用；同一条 `message/send` 提交两次就是两个任务 |
| G16 | 预授权与可派发者白名单；不可达候选的处理 | 没有 origin 侧预授权，也没有按 `orca_node_id` 限制谁能派任务；候选（`unknown`）每一拍都去拨，失败不退避，也永不修剪 |

## 4. 延后修复的缺陷

| # | 位置 | 问题 |
|---|---|---|
| B6 | `security/identity.ts` `loadIdentity` | `identity.json` 损坏或无法读取时返回 null，身份被**静默重新生成**；应只在 ENOENT 时返回 null，其他情况报错 |
| B17 | `scripts/sync-guest.ps1` | 硬编码私网 IP `192.168.86.252` 与 `root` 用户，属于个人开发环境脚本 |
| B18 | `cli/send.ts`（`--local-task` 分支）、`tasks/delegation.ts`（`withParentChain`，`{ ...callerPod, ...childPodMetadata(...) }`） | 子任务的 `permission_mode` 没有按“只能收窄”继承：CLI 里显式 `--permission-mode` 覆盖父任务的模式，所以以 `read-only` 运行的 agent 可以派出 `danger-full-access` 的子任务（目标机仍受本机上限约束）；`delegation.ts` 则相反，父任务模式覆盖调用方。应统一为 `narrowPermissionMode(父, 请求)`，放进 `childPodMetadata` 一处实现，CLI 改调它（TY5）。与 G2/N11、P1 同属“子任务权限不可放大”一族 |

## 5. 架构重组中发现、不在本次范围内的问题

| # | 位置 | 问题 |
|---|---|---|
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

## 9. 代码整理候选（2026-11-17 审查，已实施，余项如下）

> 原清单分四类：**TY** 散装 object 规范成命名强类型，**NE** 减少嵌套，**IN** 内联或删除超短函数，**MG** 合并单一使用者的短文件。已完成的条目不再记录，包括 TY1–TY8、TY10–TY14、TY19、NE1–NE5、NE8–NE13、IN1–IN8、IN10、MG1/2/3/5，以及与之重叠的 R2（`PeerClient` 契约、事件载荷类型、`NodeLogger`、ACP 配置类型都已归到正确的层）。以下是没做完或有意保留的部分。

### 9.1 没做完

| # | 现状 |
|---|---|
| TY9 | `OrcaNodeId`/`WorkgroupId` 已导出并用在签名上，`Grant`、`BusyState`、`PermissionRequest`、`pod.chain`/`root_origin` 的 id 字段改用 `OrcaNodeIdSchema`/`WorkgroupIdSchema`（测试里的假 id 改成 `test/fixtures/ids.ts` 的合法 id）；两者仍是 `string` 别名，没有 `.brand()` |
| TY15 | 请求体 schema 与 `PodState`/`PodTasksResponse`/`PodTaskResponse`/`PodActions` 已在 `plugin/panel-api.ts`，`store.act` 按动作名定类型；`api<T>`/`useApi<T>` 的读取仍由调用方写泛型，没有“路径 → 响应类型”映射 |
| TY16 | `PanelPatch` 与 `PanelPatchSchema` 由 `node/settings.ts` 的字段表派生，口令空白规则只剩 `reconfigure` 一处；`pickPanelFields` 已删，面板路由用 `PanelPatchSchema` 解析一次，`reconfigure` 只收 `PanelPatch`；`plugin/stores.ts` 的 `RawConfig` 仍是 `Record<string, unknown>` |
| TY17 | 工具参数已按 `method` 用 zod 解析、结果有命名类型；`parameters` 的 JSON schema 仍是手写（权限模式枚举取自 schema），没有用 `z.toJSONSchema` 生成，因为宿主支持的 JSON schema 子集没核对过 |
| TY18 | `taskKey`、`PendingApproval`、`ExecutorKind`、`PodTaskRow.state`、`selectionOf`、`modelId`/`modelText` 已做。tracker 已改用 `instanceof PodError`。没做：`client/settings.tsx` 的权限模式选项仍是手抄的第三份（`PERMISSION_MODES` 所在的 `permission.ts` 会把 zod 带进客户端 bundle，没验证过体积影响） |
| NE6/NE7 | 服务端部分已做。客户端只做了 `TaskDetail`/`AllTasks`（`Loaded`、`TaskFacts`、`ArtifactLinks`）、`Panel` 早返回、`ConnectForm`、`NodeDetail`（`RuntimeFacts`/`ModelList`）和 `buildPatch`（`limitValues`/`choiceValues`）；`ConfigForm`/`initialForm` 没拆。这些没有在真实 React 里渲染过，只过了类型检查与构建冒烟（见 §7） |

### 9.2 有意保留

- **IN9** `workgroupKey`：一行、一处使用，但名字说明了编码的作用，低把握，没内联。
- **MG4** `execution/acp/permissions.ts`：§6、§7.14 以文件名引用它作为自动应答规则的出处。
- **MG6** `protocol/constants.ts`：现在有 `DEFAULT_PORT` 与 `BODY_SHA256_HEADER` 两个常量，保留。
- **MG7** `transport/gateway/error-handler.ts`：文档把它描述为“唯一的错误出口”，单独成文件便于找。

### 9.3 实施中发现

- **B18 现在只有一处可改**：`cli/send.ts` 改为调用 `tasks/delegation.ts` 导出的 `childPodMetadata`，但为了不改变行为，仍让显式 `--permission-mode` 覆盖父任务的模式（原样保留缺陷）；`delegation.ts` 的 `withParentChain` 仍是父任务模式覆盖调用方。要修成 `narrowPermissionMode(父, 请求)`，只需改 `childPodMetadata` 并去掉 `cli/send.ts` 里那一行覆盖。
- **错误文案变化**：zod 取代手写校验后，`parseSignedGrant`、`parsePodMetadata`、echo 脚本、工具参数的错误文案改为 `<路径> <zod 消息>`（例如 `Unrecognized key`、`expected object`）；错误码不变。
