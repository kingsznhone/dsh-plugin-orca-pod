# orca-pod

分布式 DSH 对等集群（DSH 插件形态）。设计文档入口：[docs/README.md](docs/README.md)。

- 目标：2–10 台自己的机器，跨 Windows/Linux，互相派任务、回传结果。
- 形态：full mesh、明文 HTTP + 前置代理终止 TLS、A2A 任务面、内容寻址 blob 通道。
- 代码：单包 `orca-pod`，库与 DSH host bundle 共用一个入口；运行时只依赖 `fastify`，自研模块在 `src/`，随包发布的是编译后的 `lib/`（`npm run build`），安装时不需要本仓库的 `node_modules`。
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
├── scripts/              # cross.ts（跨进程联调）、harness_run.ts（真实进程 smoke）、e2e-acp.mjs（真实 dsh 冒烟）、sync-guest.ps1
├── skills/orca-node/     # 标准 skill bundle（随包发布）
├── src/                  # TypeScript 源码（tsc 构建到 lib/）
│   ├── index.ts          # 公共入口：createOrcaNode + apply/Config/inject
│   ├── orca_node.ts      # 组合根：createOrcaNode
│   ├── protocol.ts       # 线上类型、id/digest、任务视图
│   ├── errors.ts         # PodError + 错误码 → HTTP 状态表
│   ├── identity.ts       # Ed25519 密钥对、orca_node_id=公钥
│   ├── crypto.ts         # 请求签名、准入证明、nonce、grant 与直链签名
│   ├── settings.ts       # 设置字段表与解析器（config.json / 插件 / 面板 / install / CLI 共用）
│   ├── config.ts         # config.json 读写
│   ├── membership.ts     # 成员记录、心跳看门狗、墓碑与修剪
│   ├── mesh.ts           # join、心跳循环、leave、自述记录
│   ├── peer_client.ts    # 唯一的出站签名客户端（不隐式 join）
│   ├── delegation.ts     # 发起侧：派发、审批、上交、派发日志、child-link
│   ├── gateway/          # HTTP：index / auth / error_handler / cluster_routes / a2a_routes / blob_routes
│   ├── tasks.ts          # 单槽任务运行器
│   ├── task_record.ts    # 一个任务的状态机
│   ├── task_meta.ts      # 任务元数据解析
│   ├── task_inputs.ts    # 任务书与输入物化
│   ├── grants.ts         # grant 解析与校验
│   ├── chain.ts          # 子任务元数据与 grant 转发
│   ├── executor.ts       # LocalExecutor 契约
│   ├── echo.ts           # EchoExecutor
│   ├── acp/              # AcpExecutor：connection / session / permissions / executor
│   ├── workspace.ts      # 工作区与配额测量
│   ├── session_store.ts  # state/<workgroup_id>/sessions.json
│   ├── storage.ts        # task store 接口 + 内存实现
│   ├── sqlite.ts         # node:sqlite 实现（tasks / dispatches / file_blobs）
│   ├── blobs.ts          # 内容寻址 blob store（含配额与 GC）
│   ├── blob_files.ts     # publish 的本机文件映射
│   ├── dispatches.ts     # origin 派发日志
│   ├── events.ts         # 进程内事件总线
│   ├── net.ts            # 端点筛查、端口、回环判定
│   ├── process.ts        # 子进程公共件
│   ├── harness.ts        # 测试用进程内多 orca node
│   ├── cli.ts            # `orca-node` CLI
│   ├── orca_pod.ts       # `orca-pod` bin：install（systemd 安装）
│   ├── install.ts        # install 计划与 unit 渲染
│   ├── entry.ts          # 包内入口路径（src/cli.ts 或 lib/cli.js）
│   └── plugin/           # DSH bundle：index / lifecycle / broker / tracker / tools / admin / web / models / skill / config / dsh / util
└── test/                 # vitest 套件
```

## 安装（本地 checkout）

```bash
npm install          # 触发 prepare，产出 lib/（包入口在 lib/，checkout 里没有它就无法加载）
dsh plugin --profile desktop add /absolute/path/to/orca-pod

# verify the profile picked up the bundle and its patch row
dsh --profile desktop --dump-config
```

`dsh plugin add` 把包记成 profile 里的 `link:` 依赖并追加到 `dsh.profile.bundles`；DSH 通过 profile 的 `node_modules` 解析包名并应用 `cordis.patch.yml`。bundle 没有私有依赖，运行时不需要本 checkout 的 `node_modules`。之后用 Plugin Manager（或改 profile 的 patch/config）改配置。

首次启动保持空闲：`cordis.patch.yml` 不携带 workgroup 或密码，必须先在面板向导里完成 setup（workgroup、密码、监听地址）才会开始监听。监听默认 `127.0.0.1`；要让局域网 peer 直连，在向导里选择 LAN 地址或 `::`。

## 后台安装（systemd）

在没有桌面的 Linux 机器上，`npx orca-pod install` 把本机的主机节点注册成 systemd 服务，常驻 `orca-node serve`（不需要浏览器或 dsh web）。要面板的用户自己装 DeepSeek Harness，再从它的 Web UI 里安装本插件；`install` 只负责 headless 宿主。

裸 `orca-pod install`（或只带 `--dry-run`）进入交互式设置，询问 workgroup id、密码（隐藏输入）、监听地址与端口。**只要再带任何其他参数**就进入参数分支、完全不提问，所有必填答案都要通过参数给出（缺少 workgroup/密码直接报错退出），适合让 agent 通过 SSH 安装；密码用 `-p`/`--password` 传入，程序不读 stdin。

`install` 会检查 `dsh --version`、生成 `<data_root>/config.json`（0600、`executor: "acp"`、监听 `::`）、写 unit 并 `enable --now`；`--dry-run` 只打印计划，`--system` 装系统级（默认用户级），`--skip-dsh-check` 跳过检查，`--no-start` 只写不启动，`--force` 重写已有 unit 与配置。`--peer <url>`、`--endpoint <url>`、`--env-file <path>`、`--env KEY=VALUE` 都可重复：分别写启动时的 join 目标、覆盖广播地址、`EnvironmentFile=`（例如放 `DEEPSEEK_API_KEY` 的 0600 文件）、`Environment=`（例如给 ACP 子进程的 `PATH`）。用户级 unit 在无头服务器上还需要 `loginctl enable-linger $USER`。

```bash
# 交互式（终端里运行）
npx orca-pod install

# 全参数（agent 在 SSH 上安装时推荐；不会提问）
npx orca-pod install --workgroup orca-demo -p 'secret' --peer http://192.168.86.152:11811

# 先看会写什么、执行什么
npx orca-pod install --dry-run --workgroup orca-demo -p 'secret'
```

节点只监听节点端口（默认 11811）；不要通过代理暴露 `/cluster/child-link` 与 `/cluster/task`（它们只接受回环请求）。

## 配置

所有设置只在 `src/settings.ts` 的字段表里声明一次；`config.json`、插件 `Config`、面板、`install` 与 CLI 都走同一个解析器。插件模式下，设置就是 profile 里的插件配置（面板经 DSH `configEditor` 写回），密码在 DSH 凭据库，运行期记住的 peer 在 `<data_root>/peers.json`。常用字段：

| 字段                   | 默认                                   | 含义                                                                                                  |
| ---------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `workgroup_id`         | 未设置（向导填写）                     | 要加入的 workgroup，`[a-z0-9][a-z0-9-]{1,31}`                                                          |
| `workgroup_password`   | `""`                                   | 共享密码，只用来派生准入密钥；不能为空。CLI/`install` 直接接收；**插件配置不接受**，插件从 DSH 凭据库读取（见 [§7.1](docs/07-security.md#71-workgroup-与密码)） |
| `workgroup_password_ref` | `ORCA_POD_PASSWORD_<WORKGROUP>`      | 仅插件：存放密码的 DSH 凭据引用名（也是无头宿主可导出的环境变量名）                                    |
| `display_name`         | 缩略的 orca node id                    | 显示名                                                                                                |
| `bind_host` / `port`   | `127.0.0.1` / `11811`                  | 监听地址与端口（`port: 0` 自选）；`install` 默认写 `::`                                               |
| `endpoints`            | `[]`（按监听地址推导）                 | 对外宣告的拨号地址，1–8 个，第一个是 primary                                                          |
| `data_root`            | `$ORCA_POD_HOME`、`$DSH_PROFILE_DIR/orca-pod` 或 `$DSH_HOME/orca-pod` | `identity.json`、`config.json`、`tasks.db`、`blobs/`、工作区所在目录（插件内跟随当前 DSH profile；宿主不导出 `DSH_PROFILE_DIR` 时用 loader `baseUrl` 兜底。不读取、不迁移任何旧位置，如 `~/.orca-pod`）    |
| `peers`                | `[]`                                   | 启动时 join 的 peer（仅插件）                                                                          |
| `executor`             | 插件与 `install` 为 `acp`，库/CLI 未设置时 `echo` | 本机执行器（origin 不能指定）；`acp` 对象配 `command`/`profile`/`extra_args`/`mcp_servers`  |
| `permission_mode`      | 未设置（无本机上限）                   | 本机权限上限；生效模式 = 它与 origin 继承值中较窄的                                                    |
| `task_timeout_s`       | `3600`                                 | 单任务硬上限，对外公布为 `max_task_ttl_s`                                                              |
| `approval_timeout_s`   | 未设置（无限等待）                     | 挂起的权限请求到点自动拒绝（`failed(permission_timeout)`）                                             |
| `result_max_bytes`     | 32 KiB                                 | 结论文本内联上限                                                                                      |
| `max_input_files` / `max_input_bytes` | 32 / 512 MiB             | 单任务素材上限                                                                                        |
| `max_workspace_bytes` / `max_workspace_files` | 5 GiB / 50 000    | 工作区配额；超出时新任务 `507 quota_exceeded`                                                          |
| `max_blob_store_bytes` | 5 GiB                                  | blob 存储配额；超出的上传 `507`                                                                        |
| `request_timeout_ms`   | `30000`                                | 单次出站调用的超时                                                                                    |
| `allow_public_peers` / `allow_loopback_peers` | `false` / `true`  | 候选端点是否允许公网 / 回环地址                                                                        |
| `models` / `default_model` / `default_reasoning_effort` | 空 | 节点自述的模型目录与默认值；插件从 DSH Host 采集，纯 CLI 节点可手填                                    |
| `skill_injection`      | `false`                                | 把内置 skill 注册到 DSH Host 的 skills 服务（仅插件；不写用户 skill 目录）                               |

`config.json` 首次启动生成（身份 + 派生密钥，0600），同一 `data_root` 下复用，因此 node id 跨重启保持不变；改密码 = 重建组。ACP/CLI 子会话从 executor 收到 `ORCA_POD_CLI`/`ORCA_POD_DATA_ROOT`。

任务的权限模式继承发起会话（没继承到就 `read-only`），本机 `permission_mode` 只能收窄；审批默认无限等待，只有配置了 `approval_timeout_s` 才在到点自动拒绝。多跳没有深度上限：子任务由 agent 显式派发（CLI），环靠 `pod.chain` 检测（`403 ancestor_call_forbidden`）。

## 工具

插件只注册一个 `orca_pod` 工具（一份 schema，按 `method` 分派），返回 JSON 文本，从不阻塞等待远端任务；任务在远端 orca node 异步执行，完成由后台 tracker 通知发起会话。

| Method    | Extra arguments                                                            | Result                                                           |
| --------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `send`    | `peer`, `text`, `echo?`, `model?`, `reasoning_effort?`, `permission_mode?` | `{task_id, state, peer}`，远端接受后立即返回                     |
| `status`  | `peer`, `task_id`                                                          | 远端 `TaskView` 加 `terminal` 标志                               |
| `cancel`  | `peer`, `task_id`                                                          | 取消时刻的任务视图加 `terminal`                                  |
| `members` | —                                                                          | `{self, members, members_digest}`                                |
| `connect` | `peer`                                                                     | 把 peer join 进 mesh、记住它以便重启、返回刷新后的成员表         |

没有 approve 方法：权限请求只在 UI（会话聊天卡、后台弹窗、面板）里由人批准。`peer` 接受 `http(s)://host:port`、`host:port` 或裸 `host`（端口默认 11811）；出站调用只到已加入的成员，陌生地址要先 `connect`。`send` 不给 `permission_mode` 时继承当前会话的权限模式（DSH 的 `permissionPresets`），显式传入则覆盖（[§7.10](docs/07-security.md#710-权限模式继承)）。

## CLI

无头/ACP 会话里没有插件工具，agent 用自带 shell 调 `orca-node` 子命令（任务书的前言会给出 CLI 路径与用法）：

```bash
orca-node serve    --config <path> [--peer <url>] [--bind <host>] [--port <n>]   # 启动一个节点
orca-node send     --peer <url> --text <text|-> [--file <path> ...] [--local-task <this task>] [--context <id>] [--permission-mode <mode>] [--model <provider/model>] [--reasoning-effort <effort>] [--echo <json>] [--json]
orca-node status   --peer <url> --task <id> [--json]
orca-node wait     --peer <url> --task <id> [--local-task <this task>] [--timeout <s>] [--json]
orca-node escalate --peer <child> --task <child task> --local-task <this task> [--timeout <s>] [--json]
orca-node publish  <path> [--ttl <s>] [--json]       # 把产出文件登记成 blob 直链（写本机 SQLite，无 HTTP 路由）
orca-node log      [--json]                          # 本节点派发过的任务（读派发日志）
orca-node members  [--peer <url>] [--json]
```

共用选项：`--config <path>` 或 `--data-root <path>`（默认 `$ORCA_POD_HOME`，否则 `$DSH_PROFILE_DIR/orca-pod`，否则 `$DSH_HOME/orca-pod`，再否则 `~/.dsh/orca-pod`；在 profile 之外的终端里运行时请用 `--data-root` 指向插件所在 profile 的目录）。`wait` 退出码：0 完成 / 1 失败或取消 / 2 仍在跑 / 3 需要权限；`escalate`：0 已批准恢复 / 1 被拒绝 / 2 超时。`--local-task` 让节点监视子任务并在它要权限时把本任务挂起上交，由 origin 的人决定一次。CLI 读本机 `config.json`，用本 orca node 的身份签名；它不是节点，不监听端口，也不会替你 join 陌生地址（先 `serve --peer <url>`）。

## 开发

```bash
npm install         # 同时触发 prepare -> npm run build，产出 lib/
npm run build       # tsc -p tsconfig.build.json + 客户端 esbuild，产出 lib/（已进 .gitignore）
npm run check       # biome check + tsc --noEmit + vitest run（唯一的验收入口）
npm run format      # biome format --write
npm run harness     # 两个真实 orca-node 进程的 smoke
```

维护注意：

- 包导出编译产物（`"exports"` 指向 `./lib/index.js` 与 `./lib/index.d.ts`），并导出 `./locale/*.json` 与 `./icon`；TypeScript 源码只用于开发与类型检查，`src/` 里的 .ts 导入由 `rewriteRelativeImportExtensions` 在构建时改写。
- `src/` 的依赖方向靠 review 维持：`gateway/` 不 import 执行器或任务实现，只有 `orca_node.ts` 负责装配（[§9.1](docs/09-implementation.md#91-单包内的模块划分)）。
- 抖动/超时类测试的窗口按心跳间隔的倍数给，不按绝对毫秒。
