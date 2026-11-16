# orca-pod 审计：未完成事项

> 日期：2026-11-16
> 基线：`df6abce` 加上本轮重构（未提交，在工作区）。工作区相对 `df6abce`：104 个已跟踪文件改动（+7157 / −12578），另有 22 个新文件。
> 验证：`npm run check` 通过（Biome、`tsc --noEmit`、vitest 45 个文件 / 390 个用例）；`node --check client.js` 通过。
> 本文**只列尚未完成的事项**，已完成的重构项不再记录。设计文档 `docs/11-open-questions.md` 与本文的未决项保持一致。

---

## 1. 留待后续讨论（所有者决定）

| ID | 事项 | 现状 |
|---|---|---|
| G2 | 远端任务中的 agent 与节点密钥的隔离；子任务的 hop/chain 由 CLI 在客户端拼装 | agent 可以读取 `<data_root>`（`identity.json`、`config.json` 的 `key_base64`、`ui-config.json` 的明文口令）。CLI 用本节点身份签名；不带 `--local-task` 就是新的根任务。`ORCA_POD_PARENT_TASK` 没有任何地方设置 |
| G6 | 口令存 DSH `credentials`，配置通过 `configEditor` 持久化（即 D1） | 口令明文存在 `ui-config.json`（没有 0600）；`config.json` 以 0600 写入 `key_base64` |

## 2. 延后实施（所有者决定）

| ID | 事项 |
|---|---|
| G5 | 可观测性指标（原 §8.7 的 `pod_*` 指标） |
| G7 | tracker 重启恢复只覆盖启动时已存在的 agent；应监听 `agent/created`，为之后才 resume 的会话恢复跟踪 |
| G9 | `message/stream` / SSE / resubscribe |
| 7.x | DSH 插件规范对齐，见下表 |
| 6.4 | 发布形态：`main`/`exports`/`bin`/systemd `ExecStart` 仍指向 `.ts`，从 `node_modules` 安装后无法运行（Node 拒绝在 `node_modules` 内做类型剥离）。需要产出 `lib/`，与 D9 一并处理 |

### 2.1 仍未对齐的 DSH 规范（7.x）

| # | 规范 | 现状 |
|---|---|---|
| D1 | 配置用 `configEditor`，秘密用 `credentials` | 仍是 `ui-config.json` 覆盖层（同 G6） |
| D2 | 提供 `locale/*.json` 的 `meta.title`/`meta.description`、icon，并加到 `exports`/`files` | 缺失 |
| D3 | 可选服务用 `inject` 或 `ctx.inject([...], cb)` 声明 | 现在用 `ctx.get(name)` 取（已去掉 try/catch 与多层兜底） |
| D4 | 工具响应 `exec.signal`；用 `register(def, { when })` 控制可见性 | 未做 |
| D5 | 工具 schema 中删除测试用的 `echo` 参数；描述中不引用章节号 | `echo` 仍在（`approve` 方法已删） |
| D7 | 按 agent 的注册放在 `agent/created` 中，挂在 `agent.ctx` 上 | 同 G7 |
| D8 | 客户端文案走 Client locale 服务 | 仍是文件内自带的 en/zh 词典（locale 读取已收敛为一条路径） |
| D9 | 发布 `lib/`、`exports` 带 `types`、声明 `engines.dsh`、关键词 `dsh-plugin` | 未做（同 6.4）；`cordis.patch.yml` 注释仍引用不存在的 `packages/orca-pod` |
| D10 | 数据目录跟随 DSH home / profile | 仍是 `~/.orca-pod`，多个 profile 共享同一身份、端口与 `tasks.db` |
| D11 | 嵌入式技能用 `ctx.skills.register` | `skill_injection` 仍会把技能复制到 `$DSH_HOME/skills` |
| D13 | 自带设置页的插件注册 `configure({ auto: false }, ctx.fiber)` | 未做 |

---

## 3. 待决策的设计缺口

以下各项在 `docs/11` 中登记为"开放"，正文不再把它们写成已实现。

| ID | 事项 | 现状 |
|---|---|---|
| G12 | 子任务的 `blocked` 上报到不了发起方 agent | tracker 只处理权限请求与终态；ACP 执行器本身也从不产生 `blocked` |
| G13 | 节点自述变更的传播 | `profilePatch`（`membership.ts`）在重新 join 时不刷新 `models`/`default_model`/`default_reasoning_effort`；`membersDigest` 只覆盖 `id|endpoints|runtime_digest` |
| G15 | `idempotency_key`、`trace_id` | 类型里有字段，没有任何逻辑使用 |
| G16 | 文档中其余的权限 / 成员条款 | 预授权与可派发者白名单；不可达候选的退避与修剪（`unknown` 记录每一拍都会去拨，且永不清理） |
| P1 | `orca_pod send` 的显式 `permission_mode` 可以**放宽**会话模式 | 所有者确认 G1"继承会话权限"是有意设计；"模型显式传参覆盖会话模式"是否也属于有意为之，需要确认。若否，应改为只能收窄 |
| P2 | 祖先禁调不覆盖根发起方 | 由插件工具发起的根任务，`pod.chain` 中没有根节点自己，所以 A→B→A 不会被拦下 |
| P3 | 挂起的子任务没有超时 | `input-required` 期间 TTL 暂停；未设置 `approval_timeout_s` 时会无限期挂起 |

---

## 4. 下一轮处理的缺陷（9.x，所有者决定延后）

| # | 位置 | 问题 |
|---|---|---|
| B2 | `protocol.ts:400` `newTaskId` | `BigInt(now & 0xffffffffffff)`：JS 位运算按 32 位进行，结果为负，task id 实际上**不按时间排序**。应改为 `BigInt(now) & 0xffffffffffffn` |
| B3 | `plugin/tracker.ts` `track()` → `schedulePoll(0)` | poll 进行中 `pollTimer` 为 undefined，此时新调用 `track` 会立刻启动第二个并发 poll，可能重复投递终态。应加 in-flight 标志 |
| B4 | `membership.ts:202` | 显式 upsert 遇到墓碑直接返回。节点 leave 或被 drop 后 10 分钟内重新 join，网关回 200 却不记录它，之后的签名请求都被 403 |
| B6 | `identity.ts:93` | `identity.json` 损坏或无法读取时返回 null，随后身份被**静默重新生成**；应只在 ENOENT 时返回 null |
| B8 | `blobs.ts` | 先写数据再写 meta，崩溃后会出现 `has()` 为 true 但 `get()` 失败；`X-Pod-Body-SHA256` 不符时返回 400，但字节已经按真实哈希落盘；重复上传不刷新 TTL |
| B9 | `net.ts`、入站 join | 入站 join 自报的端点不做筛查；`::ffff:` 映射地址的分类；DNS 判定结果在进程生命周期内永久缓存（DNS rebinding）；`fetch` 默认跟随重定向 |
| B17 | `scripts/sync-guest.ps1` | 硬编码私网 IP 与 `root` 用户，属于个人开发环境脚本 |

---

## 5. 本轮重构带来的行为变化（请确认）

| 变化 | 影响 |
|---|---|
| 不再隐式 join：对未知端点的读、取消、审批、派发一律返回 `unknown_peer` | 插件重启后只重新 join 配置里保存的 `peers`。经由他人目录认识、不在配置里的对端，在被重新连接之前，其任务的跟踪会以"tracking interrupted"结束 |
| `config.json` 结构变为扁平的 `bind_host`/`port`，并在每次插件启动时按有效配置重写 | 手工编辑 `config.json` 的内容不再保留，相应字段应写进 bundle 配置 |
| 面板对字段传 `null` 表示清回**默认值**（不再回落到 bundle 配置里的值）；对端地址会被规范化（`http://host` 变为 `http://host:80`） | — |
| 删除 `orca_pod approve` 方法；权限请求不再产生聊天提示，也不再强制唤醒，只能在 UI（会话卡片、弹窗、面板）中作答 | 用户不看 UI 时，权限请求只能等弹窗被看到 |
| `/cluster/child-link`、`GET /cluster/task` 只接受本节点自己的签名 | — |
| CLI 改用 `parseArgs` | 未知参数直接报错；以 `-` 开头的值需写成 `--text=--foo`；`cross.ts --auto-resume` 改为布尔开关 |
| 回环判断扩大到整个 `127.0.0.0/8`；`127.evil.com` 不再被当作回环 | — |
| 任务在输入物化期间对外显示 `submitted`，执行器开始运行后才变为 `working` | — |
| 持久化失败、输入清理失败改为记录日志、不再抛出；执行器的启动错误以抛出方式结束任务，状态为 `failed/executor_error` | — |
| 新增开发依赖 `@biomejs/biome` | 仅开发期使用，不随包发布 |

## 6. 尚未验证的事项

- 没有在真实的 DSH 桌面或浏览器中运行。客户端只在 jsdom + React 18 中做过冒烟测试。
- 一次 `ctx.slots.inject("shell.overlay", …)` 回调里注册两个 slot 条目，是否被 DSH 支持，需要在真实环境确认。
- G8 判断"用户消息"所依据的 `message.source.kind === "user"`，只能从 README 示例中确认；`agent/inbox/claimed` 的事件签名已在运行时类型中确认。
- 客户端是否改为 TSX + 构建步骤（会新增 esbuild 或 tsdown 开发依赖），待所有者决定。本轮保持单个纯 JS 文件。
- 并发运行 3 个完整测试套件（CPU 严重超订）时，个别实时心跳测试会超时；单套件运行稳定通过。
