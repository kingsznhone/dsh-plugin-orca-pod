# orca-pod

分布式 DSH 对等集群（DSH 插件形态）。设计文档入口：[docs/README.md](docs/README.md)。

- 目标：2–10 台自己的机器，跨 Windows/Linux，互相派任务、回传结果。
- 形态：full mesh、明文 HTTP + 前置代理终止 TLS、A2A 任务面、内容寻址 blob 通道。
- 代码：单包 `orca-pod`，库与 DSH host bundle 共用一个入口；运行时只依赖 `fastify`，所有自研模块都在 `src/`，安装时不需要本仓库的 `node_modules`。
- 状态：Phase 0–3 可运行——`/health`、join/心跳/成员、`/a2a`（`message/send`/`tasks/get`/`tasks/cancel`、单槽、grant 与 permission 升级）、`/blobs`、三种执行器（Echo/Headless/ACP）、SQLite task store + fs blob + group 工作区、审批卡片与链式 relay、`orca-node` CLI 与插件后台 tracker；Windows ↔ Hyper-V Ubuntu 跨机 join、A2A 往返、blob 双向与真实 `dsh` 任务均已验证。

## 布局

```text
orca-pod/
├── package.json          # 单包清单：dsh.bundle.patch -> cordis.patch.yml
├── cordis.patch.yml      # DSH 行：id orca-pod、name 'orca-pod'
├── README.md
├── docs/                 # 设计文档（12 篇 + DECISIONS）
├── scripts/              # 跨进程联调（cross.ts）、真实 dsh 冒烟（e2e-headless.ts / e2e-acp.mjs）
├── src/
│   ├── index.ts          # 公共入口：createOrcaNode + apply/Config/inject
│   ├── protocol.ts       # id、成员 digest、任务/peer 类型
│   ├── crypto.ts         # workgroup key、请求签名、nonce cache
│   ├── config.ts         # orca node 配置持久化
│   ├── storage.ts        # peer store（+ 重导出 blob store）
│   ├── blobs.ts          # 内容寻址 blob store
│   ├── membership.ts     # 成员记录、心跳看门狗、墓碑与修剪
│   ├── gateway.ts        # HTTP: /health、agent card、/cluster/*、/a2a、/blobs
│   ├── executor.ts       # LocalExecutor 契约 + EchoExecutor
│   ├── headless.ts       # HeadlessExecutor（dsh headless --json 子进程）
│   ├── acp.ts            # AcpExecutor（dsh --profile acp stdio：流式、权限、session）
│   ├── process.ts        # 子进程公共件（Windows shim 解析、killTree）
│   ├── session-store.ts  # .pod/sessions.json（origin+context → session）
│   ├── tasks.ts          # 单槽任务运行器
│   ├── orca_node.ts      # createOrcaNode：装配 gateway、tasks、membership
│   ├── harness.ts        # 测试用进程内多 orca node
│   ├── cli.ts            # `orca-node` CLI：serve / send / status / wait / members
│   └── plugin/           # DSH bundle：Config、apply(ctx, config)、tools
└── test/                 # vitest 套件
```

## 安装（本地 checkout）

```bash
dsh plugin --profile desktop add /absolute/path/to/orca-pod

# verify the profile picked up the bundle and its patch row
dsh --profile desktop --dump-config
```

`dsh plugin add` records the package as a `link:` dependency in the profile and
appends it to `dsh.profile.bundles`; DSH then resolves the package name through
the profile's `node_modules` and applies `cordis.patch.yml`. Because the bundle
carries no private dependencies, the checkout's `node_modules` is not needed at
runtime. Use the Plugin Manager (or edit the profile's patch/config) to change
the config afterwards.

## 配置

| Field                | Required | Default                         | Meaning                                                                 |
| -------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------- |
| `workgroup_id`       | yes      | —                               | Workgroup to join; `[a-z0-9][a-z0-9-]{1,31}`                            |
| `workgroup_password` | yes      | —                               | Shared password; the orca node key is derived from it (prototype: plaintext) |
| `display_name`       | no       | `orca-<orca_node_id>` from node config | Human-readable orca node name                                              |
| `port`               | no       | `11811`                         | Local listen port (`0` = OS-assigned)                                   |
| `endpoint`           | no       | `http://<host>:<port>`          | Public endpoint advertised to peers                                     |
| `data_root`          | no       | `$ORCA_POD_HOME` or `~/.orca-pod` | Directory of the persisted `config.json` (orca node identity)             |
| `peers`              | no       | `[]`                            | Peer endpoint URLs to `join` at startup; failures are logged only       |

orca node 配置（`config.json`）首次启动时生成，同一 `workgroup_id` 下复用，因此 node id 跨 DSH 重启保持不变；改密码会在原地重新派生共享密钥。

执行器选择也在本机 `config.json` 里（origin 不能指定）：`"executor": "echo" | "headless" | "acp"`。`headless` 对象可配 `command`（默认 `dsh`）、`profile`（默认 `headless`）、`permission_mode`（默认 `read-only`）、`approval_policy`（默认 `never`）与 `extra_args`，详见 [docs/06-execution.md §6.14](docs/06-execution.md#614-headlessexecutorphase-2-真实执行器)；`acp` 对象可配 `command`（默认 `dsh`）、`profile`（默认 `acp`）、`extra_args` 与 `mcp_servers`（原样传给 `session/new`，给 ACP 会话装额外工具），它经 ACP stdio 跑长任务并承接权限挂起（[§6.15](docs/06-execution.md#615-acpexecutorphase-23-长任务执行器)）。

多跳委派也在本机 `config.json` 里：`"delegation": { "max_hop": 1 }`（0–3，默认 0，即拒绝 `hop > 0` 的子任务；`max_fanout` 预留）。超过上限返回 `400 hop_limit`，祖先回环返回 `403 ancestor_call_forbidden`。

### 安全注意（原型）

`workgroup_password` 目前直接写在 `cordis.patch.yml` 里，该文件是明文、可能被分享或记进日志。正式版本应从 DSH credentials 服务读取，patch/config 里不出现密钥。

## 工具

五个工具都返回 JSON 文本，且从不阻塞等待远端任务；任务在远端 orca node 异步执行。

| Tool          | Arguments                | Result                                                         |
| ------------- | ------------------------ | -------------------------------------------------------------- |
| `pod_send`    | `peer`, `text`, `echo?`  | `{task_id, state, peer}` immediately after the remote accepts   |
| `pod_status`  | `peer`, `task_id`        | Remote `TaskView` plus a `terminal` flag                        |
| `pod_cancel`  | `peer`, `task_id`        | Task view observed at cancel time plus `terminal`               |
| `pod_members` | —                        | `{self, members, members_digest}` with id/name/endpoint/state   |
| `pod_approve` | `peer`, `task_id`, `decision`, `reason?` | Answers a suspended `permission_request`: opens the DSH approval card in the current turn and sends a grant or denial |

`peer` 接受 `http(s)://host:port` 或裸 `host:port`；可选 `echo` 会作为 `metadata.echo` 转发确定性脚本（测试用；默认任务本身就会回显）。

## CLI

无头/ACP 会话里没有 orca-pod 的插件工具，agent 用自带 shell 调 `orca-node` 子命令（`AcpExecutor` 会在 prompt 前注入 CLI 绝对路径与用法）：

```bash
# 派任务，文本从 stdin 读，输出 JSON
echo "compile and run the tests" | orca-node send --peer 192.168.86.252:11811 --text - --json

# 等结果：0 completed / 1 failed|canceled / 2 仍在跑 / 3 需要权限
orca-node wait --peer 192.168.86.252:11811 --task <id> --timeout 60 --json

orca-node status --peer 192.168.86.252:11811 --task <id> --json
orca-node members --json
```

CLI 读本机 `config.json`（`--config` 或 `--data-root`），用本 orca node 的身份做请求签名；它不是节点，不监听端口。`wait` 返回 3 时，agent 应通过宿主（ACP 的 `session/request_permission` 或插件 tracker）请求人工批准，而不是自己批准。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run
```

维护注意：

- 包导出 TypeScript 源码（`"exports": "./src/index.ts"`），依赖 Node ≥22 的类型剥离；若 DSH 构建以保留符号链接的方式解析 linked bundle，则需要提供编译后的 JS 入口（原型阶段不做）。
- `src/` 的依赖方向靠 review 维持：`gateway.ts` 不得 import `executor.ts` 或 `harness.ts`，只有 `orca_node.ts` 负责装配。
- 抖动/超时类测试的窗口按心跳间隔的倍数给，不按绝对毫秒。
