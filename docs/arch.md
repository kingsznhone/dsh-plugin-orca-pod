# 插件架构：从加载到工作

> Status: 当前设计（与代码一致）
> Updated: 2026-11-19
> Audience: 第一次读插件代码的人

本篇是一张导览图：插件被 DSH 加载后，关键的调用入口在哪里，host 和 client 怎么通信。设计理由在各章正文，本篇只给结构和入口（`文件:行号` 以当前代码为准，改动后以函数名为准）。

术语：**host** 指 DSH Node 进程里的 bundle（`lib/index.js`，源码 `src/`）；**client** 指浏览器里的面板 bundle（`lib/client.js`，源码 `client/`）。

## 1. 全景：一个插件，四个进程/通道

```
┌──────────────────────────── 浏览器 (DSH Web UI) ───────────────────────────────┐
│  lib/client.js  ← client/index.tsx  (esbuild 打成 __ModuleLoader__ 工厂)       │
│   apply(ctx) → 往 slots 注册: settings.section / sidebar / overlay / 审批 dock │
│   store.ts: 一个共享 snapshot，轮询 GET /orca-api/state，POST /orca-api/<动作>  │
└───────────────────────────────┬────────────────────────────────────────────────┘
                                │ 同源 HTTP fetch（不走 host.call）
                                │ 请求头 x-orca-pod: 1，仅限 loopback 访问，带同源校验
┌───────────────────────────────▼──── DSH host 进程 (Node) ───────────────────────┐
│ cordis 加载 cordis.patch.yml → lib/index.js → src/plugin/bundle.ts              │
│                                                                                 │
│  apply() ───┬─ Pod (pod.ts)  生命周期状态机 + SerialQueue                        │
│             │    └─ Orca (node/orca.ts) 每次启动重建一个，内部装配:               │
│             │         Gateway(Fastify :11811) · Mesh · TaskRunner · DispatchLog │
│             ├─ PodTool  (tools.ts)   → ctx.tools 注册 `orca_pod`                │
│             ├─ Tracker  (tracker.ts) → 轮询远端任务，agent.inject/followup       │
│             ├─ PanelModel + PanelRoutes → webServer 上注册前缀路由 /orca-api      │
│             └─ ModelCatalogFeed      → 读 llm / agent-default-model             │
└───────┬─────────────────────────────────────────────────┬───────────────────────┘
        │ Ed25519 + 工作组密钥签名的 HTTP                   │ spawn `dsh`（ACP 协议）
        ▼                                                  ▼
  其他机器上的 orca 节点                              AcpExecutor 拉起的 dsh 子进程
  /cluster/hello /a2a /blobs/:id /local/blobs          （本机为别人执行任务；单跳，
                                                       子进程里不能再 send）
```

## 2. 从加载到开始工作：关键入口

```
DSH 启动
 │ 读 profile 中的 bundle 行（cordis.patch.yml: id/name = orca-pod）
 │ 用 Config 做校验（plugin/bundle.ts 的 zod schema，只有 skill_injection）
 │ 等待 inject 列出的硬依赖 ["tools","credentials"]   bundle.ts:61
 ▼
apply(ctx, config)                                     bundle.ts:76
 ├─ 建：只做组装，不触碰网络和磁盘
 │    dataRoot ← DSH home（一台机器一个节点，多个 profile 共用）
 │    Pod / Tracker / PodTool / PanelRoutes（自己造 PanelModel）
 │    OptionalService("agents" | "sandboxPolicy")  ← ctx.inject 围栏跟踪可选服务
 │
 ├─ 挂：一个 apply 内联完成                             bundle.ts:104
 │    ctx.effect(dispose)            插件卸载时: tracker.stop → pod.stop
 │    ctx.on("agent/inbox/claimed")  用户发消息 → 重置唤醒预算
 │    ctx.on("credentials/*")        密码或节点私钥变了 → pod.credentialsChanged() 重启
 │    ctx.tools.register(orca_pod, {when: configured})  bundle.ts:121
 │    PanelRoutes.register  → inject(["webServer","connection"]) → /orca-api   panel-routes.ts
 │    inject(["skills"])    → 注册内置的 orca-node skill（`skill_injection`，默认开） bundle.ts:128
 │    inject(["settings"])  → configure({auto:false})，不让 DSH 自动生成设置页  bundle.ts:134
 │
 └─ start()                                            bundle.ts:140
      pod.start()  立即返回，不阻塞 host               pod.ts:186
        └─ queue: peers.load → restart → boot()
             bringUp()                                 pod.ts:298
               读 settings.json + 凭据库里的密码
               ├─ 缺 workgroup 或密码 → 状态 "unconfigured"，等面板向导
               └─ startNode()                          pod.ts:366
                    stores.identity()（Ed25519 私钥，首次使用时生成）
                    deriveWorkgroupKey(scrypt，只在内存里)
                    new Orca(...) → orca.start()       node/orca.ts:184
                       gateway.listen  ← 端口就是机器级的锁，绑不上 = 已有节点
                       db.open / tasks.start / dispatches.markInFlightUnknown
                       mesh.start()   心跳 + hello 握手
                    advertise(): 把模型目录装到节点上
             seed()  连上配置里的 peers 和记住的 peers   pod.ts:290
      tracker.start()  每 1s 一轮：从 DispatchLog 取未结束的派发（没有节点时什么也不读）
```

要点：

- `apply` 永远不会抛异常，也不会卡住 host。启动失败只会变成 `PodStatus.failed`，工具和面板会显示 "orca node is not running: …"。
- `Pod` 活得和插件 fiber 一样长。`Orca` 只活一次运行：每次重启都**整个换掉**，从不原地修改。所有重启和状态写入都排进同一个 `SerialQueue`。
- 首次运行时没有密码，所以不监听端口，`orca_pod` 工具也不显示（`when: () => pod.configured`）。
- 可选的 host 服务（`webServer` 与 `connection`、`skills`、`settings`、`agents`、`sandboxPolicy`、`llm`）都用 `ctx.inject` 围栏：服务不存在时插件照常启动，只是少了对应功能；服务被替换时，回调在新的子 scope 里重新执行。

## 3. Host ↔ Client 通信

client 不能 import host 的包，`host.call` 在 host 侧也没有文档化的契约，所以**走 DSH 自己的 web server**，用一个前缀路由 `/orca-api`：

```
client/store.ts                               src/plugin/panel-routes.ts
───────────────                               ──────────────────────────
subscribe() 第一个订阅者 → 开始轮询
  read("state")  ── GET <baseURI>orca-api/state ▶  handle()  panel-routes.ts
                                               rejection(): 必须同时满足
                                                 ① connection.admit 通过：DSH 的 Host/Origin 信任
                                                    + 浏览器会话 cookie（与 DSH 自己的 /api 相同）
                                                 ② Peer 的 principal 是 owner
                                                 ③ x-orca-pod: 1（跨域会触发预检，而预检永远不放行）
                                                 ④ POST 必须是 application/json
                                               handleGet → PanelModel.state()
                ◀── PodState JSON（已经算好用于显示的数据）

act("approve",{peer,task_id})
                ── POST /orca-api/approve ─▶  POST_ACTIONS[name]
                                               zod 校验 body → panel.approve
                                                 → broker.approve → 远端节点
                ◀── {task} ; 然后 act 再 refresh 一次 state
```

- **契约只有一个文件**：`src/plugin/panel-api.ts`。请求体用 zod schema，host 端解析；响应用 TS 类型（`PodState`、`PodReads`、`PodActions`），client 只做 type-only import。
- GET 路由：`state`、`tasks`、`task`、`blob`（流式下载）。POST 动作：`config`、`connect`、`reset`、`approve`、`deny`、`cancel`。
- client 不放业务逻辑：名称、标签、能不能取消，这些都由 `PanelModel`（`src/plugin/panel.ts`）在 host 端算好。
- 轮询只有一个计时器：有订阅者时运行，最后一个订阅者离开就停；payload 不变时不触发重渲染。
- 审批**不经过模型**：面板直接调 `Tracker` 的 `approve` / `deny`，因为批准权属于人。

client 侧入口：`client/index.tsx` 的 `inject = ["slots", "locale"]` 和 `apply(ctx)`，它注册语言包和四类 slot（设置页、侧边栏按钮、overlay 面板与审批弹窗、会话输入框上方的审批 dock）。构建见 `scripts/build-client.ts`：`react`、`react/jsx-runtime`、`@deepseek-ai/dsh-client-ui-primitives` 由 shell 提供，其余代码打进 bundle。

## 4. 一次 `orca_pod send` 的完整链路（跨机器）

```
本机 Agent 调用工具
  PodTool.send            tools.ts:293
    taskMode（权限不超过本会话）/ attach 文件（先 publish 成 blob）
    orca.mesh.resolve(peer).sendTask()    mesh/orca-node.ts:345
      ── 签名的 POST /a2a  message/send ─▶  远端 Gateway → AccessPolicy 验签
                                            A2aRoutes → tasks.submit()  task/runner.ts:66
                                            SingleSlotTaskRunner → AcpExecutor
                                              spawn dsh 子进程，通过 ACP 跑任务
      dispatches.recordSend(node, view, agentId)  写进派发日志，立即返回 task_id，本轮对话结束
  Tracker 每轮 dispatches.open() → tasks/get → dispatches.update(view)（变了才写，一条 UPDATE）
    ├─ 远端暂停在权限请求上 → broker.park() → 面板或审批 dock 显示 → 人点批准
    │                          → node.approve()（带签名的授权）→ 远端继续执行
    ├─ 404 / 401 / 403，或连续 5 次没有响应 → dispatches.fail() 记成 failed，停止轮询，同样通知
    └─ 进入终态 → 合并通知 → 按 agent_id 找会话（不在就不通知）
                           → agent.inject()（agent 正在运行）
                              或 agent.followup()（agent 空闲，受唤醒预算限制） tracker.ts:197
```

## 5. 建议的阅读顺序

1. `src/plugin/bundle.ts`：整个插件的组装图，最先看。
2. `src/plugin/pod.ts`：状态机（`unconfigured / starting / running / failed / stopped`）和队列。
3. `src/node/orca.ts`：节点内部各子系统是怎么接起来的（Gateway、Mesh、Runner、事件汇总）。
4. `src/plugin/panel-api.ts` → `panel-routes.ts` → `client/store.ts`：host 和 client 之间的通信闭环。
5. `src/plugin/tools.ts` + `tracker.ts`：agent 侧的工作流。
6. 跨机器部分：`src/mesh/mesh.ts`、`src/api/gateway.ts`、`src/api/access.ts`（签名和准入）。

相关正文：模块划分与面板见 [09-implementation.md](09-implementation.md)，签名与审批回路见 [07-security.md](07-security.md)，任务回报与唤醒见 [05-tasks.md](05-tasks.md)。
