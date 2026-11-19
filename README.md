# orca-pod

分布式 DSH 对等集群（DSH 插件形态）。设计文档入口：[docs/README.md](docs/README.md)。

- 目标：2–10 台自己的机器，跨 Windows/Linux，互相派任务、回传结果。
- 形态：full mesh、明文 HTTP + 前置代理终止 TLS、A2A 任务面、按名字（`<节点 id>/<sha256>`）拉取的文件。**只有 DSH 插件这一种运行形态**：一台机器一个 orca 节点（“这台机器上装的 DSH 可以被连接”），所有 DSH profile 共用同一个节点；没有独立运行的 `orca-node`、没有 CLI、没有 `install`。
- 代码：单包 `orca-pod`，入口只有 DSH host bundle；运行时依赖见 `package.json`（16 项：`fastify`、`zod`、`ulid`、`cross-spawn`、`@agentclientprotocol/sdk` 与 11 个 `@deepseek-ai/dsh-*` 子包），自研模块在 `src/`，随包发布的是编译后的 `lib/`（`npm run build`）；本地 checkout 用 `link:` 接入时先在仓库里 `npm install`，依赖从该仓库的 `node_modules` 解析（从安装包安装则依赖随包解析）。
- 验收：`npm run check`（biome + tsc + vitest）。

## 布局

```text
orca-pod/
├── package.json          # 单包清单：dsh.bundle.patch -> cordis.patch.yml；exports -> lib/
├── cordis.patch.yml      # DSH 行：id orca-pod、name 'orca-pod'
├── client/               # DSH 客户端（面板：设置页、侧栏按钮、审批卡片）的 TSX 源码，构建到 lib/client.js
├── locale/               # Plugin Manager 显示元数据（en.json / zh.json）
├── icon.svg              # 插件图标（随包发布）
├── biome.json            # lint + format
├── docs/                 # 设计文档（12 篇 + DECISIONS）
├── scripts/              # cross.ts（跨机器手测）、harness_run.ts（进程内两个节点走真实回环网络的 smoke）、e2e-acp.ts（真实 dsh 冒烟）、build-client.ts（客户端 TSX 构建）；开发脚本，不随包发布
├── skills/orca-node/     # 标准 skill bundle，介绍 orca_pod 工具（随包发布）
├── src/                  # TypeScript 源码（tsc 构建到 lib/）；按功能分 7 个目录：core ← executor ← task ← mesh ← api ← node ← plugin
│   ├── index.ts          # 公共入口：apply / Config / inject
│   ├── core/             # 公共底座（只放多个上下文共用的）：errors、schema、events（EventBus / ChangeSignal）、constants、ids（orca node id 与 workgroup id）、net、identity（Ed25519 与 base58 的纯函数，orca_node_id=公钥）、signing（请求的签名 + workgroup 证明、答复签名、nonce）、sqlite、stream、blobs（发布文件）、wire/reply（错误体与 ack）
│   ├── executor/         # executor 契约、echo、model（模型路由）与 model-catalog、permission（权限模式）、acp/（config / connection / session / permissions / executor）
│   ├── task/             # 本机执行：wire、runner（单槽运行器）、record（任务状态机）、quota、workspace、grants、meta、prompt（任务书）、dispatch-log（派发日志，含它的表）
│   ├── mesh/             # 节点表：mesh（`Mesh`：Map<节点 id, OrcaNode>，本机自己也在表里；hello / 种子 / 目录 / 墓碑 / 心跳循环）、orca-node（表里的一行：自述、状态机、拨号、sendTask / fetchBlob）、context（一个实例里所有节点共用的 `MeshContext`）、peer-client（唯一的出站客户端）、screening（端点筛查）、timings、wire
│   ├── api/              # 入站 HTTP：gateway（含答复签名）、access（public / hello / member / local）、cluster-routes、a2a-routes、blob-routes、local-routes（本机进程发布与取文件）、input
│   ├── node/             # orca（组合根 `Orca`：本进程里的这个实例）、settings（设置 schema 与解析器）、events
│   └── plugin/           # DSH bundle：broker / bundle / catalog / config / local-node（任务进程经本机节点收发文件）/ panel / panel-api / panel-routes / peers-file / pod / services / settings-file / skill / stores / tools / tracker
└── test/                 # vitest 套件
```

## 安装（本地 checkout）

```bash
npm install          # 触发 prepare，产出 lib/（包入口在 lib/，checkout 里没有它就无法加载）
dsh plugin --profile desktop add /absolute/path/to/orca-pod

# verify the profile picked up the bundle and its patch row
dsh --profile desktop --dump-config
```

`dsh plugin add` 把包记成 profile 里的 `link:` 依赖并追加到 `dsh.profile.bundles`；DSH 通过 profile 的 `node_modules` 解析包名并应用 `cordis.patch.yml`。bundle 的运行时依赖见 `package.json`（16 项，含 11 个 `@deepseek-ai/dsh-*` 与 `cross-spawn`）；`link:` 安装时这些依赖从本 checkout 的 `node_modules` 解析，所以先在本仓库跑过 `npm install`。

首次启动保持空闲：`cordis.patch.yml` 不携带 workgroup 或密码，必须先在面板向导里完成 setup（workgroup、密码、监听地址）才会开始监听。监听默认 `127.0.0.1`；要让局域网 peer 直连，在向导里选择 LAN 地址或 `::`。

**在新机器上加入 mesh**：装 DSH 与本插件，打开面板填同一个 workgroup 与密码，再在任一已在 mesh 里的机器上 `connect` 它的地址（或在它的面板里填已在 mesh 里的机器）。没有无头安装器：要在没有桌面的 Linux 机器上跑，就在那里装 DSH，用它的 Web UI 装本插件。

节点只监听节点端口（默认 11811）。**一台机器一个节点**：身份、密码、设置、任务库、工作区整台机器一份，不论有几个 DSH profile；两个 DSH 进程同时开着时，只有先绑定端口的那个跑节点，另一个显示“已在另一个进程中运行”。

## 配置

节点设置只在 `src/node/settings.ts` 的 `SettingsSchema` 里声明一次；面板与测试都走同一个解析器。**设置存在 `$DSH_HOME/orca-pod/settings.json`**（不含机密，面板写它，节点原地重启；DSH 的 `configEditor` 只能写当前 profile 的 patch，没法让所有 profile 共用）。profile 的插件配置只剩一个字段 `skill_injection`，旧的节点字段会被忽略（面板里重新填一次）。机密都在 DSH 凭据库：密码是引用 `ORCA_POD_PASSWORD`（固定名字、整台机器一份，也是无头宿主可导出的环境变量名），节点私钥是记录 `orca-pod/node`；workgroup 密钥由密码在启动时派生，只在内存里。运行期记住的 peer 在 `<data_root>/peers.json`，`data_root` 固定为 `$DSH_HOME/orca-pod`。常用字段：

| 字段                   | 默认                                   | 含义                                                                                                  |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `workgroup_id`         | 未设置（向导填写）                     | 要加入的 workgroup，`[a-z0-9][a-z0-9-]{1,31}`                                                          |
| `workgroup_password`   | —                                      | 共享密码，面板里填；存进 DSH 凭据库，**不进设置文件**；不能为空（见 [§7.1](docs/07-security.md#71-workgroup-与密码)） |
| `display_name`         | 缩略的 orca node id                    | 显示名                                                                                                |
| `bind_host` / `port`   | `127.0.0.1` / `11811`                  | 监听地址与端口（`port: 0` 自选）                                                                       |
| `endpoints`            | `[]`（按监听地址推导）                 | 对外宣告的拨号地址，1–8 个，第一个是 primary                                                          |
| `peers`                | `[]`                                   | 启动时作为种子接触的 peer；没应答的会按退避继续重试                                                    |
| `executor`             | 插件默认 `acp`，库未设置时 `echo`      | 本机执行器（origin 不能指定）；`acp` 对象配 `command`/`extra_args`/`mcp_servers`；任务总在宿主自己的 profile 里运行 |
| `permission_mode`      | 未设置（无本机上限）                   | 本机权限上限；生效模式 = 它与 origin 继承值中较窄的                                                    |
| `task_timeout_s`       | `3600`                                 | 单任务硬上限，对外公布为 `max_task_ttl_s`                                                              |
| `approval_timeout_s`   | 未设置（无限等待）                     | 挂起的权限请求到点自动拒绝（`failed(permission_timeout)`）                                             |
| `result_max_bytes`     | 32 KiB                                 | 结论文本内联上限                                                                                      |
| `max_workspace_bytes` / `max_workspace_files` | 5 GiB / 50 000    | 工作区配额；超出时新任务 `507 quota_exceeded`                                                          |
| `request_timeout_ms`   | `30000`                                | 单次出站调用的超时                                                                                    |
| `allow_public_peers` / `allow_loopback_peers` | `false` / `true`  | 候选端点是否允许公网 / 回环地址                                                                        |
| `models` / `default_model` / `default_reasoning_effort` | 空 | 节点自述的模型目录与默认值；插件从 DSH Host 采集                                                       |
| `skill_injection`      | `false`                                | **插件配置**里唯一的字段：把内置 skill 注册到 DSH Host 的 skills 服务（不写用户 skill 目录）            |

节点私钥在凭据库，所以 node id 跨重启保持不变；改密码 = 重建组（改了密码的节点在它的下一个请求就被旧 mesh 拒绝）；面板的“完全重置”删掉整台机器的节点（密码、私钥、设置、peers），没有分支。旧版本按 profile 存的身份和任务库不读、不迁移：已装过的机器会得到新身份，需要重新入组。

任务的权限模式继承发起会话（没继承到就 `read-only`），显式传的模式只能更窄，本机 `permission_mode` 是上限；任务需要更多权限时请求发起者把本任务升级一档，人在面板或聊天卡上批准后，该任务余下的同类操作不再询问。审批默认无限等待，只有配置了 `approval_timeout_s` 才在到点自动拒绝。任务只有一跳：任务在宿主的 profile 里运行，执行器拉起的会话带 `ORCA_POD_IN_TASK=1`，插件见到就不启动节点，`orca_pod` 只剩 `fetch` 与 `publish`、经本机节点收发文件——这是防 agent 转手的非对抗性约束，不是密钥隔离。

## 工具

插件只注册一个 `orca_pod` 工具（一份 schema，按 `method` 分派），返回 JSON 文本，从不阻塞等待远端任务；任务在远端 orca node 异步执行，完成由后台 tracker 通知发起会话。

| Method    | Extra arguments                                                                       | Result                                                           |
| --------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `send`    | `peer`, `text`, `echo?`, `model?`, `reasoning_effort?`, `permission_mode?`           | `{task_id, state, peer, node}`，远端接受后立即返回               |
| `publish` | `path`, `ttl_s?`                                                                      | `{ref, size, expires_at}`：把本机文件复制进本机节点，名字是 `<节点 id>/<sha256>`；默认 7 天过期，`0` 永不过期 |
| `fetch`   | `ref`, `output`                                                                       | `{path, size}`：把任一成员发布的文件存到 `output`，校验 sha256；写入位置要经会话沙箱允许 |
| `status`  | `peer`, `task_id`                                                                     | 远端 `TaskView` 加 `terminal` 标志                               |
| `cancel`  | `peer`, `task_id`                                                                     | 取消时刻的任务视图加 `terminal`                                  |
| `members` | —                                                                                     | `{self, members, members_digest}`                                |
| `connect` | `peer`                                                                                | 接触这个地址、记住它以便重启、返回刷新后的成员表                 |

没有 approve 方法：权限请求只在 UI（会话聊天卡、后台弹窗、面板）里由人批准。`peer` 是**节点 id、唯一的显示名、或该节点的 URL**（重名时报错并列出候选 id）；出站调用只到已知的节点，陌生地址要先 `connect`（`connect` 的 `peer` 接受 `http(s)://host:port`、`host:port` 或裸 `host`，端口默认 11811）。`send` 不给 `permission_mode` 时继承当前会话的权限模式（DSH 的 `sandboxPolicy` 服务），显式传入则覆盖（[§7.10](docs/07-security.md#710-权限模式继承)）。

**文件不是任务的一部分**：要交给任务的文件先 `publish`，把返回的名字写进任务文本；任务里的 agent 用同一个工具 `fetch` 它，要交回的文件也 `publish`、把名字写进结论，你再 `fetch`。任务进程里的 `orca_pod` 只有这两个方法（[§5.6](docs/05-tasks.md#56-文件交换blob-通道)）。需要收文件的任务要以 `workspace-write` 派出：`read-only` 的会话写不了任何地方。

## 开发

```bash
npm install         # 同时触发 prepare -> npm run build，产出 lib/
npm run build       # 先清空 lib/，再 tsc -p tsconfig.build.json + 客户端 esbuild，产出 lib/（已进 .gitignore）
npm run check       # biome check + tsc --noEmit + vitest run（唯一的验收入口）
npm run format      # biome format --write
npm run harness     # 进程内两个节点走真实回环网络的 smoke
```

维护注意：

- 包导出编译产物（`"exports"` 指向 `./lib/index.js` 与 `./lib/index.d.ts`），并导出 `./locale/*.json` 与 `./icon`；TypeScript 源码只用于开发与类型检查，`src/` 里的 .ts 导入由 `rewriteRelativeImportExtensions` 在构建时改写。
- `src/` 的依赖方向由 `test/architecture.test.ts` 固化：运行期 import 无环、只能向下（`core ← executor ← task ← mesh ← api ← node ← plugin`），存储实现只由装配点（`node/`、`plugin/`）引用（[§9.1](docs/09-implementation.md#91-单包内的模块划分)）。
- 抖动/超时类测试的窗口按心跳间隔的倍数给，不按绝对毫秒。
