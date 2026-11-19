# 02 系统模型

> 本章定义系统的静态结构：两条平面、orca node 的职责、orca node 如何描述自己，以及 orca node 之间的信任与连接关系。

## 2. 系统模型

### 2.1 两条独立平面

**任务面（A2A）**

```text
Origin
  → POST target /a2a  message/send          （带继承的权限模式；审批后同一 task 再发一条带批准的恢复消息）
  → target task store (SQLite): submitted → working
  → origin 轮询 tasks/get
  → completed（结论文本内联；交回的文件以 `<节点 id>/<sha256>` 写在结论里，按需 `fetch`）
```

**控制面（cluster）**

```text
hello（请求头带两样证明：Ed25519 签名 + workgroup 密码派生的 HMAC）→ 双方登记 → 拿到 target 自述 + 目录
  → 目录里的其他成员是候选端点，按心跳节奏拨号（同一个 hello，不存在“被拒再补 join”）
  → 双向心跳 + 本地看门狗
  → 在线集变化 → 任务路由候选集变化
  → 漏掉的成员靠 members_digest 变化拉全量，≤2 个心跳周期收敛
```

任务面不负责成员发现；控制面不负责执行任务。两者共用一个 HTTP server、同一套请求证明（Ed25519 签名 + workgroup HMAC，答复也由应答方签名）；权限与状态严格分开。密码只出现在每个请求头里的 workgroup 证明中（[§7.1](07-security.md#71-workgroup-与密码)）。

### 2.2 每个 orca node 的职责

- 对外：A2A server（接收任务）、A2A client（发起任务）、控制面端点。
- 对内：成员观测、任务存储、LocalExecutor、工作区管理、DSH 生命周期。
- 安全：请求的两样证明校验、答复签名、恢复消息的 origin 校验（[§7.11](07-security.md#711-批准与拒绝)）。
- 可观测：任务记录、origin 派发日志、peer 状态、审批面板（[§8.7](08-reliability.md#87-可观测性)）。

### 2.3 部署形态

| 形态        | 监听                      | TLS           | 适用                     | 备注                                         |
| ----------- | ------------------------- | ------------- | ------------------------ | -------------------------------------------- |
| 单机开发    | `127.0.0.1:11811`         | 无            | 单机自测、面板体验       | 仍然要非空密码；同一台机器同时只有一个 DSH 进程能跑节点 |
| 局域网直连  | `0.0.0.0` / `::` 或私网 IP | 无（明文）    | 家庭/办公室可信网络、VPN | 密码必须够强；跨网段建议走代理               |
| 反代 + 域名 | `127.0.0.1:11811`         | Caddy / nginx | 公网、跨网段、多网卡     | 证书与 HSTS 归代理；把公网 URL 配进 endpoints |

默认监听：插件绑 `127.0.0.1`。默认端口 `11811`。节点只以 DSH 插件的形态运行，一台机器一个节点，不论有几个 DSH profile（[§9.2](09-implementation.md#92-面板)）；端口本身就是互斥锁，第二个 DSH 进程里的节点会启动失败。

### 2.4 orca node 身份（Ed25519 公钥）

- **生成时机**：首次启动时由插件在 DSH 凭据库生成 Ed25519 密钥对，私钥的 32 字节种子以 base58 存在记录 `credentialKey('orca-pod', 'node')`（`{ kind: 'grant', payload: { ed25519 } }`）里（[§7.1](07-security.md#71-workgroup-与密码)）；`orca_node_id` = 原始 32 字节公钥的 base58（与种子同一套 Bitcoin 字母表）。id 与公钥的互换在 `core/ids.ts`（`nodeIdOf` / `publicKeyOf`），`core/identity.ts` 只有纯函数（签名、验签、缩略 id），种子的编解码与生成在 `plugin/stores.ts`。检查与写入在 DSH 的文件锁（`withFileLock`）下进行、写入是原子的，所以两个进程同时首启也只会得到同一个身份。
- **记录损坏**：凭据记录存在但解析不出合法私钥时直接报错，**不会**悄悄生成新身份（那会让节点换一个 id）；要换身份就自己删掉这条记录。
- **格式**：base58（字符集 `[1-9A-HJ-NP-Za-km-z]`，没有 `0OIl`，也没有 `-`、`_`），解码必须正好 32 字节，通常 43–44 字符（开头的零字节各写成一个 `1`）；base58 一一对应，同一把公钥只有一种写法。可验证、不可伪造。日志与缺省显示名用缩略（前 6 + `…` + 后 4），面板空间紧的地方用前 4 + `…` + 后 4、悬停看全称；节点抬头与成员详情显示全称。**不兼容**旧的 base64url id（D62）。
- **换身份**：删除凭据记录并重启会生成新密钥对（面板的“完全重置”是整台机器的节点回到初始状态、没有分支：删密码、私钥记录、设置文件）；新身份需重新入组。**不迁移**：旧版本按 profile 存的身份和任务库都不读，节点用新身份重新入组。
- **持久化**：只存私钥种子（公钥由私钥推导，不单独存）；节点按解析后的设置（`Settings`）运行，节点 id 取自身份，不另组装、不写文件。
- **是安全主体**：签名证明“谁在调用”，伪造需要私钥；密码只补上“此刻在组内”。
- **改名语义**：`display_name` 可随时改（只影响显示，缺省显示缩略 id）；`orca_node_id` 不可改，改就是换身份。
- **冲突**：id 由公钥决定，天然全局唯一；同一身份重复 `hello` 幂等。

### 2.5 orca node 自述记录（SelfRecord）

成员记录的形状（`mesh/wire.ts` 的 `PeerView`）：`orca_pod` 的 `members` 与面板列出的就是它，也是 `hello` 答复里 `self` 的内容（`self` 多一个 `workgroup_id`）；没有单独的“成员目录”路由（`hello` 答复在摘要不一致时附带的目录，见 [§3.3](03-membership.md#33-心跳与双向看门狗)）：

```json
{
  "orca_node_id": "<base58 公钥>",
  "display_name": "书房台式机",
  "endpoints": ["http://192.168.1.11:11811", "https://desk.example.com"],
  "workgroup_id": "orca-dev",
  "runtime": {
    "os": { "family": "win32", "name": "Windows", "version": "10.0.26100" },
    "arch": "x64",
    "cpu": { "model": "AMD Ryzen 9 7950X 16-Core Processor", "logical_cores": 32 },
    "memory": { "total_bytes": 68719476736 },
    "node": { "version": "v26.13.0" },
    "captured_at": "2026-11-14T04:36:33Z"
  },
  "runtime_digest": "<sha256 hex>",
  "state": "online",
  "busy": null,
  "last_recv_at": "2026-11-14T04:36:33Z",
  "max_task_ttl_s": 3600,
  "models": [{ "provider": "deepseek", "id": "deepseek-flash", "name": "DeepSeek Flash" }],
  "default_model": { "provider": "deepseek", "model": "deepseek-flash" },
  "default_reasoning_effort": "max"
}
```

字段规则：

- `runtime` 与整个记录只出现在需要签名的接口里（`hello` 的请求与答复），公网匿名不可读。
- `state`、`last_recv_at` 是**接收方的本地观测**，不是对端的声明；自己的记录里恒为 `online`。
- `busy` 为 `null` 或 `{ "task_id", "origin_orca_node", "since" }`，由本人写、随心跳刷新；origin 的 UI 据此显示“B 正在跑 X”。
- `max_task_ttl_s` 是本机单任务硬预算（`task_timeout_s`，默认 3600），随 self record 公布（面板的节点详情也显示它）；origin 据此拆解任务，超时的任务会被目标机直接终止（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- `models` 与 `default_model` 是本机可执行模型的目录与默认选择：`models` 是 `[{provider, id, name, description?}]`（`name` 必填；去重、上限 128），`default_model` 是 DSH 的 `ModelSelection`（`{provider, model, reasoningEffort?}`）或 `null`；`default_reasoning_effort` 是默认 effort（`null` 表示由 provider 决定）。目录与默认模型就是 DSH Host 报告的（Host 报告前为空），节点设置里只有 `default_reasoning_effort` 一项，它优先于 Host 的 effort 并折进宣告的默认模型（[§6.15](06-execution.md#615-按任务选择模型)）。它们只出现在同组成员可见的记录里（公网匿名读不到，只有签名的 `hello` 带它们）；调用方用 `metadata.pod.model` / `metadata.pod.reasoning_effort` 选择（[§6.15](06-execution.md#615-按任务选择模型)）。
- `endpoints` 是有序列表（1–8 个 http(s) URL，去重去尾斜杠），第一个是 primary：面板展示用它。节点只认它宣告过的地址：别人用没在列表里的地址（比如 `localhost:端口`）连上它，那个地址之后也不能用来指名它（[§3.1](03-membership.md#31-成员状态的判定)）。顺序即拨号优先级，覆盖 IPv6/IPv4 双栈与“局域网直连 + 公网反代”矩阵；对端逐地址尝试，一个地址不可达不等于 orca node 离线，上次成功的地址会排到最前（[§4.3](04-transport.md#43-反向代理注意事项)）。列表只影响“别人怎么拨我”，监听地址由 `bind_host` 决定。
- 配置里 `endpoints` 为空时按监听地址推导：绑 `0.0.0.0`/`::` 时枚举本机非 internal 的 IPv4/IPv6 地址（IPv4 在前，跳过 `fe80:` 前缀的链路本地 IPv6），识别不到才回退 loopback；绑具体地址就用该地址。
- 记录里**没有**工作区用量、GPU、DSH 版本、能力标签；需要这些信息就问对方的 agent。

### 2.6 runtime 采集

runtime 的用途只有一个：让 origin 在派任务前判断“那台机器能不能干这个活”。

- 全部来自 Node 的 `os` 模块与 `process`：`os.platform()`/`os.release()`、`process.arch`、`os.cpus()` 的型号与逻辑核数、`os.totalmem()`、`process.version`；没有注册表、`lscpu`、`nvidia-smi` 之类的外部调用。
- 进程创建 orca node 时采集一次，不刷新；`captured_at` 是采集时间。
- `runtime_digest` = sha256(os.family|os.name|os.version|arch|cpu.model|逻辑核数|memory.total|node.version)。

### 2.7 刷新与一致性

- 心跳就是 `hello`：带 `busy`、成员摘要与完整的 `self` 自述（收到 `self` 会重建对端记录），答复只在摘要不一致时回整张目录作候选（[§3.3](03-membership.md#33-心跳与双向看门狗)）。
- `members_digest` = sha256(排序后的 `id|endpoints|runtime_digest` 行，含自己)；只覆盖这三项，不覆盖 busy、模型目录和在线状态。
- 收到的 digest 与本地不一致 → 对端在响应里回整张目录，只作候选端点。
- 目录里每条记录的“新鲜度”由本地的 `last_recv_at` 体现，不由记录内的字段体现。
- 记录只有本人能写：**其他 orca node 绝不改写某条记录的内容**，也不替它声明在线。这条规则是不需要版本号的基石（[§3.1](03-membership.md#31-成员状态的判定)）。

---
