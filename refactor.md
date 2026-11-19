# 重构方案：还没决定的项

> 状态：**待 owner 审阅**（2026-11-20 整理，分支 `refactor/classes`，工作区含未提交的 D54–D58）。
> 已实施：第五轮 §一（D56）、§二（D57），第六轮的 F3、F5、S1–S3、I8（D58）。各轮原文见 git 历史。
> 现状规模：`src` 7704 行（55 个文件、215 条相对 import 边）。

---

## 一、功能项（会改变行为）

### F10 ACP 会话持久化（待定）

- 现状：`AcpExecutor` 把 (origin, context) → ACP session id 存在 `<data_root>/state/<workgroup>/sessions.json`，节点重启后用 `session/resume` 接上；子进程不认识这个 id 时开新会话（`executor/acp/executor.ts` `loadBindings`、`resume`、`SessionBindingsSchema`、`RESOURCE_NOT_FOUND`）。
- 砍掉：只保留内存里的 (origin, context) → session 映射。约删 55 src / 80 test。
- 失去：节点重启后同一 context 的对话从头开始。重启时进行中的任务本来就都失败（§8.3），受影响的只是“下一次同 context 的任务能否接着上次的对话”。

### F12 节点的默认推理强度设置（新提出，待定）

- 现状：调用方可以指定强度（`orca_pod` `send` 的 `reasoning_effort`，或写在 `model` 里）；没指定时依次取 target 面板设置的 `default_reasoning_effort`、DSH 宿主默认模型自带的强度、都没有就不设（dsh 自己的默认）。
- 砍掉：没指定就一律用 DSH 的默认强度。删 `ModelSettingsSchema`（`executor/model-catalog.ts`，F8 之后只剩这一项）、`ModelCatalog` 的 `pinnedEffort`、面板的“默认推理强度”选项与 `PodConfigView.reasoning_efforts`（以及 `ModelCatalogFeed` 为它读的强度列表）。
- 失去：节点主人无法给本机任务定一个不同于 DSH 默认的强度。

---

## 二、待决定的化简项（不改行为）

- **P8 余项：只给设置表单的字段挪到单独的读路由**：`permission_modes`、`reasoning_efforts`、`bind_choices`、`suggested_endpoints` 只有设置表单读，却随每 2 秒的面板轮询计算（含 `os.networkInterfaces`）。挪到 `GET /orca-api/config/choices` 一类的路由，表单打开时读一次。代价：多一条路由与一个客户端读取。若 F12 砍掉，`reasoning_efforts` 随之消失。

---

## 三、刻意不做的（分析过，核对后不建议，或 owner 决定保留）

owner 决定保留：

- **F4 运行时信息**（OS、CPU、内存：`collectRuntime`、`RuntimeInfoSchema`、`runtimeDigest`）：供节点派任务前了解对方的运行环境和能力。
- **`max_workspace_bytes`、`allow_public_peers` / `allow_loopback_peers`** 仍是设置。
- **`max_task_ttl_s` 在节点自述里的通告**：面板的节点详情显示它（F5 只删了同样带它的 agent card）。
- **单个端点代替端点列表**：线协议变动面广，收益小。

核对后不做：

- 建表集中到 `core/sqlite.ts`：会让 core 知道 task 层的表。
- 客户端 `TaskFacts` 改用 `messageText`：客户端只做类型导入，引用它会把 zod 拉进浏览器包。
- 模型目录的 `ChangeSignal` 改成构造回调：`Pod` 在 feed 之后创建，回调会成环。
- 把 `HelloRequest` 类型挪离它的 schema；把 `permissionRequestOf` 挪进 `orca-node`（要多导出 `PermissionRequestSchema`）。
- `executor/acp/connection.ts` 并入 `session.ts`：两个类各自内聚。
- `plugin/panel-api.ts` 并入 `panel.ts`：契约文件单列是第三轮（H5）的决定。
- `ModelCatalog` 并入 ACP 执行器：模型目录是节点对外通告的内容，不只属于 ACP。
- `tracker.ts` 并入 `panel.ts`、`timings`/`peer-client`/`screening`/`dispatch-log` 的定义并入 `mesh/context.ts`：机械命中，会变成杂物间（I8 只让 `MeshContext` 构造它们）。
- 把 `recordSend` 从 `sendTask` 里拿出：`outbound.test` 断言了日志行为，十几个测试文件调用 `sendTask`。
- `Gateway` 构造器不再收 `workgroupId`/`identity`：D54 刻意去掉了 `Mesh.workgroupId`。
- `MeshClock` 这个测试注入点（D47 保留；现在是 `MeshContext` 的可选参数）。
- D54 已列的保留项：`ModelCatalog` 把 effort 并进 `default_model`（客户端 `modelText` 显示它）、`AcpConnection.spawn` 静态工厂（构造器不起进程）、`pickFreePort`/`isBlockedFetchPort` 导出（纯函数契约有测试）、名字的写读都在 `core/blobs.ts`、`Mesh.setIntervalMs`（心跳测试监视它）、`ModelOffer = Pick<LlmModelInfo>`（D40）、`DEFAULT_PORT` 在 `core/constants.ts`（客户端引用）。
