# 文档与注释脱节清单（以代码为基准）

> 基线：`f7dada9`（2026-11-18 06:41），工作区干净。基准验证：`biome check`、`tsc --noEmit`（含 client）通过，`vitest --pool=vmThreads` 47 个文件 / 386 个用例通过。
> 范围：`docs/*.md`、根 `README.md`、`docs/README.md`、`audit.md`、`cordis.patch.yml` 以及 `src/`、`client/` 的注释。
> 方法：逐章人工比对 + 代码事实核对；机械检查（Markdown 锚点、代码里的 `§N.M` 引用）全部可解析（113 节 / 138 锚点 / 291 个 `§` 引用，0 缺失），所以本清单只列**语义**脱节。
> 已核对无脱节：`docs/DECISIONS.md`（D1–D40 编号连续、每条“去向”小节都存在）、`docs/01-overview.md`、`docs/10-roadmap.md`。

分级：**P0** = 直接说错关键事实（依赖/安装物），会误导部署；**P1** = 描述的行为与代码相反，会误导实现；**P2** = 细节、清单、措辞、交叉引用。

---

## P0：运行时依赖描述集体停留在 D40 之前

f7dada9（D40）把 DSH 的一批基建包变成真正的运行时依赖：`package.json` 的 `dependencies` 现在是 16 项——`@agentclientprotocol/sdk`、11 个 `@deepseek-ai/dsh-*`（agent、atomic-write、brand、credentials、error、home-paths、llm、sandbox-policy、timeout、tools、util-values）、`cross-spawn`、`fastify`、`ulid`、`zod`。`lib/` 产物里能直接看到这些 import（如 `lib/cli/install.js:22`、`lib/plugin/tools.js:15`、`lib/transport/peer-client.js:2`）。以下四处仍在说“只依赖 fastify / 运行时一个都不加载”：

| 位置 | 现文（摘） | 代码事实 | 建议 |
| --- | --- | --- | --- |
| `README.md:7` | “运行时只依赖 `fastify`，…安装时不需要本仓库的 `node_modules`” | 见上，运行时会加载 DSH 包 | 改成“运行时依赖见 `package.json`（含 DSH 基建包，D40）；安装后随包解析，不依赖本 checkout 的 `node_modules`” |
| `README.md:49` | “bundle 没有私有依赖，运行时不需要本 checkout 的 `node_modules`” | 同上；`link:` 安装时依赖在仓库 `node_modules` 里解析 | 删“没有私有依赖”，改成“依赖随包解析” |
| `docs/09-implementation.md:167` | “这些包都是 devDependency…运行时一个都不加载——构建产物里对 `@deepseek-ai/*` 的 require 只出现在 `lib/client.js`” | 与 dsh-llm/-error/-tools/-timeout/-sandbox-policy/-atomic-write/-home-paths/-brand/-util-values/-credentials 的实际值导入（如 `src/kernel/errors.ts:1`、`src/node/config.ts:6-7`、`src/transport/peer-client.ts:5`、`src/execution/acp/connection.ts:27`、`src/plugin/tools.ts:19-30`）相反 | 重写为：宿主类型与运行时工具都来自 DSH 包；哪些是 dependency、哪些是 devDependency 照 `package.json` 说 |
| `docs/09-implementation.md:229-242`（§9.7） | 运行时表只有 fastify / ulid / ACP SDK / zod；`:242` “其余能力都用 Node 内置” | 缺 11 个 dsh-* 与 `cross-spawn`（`src/execution/process.ts:3`） | 补两行（DSH 基建包一组、cross-spawn），并说明“事件/超时/原子写/错误基类不再自写” |

同类脱节（配置层注释）：`cordis.patch.yml:8` “The package is self-contained: its only runtime dependency is fastify” —— 直接删掉这半句。

## P1：行为/语义描述与代码相反

1. **`docs/02-model.md:53`** — “`identity.json` 存 `{orca_node_id, public_key, private_key_pem, created_at}`”。代码只写 `{orca_node_id, private_key_pem, created_at}`，公钥由私钥推导（`src/security/identity.ts:25-29,100-104`）。建议删 `public_key`。
2. **`docs/02-model.md:108`** — “心跳带准入证明、`busy` 与 `members_digest`，不带 self 记录”。代码心跳带完整 `self`（`src/membership/mesh.ts:233` 构造，`src/transport/gateway/cluster-routes.ts:174-179` 收到后重建 profile），且 `docs/03-membership.md:96` 自己就写了“心跳带完整自述”。建议改成“带 self（见 §3.3），不带整张目录”。
3. **`docs/09-implementation.md:35`** — `node/` 行仍列 `harness`。实际 `src/node/` 只有 `config.ts` / `orca-node.ts` / `settings.ts`；harness 在 `test/support/harness.ts`（`:131` 已正确说明“不进 lib/”）。删 `harness`。
4. **`docs/09-implementation.md:115`** — 测试矩阵行 `security/grants.ts / tasks/delegation.ts`（`childPodMetadata`）断言“祖先禁调、grant 校验/转发/过期/重放/工具不符”。`childPodMetadata` 在全仓不存在；grant 转发与祖先禁调已被 D39 删除（DECISIONS.md:17）。改成“grant 校验/过期/重放/工具不符，以及执行器会话内 `send` 拒绝”。
5. **`docs/09-implementation.md:117`** — `tasks/workspace.ts` 断言含“`inputDir` 拒绝路径穿越”。任务输入（`inputDir`/`inputs/`）随 32dc79f 删除；`WorkspacePaths` 现在只有 `root` / `notes` / `state`（`src/tasks/workspace.ts:25-37`）。删该断言。
6. **`docs/04-transport.md:26`、`docs/07-security.md:26`、`docs/07-security.md:108`** — 把“签名身份就是本机自己”当成 `/cluster/blob` 与面板 `/orca-api` 的共同前提。`/cluster/blob` 确实是 `local` 访问级（验签 + 本机身份，`src/transport/gateway/auth.ts:59-61,85-87`）；面板 `/orca-api` 根本不验节点签名，只验回环 + 无转发头 + 同源头（`src/plugin/web.ts:67-77,137-143`，拒绝码 `local_only` / `cross_origin`）。把面板那半句改成“同源桥只做回环 + Host/Origin/Sec-Fetch-Site + `X-Orca-Pod` 闸门，不验节点签名”。
7. **`docs/04-transport.md:130`** — “每次调用带 `AbortSignal.timeout`”。出站客户端用的是 DSH `deadline`（`src/transport/peer-client.ts:154-175`，`deadline(...)` + `timeoutOf` → `peer_timeout`）；`:64` 已正确写成“DSH 的 deadline”。两句统一。
8. **`docs/06-execution.md:168`** — “`submit` 的检查顺序是：槽位 → 元数据/Echo 脚本 → 工作区配额 → 输入清单”。没有“输入清单”这一步，实际顺序到此为止（`src/tasks/runner.ts:98-100`：槽位 → `parsePodMetadata` → 配额）。删“→ 输入清单”。
9. **`docs/11-open-questions.md:18`** — “模型目录与默认 effort 只在 join 时随自述登记，已存在的记录不会被后续 join 刷新模型目录”。心跳 self 会刷新（`cluster-routes.ts:174-179`，注释明写 “a model catalog that arrived late”），`docs/03-membership.md:96` / `docs/02-model.md:103` 也这么说。只保留“`members_digest` 仍只覆盖 `id|endpoints|runtime_digest`”这一句。
10. **`README.md:27`** — `security/` 说明写“grants（grant 校验与转发）”。“转发”是 D39 前的旧语义（现在只校验，`checkGrant` 在单跳内本地消费）。改成“grant 校验与消费账本”。
11. **`docs/09-implementation.md:51`** — 访问级列表写成 `public|join|member|link|local`。`link` 随直链下载删除（`src/transport/gateway/auth.ts:21` 只有 `public|join|member|local`，`src/transport/gateway/blob-routes.ts` 也没有 link 路由）。删 `link`。

## P2：文档细节

### 布局与清单
- `README.md:21`、`docs/09-implementation.md:18`：`scripts/` 清单缺 `build-client.ts`（`docs/09:208` 又引用了它，前后不一致）。
- `README.md:26`、`docs/09:28`：`protocol/` 清单缺 `blob.ts`；`docs/09:28` 还说 `constants` 里有 `BODY_SHA256_HEADER`——该常量随上传路由删除，`src/protocol/constants.ts` 现在只有 `DEFAULT_PORT`。
- `README.md:31`、`docs/09:33`：`execution/` 清单缺 `kinds.ts`（`EXECUTOR_KINDS`）。
- `README.md:33`、`docs/09:35`：`node/` 里的 `harness`（同上 P1-3）。
- `README.md:35`：`plugin/` 列表末尾的 `dsh` 不存在；实际 13 个文件是 `admin/broker/bundle/catalog/config/lifecycle/panel-api/services/skill/stores/tools/tracker/web`。
- `docs/09:64`：`createPodAdmin(handle, tracker, broker)` 实际是 4 参（第 4 参 `reasoningEfforts: () => readonly LlmReasoningEffortInfo[] = () => []`，`src/plugin/admin.ts:203-209`、调用点 `src/plugin/bundle.ts:117`）。
- `docs/09:93`：“它没有发布类型，`client/dsh-ui.d.ts` 按 DSH 自己的调用写了…” —— 包**有**类型（`@deepseek-ai/dsh-client-ui-primitives`，见 `client/types.ts:8-10`），`client/dsh-ui.d.ts` 也不存在（只有 `client/css-modules.d.ts`）。同时模块清单缺 `constants.ts` / `types.ts`。
- `docs/09:128`：handle 列表缺 `annotateDispatch(taskId, agentId)`（`src/node/orca-node.ts:152`、`src/tasks/delegation.ts:59`）与只读字段 `orcaNodeId` / `config` / `endpoints` / `heartbeatIntervalMs`（`orca-node.ts:105-111`）。
- `docs/09:152`：表格里写 `createOrcaNode(config)`，实际签名是 `createOrcaNode(options: CreateNodeOptions)`（`{ config, runtime?, timings?, clock?, fetch?, storage?, executor?, logger? }`）；与同章 `:128` 的 `{ config }` 自相矛盾。

### 字段/形态
- `docs/02-model.md:93`：`models` 写成 `[{provider, model, name?, description?}]`——实际 `ModelOfferSchema` 是 `{provider, id, name, description?}`（`name` 必填，`src/protocol/model.ts:24-29`，`:81` 的 JSON 例子已用 `id`）；`default_model` 写成 `{provider, model, reasoning_effort?}`——实际是 DSH `ModelSelection`，字段为 `reasoningEffort`（驼峰，`src/protocol/model.ts:41-45`）。
- `docs/02-model.md:95`：说推导端点时“跳过 `fe80::/10`”；`src/transport/net.ts:88` 的正则 `/^fe80:/i` 只匹配 `fe80:` 前缀，`fe80::/10` 的 `fe90:–febf:` 并未过滤（`net.ts:76-78` 注释同样写错）。建议把正则改成 `/^fe[89ab][0-9a-f]:/i` 后保留文档表述。
- `docs/03-membership.md:96`：“`self` 字段与 join 请求体相同”。join 请求体还含准入字段（`workgroup_id`/`orca_node_id`/`ts`/`nonce`/`proof`），`self` 是自述子集（`src/protocol/cluster.ts:27-34`）。改成“字段即 join 请求体里的自述部分”。
- `docs/03-membership.md:142`：“1 次 join + N-1 次 join 与心跳，**全部并发**”。实现是顺序的：`serve` 先 join 再逐个 `joinRoster`（`src/cli/serve.ts:24-33`、`src/node/orca-node.ts:176-187`）；并发只发生在心跳触发的补 join。改成“顺序 join；租约到期/心跳触发时才并发补”。
- `docs/03-membership.md:181`：“冲突以本人最近一次 join 自述的端点为准”。与 `:96`/`:180` 矛盾：心跳 self 同样更新端点（`cluster-routes.ts:174-179`）。改成“以本人最近一次签名自述（join 或心跳 self）为准”。
- `docs/05-tasks.md:108`：“三张表，结构相同”。`tasks`/`dispatches` 是 `(task_id, payload, updated_at)`，`file_blobs` 是 `(blob_id, path, size, expires_at)`（`src/storage/sqlite.ts:41-46,97-104`）。改成“`tasks`/`dispatches` 结构相同；`file_blobs` 另列”。
- `docs/06-execution.md:148`：“节点自己拼的路径只有两类：`state/<wg>/sessions.json` 与 `state/<wg>/artifacts/...`”。`createWorkspaceManager` 还会建 `state/<wg>/tasks`（`src/tasks/workspace.ts:42`，目前无其他使用）。要么补进 §6.7 的目录树与“两类”表述，要么删这行 mkdir。
- `docs/07-security.md:22`：“CLI 用这里的私钥以本节点身份签名（`publish`/`fetch`）”。`publish` 是直写本机 SQLite、没有 HTTP 请求（`src/cli/publish.ts:31-44`；同章 `:26` 自己已写明）。改成“`fetch`/`send` 等出站命令签名；`publish` 直写本机数据库”。
- `docs/07-security.md:169`：“mode 不写进 grant 之外的任何持久状态”。任务视图会把元数据（含 `pod.permission_mode`）落库（`src/tasks/runner.ts:115` 合并 metadata，`src/tasks/record.ts:380-389` 持久化 view）。改成“mode 只随任务元数据落库，任务结束即失效”。
- `docs/08-reliability.md:40`：“`dispatches` 表（`task_id`、`peer`、`context_id`、`state`、`last_error`、`agent_id`、`created_at`、`updated_at`）”。表实际只有三列 `(task_id, payload, updated_at)`，其余字段在 payload JSON 里（`src/storage/sqlite.ts:42-46`、`src/protocol/dispatch.ts:5-22`）。改成“表三列；条目 JSON 含这些字段”。
- `docs/12-handoff.md:58-59`：“The protocol never carries paths (task input names are bare file names).” 任务输入已在 32dc79f 删除；任务文本现在引用 `<orca node id>/<sha256>` 名字（`src/tasks/prompt.ts`、`src/protocol/blob.ts:1-20`）。改成“…; the task text refers to shared files by their `<orca node id>/<sha256>` name”。
- `docs/README.md:4`：`Updated: 2026-11-16`，但 docs 在 b944992 / f7dada9（2026-11-18）连续改过。改成 2026-11-18。

### 已记录在 audit.md、可顺手一起改
- `docs/04-transport.md:55`：400 行里的 `blob_digest_mismatch`、`input_blob_missing`、`too_many_inputs`、`inputs_too_large` 都不在 `src/kernel/errors.ts`（400 只有 `bad_request`、`bad_echo_script`、`unsupported`、`workgroup_mismatch`、`endpoint_refused`）。
- `docs/04-transport.md:59`：413 行的 `blob_too_large` 不存在，只有 `body_too_large`。两处都是上传/任务输入时期遗留，audit.md §10.3 已记。
- `audit.md:92`（MG6）：“`protocol/constants.ts`：现在有 `DEFAULT_PORT` 与 `BODY_SHA256_HEADER` 两个常量”。文件里只有 `DEFAULT_PORT`（`src/protocol/constants.ts:2`）。

## 注释脱节

| 位置 | 现文 | 事实 / 建议 |
| --- | --- | --- |
| `src/execution/executor.ts:36`、`:38` | “Group workspace `work/` dir”、“`.pod/` dir” | 实际目录是 `workgroups/<workgroup_id>/`（cwd）与 `state/<workgroup_id>/`（`src/tasks/workspace.ts:31-32`、docs/06:118-125）。改成 `workgroups/` 与 `state/` |
| `src/storage/file-registry.ts:6-8` | “A task appends the URL of a result…”、“origin puts the URLs…” | 文件按名字传递：`<orca_node_id>/<sha256>`，不是 URL（`docs/05:125`、`blob-routes.ts:20`、`src/protocol/blob.ts:1-20`；`blob_id` 本身是纯 sha256，名字由 `blobRefText` 拼）。`:12` 的 “content-addressed URLs” 同改 |
| `src/security/grants.ts:31` | “each is also the `PodErrorCode` the task fails with” | `grant_replayed` 不在 `kernel/errors.ts` 的错误码表；且这些是拒绝原因，任务不一定以它们失败。audit.md B22 已记 |
| `src/tasks/record.ts:308` | “Ask the origin to decide on one tool (§7.11)” | 升级回路是 §7.12（docs/07:209），grant 才是 §7.11 |
| `src/tasks/record.ts:391-395` | “…leftover input directories are purged at the next start” | 输入目录机制已随 32dc79f 删除，没有任何清理逻辑 |
| `src/plugin/tools.ts:5` | “one schema rather than six” | `METHOD_NAMES` 现在 5 个：send/status/cancel/members/connect（`tools.ts:54`） |
| `src/membership/membership.ts:35` | “each orca node sends one every interval (+-20% jitter)” | 实际 ±10%（`src/membership/mesh.ts:390-392`） |
| `src/transport/gateway/blob-routes.ts:22-23` | “A node never receives bytes from another one.” | 字面与 `/cluster/blob` 相反（本机节点替 CLI 去拉字节）。本意应是“网关不接收兄弟节点推来的字节（没有上传路由）”；改成这个说法，或删掉 |
| `src/transport/gateway/cluster-routes.ts:86` | “The transport repeats the check on every connection.” | 访问筛查只在两处：join 自报端点（`cluster-routes.ts:92`）与候选拨号（`mesh.ts:340`）；`peer-client`/`net` 没有筛查。`:91` “the transport screens whatever it resolves to” 同样不对 |
| `src/transport/gateway/auth.ts:30` | “…except `public` (and link downloads)” | 没有 link 访问级/直链路由（`auth.ts:21`）；改成 “except `public`” |
| `client/index.tsx:4` | “`npm run build:client` bundles this module…” | `package.json` 没有 `build:client` 脚本；构建是 `scripts/build-client.ts`（由 `npm run build` 调用） |
| `client/index.tsx:14` | “…build on DSH's primitives (`dsh-ui.d.ts`)” | 仓库里没有 `dsh-ui.d.ts`；primitive 类型来自 devDependency 包（`client/types.ts:8-10`） |
| `cordis.patch.yml:8` | “only runtime dependency is fastify” | 见 P0 |

## 备注

- **不列入脱节**：`docs/08:53`“`input-required` 期间暂停”与 `docs/06:170`“暂停，恢复后重新计时”一致，属有意设计；`docs/07:117`“显式端点不筛查”与 `src/membership/screening.ts:13` 一致（候选筛查只对 candidate 生效）。
- **audit.md 本身已更新到 f7dada9**（含 D40 遗留 §10），除 MG6 一行外没有过时项；`docs/04` 错误码两行已在 §10.3 记录。本清单与 audit.md 的差异：本清单只回答“文字与代码是否一致”，不重复记录“代码待改进”。
- **修改提醒**（docs/README.md:42 的约定）：本轮都是“文字对齐代码”的纠正，不改变协议/语义，因此不需要同步 10.6 验收；但 P1-2（心跳 self）、P1-9（模型目录刷新）、P1-11（link 访问级）纠正后，`docs/03` / `docs/11` / `docs/09` 之间应互相对齐一次。
- 机械可解析性保持：修完可重跑 `C:\Users\kings\AppData\Local\Temp\orca-doc-scan2.mjs` 验证链接/锚点/`§` 引用不破。

## 修复状态（2026-11-18）

已按本清单全部落地（工作区改动，未 commit）：

- P0 五处：`README.md:7`、`README.md:49`、`docs/09:167`、`docs/09 §9.7` 表、`cordis.patch.yml:8-11` 都改为“运行时依赖见 `package.json`（16 项，含 11 个 `@deepseek-ai/dsh-*` 与 `cross-spawn`）”；README 两处补注：`link:` 接入本地 checkout 时依赖从该仓库的 `node_modules` 解析，需先在仓库 `npm install`。
- P1 11 条与全部 P2 布局/字段项、注释表 13 条已落实；`docs/09 §9.5` 的 `apply` 示例同步到 `src/plugin/bundle.ts:52-133` 的实际形态（统一 `logger`、`node` 闭包、`createModelCatalogFeed(ctx, logger)`、`createTracker(node, broker, logger)`、`createPodTools(handle, tracker, sandbox.current)`、`createPodAdmin(..., catalog.reasoningEfforts)`、`when: () => handle.configured`）。
- 面板第三道闸门 `403 json_required` 补进 `docs/04:28`、`docs/07:26` 与 `docs/07 §7.6` 授权矩阵行。
- 未改：`audit.md`（外部 actor 并发重构中，MG6 已由其修掉）、`src/protocol/task.ts`（外部 actor 删除 `idempotency_key`；`docs/08`/`docs/11` 已随其对）。

与清单的出入/更正：

- `cross-spawn` 的值导入在 `src/execution/acp/connection.ts:27`，不是 `src/execution/process.ts:3`（后者只在注释里提 cross-spawn，杀进程树用 `taskkill`）。
- 原 P1“面板 local-only 要求本机签名”实际在 `docs/07`（`docs/04` 原本没有这句）；`docs/04` 已改为补充说明同源桥不验节点签名。
- `dsh-agent` 在 `src` 中全部是 `import type`（`executor.ts:8`、`mesh.ts:21`、`orca-node.ts:33`、`bundle.ts:15`、`catalog.ts:17`、`tracker.ts:18`、`model.ts:10`、`meta.ts:10`），`docs/09:167` 的“dsh-agent 只做类型导入”成立。
- `docs/04:28` 链到 §7.1 正确（local-only 段位于 `docs/07:7` 起的 §7.1 内）。

验证（2026-11-18，基线 HEAD 仍 `f7dada9`）：

- `npx biome check .`：0（161 files）。
- `npx tsc --noEmit`：0；`npx tsc --noEmit -p client`：0。
- `npx vitest run --pool=vmThreads`：47 files / 386 tests passed。
- `orca-doc-scan2.mjs`：`docsProblems` []；292 个 `§N.M` 引用 0 失配。
- 旧表述 grep 0 命中：`只依赖 fastify` / `self-contained` / `BODY_SHA256_HEADER` / `childPodMetadata` / `inputDir` / `AbortSignal.timeout` / `blob_too_large` / `build:client` / `dsh-ui.d.ts` / `不需要本 checkout 的 node_modules`。

本轮不 commit；工作区为 26 个 M 文件 + 新增本文件。
