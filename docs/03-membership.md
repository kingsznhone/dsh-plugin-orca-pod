# 03 成员与收敛

> 成员关系只有一种来源：直接收到对方的 `hello`。本章描述接触、心跳、收敛、死亡判定与恢复。

## 3. 成员与收敛

### 3.1 成员状态的判定

| 问题                              | 回答                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| 谁有资格说“某 orca node 存在”？   | 只有该 orca node 自己。别人只能转述端点，不能转述在线。                           |
| “在线”由谁判定？                  | 收方本地。`last_recv_at` 只由对方自己的 `hello`（或它对我方 `hello` 的应答）更新，与别人怎么说无关。 |
| 死掉的 orca node 怎么从表里消失？ | 本地过期 + 墓碑 + 修剪。不需要共识，也不需要广播。                                |

由此推出三条硬规则：

1. 成员表里只放**直接观测**或**显式登记**：它的 `hello` 到过我这里，或我的 `hello` 被它应答过。
2. `hello` 的答复里可以携带**目录**（谁存在），但目录条目只是候选端点，永远不提供“它在线上”。
3. 在线判定的唯一输入是本地的 `last_recv_at`；候选目录不得修改它、不得修补已有记录、不得清除墓碑。

**表里是节点对象。** 成员表是一张 `Map<节点 id, OrcaNode>`（`mesh/mesh.ts`），**本机自己也在表里**：`mesh.self` 与其他行是同一个类，“是不是自己”只看 `node.id === 本机 id`。一个节点的一切状态都在它自己身上（自述、状态机的证据、可拨地址、上次成功的地址）；要用哪个节点，就先 `mesh.resolve(引用)` 拿到它再调它的方法（`hello` / `sendTask` / `getTask` / `fetchBlob`……）。引用可以是节点 id、**唯一**的显示名、或它**宣告过**的 URL（`hasUrl` 只看它自述里的 `endpoints`，没有别名：靠没宣告的地址，比如 `localhost:端口`，连上一个只宣告局域网地址的节点之后，仍只能用 id、显示名或它宣告的地址指名它）；显示名重名时报错并列出候选 id，陌生 URL 报 `unknown_peer`（D58）。本机这一行恒为 `online`、不被心跳、取文件直接读本机盘，其余与别的行一样。

### 3.2 引导与加入

**启动**（一个 DSH 进程里的一个节点；一台机器只有一个节点，不论有几个 profile）

```text
1. 读设置文件 <data_root>/settings.json、凭据库里的密码与节点私钥（没有私钥就生成并写入）
2. 起监听（默认 127.0.0.1:11811）——这是启动的第一步，端口就是锁：另一个 DSH 进程已占着端口时，
   本进程报 `an orca node is already running on this machine, in another DSH process`，且没有动过共用的数据目录
3. 绑定成功后才打开 SQLite、把被中断的任务标失败、把在途派发标 unknown
4. 采集 runtime、把监听地址写进自述；开始心跳循环
5. 配置的 peers 与记住的 peers 作为种子：逐个 `hello`；没应答的由心跳循环按 `recover_probe` 退避继续重试（与 offline 节点的探测共用一条退避，`recoverDelayMs`），直到连上或被手动移除
6. 没有 workgroup_id 或密码：节点保持未配置、不监听（面板向导填完才启动）
```

**接触任意地址（host + port）：`hello`**

接触和保活是**同一个请求**，区别只是有没有可比对的摘要、签名里有没有接收方 id：

```text
D（新）                                            A（已在 mesh）
  POST http://A:11811/cluster/hello
  Authorization: Pod id=D; wg=<workgroup>; ts; nonce; sig=<Ed25519>; proof=<HMAC>   （首次没有 target）
  { self: {display_name, endpoints, runtime, max_task_ttl_s, models, ...}, busy, digest }
                                              ├ 验两样证明、时间窗、nonce 未用过（所有路由一样）
                                              ├ 筛查 D 声明的端点
                                              └ 登记或刷新 D（显式成员，在线）
  200 { self: A, members_digest, members: [A 已知的其他成员] | null }
  Pod-Reply: id=A; sig=<对 请求 nonce | status | body 的签名>

  D 验 A 的答复签名，登记 A（首次是 TOFU：签名者的 id 就是 A 的身份），把 members 当候选端点
  → D 的心跳循环拨候选 B：同一个 hello；B 登记 D
  → 双方互相登记，双向计时开始
```

要点：

- **`hello` 即登记**：请求头里的两样证明已经说明发送者在组内，所以不需要先 join 再心跳；对端把我的记录修剪了也没有关系，我的下一个 `hello` 本身就重新登记。没有 `not_a_member`、没有“被拒就补 join”。
- **只有种子地址能碰陌生人**：种子来自设置里的 `peers`、记住的 peers、`connect` 工具或面板。别人目录里的地址只能当候选，拨之前照旧筛查（[§7.7](07-security.md#77-ssrf--候选端点防护)）。
- **方向恒为单向出站**：新 orca node 主动连已知 orca node；旧 orca node 不需要能反向连新 orca node。
- **不广播**：没有 announce 消息、没有 gossip。D 自己去找目录里的每个人，这本身就把“我在”传播出去了。
- **幂等**：同一 `orca_node_id` 重复 `hello`，用这次的自述替换记录里的资料（端点、显示名、runtime、预算、模型目录），不重复写表。
- **自动接受**：workgroup 密码正确即接受，没有“待批准”状态。
- **拒绝**：`400 workgroup_mismatch`（workgroup 不对）、`401 bad_proof`（密码证明不对）、`401 bad_signature`、`401 clock_skew`（时间差 > 60s）、`401 nonce_replay`。
- **答复绑定请求并带签名**：发方已知对端 id 时，答复必须由那个 id 签名，否则按 `peer_error` 处理；答复签名绑定请求的 nonce，一个答复不能被挪去冒充另一个请求的答复。
- **模型目录随自述登记**：`self` 里的 `models`/`default_model`/`default_reasoning_effort` 写进成员记录；模型清单只对同组成员可见，不进公开面（[§6.15](06-execution.md#615-按任务选择模型)）。

### 3.3 心跳与双向看门狗

> 判定在线不是“我能不能连上它”，而是“我最近有没有收到它”。

每个 orca node 对每个 peer 维护两条时间线：

| 字段           | 含义                                           | 谁更新                     |
| -------------- | ---------------------------------------------- | -------------------------- |
| `last_recv_at` | 最近一次**收到**该 peer 的 `hello`（或它的应答）的时间 | 本 orca node（收包时）     |
| `fails`        | 连续失败次数（用于判定 `suspect(unreachable)`） | 本 orca node               |

心跳就是对每个到期的 peer 发一个 `hello`：

```http
POST /cluster/hello          （请求头同上；body 如下）
{ "self": { "display_name": "...", "endpoints": ["http://10.0.0.2:11811"], "runtime": { ... },
            "max_task_ttl_s": 3600, "models": [ ... ], "default_model": { ... }, "default_reasoning_effort": "high" },
  "busy": null,
  "digest": "<members_digest>" }

200 { "self": { ...对端自己的记录，多一个 workgroup_id },
      "members_digest": "<hex>",
      "members": [ ...整张目录... ] }          // 仅摘要不一致时，否则为 null
```

- 每个请求的头里同时带 **Ed25519 签名**（证明出自这个节点、方法/路径/接收方/body 没被改）和 **workgroup 证明**（HMAC，证明它此刻仍在组内），输入相同：`"orca-pod/request" | 方法 | target | 路径+查询 | sha256(body) | ts | nonce | workgroup_id`。两样都对才进路由；失败回 `401 bad_proof` / `bad_signature`（时钟偏差 `clock_skew`、nonce 重放 `nonce_replay`）。见 [§4.7](04-transport.md#47-方法与异步语义) 与 [§7.1](07-security.md#71-workgroup-与密码)。
- 证明对不上意味着“它不再属于这个 group”：发方收到 401 立即把对方从成员表移除（不等 offline 计时），收方同样拒绝；**改了密码的节点在它的下一个请求就被拒**，不必等下一拍心跳。
- **每个 `hello` 带完整自述**（`self`）：节点启动后才变化的资料（典型是插件晚一步拿到 Host 模型目录）靠它在下一拍传到已认识它的 peer。请求签名覆盖整个 body，所以它就是本人的话，收方用它替换该成员的资料；端点照 [§7.7](07-security.md#77-ssrf--候选端点防护) 筛查，全部被拒回 `endpoint_refused`，同一组端点的筛查结果复用 60s（首次接触总是重新筛查）。
- 摘要不一致 → 对端顺势回一次目录。接收方按 [§3.5](03-membership.md#35-候选端点与墓碑) 处理：只进候选，不声明在线。
- `hello` 同时是 keep-alive 与“我还活着”的证明；没有单独 ping。
- 请求超时取当前 `interval` 的一半，别用 30s 默认值。
- 对每个 peer 按 `endpoints` 顺序逐地址拨号：任一成功即可达，成功的地址下一轮排最前；全部失败才计一次失败。拨号状态（上次成功的地址）在节点对象上。

**节奏自适应**：`interval = N` 秒，`N` 是 workgroup 里的 orca node 数（含自己），夹在 2–10s，±10% 抖动。这样每个节点每秒只发约 1 个 `hello`，全集群总流量 ≈ `N` req/s——线性，而不是固定 2s 下的 `N(N-1)/2` 条链路。代价是判定延迟随 `N` 增长：`suspect` ≈ 1.25 拍、`offline` ≈ 3 拍，10 节点时分别约 12.5s / 30s。成员数一变，下一拍自动换算。

参数：

| 参数            | 默认                              | 说明                                         |
| --------------- | --------------------------------- | -------------------------------------------- |
| `interval`      | `N` 秒，夹在 2–10s（±10% 抖动）   | 集群总流量 ≈ `N` req/s，线性增长             |
| `suspect_after` | `interval × 1.25`（留抖动余量）   | 这么久没收到即可疑                           |
| `offline_after` | `interval × 3`                    | 累计未收到，移出在线集                       |
| `recover_probe` | 15s → 30s 退避                    | offline 后的探测，种子重试同此（`recoverProbeMs × 2^(失败次数-1)`，封顶 `maxRecoverProbeMs`） |
| `record_ttl`    | 7d                                | offline 记录保留上限，之后修剪               |
| `tombstone`     | 10 min                            | 被移除/修剪的 id 在这段时间内不再从他人目录登记；本人的 `hello` 会清除墓碑 |

超时判定用**单调时钟**。墙上时钟只用于显示与 `ts` 校验：墙钟会因休眠、校时跳变，用它算“多久没心跳”会把全网点成 offline。

状态机：

```text
unknown ──(收到对方的 hello，或对方应答了我的 hello)──► online
online  ──(静默超过 suspect_after)────────────► suspect(quiet)
online  ──(连续 1 拍发失败，但仍在收到)────────► suspect(unreachable)
suspect(unreachable) ──(某次发送成功)─────────► online
suspect(unreachable) ──(也开始收不到)─────────► suspect(quiet)
suspect(quiet) ──(累计静默超过 offline_after)──► offline
suspect(quiet) ──(任何一次收到)────────────────► online
offline ──(低频探测成功)───────────────────────► online
offline ──(record_ttl 到期)────────────────────► 修剪出表（本地）+ 墓碑
```

路由规则：**只有 `online` 接受新任务**（否则 `peer_not_online`）；`suspect`/`offline` 都不派新任务，但不取消已经在跑的任务。`suspect(unreachable)` 在 UI 里单独标“单向不通”——这和“它挂了”是两种故障，排障方向完全相反。

### 3.4 收敛时序

```text
D → A: hello（首次，target 为空）                A 登记 D，回 {self: A, members: [B, C]}
D 的心跳循环把 B、C 当候选，并发拨号：
D → B, C: hello                                  B/C 凭请求头里的两样证明登记 D，回各自的 self
B/C 的 hello 也各自到达 D                         三向稳定；D 出现在所有人的 online 集
```

- 已有 N 个 orca node 时，新 orca node 的开销 = 1 次 `hello`（到种子 A）+ N-1 次 `hello`（候选，随心跳循环并发发出）。没有“被拒再补 join”的第二步。
- 目录是旧的（漏了 E）：`hello` 摘要不一致 → 对端回目录 → 本 orca node 把 E 当候选拨号。最多 2 个心跳周期。

### 3.5 候选端点与墓碑

**为什么 `hello` 要回目录**。一次接触只给一次快照。如果两个 orca node 分别从不同 orca node 加入（比如 A 和 B 短暂分区时，C 跟了 A、D 跟了 B），只靠第一次的快照会永久分成两半。`hello` 的答复里的目录就是这条修复通道：请求带摘要，摘要不一致时对端回一次自己的目录。但目录条目**只是候选端点**，不是在线声明；两个 orca node 真正建立心跳边，靠的是互相拨号。

**要避免的死循环**（把“别人的记忆”当成“它还活着”的证据）：

```text
D 掉线
A 的表里还有 D（旧记录）→ A 在摘要变化时把 D 回给 C
C 收到 → 把 D 当成 online 写进自己的表，并回传给 A
→ A、C 互相刷新，D 永远“活着”
```

解法是把“记录”和“在线”彻底拆开：

| 动作                                         | 允许吗                          |
| -------------------------------------------- | ------------------------------- |
| 心跳目录给我一个端点                         | 允许（进表为 `unknown` 的候选） |
| 心跳目录修改我的 `last_recv_at`              | **禁止**                        |
| 心跳目录把 orca node 标成 `online`           | **禁止**                        |
| 心跳目录改写已有记录的端点/显示名/模型       | **禁止**                        |
| 只有该 orca node 自己的心跳/应答能把它标 `online` | 是                         |

具体规则：

1. **候选**：未知 `orca_node_id` + endpoints 进表，`state=unknown`、来源标 `candidate`；拨号前先过 [§7.7](07-security.md#77-ssrf--候选端点防护) 的地址筛查（按 endpoints 顺序）。对方收到我的 `hello` 就会登记我；它的答复到达后，对方在我这里转 online。拨不通时按 offline 的退避节奏重试（`recover_probe` 起、`max_recover_probe` 封顶）；**连续 5 次**没拨通就删记录并留墓碑——别人对一个节点的记忆，不是一直拨它的理由。
2. **目录只转发亲耳听到的**：`hello` 答复里的目录（以及双方比对的摘要）只含本机与 `online`/`suspect` 的成员。从没拨通的候选、已 offline 的记录留在本机表里（面板与 `orca_pod` 的 `members` 照常显示），但不转发。每个节点只为自己正在通信的对象作保，所以一个死节点最多 `offline_after` 之后就没人再转发它，“A、C 互相把 D 传来传去”的回声从源头断掉。单向不通时（C 听得到 D、A 拨不通 D），C 会继续转发 D，A 在墓碑过期后再试——D 确实还活着，这是对的。
3. **已知但 offline**：不复活，只按 `recover_probe` 退避探测。
4. **对端把我修剪掉**：没有任何东西被拒绝，所以也没有补救——我的下一个 `hello` 本身就让它重新登记我，并带回它的目录。
5. **修剪**：offline 超过 `record_ttl`（7d）→ 删记录并本地留墓碑；墓碑不传播。墓碑只挡**他人目录**，不挡本人：节点复活后自己的 `hello`（两样证明都通过）会清除墓碑并重新登记。
6. **探测即扩散**：每次 `hello` 对端都会按摘要回目录，所以知识沿 `hello` 边继续扩散，不需要额外的 gossip 协议。

> 回答“能不能用 `offline_after` 阻止别人的缓存进入我的表”：不要。`offline_after` 是**在线阈值**，不是**入表过滤器**。该做的是：目录只进候选 + 只有本人能复活 + 本人的 `hello` 自己登记。

### 3.6 目录合并与墓碑

- 合并原则：**按 `orca_node_id` 去重；目录只新增从未见过的节点（`candidate`），绝不修补已有记录**。已有记录的端点、显示名、runtime、模型目录只由该节点本人签名的 `hello`（`self`）更新，忙闲只由它本人的心跳更新；第三方目录无权改写（[§7.1](07-security.md#71-workgroup-与密码)）。
- 冲突（同 id 不同端点）：以本人最近一次签名自述（`hello` 的 `self`）的端点为准；别人目录里的同 id 条目不会覆盖它（真要换 IP，发一次 `hello` 即可）。
- 删除：只删本地记录，不通知别人；别人会在 `record_ttl` 后自己修剪。
- **踢人（安全语义）**：没有共识，所以“移除 orca node”不是可广播的操作。真正把它踢出去只能**换密码**：改过密码的节点与旧 mesh 的每个请求都过不了 workgroup 证明（[§3.3](03-membership.md#33-心跳与双向看门狗)），双方在下一个请求就互相丢弃，等于被移出。UI 必须这么写，别让用户以为点一下 forget 就安全了。
- 换密码的代价：所有要保留的 orca node 要同步新密码；这是**唯一**的吊销手段，也是它简单的原因。

### 3.7 故障、恢复、休眠

- 网络抖动：`suspect` 是可恢复态；新任务在 suspect 期间暂停路由（只有 `online` 接新任务），但**不取消**在跑的任务。
- 单向不通：`suspect(unreachable)`，UI 提示检查防火墙/代理/端口，而不是“对方关机了”。
- 机器休眠：超时判定用单调时钟，不用墙钟；唤醒后各 peer 按正常的看门狗规则恢复。
- 时钟漂移：`ts` 窗口 ±60s；超过就以独立的 `clock_skew` 错误拒绝，别静默容忍。
- 脑裂（本设计不存在“裂”）：没有主 orca node，没有需要多数派的状态；每个 orca node 各自观测，最多是互相看不见，恢复后靠心跳自动重连。

### 3.8 id 变更、离开

- 改 `orca_node_id`：以新身份 `hello`；旧记录不再有消息，按看门狗变成 offline，靠 `record_ttl` 自然消失。
- **没有“离开”请求**（D53）：成员身份就是持有 workgroup key（D44），持着 key 的节点无论怎么声明离开，任何一个还记得它的成员下一次 `hello` 都会把它带回来。要离开一个 workgroup，就改 workgroup 或密码：对方下一次心跳在证明上被拒（401/403），当即把它从表里删掉（记墓碑）；或者在面板里重置。只是停机的节点照常变成 offline，留到 `record_ttl` 到期，回来就恢复。

---
