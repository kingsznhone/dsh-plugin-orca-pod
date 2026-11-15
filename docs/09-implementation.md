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
    protocol.ts       类型、错误码、orca_node_id、成员 digest、任务/peer 类型（零依赖）
    identity.ts       Ed25519 密钥对（identity.json）、orca_node_id=公钥、签名/验签
    crypto.ts         请求签名（Ed25519）、join 准入证明、nonce cache、grant 签发/校验、blob 直链签名
    config.ts         配置校验、默认值、身份注入、JSON 读写
    storage.ts        PeerStore / TaskStore 接口 + 内存实现（+ 重导出 blobs）
    blobs.ts          内容寻址 blob store（内存 + fs，含 TTL GC，流式上传/下载）
    blob_files.ts     本地文件 blob 映射（CLI 登记，网关按签名 URL 流式读取）
    dispatches.ts     origin 侧派发日志（派给谁、最后知道什么；重启标 unknown）
    events.ts         进程内变更事件总线（task / members / dispatch），面板订阅用
    sqlite.ts         TaskStore、file_blobs 与 dispatches 的 node:sqlite 实现（WAL，单进程写）
    workspace.ts      workgroup 工作区（根 = agent cwd）与网关状态目录
    membership.ts     成员记录、心跳看门狗、墓碑与修剪
    gateway.ts        HTTP：/health、Agent Card、/cluster/*、/a2a、/blobs
    executor.ts       LocalExecutor 接口 + EchoExecutor
    acp.ts            AcpExecutor（dsh acp stdio：流式事件、权限挂起、session resume、按任务选模型）
    process.ts        子进程公共件：命令解析（Windows shim）、killTree、abort 错误
    preamble.ts       编排 preamble（task id、CLI 路径、send/wait/escalate/publish 用法）
    session_store.ts  `state/<workgroup_id>/sessions.json` 读写（按 origin+context 绑 ACP session）
    tasks.ts          单槽任务运行器
    orca_node.ts      组合根：一个进程 = 一个 orca node
    harness.ts        进程内多 orca node + `waitFor` 断言 helper，测试用
    harness_run.ts    真实进程 smoke test（`npm run harness`：两个 serve、join、任务往返）
    cli.ts            `orca-node` CLI：serve / send / status / wait / members / escalate / publish / log
    orca_pod.ts       `orca-pod` CLI：install（检查 dsh、生成配置、写 systemd unit）
    install.ts        install 计划、unit 渲染与 systemd 命令（纯函数，runner 可注入）
  skills/orca-node/
    SKILL.md        标准 skill 入口（随包发布；安装到本地 skill 根后由 DSH 发现）
    references/add-machine.md  加机器到 mesh 的命令与前置条件
    plugin/           DSH bundle：Config、apply、单个 `orca_pod` 工具（`method` 分派）、后台 tracker、admin.ts（面板数据面）、web.ts（面板同源路由）、models.ts（模型目录采集）、skill.ts（可选把标准 skill bundle 复制到 user 根；`skill_injection` 默认关）
  client.js           DSH 客户端 bundle：设置页 + 侧栏按钮 + 停靠式浮层（轮询 /orca-api；首启向导 / 状态 / 设置三视图）
  test/               vitest 套件（protocol/crypto/membership/mesh/a2a/blobs/plugin/tracker/skill/approval/watchdog）
```

当前代码状态：

| 模块 | 状态 | 说明 |
|---|---|---|
| `protocol.ts` | 已实现 | 类型、错误码、任务视图、orca_node_id、digest、签名规范化 |
| `crypto.ts` | 已实现 | HKDF、请求签名、nonce cache、grant 签名/校验 |
| `chain.ts` | 已实现 | 多跳元数据（hop/chain/root）校验、祖先禁调、child grant 派生（含 Echo relay 原型的下发） |
| `config.ts` | 已实现 | 配置校验、密钥派生、JSON 读写 |
| `storage.ts` / `blobs.ts` | 已实现 | PeerStore/TaskStore 接口 + 内存实现；blob 另有 fs 实现（内容寻址、临时文件+rename、TTL GC、流式 `putStream`/`openRead`） |
| `sqlite.ts` | 已实现 | `node:sqlite`：TaskStore 与 `file_blobs` 映射都在 `<data_root>/tasks.db`，WAL、`synchronous=NORMAL`、整条记录 JSON 存储 |
| `workspace.ts` | 已实现 | `<data_root>/workgroups/<workgroup_id>/`（根 = agent cwd，含 `notes/`、`inputs/<task_id>/`）与 `<data_root>/state/<workgroup_id>/`（sessions、任务目录）；启动 `ensure()` + `purgeInputs()` |
| `membership.ts` | 已实现 | 双向看门狗、单调时钟、suspect(unreachable)、墓碑与 record_ttl 修剪 |
| `gateway.ts` | 已实现 | `/health`、Agent Card、`/a2a`、`/cluster/*`、`/blobs`（上传/下载/直链） |
| `executor.ts` | 已实现 | `LocalExecutor` 事件流接口 + EchoExecutor；真实实现只有 `acp.ts` |
| `acp.ts` | 已实现 | `dsh --profile acp` stdio（NDJSON JSON-RPC）：initialize/session/prompt/update/permission/cancel，权限挂起映射为 `input-required`，grant 回 allow-once；按任务选模型走 `session/set_config_option`（`model`，可选 `reasoning_effort`），失败 `failed(model_unavailable)` |
| `process.ts` / `session_store.ts` | 已实现 | Windows `.cmd` shim 解析、进程树终止；`state/<workgroup_id>/sessions.json` 原子读写 |
| `install.ts` | 已实现 | `orca-pod install` 的主机形态：生成配置、渲染 systemd unit、检查 `dsh --version`、交互式答案（`installQuestions`/`promptForInstall`）与执行 `daemon-reload`/`enable --now`（runner 可注入） |
| `orca_pod.ts` | 已实现 | `orca-pod` bin：`install` 子命令；裸 `install` 或仅带 `--dry-run` 是交互式向导，带任何其他参数即进入参数分支、完全不提问（`-p`/`--password`、`--workgroup`、`--dry-run`、`--system`、`--force`、`--skip-dsh-check`） |
| `tasks.ts` | 已实现 | 单槽状态机；inputs 物化/附录/终态清理、硬 TTL、简报截断、usage/错误码；TaskStore 可注入（默认内存，CLI/插件用 SQLite），启动时把非终态标 `failed(node_restart)` |
| `blob_files.ts` | 已实现 | 本地文件 sha256→路径映射（SQLite 持久化），`GET /blobs/:id` 按映射流式读取 |
| `dispatches.ts` | 已实现 | origin 侧派发日志（`dispatches` 表）：记录 peer/状态/父任务链接，重启把非终态标 `unknown`，`orca-node log` 可读 |
| `events.ts` | 已实现 | 进程内事件总线：`task`（每次状态变更）、`members`（名单/状态/busy/模型目录变化，按签名去重）、`dispatch`（派发落库）；listener 抛错被隔离 |
| `plugin/models.ts` | 已实现 | 从 DSH Host 的 `llm`（providers × listModels）与 `agentDefaultModel.currentSelection()` 采集模型目录；坏 provider 只 warn；结果经 `setModelCatalog` 写进 self record（含本地 effort pin）；纯 CLI 节点用 config 手填 |
| `orca_node.ts` | 已实现 | 组合根；启动/停止心跳循环，装配 PeerStore 门面与任务运行器；origin 日志 upsert 与 child-link 轮询（自动上升）；`listTasks`/`subscribe`/`blobLink`/`workspacePaths` 供面板读 |
| `harness.ts` | 已实现 | `createMesh`、`joinRoster`（按目录 best-effort 加入）、`waitFor`；mesh/A2A/discovery/formation/transport 测试 |
| `harness_run.ts` | 已实现 | 真实进程 smoke：两个 `orca-node serve`、`--peer` 引导 join、CLI members 收敛、Echo 任务到终态、清理临时目录 |
| `plugin/` | 部分实现 | `apply` 启动 orca node、注册单个 `orca_pod` 工具（`method` 分派 send/status/cancel/approve/members/connect）；后台 tracker 轮询终态并 `inject`/`followup`；权限请求由 tracker 直接 park 进 `prompts` 注册表（`onPermission`），原始请求文本不进入对话，UI 三通道（会话聊天卡/后台弹窗/面板）作答、无超时；`admin.ts` 提供面板数据面（成员/任务/审批/工作区/产物直链，审批不经模型）；`web.ts` 在 DSH web 同源注册 `/orca-api`（仅回环）；`lifecycle.ts` 支持 UI 保存配置与重启（`<data_root>/ui-config.json` 覆盖层）和 UI 直连 peer；`client.js` 是注册设置页/侧栏按钮/停靠浮层的客户端 bundle；标准 skill bundle 在 `skills/orca-node/`，可选 `skill_injection` 复制到 user 根；credentials 读取未做 |
| `ui`（独立前端） | 未开始 | 目前面板是 DSH Settings 里的一页；将来若要独立窗口/路由，仍放在同一包内（`src/ui/` 或独立 client 入口），发布物不增加依赖 |

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
executor  ← tasks, acp
acp       ← orca_node   （AcpExecutor 只依赖 executor 的接口）
process   ← acp   （命令解析与杀进程树，不知道 ACP 协议）
session_store ← acp   （只读写 state/<workgroup_id>/sessions.json）
install   ← orca-pod   （只依赖 config.ts 的 createOrcaNodeConfig；不 import gateway/executor）
tasks     ← orca_node
orca_node ← harness, plugin
```

`gateway` 通过构造参数拿到 `TaskRunner` 接口实例，而不是 import executor 或具体实现——这是“gateway 能单独测”的前提。

`orca_node.ts` 是装配 orca node 的库根，与 Node.js 运行时无关；命名里带 orca 就是为了让 import 和 grep 一眼分清。

HTTP 层用 Fastify 承载：路由、JSON 解析、`bodyLimit`、`trustProxy`、错误处理都用它现成的，不手写 http server。

### 9.2 面板（数据面 + 同源桥 + 设置页）

将来 UI 面板需要的每个数字都应该从 Host 侧同步取到，而不是先让模型调一次工具再转述。为此库根暴露四个只读入口，插件再把它们打包成 `PodAdmin`：

| 入口 | 位置 | 内容 |
|---|---|---|
| `listTasks(limit?)` | `orca_node.ts` | 本机任务（inbound），内存记录按新到旧在前，持久 store 回填历史；返回完整 `TaskView` |
| `subscribe(listener)` | `orca_node.ts` → `events.ts` | `task`（每次状态/权限变化）、`members`（名单、state、busy 持有者、endpoints 变化；按签名去重，心跳周期内不重复）、`dispatch`（origin 侧派发落库） |
| `blobLink(blobId, ttlS?)` | `orca_node.ts` | 与 `POST /blobs/:id/link` 同形的签名直链（`?exp&sig`），面板直接 `<a href>` 下载产物 |
| `workspacePaths()` | `orca_node.ts` | workgroup 根、`notes/`、`inputs/`、`state/` 路径；`admin.workspace()` 再附一层浅列表 |

`createPodAdmin(handle, tracker, { prompts })` 组合出面板 API：`members()`（完整 `PeerView`，含 busy/runtime/last_recv_at/max_task_ttl_s）、`tasks()`、`dispatches()`、`task(peer, id)`、`approvals()`（tracker 里正挂权限请求的任务）、`prompts()`（被 `orca_pod` 的 `approve` 方法 park 住的审批请求）、`approve(peer, id)` / `deny(peer, id, reason?)`（先 `prompts.resolve` 唤醒被 park 的工具调用，再等任务离开 `input-required`；没有 park 的调用时才直接走 `OrcaNode.approveTask`，不经过模型与工具轮次）、`artifacts(view)`（附 `blobLink` URL）、`workspace()`、`subscribe()`（合并节点事件与 tracker 更新）。

面板用轮询兜底即可，事件只是降低延迟：`orca_pod` 的 `members` 方法也返回 busy/runtime/last_recv_at/max_task_ttl_s，不再裁剪成四个字段；`connect` 方法供会话内 agent 主动加入一个还没出现在成员表里的节点（例如刚跑完 `orca-pod install` 的服务器），成功后把 peer 记入 `ui-config.json` 并返回刷新后的成员表，`peer` 接受裸 host / host:port / 完整 URL（默认端口 11811）。审批本身是一条通道、三个落点（见 §9.2.2 的 `prompts`）：会话内聊天卡、后台会话弹窗、面板列表，三者最终都调用 `PodAdmin.approve/deny`，不存在“无 UI 回退原生卡”的分支。tracker 侧走 `onPermission` 直接把 prompt 放进注册表（回调和远端 approve/deny 绑定），agent 不接触原始请求文本；任务终态 `onSettled` 收回卡片。

**UI 改配置与连接 peer**：`PodAdmin.config()` 给出去敏视图（`workgroup_id`、`display_name`、`port`、`endpoints`、`detected_endpoints`、`peers`、`running`、`password_set`，**永不返回密码**；`display_name` 在节点运行时回退为 orca node id）；`saveConfig(patch)` 把可编辑项写进 `<data_root>/ui-config.json`（`{setup_complete, workgroup_id, workgroup_password?, display_name, port, endpoints, peers, task_timeout_s?, approval_timeout_s?, result_max_bytes?, max_input_files?, max_input_bytes?, allow_public_peers?, allow_loopback_peers?, permission_mode?}`；高级项传 `null` 表示清除 override、回到默认），再按“bundle 配置 + override”合并并复验，串行地停掉旧节点、用合并后的配置重启——orca node 身份（`config.json`，按 workgroup 复用）不变。`workgroup_id` 或 `workgroup_password` 为空时节点保持空闲（不启动、不报错），首屏就是向导；面板填好后 `reconfigure` 才启动。换 `workgroup_id` 时省略 `workgroup_password` 会沿用当前密码（密码是本地秘密，不绑定某个工作组）；只有显式传空串会被拒绝（不支持无密码 mesh）。`connect(peer)` 先把地址归一化（裸 host/IP 补 `http://` 与默认端口 `11811`；`host:port`、带 `http(s)://` 前缀的完整 URL 原样保留、缺端口时按 scheme 用 80/443；裸 IPv6 自动加方括号；拒绝带路径/查询串或非法端口），再立即 `join` 一次并把 peer 记入 override（不需要重启），失败只回错误、不落盘；`disconnect()` 调 `OrcaNode.leave()` 通知已知 peer 后清空本地 peers 并落盘；`reset()` 删除 `ui-config.json` 与 `config.json`（不动 `state/`、blob、工作区），再按 bundle 配置重启或保持空闲，`uiConfigured` 回到 false，面板因此回到首启向导。`detected_endpoints` 由 `os.networkInterfaces()` 枚举非 internal 的 IPv4/IPv6（跳过 `fe80::/10`，IPv4 在前）拼成 `http://<addr>:<port>`，给向导做地址行初值；面板设置视图会丢掉 loopback-only 的 advertised 列表改用识别结果。插件默认 `bind_host: "::"`，使局域网 peer 能直连；核心库默认仍是 `127.0.0.1`（CLI/脚本按需显式绑）。`ui-config.json` 只由回环闸门后的面板路由写入，不改 profile 的 `cordis.patch.yml`；`setup_complete=true` 之前面板首屏是向导。

设置视图在地址列表下方有一个可折叠的**高级设置**段落（本地连接/超时精细控制，保存会重启节点）：任务超时上限（秒）、审批等待超时（秒，留空永久等待）、结果简报上限（字节）、单任务输入文件数上限、单任务输入总大小（MiB）、公网候选节点/回环候选节点（默认/允许/拒绝三态）、本机权限上限（`read-only`/`workspace-write`/`danger-full-access`）。留空提交 `null`：override 里删掉该键，并同时从持久化的 `config.json` 清除，避免旧值残留；`permission_mode` 仍与 bundle 的本地上限取窄。地址列表的界面名称改为“本地节点地址”（协议层字段仍叫 advertised endpoints，§3.2）。

#### 9.2.1 同源桥（`plugin/web.ts`）

第三方 bundle 不能 import Host 包，也没有 Typert Remote 的生成流程，所以面板不声明 RPC，而是在已经运行的 DSH web 服务上注册一条同源前缀路由（与 `billion-context` 的做法一致）：

| 路由 | 方法 | 内容 |
|---|---|---|
| `/orca-api/state` | GET | 一次轮询拿全量：`self`、`config`、`members`、`tasks`（最近 50）、`dispatches`、`approvals`、`prompts`（被 park 的 `orca_pod` `approve` 方法请求）、`artifacts`（按任务）、`workspace`、`now`；任务详情模态直接复用这份快照 |
| `/orca-api/task?peer=&task=` | GET | 单任务详情 + 该任务的产物直链 |
| `/orca-api/tasks?limit=` | GET | 全部任务视图：本机任务（`limit` 默认 500、钳 1–1000，新到旧）+ dispatch 日志（取最新 `limit` 条）+ 按任务的产物直链；面板「最近任务」只显示前 5 条，点「全部任务」打开该数据源的模态列表 |
| `/orca-api/config` | GET / POST | GET 返回去敏配置视图（含 `detected_endpoints` 与 `advanced`）；POST `{workgroup_id?, workgroup_password?, display_name?, port?, endpoints?, peers?, task_timeout_s?, approval_timeout_s?, result_max_bytes?, max_input_files?, max_input_bytes?, allow_public_peers?, allow_loopback_peers?, permission_mode?}` → `PodAdmin.saveConfig`（写 override 并重启节点；高级项传 `null` 清除；`workgroup_id` 为空时保持空闲） |
| `/orca-api/connect` | POST | `{peer}` → `PodAdmin.connect`：先归一化地址再立即 join 并把 peer 记入 override，不重启 |
| `/orca-api/disconnect` | POST | `{}` → `PodAdmin.disconnect`：通知已知 peer `leave`、清空本地 peers，不重启 |
| `/orca-api/reset` | POST | `{}` → `PodAdmin.reset`：删除 `ui-config.json` 与节点身份 `config.json`，按 bundle 配置重启（workgroup 为空则保持空闲），面板回到首启向导 |
| `/orca-api/approve` / `deny` / `cancel` | POST | `{peer, task_id, reason?}` → 直接调 `PodAdmin` 对应方法，不经模型 |

注册走 `ctx.inject(['webServer'], sub => sub.effect(() => sub.webServer.register({kind:'prefix', path:'/orca-api', handler})))`；没有 web 服务的宿主（ACP/CLI）直接跳过，不影响启动。路由只接受回环连接（`socket.remoteAddress` 必须是 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`）且拒绝带 `x-forwarded-for`/`forwarded`/`x-real-ip` 的请求，因此面板不会因为反向代理或多网卡把审批面暴露出去——和 `/cluster/child-link` 同一原则：本地能力信传输层，不信任签名身份。

#### 9.2.2 客户端 bundle（`client.js`）

包根 `client.js` 是 DSH 客户端 lazy-CJS 工厂：`window.__ModuleLoader__.load({id:"orca-pod", factory(require){…}})`，factory 内只 `require('react')`，返回 `{inject:['slots'], apply}`；`apply` 注册五个 Slot：

| Slot | id | 作用 |
|---|---|---|
| `settings.section` | `orca-pod` | 一页设置面板（order 60，排在 Plugins 之后）。首页按状态展示待审批/最近任务/成员/工作区；成员列表只显示名称、忙碌与模型（在线用正常文字色、suspect 标黄、offline 不展示），点「详情」打开节点详情（ID、状态、忙碌、最近心跳、单任务预算、运行环境、默认/可用模型、自报地址） |
| `sidebar.footer.action` | `orca-pod` | 侧边栏底部 Settings 旁的动作按钮（面板收起时只显示 `◈` 图标，`wide` 时带文字）；按钮同时是状态灯：有挂起审批为橙黄、有在线成员为绿、未连接为灰，悬停提示待审批数量 |
| `shell.overlay` | `orca-pod.panel` | 居中模态浮层（`padding:24`、半透明遮罩）；点侧边栏按钮打开，按 Esc、点遮罩或 `×` 关闭 |
| `conversation.input.dock` | `orca-pod.approval-dock` | **当前会话**里被 park 的审批请求：聊天卡（按 `prompt.agent_id` 匹配本会话；卡片宽度铺满输入列、无浮层阴影，紧贴 composer 上方），卡上允许/拒绝/在面板中处理 |
| `shell.overlay` | `orca-pod.approval-popup` | **后台会话**的审批请求：框内右下弹窗（不受当前会话过滤），同样允许/拒绝/在面板中处理 |

设置页与浮层共用同一份 `Panel`，面板按状态分三视图：`ui-config.json` 未完成设置时是**首启向导**（workgroup 预填 `WORKGROUP`、保存时统一转小写、密码必填（留空则节点保持未配置、向导要求填写）、显示名初值 = 本节点的 orca node id（每个节点唯一；bundle 默认配置不再带共享 `display_name`）；advertised endpoints（界面名“本地节点地址”）是一行一个可增删的输入框，初值来自 `detected_endpoints`；不再填 peers）；否则第一屏是**集群状态**（自身/成员/待审批/最近任务/工作区），右上 `⚙` 进入**设置视图**，右上另有**连接/断开**：未加入 mesh 时点“连接”展开 host+port 表单（自动拼 `http://host:port`，IPv6 加方括号），已加入时按钮变为“断开”。浮层是居中模态（遮罩 + Esc/`×` 关闭），卡片宽 `min(720px, 100vw-48px)`、高 `min(78vh, 820px)`，内容超出时卡片内部滚动。面板每 2s `fetch('/orca-api/state')`；审批与取消按钮直接 POST，保存配置后自动回到状态页。审批请求来自 `state.prompts`（`orca_pod` 的 `approve` 方法 park 在 Host 的 `prompts` 注册表里，不设超时，见 §7.12 第七版）：`ApprovalDock` 只渲染 `agent_id === 本会话 sessionId` 的请求，并维护模块级 `activeSessionId`；其余会话的请求由 `ApprovalPopup` 弹出，三个落点共用同一决议通道。文案跟随 DSH 桌面语言：`apply` 里用 `ctx.get("locale")` 取 `locale` 服务，active 以 `zh` 开头用中文，否则英文（`locale.subscribe` 触发重渲染，`useLocaleTick` 挂在 `Panel`/`OverlayPanel`）。样式只用内联对象与 `--dsw-alias-*` 主题 token（字号/圆角对齐 DSH 设计平台 `--dsw-font-*`/`--dsw-radius-*`）：卡片背景 `--dsw-alias-bg-layer-1`、遮罩 `--dsw-alias-bg-mask-1`、输入框 `--dsw-specific-input-major`，随明暗主题自动切换；不写 `document.body`，卸载时清理定时器。

集群状态首屏还会显示自己的忙碌行（`busy · 任务 id · 来自 <节点>`，悬浮显示完整 task_id），成员表的忙碌列同样带完整 task_id 的悬浮提示；最近任务把本机任务与派发到 peer 的任务合并（`state.tasks` + `state.dispatches` 里不在本机任务列表中的记录，按时间倒序；dispatch 行的来源列显示目标节点的显示名（成员表按端点解析，未知时回退 `host:port`）、状态与 age），首页只取**前 5 条**，标题右侧「全部任务」按钮会 `GET /orca-api/tasks?limit=500` 打开一个更大的模态列表（同一份合并逻辑、可滚动；每行末列是「详情」按钮、运行中另有「取消」，该请求失败显示在模态内部）。首页最近任务不显示产物列（产物只在任务详情的「产物」段展示）；点本行或末列「详情」打开**任务详情**模态：状态、来源、上下文、更新时间、reason、hop/root、usage、状态消息文本、派发日志（`dispatches` 里的对应条目）、产物直链与本次任务的 inputs 文件名；点 dispatch 行会 `GET /orca-api/task?peer=&task=` 向目标节点拉一次任务视图再打开同一模态（读取失败按打开位置显示：模态内出错留在模态，主页面行出错显示在面板顶部）。本机任务的数据全部来自每 2s 的 `/orca-api/state` 快照（单行 `tasks` + `dispatches` + `workspace.inputs_dirs` + `artifacts`），打开详情不发额外请求。

清单接线：`package.json` 的 `exports["./client"] = "./client.js"`、`dsh.client = {platform:"web", immediately:true}`、`files` 含 `client.js`；Host 侧 `apply` 把 `createPodAdmin(handle, tracker)` 传给 `registerPodWeb`。

### 9.3 每个模块怎么测

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
| `install.ts` | 临时目录 + 注入 `CommandRunner` | systemd plan 与引号（含 `--peer` 注入）、`dsh --version` 检查、交互式问题只在需要写新配置时出现、配置只生成一次且 0600、`--dry-run` 不执行命令 |
| `acp.ts` | 假 ACP server（`test/fixtures/fake-acp.mjs`，模式 ok/permission/hang/resume-fail） | 完成文本、cwd、权限挂起→grant→继续、`session/cancel`、session 复用与重启 `session/resume`、启动失败即 `failed` |
| `tasks.ts` | 假 executor + 注入时钟 | 单槽、TTL、取消 |
| `harness.ts` | 多 orca node mesh + 可注入时钟 | 成员收敛、故障、任务往返 |
| `plugin/` | 假 DSH host 的 smoke | 工具注册、生命周期 |
| `plugin/prompts.ts` | 纯内存注册表 + 假节点 | park 请求、面板 resolve 唤醒 `orca_pod` 的 `approve` 方法、tracker `park` 的 `onDecision` 回调、`withdraw` 收回、同任务替换、unload 时 `cancelAll`、subscribe 通知 |
| `plugin/web.ts` / `client.js` | 假 `PodAdmin` + 假 req/res | 状态/配置快照（含 `prompts`）、回环与转发头拒绝、approve/deny/cancel 直通、config 保存与 connect/disconnect/reset、路由注册与 `effect` 清理 |
| `lifecycle.ts` + `plugin/admin.ts` | 临时 `data_root` 起真实 orca node（port 0） | 首启未配置→reconfigure 写 `ui-config.json` 并重启保身份、空 workgroup 时保持空闲（向导）→填好后启动、重启后加载 override、live join 持久化、失败 peer 不落盘、disconnect 后清空并落盘、reset 删除两份配置并回到向导、admin 不返回密码、换组沿用原密码、peer 归一化、`detected_endpoints` 与显示名回退 node id |

`orca-pod install` 已实现：生成 `config.json`（0600、`executor: "acp"`）并写 systemd unit 常驻 `orca-node serve`；`--peer <url>`（可重复）把启动 join 目标写进 unit，`--endpoint` 覆盖广播地址，`--env-file <path>`（可重复）写 `EnvironmentFile=`（例如装 API key 的 0600 文件）、`--env KEY=VALUE`（可重复）写 `Environment=`（例如 ACP 子进程依赖的 `PATH`）；用户级 unit 在无头服务器上需要 `loginctl enable-linger $USER`（安装结束会提示）。裸 `orca-pod install` 或只带 `--dry-run` 是交互式向导（workgroup id、密码隐藏输入、监听地址与端口），**只要再带任何其他参数就进入参数分支、完全不提问**（缺少 workgroup/密码直接报错退出，适合 agent 通过 SSH 调用；密码用 `-p`/`--password` 传入，程序不读 stdin，避免 SSH 调用被挂住）；`--dry-run` 只打印计划，`--skip-dsh-check` 跳过 `dsh --version` 检查；命令不提供 web 模式（要面板的用户自己装 dsh 再从 Web UI 装插件）（`test/install.test.ts` 20 条）。实际跑通的测试：protocol 32 个、crypto 23 个、membership 5 个、mesh 1 个、a2a 8 个、blobs 13 个、blobs-fs 5 个、storage-sqlite 3 个、workspace 5 个、inputs 7 个、persistence 2 个、plugin 15 个、tracker 13 个、skill 4 个、approval 12 个、approval-prompts 6 个、chain 12 个、acp 12 个、cli 11 个、escalation 5 个、watchdog 2 个、discovery 2 个、formation 6 个、transport 4 个、permission-mode 7 个、acceptance 4 个、ssrf 9 个、limits 6 个、dispatches 4 个、relay-auto 2 个、endpoint 4 个、multi-endpoint 2 个、heartbeat-adaptive 5 个、heartbeat-admission 2 个、ui-surface 4 个、web 15 个、panel-config 15 个、model-selection 5 个、install 23 个，共 315 个、39 个测试文件（`npm test`）。gateway 与 executor 的行为由 `test/a2a.test.ts` 经真实 HTTP 覆盖，插件配置/工具注册契约由 `test/plugin.test.ts` 覆盖，orca node 重启后的持久化与恢复由 `test/persistence.test.ts` 覆盖，面板配置/override/连接 peer 由 `test/panel-config.test.ts` 覆盖，审批 park/唤醒由 `test/approval-prompts.test.ts` 覆盖。

### 9.4 进程内多 orca node

`orca_node.ts` 的 `createOrcaNode({ config })` 返回 handle：`start() / stop() / self() / members() / membersDigest() / join(peerUrl) / heartbeat(peerUrl) / sendTask(peerUrl, input) / getTask(peerUrl, id) / cancelTask(peerUrl, id)`。

- 端口用 `0` 让系统分配，避免并行测试抢 11811；`start()` 返回实际 `url` 与 `port`。
- harness 目前有 `createMesh({ orcaNodes, workgroupId, password, basePort, displayNamePrefix, dataRoot, timings, fetch })`，返回 `{ orcaNodes, urls, stop() }`。它启动 orca node 后让每个 orca node join 第一个 orca node、用 `joinRoster` 按返回目录 best-effort 补 join，再对 bootstrap 发一轮心跳。
- 已支持：可注入时钟（`createOrcaNode({ clock })`）、可注入 transport（`createOrcaNode({ fetch })`，模拟丢包、延迟、单向阻断）、orca node 启停（`start()` / `stop()`）、进程内 mesh、真实 HTTP（gateway / A2A / blob 测试直接 listen + fetch，不 mock）。抖动场景的窗口按心跳间隔的倍数给（延迟 0.3–2.5 个间隔、丢包 30 个间隔、单向阻断 15 个间隔、全断 5 个间隔），不按绝对毫秒。
- 跨进程：`npm run harness` 起两个真实 `orca-node serve` 子进程（第二个用 `serve --peer <url1>` 在启动时 join），用 CLI 观察 members 收敛、派一个 Echo 任务并等到终态，最后清理临时数据根；退出码即结果。
- 公共 helper：`waitFor(probe, done, { timeoutMs, intervalMs, label })` 从 `src/harness.ts` 导出，进程内与真实进程 smoke 共用。
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

### 9.5 组合入口：库根在 `orca_node.ts`，安装根是整个包

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
  if (config.skill_injection) void installSkill()  // 标准 skills/orca-node bundle 幂等复制到 user 根（默认关）
  ctx.effect(() => async () => { tracker.stop(); await stopPod(handle) }, "orca-pod.orca-node")
  for (const tool of createPodTools(handle, tracker, { approval: ctx.approval })) ctx.tools.register(tool)
  // 密码：原型阶段从 patch config 读；生产应改为 ctx.credentials.readRecord('orca-pod')
}
```

三条约束：

- `apply` 必须快速返回：`start()` 异步，端口占用/证书问题写日志与状态页，不能让 DSH 启动卡在网络监听上。
- 配置分两类：`workgroup_id` / `port` / `display_name` 走普通 config（Plugin manager 可改，`configEditor.edit` 持久化）；**密码生产上应进 `ctx.credentials` 记录，不进 config**，也不写进 bundle patch。Phase 0 为了能跑，密码暂在 patch 里（见 README 的安全提示）。
- 进程内嵌、不开子进程；DSH 退出 → cleanup → listener 关闭。工具注册用 `inject: ['tools']`；审批走插件自己的 `prompts` 注册表（UI 三通道）（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）：tracker 看到 `permission_request` 强制 `followup`，模型调用 `orca_pod` 的 `approve` 方法，工具在 open turn 内弹卡，再把决定回成同一 task 的后续 message。

harness / CLI 是第三个入口：包内 bin `orca-node`（`src/cli.ts`）有 `serve` 与客户端子命令 `send`/`status`/`wait`/`members`——`serve` 加载配置 → `createOrcaNode` → `start()`；客户端子命令读同一份 `config.json`（`--config` 或 `--data-root`），用本 orca node 身份签 `Pod` 头，直接打本机或对端的 `/a2a`（`--peer`），`--text -` 从 stdin 读任务文本，`--json` 输出结构化结果，`wait` 的退出码 0/1/2/3 分别表示终态成功/失败/仍在跑/需权限，供 ACP 会话里的 agent 用 shell 调用；`AcpExecutor` 在 prompt 前注入的 preamble 就指向这个 CLI。`scripts/cross.ts` 提供 serve/join/task/blob 跨进程、跨机联调命令；`scripts/sync-guest.ps1` 把当前提交（`git archive HEAD` + `scp`）同步到 Hyper-V guest 并在远端 `npm install`，保证跨机验证的两端代码一致（只同步已提交内容，未提交改动不会过去）。两者都复用同一个 `createOrcaNode`，不依赖 DSH。`--nodes` / `--scenario` 这类 harness CLI 尚未实现。

一句话：**装进 DSH desktop 的东西 = `orca-pod` 这一个包；它被 Loader 激活后执行 `apply()`，`apply()` 里唯一的重活是 `createOrcaNode()`。**

**Phase 0 现状**：库根 `createOrcaNode` 与安装根 `orca-pod` bundle 都已可用。bundle 有 `cordis.patch.yml`、`Config`（Standard Schema）、`apply(ctx, config)`：非阻塞启动 orca node、`ctx.effect` 清理、注册单个 `orca_pod` 工具（`method` 分派 send/status/cancel/approve/members/connect，均不阻塞）。`send` 成功后在插件侧登记任务，`createTracker` 每 1s 拉一次 `tasks/get`，终态在 2s 窗口合并成一条 notice；`agent.status === "running"` 时 `inject()`，idle 时 `followup()` 唤醒，连续唤醒预算 3；`permission_request` 不受预算限制强制 `followup`，`approve` 方法在 open turn 内弹 DSH approval 卡片并回 grant/deny（[§5.2](05-tasks.md#52-任务回报)、[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。已用 DSH 自带 Node 运行时做过两个 orca node smoke（join、send、status、cancel、重启后 orca_node_id 不变）。包自包含（运行时只依赖 `fastify`），`npm pack` 产物不含任何内部私有依赖。未做：client bundle/locale、`ctx.credentials` 读取（原型阶段密码暂放配置）、“用户发过新消息就重置唤醒预算”（当前只看 agent 当前状态）。

### 9.6 工程约定

- TypeScript、ESM、Node ≥ 24（开发机为 26）；npm（不用 pnpm；单包，`npm install` 在仓库根目录一次装齐）；vitest；`tsc --noEmit` 进 CI。
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

  `task` 支持 `--echo '<json>'` 传入自定义 Echo 脚本，`--auto-resume true` 在 `input-required` 后自动补发恢复消息。跨机时把可达地址写进 config 的 `endpoints`（有序列表，例如 `["http://192.168.1.11:11811"]`，可再加公网 URL）；`serve` 不会覆盖显式配置。

### 9.7 依赖选型：基础能力不自己写

原则：路由、解析、校验、日志、CLI、原子写、id 生成这类“基础功能”直接用成熟包；自己写的只有**协议语义**——签名规范化、任务状态机、单槽、成员 digest、grant、blob 生命周期。这些是本项目的全部价值，也没有包能替。

| 能力 | 选型 | 说明 |
|---|---|---|
| HTTP 服务 | `fastify` | 成熟、插件生态、schema 校验、`trustProxy`、`bodyLimit`；不手写 http server 与路由 |
| 参数校验 | `zod` + `fastify-type-provider-zod` | `protocol` 包统一用 zod，服务端复用同一套 schema |
| 结构化日志 | `pino` / `pino-pretty` | 低开销、字段化；测试里可静音 |
| 小 JSON 状态 | `lowdb` + `steno` | 原子写、无数据库；存成员缓存、配置、GC 标记 |
| 任务存储 | `better-sqlite3` | 同步 API、稳定；替代方案 `node:sqlite` |
| 文件原子写 | `write-file-atomic` | blob 落盘与 manifest；避免手写 rename+fsync |
| id 生成 | `ulid` | `task_id` 单调可排序；`orca_node_id` 由 `identity.ts` 从 Ed25519 公钥生成 |
| HTTP 客户端 | 内置 `fetch`（undici） | 不引 axios；测试用 `undici` MockAgent 或 `msw` |
| 重试/退避 | `p-retry` | 只在客户端（模型/UI）用；服务端仍然不自动重试 |
| 假时钟 | `@sinonjs/fake-timers` | 心跳阈值与 `at_ms` 的单测；配合注入的 `Clock` 接口 |
| 构建/开发 | `tsup`、`tsx` | ESM 输出 + 直接跑 TS |
| Lint/format | `biome` | 一个工具，配置在根目录 |
| CLI | `commander` | harness 与 orca node 启动参数 |
| MIME/文件名 | `mime-types`、`sanitize-filename` | blob 下载 `Content-Type` 与 `Content-Disposition` |
| 限流 | 不做（局域网自用） | 若暴露公网，在代理层（Caddy/nginx）做 |
| SSE（Phase 4） | `fastify-sse-v2` | 只在做 `message/stream` 时引 |

**Phase 0 实际依赖**：运行时只有 `fastify`（在一个包里，随包发布）；开发依赖只有 `typescript`、`vitest`、`@types/node`。表中的 `zod`、`pino`、`lowdb`、`better-sqlite3`、`commander`、`tsup`、`biome` 等是目标选型，尚未安装。

明确不引的：认证/签名框架（没有比 30 行 Node `crypto` 更合适的）、DI 容器、ORM、消息队列、服务网格。集群只有十台机器，这些是负资产。

### 9.8 与路线图的对应

- Phase 0：单包内 protocol、crypto、config、storage、gateway、executor(echo)、tasks、orca_node、harness、plugin。
- Phase 1：harness 覆盖成员收敛与故障场景（vitest 用例）。
- Phase 2：持久化底座（SQLite task store、fs blob + GC、group 工作区与 cwd 绑定）、ACP、AcpExecutor。
- Phase 3：plugin 的审批卡片、权限。
- Phase 4：10 个 orca node 压测复用 harness；`orca-pod install` 把主机节点注册成 systemd 常驻服务（`orca-node serve`；面板形态由用户自己装 dsh 并加插件）。

**实际状态**：protocol、crypto、config、storage（内存 + SQLite/fs）、workspace、gateway（含 blob 路由）、tasks、orca_node、harness、plugin（含后台 tracker/唤醒）、executor（Echo + ACP）已实现；面板已实现（数据面 `events.ts` + `plugin/admin.ts`、同源桥 `plugin/web.ts` 的 `/orca-api` 含 config/connect/disconnect、客户端 `client.js` 的三 Slot 与首启向导/状态/设置三视图、`lifecycle.ts` 的 `<data_root>/ui-config.json` 覆盖层与 UI 改配置/连接/断开 peer/完全重置、空 workgroup 或空密码时节点空闲等向导填写、endpoints 行编辑与 `detected_endpoints` 初值、显示名留空回退 node id；`test/ui-surface.test.ts`、`test/web.test.ts`、`test/panel-config.test.ts`）；InProcess executor、独立风格的前端（`src/ui/`）未开始。Phase 1 的心跳循环、双向看门狗、单调时钟、墓碑修剪与候选端点扩散（摘要差异回目录、404 重 join）已实现；传输注入（丢包/分区）已用于 test。Phase 2 的持久化底座（`node:sqlite` task store、fs blob store + TTL GC、workgroup 根（agent cwd）与 `state/` 分离、任务 inputs 物化、流式 blob、重启恢复）已实现；ACP 是唯一的真实执行路径（Echo 只作调试脚本机）；AcpExecutor 已用假 ACP server 验证协议映射、权限挂起→grant→继续、取消与 session 复用/重启 `session/resume`，并在 Windows 本机用真实 `dsh --profile acp` + 模型凭据跑通端到端（`scripts/e2e-acp.mjs`：一个任务 `completed`、文本 `pong`）；`orca-node` CLI 的 send/status/wait/members/escalate/publish/log 与 ACP 共享 preamble 已实现（`test/cli.test.ts` 11 条（含 `send --echo` 脚本），`publish` 直写本机 SQLite、无 HTTP 登记路由，`send --file` 上传附件，`send --local-task` 登记自动上升）；跨进程 harness 已实现（`npm run harness`：两个真实进程、join、任务往返）；origin 侧任务日志已实现（`dispatches` 表、重启标 `unknown`、CLI `log`）。按任务选模型已实现：节点自述 `models`/`default_model`/`default_reasoning_effort`（join/心跳/成员记录，参与 digest），`orca_pod` 的 `send` 方法的 `model`/`reasoning_effort` 与 CLI `send --model`/`--reasoning-effort` 写进 `metadata.pod.model`，ACP 在 prompt 前用 `session/set_config_option` 落地模型、并仅在有效 effort 存在时设置 effort（DeepSeek 模型会拒绝空串 provider-default 值），有效值 = 任务值 ?? 本地默认（config/面板高级设置），其他执行器明确 `failed(model_unsupported)`（[§6.15](06-execution.md#615-按任务选择模型)，`test/model-selection.test.ts`、`test/acp.test.ts` 覆盖）。Phase 3 的审批回路第一版（grant 用 origin 节点 Ed25519 私钥签发、公钥校验 签发/校验、`permission_request` 载荷、`orca_pod` 的 `approve` 方法在 open turn 内调 DSH approval、批准/拒绝/篡改/过期/非 origin 测试）已实现；链式逐跳升级、收窄与自动上升已实现（`chain.ts` + `tasks.escalate` + origin 侧 child-link 轮询，`test/chain.test.ts`、`test/escalation.test.ts`、`test/relay-auto.test.ts`），`permission_mode`/`limits` 收窄仍未开始。

---
