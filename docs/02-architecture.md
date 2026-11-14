# 02 架构与成员

> 关注：系统由哪些部分组成、节点是什么、节点信息里有什么、成员如何发现彼此并收敛。
>
> 章节编号沿用全局编号；文内 `§x.y` 链接指向对应文档。

## 4. 总体架构

```text
                     Workgroup: whale-pod
                     Full mesh (<= 10 nodes), 唯一拓扑

   ┌──────────── Caddy / nginx (TLS, 可选) ────────────┐
   │                    :443                           │
   └──────────┬───────────────────────────┬────────────┘
              │ reverse_proxy             │
              ▼                           ▼
        Node A  :41241               Node B  :41241
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ Pod 插件（DSH 内）            │  │ Pod 插件（DSH 内）            │
│  ├ A2A server   /a2a         │  │  ├ A2A server   /a2a         │
│  ├ Agent Card   /.well-known │◄─┼─►├ Agent Card   /.well-known │
│  ├ 控制面       /cluster/*   │  │  ├ 控制面       /cluster/*   │
│  ├ 任务存储 (SQLite)          │  │  ├ 任务存储 (SQLite)          │
│  ├ LocalExecutor             │  │  ├ LocalExecutor             │
│  │   └ ACP client (stdio)    │  │  │   └ ACP client (stdio)    │
│  │      └ dsh --profile orca │  │  │      └ dsh --profile orca │
│  └ workgroup 工作区            │  │  └ workgroup 工作区            │
│ DSH: model + tools + sandbox │  │ DSH: model + tools + sandbox │
└──────────────────────────────┘  └──────────────────────────────┘

        Node C  ──────────────────────────────────────────  Node D
                          ... full mesh ...
```

### 4.1 两条独立平面

**任务面（A2A）**

```text
Origin
  → POST target /a2a  message/send          （带 grant + 继承的权限模式）
  → target task store (SQLite): submitted → working
  → origin 轮询 tasks/get（或 SSE）
  → completed + artifacts
  → origin 展示工作区状态与 run manifest
```

**控制面（cluster）**

```text
join（一次，凭 workgroup_id + 密码）→ 拿到 target 自述 + 全量目录
  → 向目录里每个 peer 发第一拍心跳（带 full self）
  → 对方收到 → 登记本节点 → 回心跳（双向计时开始）
  → 双向心跳 + 本地看门狗
  → 在线集变化 → 任务路由候选集变化
  → 漏掉的成员靠 members_digest 变化拉全量，≤2 个心跳周期收敛
```

任务面不负责成员发现；控制面不负责执行任务。两者共用一个 HTTP server，鉴权方式相同（同一把派生密钥），但权限与状态严格分开。

### 4.2 每个节点的职责

- 对外：A2A server（接收任务）、A2A client（发起任务）、控制面端点。
- 对内：成员观测、任务存储、LocalExecutor、工作区管理、DSH 生命周期。
- 安全：密码派生密钥、请求签名校验、grant 执行、硬拒绝清单、审计。
- 可观测：`trace_id`、`task_id`、peer 状态、工作区用量、审批记录。

### 4.3 部署形态

| 形态 | 监听 | TLS | 适用 | 备注 |
|---|---|---|---|---|
| 单机开发 | `127.0.0.1:41241` | 无 | 本机两进程、联调 | 仍然要密码，只是短一点 |
| 局域网直连 | `0.0.0.0:41241` 或私网 IP | 无（明文） | 家庭/办公室可信网络、VPN | 密码必须够强；跨网段建议走代理 |
| 反代 + 域名 | `127.0.0.1:41241` | Caddy / nginx | 公网、跨网段、多网卡 | 证书与 HSTS 归代理 |
| 内建 mTLS（后续） | 任意 | 节点自己 | Phase 4+ | 需要 CA 分发与轮换 |

---

## 6. 节点身份与节点信息

### 6.1 短 id（node_id）

- **生成时机**：插件安装/首次启用时生成一次，写入插件配置并持久化（随 profile 存放，不进 git 仓库）。
- **格式**：6 字符，Crockford Base32 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（无 I/L/O/U，避免 1/0 混淆）。展示为 `N7K3QM`。
- **可改**：UI/配置可手改成任意合法短 id（也允许小写，落库统一大写）。改完必须重启监听并向各 peer 重新发心跳（[§10.8](02-architecture.md#108-id-变更冲突离开)）。
- **持久化**：写在插件配置（如 `<profile>/plugins/pod/config.json`），含 `node_id`、`display_name`、`endpoint`、`workgroup_id`、密码引用。
- **不是安全主体**：认证靠 workgroup 密码；短 id 只用于日志、指标、UI、任务元数据。任何人可把 id 改成 `AAAAAA`，安全性不因此变化。
- **改名语义**：改 id 等价于“离开 + 重新加入”。旧 id 在别人的表里会成为一条逐渐过期的记录；推荐 UI 在改名时提示“其余节点会自己清掉旧记录”。
- **冲突**：join 时若目标 workgroup 已有同 id 且端点不同 → `409 node_id_conflict`，UI 建议 `N7K3QM-2`。若端点相同（同一节点重复 join）→ 幂等成功。

### 6.2 节点自述记录（SelfRecord）

`GET /cluster/members` 的元素，也是 join 响应里 `self` 的内容：

```json
{
  "node_id": "N7K3QM",
  "display_name": "书房台式机",
  "endpoint": "http://192.168.1.11:41241",
  "workgroup_id": "whale-pod",
  "runtime": {
    "os": { "family": "windows", "name": "Windows 11 Pro", "version": "24H2", "build": "26100.2314" },
    "arch": "x86_64",
    "cpu": { "model": "AMD Ryzen 9 7950X 16-Core Processor", "physical_cores": 16, "logical_cores": 32 },
    "memory": { "total_bytes": 68719476736, "available_bytes": 41234567168 },
    "gpus": [{ "name": "NVIDIA GeForce RTX 4090", "memory_bytes": 25757220864 }],
    "dsh": { "version": "0.9.0", "profile": "orca" },
    "plugin": { "version": "0.1.0" },
    "caps": ["shell:pwsh", "gpu:cuda"],
    "captured_at": "2026-11-14T04:36:33Z"
  },
  "runtime_digest": "sha256:1f0c9a...",
  "roles": ["exec"],
  "workspace": { "used_bytes": 12345678, "quota_bytes": 5368709120 },
  "busy": null,
  "joined_at": "2026-11-14T04:01:02Z",
  "server_version": "0.1.0"
}
```

Linux 节点的 `os` 形如：

```json
{ "family": "linux", "name": "Ubuntu", "version": "24.04.1 LTS", "kernel": "6.8.0-45-generic", "libc": "glibc 2.39" }
```

字段规则：

- `runtime` 与整个记录只出现在需要签名的接口里，公网匿名不可读。
- `available_bytes` 是采集瞬间值，会变；它不进 `runtime_digest`（否则心跳每次都要拉全量）。`digest` 只覆盖稳定字段：os/cpu/memory.total/gpus/dsh/plugin/caps。
- `workspace` 只报**用量与配额**，不含路径；真实目录由目标节点自己解析。忙闲是动态字段：`busy` 为 `null` 或 `{ "task_id", "origin_node", "since" }`，由本人写、心跳刷新；origin 的 UI 据此显示“B 正在跑 X”。
- `endpoint` 只有一个。跨网段、公网、NAT 穿透都靠代理或 VPN 把这个地址变得可达，不靠节点自报第二个地址（[§5.3](03-protocol.md#53-反向代理注意事项)）。
- 采集失败不阻塞启动：缺字段就省略，并在 `runtime.error` 里写原因。

### 6.3 runtime 采集

| 字段 | Windows | Linux |
|---|---|---|
| os.name/version | `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion` 的 `ProductName` / `DisplayVersion`，build 用 `CurrentBuild` + `UBR` | `/etc/os-release` 的 `NAME` / `VERSION` |
| kernel | `CurrentBuild.UBR` | `uname -r` |
| arch | `process.arch` / `PROCESSOR_ARCHITECTURE` | `process.arch` |
| cpu | `os.cpus()` 型号；物理核用 `Win32_Processor.NumberOfCores` 求和 | `os.cpus()`；物理核读 `lscpu` 或 `/sys/devices/system/cpu/cpu*/topology/core_id` |
| memory | `os.totalmem()/freemem()` | 同左（`MemAvailable` 更准，可选读 `/proc/meminfo`） |
| gpu | `Win32_VideoController` | `nvidia-smi -L` 或 `/sys/class/drm` |
| dsh/plugin | 插件自报版本 | 同左 |

注意：

- Windows 上别用 `Get-ComputerInfo`（慢、依赖 PowerShell 策略）；直接读注册表。
- 采集一次缓存 5 分钟，心跳只带 digest，不重复跑。
- `caps` 是人工/自动声明的能力标签（`shell:pwsh`、`gpu:cuda`、`docker`），用于 origin 侧“这个任务该发给谁”的筛选；不要靠它做安全决策。

### 6.4 刷新与一致性

- 心跳只带 `runtime_digest` 与 `members_digest`。
- 收到 digest 与本地缓存不一致 → `GET /cluster/members` 拉全量（缓存 30s，避免风暴）。
- 目录里每条记录的“新鲜度”由本地的 `last_recv_at`/`last_ok_at` 体现，不由记录内的字段体现。
- 记录只有本人能写：**其他节点绝不改写某条记录的内容**，也不替它声明在线。这条规则是不需要版本号的基石（[§10.1](02-architecture.md#101-成员状态的三个问题)）。

---

## 10. 控制面：full mesh 成员与时序

### 10.1 成员状态的三个问题

| 问题 | 回答 |
|---|---|
| 谁有资格说“某节点存在”？ | 只有该节点自己。别人只能转述端点，不能转述在线。 |
| “在线”由谁判定？ | 收方本地。`last_recv_at` 只由对方心跳更新；收不到就下线，与别人怎么说无关。 |
| 死掉的节点怎么从表里消失？ | 本地过期 + 墓碑 + 修剪。不需要共识，也不需要广播。 |

由此推出三条硬规则：

1. 成员表里只放**直接观测**：我收到过它的心跳，或它成功 join 过我。
2. 别人的表只提供 **hint（端点候选）**，永远不提供“它在线上”这一事实。
3. 在线判定的唯一输入是本地的 `last_recv_at`，hint 不得修改它、不得重置退避、不得清除墓碑。

### 10.2 引导与加入

**首次启用（插件安装）**

```text
1. 生成 node_id（§6.1），写配置
2. 采集 runtime，生成 runtime_digest
3. 起监听（默认 127.0.0.1:41241）
4. 若配置里已有 workgroup_id + 密码：向目录内每个已知端点后台发第一拍心跳
5. 否则进入“未加入”状态，只响应 /health
```

**加入任意节点（host + port）**

```text
D（新）                                            A（已在 mesh）
  POST http://A:41241/cluster/join
  { workgroup_id, node_id, display_name, endpoint,
    self, nonce, ts, proof }
                                              ├ 校验 workgroup_id
                                              ├ 校验 proof（§12.2）
                                              ├ 校验 ts 窗口 / nonce 未用过
                                              ├ 校验 node_id 冲突
                                              └ 记录 D（只记 D 的自述）
  200 { self: A, members: [...], members_digest, server_version }

  D 拿到成员表 → 对每个 peer 发第一拍心跳（带 full self）
  → peer 校验签名 → 登记 D → 回心跳（双向计时开始）
  → 漏在别处的成员，靠 members_digest 变化拉全量补上
```

要点：

- **join 只用于引导**：拿目录、完成第一次登记。之后进入 mesh 靠心跳，不需要逐节点 join。
- **第一拍心跳就是“我在这里”的声明**：带完整 self（≤ 2 KB），对方收到后验签、登记、回拍；**登记即纳入对方的发送列表**（心跳是对称的，不存在只收不发）。后续心跳只带 digest，不再带 self。
- **方向恒为单向出站**：新节点主动连已知节点；旧节点不需要能反向连新节点（NAT 场景只在 D 能出站时成立）。
- **不广播**：没有 announce 消息、没有 gossip。D 自己去找目录里的每个人，这本身就把“我在”传播出去了。
- **幂等**：同一 `node_id` 重复 join / 重复心跳，端点相同即成功，不重复写表。
- **自动接受**：workgroup 密码正确即接受。想被通知可开 `notify_only`（只发本地通知，不阻塞）。默认自动接受 + 审计。
- **拒绝**：`401` 用统一文案（不区分“workgroup 不对”和“密码不对”）；`429` 限流；`409` 只给 id 冲突（需要人改名，必须可诊断）。

### 10.3 心跳与双向看门狗

> 判定在线不是“我能不能连上它”，而是“我最近有没有收到它”。

每个节点对每个 peer 维护两条时间线：

| 字段 | 含义 | 谁更新 |
|---|---|---|
| `last_recv_at` | 最近一次**收到**该 peer 心跳的时间 | 本节点（收包时） |
| `last_ok_at` | 最近一次**成功发出**并为该 peer 收到响应的时间 | 本节点（请求返回时） |
| `fails` | 连续失败次数（用于退避） | 本节点 |

`POST /cluster/heartbeat`：

```http
POST /cluster/heartbeat
{ "from": "P2W8XA", "endpoint": "http://192.168.1.12:41241",
  "runtime_digest": "sha256:...", "members_digest": "sha256:...",
  "self": { ... },                                   // 仅首次，或记录变更时
  "hints": [{ "node_id": "Z3M4AQ", "endpoint": "http://192.168.1.13:41241" }] }

200 { "from": "N7K3QM", "endpoint": "http://192.168.1.11:41241",
      "runtime_digest": "sha256:...", "members_digest": "sha256:...", "hints": [] }
```

- `members_digest` 不同 → `GET /cluster/members` 拉全量。
- `hints` ≤ 8 条，只含**自己认为在线**的 peer 的端点；接收方严格按 [§10.5](02-architecture.md#105-hints候选与墓碑死节点为什么不会复活) 处理，只当候选。
- 心跳超时（客户端侧）取 `interval` 的一半，别用 30s 默认值。
- 心跳同时是 keep-alive 与“我还活着”的证明；没有单独 ping。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `interval` | 2s（±20% 抖动） | 10 节点 = 45 条链路 ≈ 45 req/s |
| `suspect_after` | 3 次 ≈ 6s | 连续未收到 |
| `offline_after` | 6 次 ≈ 12s | 累计未收到，移出在线集 |
| `recover_probe` | 15s → 30s 退避 | offline 后的探测 |
| `record_ttl` | 7d | offline 记录保留上限，之后修剪 |
| `hint_ttl` | 10min | 候选节点失败后的墓碑时长 |

超时判定用**单调时钟**。墙上时钟只用于显示与 `ts` 校验：Windows 休眠一夜唤醒后 `Date.now()` 会跳几小时，用墙钟算“多久没心跳”会把全网点成 offline。

状态机：

```text
unknown ──(收到第一拍心跳)──────────────────────► online
online  ──(连续 3 次未收到)─────────────────────► suspect(quiet)
online  ──(连续 3 次发失败，但仍在收到心跳)──────► suspect(unreachable)
suspect(unreachable) ──(某次发送成功)───────────► online
suspect(unreachable) ──(开始也收不到)───────────► suspect(quiet)
suspect(quiet) ──(再 3 次未收到，累计 6 次 ≈12s)─► offline
suspect(quiet) ──(任何一次收到)─────────────────► online
offline ──(低频探测成功)────────────────────────► online
offline ──(record_ttl 到期)─────────────────────► 修剪出表（本地）
```

路由规则：**只有 `online` 接受新任务**；`suspect`/`unreachable`/`offline` 都不派新任务，但不取消已经在跑的任务。`suspect(unreachable)` 在 UI 里单独标“单向不通”——这和“它挂了”是两种故障，排障方向完全相反。

### 10.4 收敛时序

```text
t0      D → A: join
t0+5ms  A: 记下 D，返回 {self: A, members: [A, B, C]}
t0+20ms D → B: 第一拍心跳（带 full self）        ← 并发
t0+20ms D → C: 第一拍心跳（带 full self）        ← 并发
t0+25ms B/C: 验签 → 登记 D → 回心跳
t0+2s   三向心跳稳定；D 出现在所有人的 online 集
```

- 已有 N 个节点时，新节点的开销 = 1 次 join + N-1 次心跳，全部并发。
- 目录是旧的（漏了 E）：E 的心跳 digest 变化 → D 拉全量 → 补发心跳给 E。最多 2 个心跳周期。
- hint 引入的未知端点：先当候选拨一次，失败即墓碑 10 分钟，不进正式表（[§10.5](02-architecture.md#105-hints候选与墓碑死节点为什么不会复活)）。

### 10.5 hints、候选与墓碑（死节点为什么不会复活）

**先看要避免的死循环**。它只会在“把整张表塞进心跳、且接收方照单全收”时出现——`hints` 只带 online peer 是第 0 道防线，下面讲的是万一第 0 道被绕过（比如实现者图省事，把表原样发出去）时，接收方靠什么兜住：

```text
D 掉线
A 的表里还有 D（旧记录）→ A 的心跳把 D 发给 C
C 收到 → “原来还有 D” → 把 D 加回心跳列表 → 给 D 发心跳（失败，但表里留着）
C 的心跳又把 D 发给 A → A 把 D 加回列表
→ A、C 互相刷新，D 永远活着
```

根因只有一个：**把“别人的记忆”当成了“D 还活着的证据”**。解法是把“记录”和“在线”彻底拆开：

| 动作 | 允许吗 |
|---|---|
| 别人的 hint 给我一个端点 | 允许（进候选） |
| 别人的 hint 修改我的 `last_recv_at` | **禁止** |
| 别人的 hint 把节点直接写进成员表 | **禁止** |
| 别人的 hint 重置我对该节点的退避/墓碑 | **禁止** |
| 只有 D 自己的心跳能让我把它标 online | 是 |

具体规则：

1. **候选**：hint 里的未知 `node_id` 进候选区（最多 32 条，TTL 10 分钟），立即拨一次；成功则等对方回心跳自然入表，失败则写墓碑 `hint_ttl=10min`，期间同 id 的 hint 直接丢弃。
2. **已知节点**：hint 只在“我当前端点已失败且新端点不同”时更新候选端点，触发一次探测，且受退避约束（每 5 分钟最多一次）。
3. **offline 节点**：hint 不改状态、不复活；只有它自己的心跳能复活它。
4. **修剪**：offline 超过 `record_ttl`（7d）→ 从表里删除（同时留 7d 墓碑）。这是纯本地决定。
5. **墓碑**：`{node_id, until}` 小表，只在本地，不传播；过期的墓碑自动清掉。

于是 A、C 之间互换 hint 不会产生任何活着的 D：hint 只能让某个节点“再试一次”，试完还是失败，就进墓碑，10 分钟内不再试；7 天后记录修剪，D 彻底消失。**D 要回来，只能是 D 自己发心跳**（或重新 join）。

> 回答“能不能用 `offline_after` 阻止别人的缓存进入我的表”：不要。`offline_after` 是**在线阈值**，不是**入表过滤器**。拿它当过滤器会把“刚启动还没收到心跳的新节点”也挡掉，而且它不解决“A 和 C 都用旧记录互相刷新”的问题。该做的是：hint 只进候选 + 墓碑 + 只有本人能复活。

### 10.6 目录合并与墓碑

- 合并原则：**按 `node_id` 去重，字段以本人记录为准**；本地只保留 `last_recv_at`/`last_ok_at`/`state`/`fails`。
- 冲突（同 id 不同端点）：以最近一次成功心跳的端点为当前端点；旧端点保留为候选 24h，失败即丢。
- 删除：只删本地记录，不通知别人；别人会在 `record_ttl` 后自己修剪。
- **踢人（安全语义）**：没有共识，所以“移除节点”不是可广播的操作。真正把它踢出去只能**换密码**：换完所有旧签名立即失效，其余节点用新密码重新加入。UI 必须这么写，别让用户以为点一下 forget 就安全了。
- 换密码的代价：所有节点要同步新密码；这是**唯一**的吊销手段，也是它简单的原因。

### 10.7 故障、恢复、休眠

- 网络抖动：`suspect` 是可恢复态；新任务在 suspect 期间暂停路由（只有 `online` 接新任务），但**不取消**在跑的任务。
- 单向不通：`suspect(unreachable)`，UI 提示检查防火墙/代理/端口，而不是“对方关机了”。
- 机器休眠：唤醒后所有 peer 同时超时；用单调时钟避免“睡了 8 小时 = 离线 8 小时”的误判；唤醒后立即对全部 peer 发一拍。
- 时钟漂移：`ts` 窗口 ±60s；超过就拒，并在错误里说明“检查系统时间”，别静默容忍。
- 脑裂（本设计不存在“裂”）：没有主节点，没有需要多数派的状态；每个节点各自观测，最多是互相看不见，恢复后靠心跳自动重连。

### 10.8 id 变更、冲突、离开

- 改 `node_id`：等同 leave + rejoin；旧记录靠 `record_ttl` 自然消失。
- 冲突：后到者 `409`；允许同一节点换端点（同 id 同端点幂等）。
- `POST /cluster/leave`：本地不再响应心跳、删除对方记录（best-effort）；**不是安全操作**，对方仍可凭密码重新加入。

---
