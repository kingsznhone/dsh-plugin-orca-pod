# 03 成员与收敛

> 成员关系只有一种来源：直接收到对方的心跳。本章描述加入、心跳、收敛、死亡判定与恢复。

## 3. 成员与收敛

### 3.1 成员状态的判定

| 问题                              | 回答                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------- |
| 谁有资格说“某 orca node 存在”？   | 只有该 orca node 自己。别人只能转述端点，不能转述在线。                           |
| “在线”由谁判定？                  | 收方本地。`last_recv_at` 只由对方自己的心跳（或它对我方心跳的应答）更新，与别人怎么说无关。 |
| 死掉的 orca node 怎么从表里消失？ | 本地过期 + 墓碑 + 修剪。不需要共识，也不需要广播。                                |

由此推出三条硬规则：

1. 成员表里只放**直接观测**或**显式登记**：它成功 join 过我、我成功 join 过它，或它的心跳到过我这里。
2. 心跳响应里可以携带**目录**（谁存在），但目录条目只是候选端点，永远不提供“它在线上”。
3. 在线判定的唯一输入是本地的 `last_recv_at`；候选目录不得修改它、不得修补已有记录、不得清除墓碑。

### 3.2 引导与加入

**启动**

```text
1. 读取（或生成）身份 identity.json，写 config.json
2. 采集 runtime
3. 起监听（默认 127.0.0.1:11811）
4. 配置里有 peers：逐个 join（失败只记日志，不影响本机）；CLI 的 `serve --peer <url>` 在启动后 join 一次，并按返回的目录给其余成员补 join
5. 没有 workgroup_id 或密码：节点保持未配置、不监听（面板向导填完才启动）
```

**加入任意 orca node（host + port）**

```text
D（新）                                            A（已在 mesh）
  POST http://A:11811/cluster/join
  { workgroup_id, orca_node_id, ts, nonce, proof,
    display_name, endpoints, runtime, max_task_ttl_s,
    models, default_model, default_reasoning_effort }
                                              ├ 验请求签名（join 允许空 target）
                                              ├ 校验 workgroup_id
                                              ├ 校验 ts 窗口、proof（密码派生 HMAC）、nonce 未用过
                                              └ 登记 D（显式成员，在线）
  200 { self: A, members: [A 已知的其他成员], members_digest }

  D 登记 A，并把 members 当候选端点
  → D 的心跳循环拨候选 B：B 回 403 not_a_member → D 先向 B join，再重发心跳
  → 双方互相登记，双向计时开始
```

要点：

- **join 只用于引导和重新准入**：拿目录、完成登记。之后靠心跳保活。
- **登记只发生在 join**：心跳虽然带 `self`（见下），但只更新已登记成员的资料，不登记陌生人；没登记过的发送者心跳会被成员闸门挡成 `403 not_a_member`，对方据此补一次 join（`404 unknown_orca_node` 同样触发）。
- **方向恒为单向出站**：新 orca node 主动连已知 orca node；旧 orca node 不需要能反向连新 orca node。
- **不广播**：没有 announce 消息、没有 gossip。D 自己去找目录里的每个人，这本身就把“我在”传播出去了。
- **幂等**：同一 `orca_node_id` 重复 join，用这次的自述替换记录里的资料（端点、显示名、runtime、预算、模型目录），不重复写表。
- **自动接受**：workgroup 密码正确即接受，没有“待批准”状态。
- **拒绝**：`400 workgroup_mismatch`（workgroup 不对）、`401 bad_proof`（密码证明不对）、`401 clock_skew`（时间差 > 60s）、`401 nonce_replay`。
- **响应绑定拨号目标**：join/心跳的响应体本身没有签名；已知 URL 的响应若声明成另一个 `orca_node_id`，按失败处理。首次接触没有可比对的身份，是 TOFU。
- **模型目录随自述登记**：join 请求里的 `models`/`default_model`/`default_reasoning_effort` 写进成员记录；模型清单只对同组成员可见，不进公开 Agent Card（[§6.15](06-execution.md#615-按任务选择模型)）。

### 3.3 心跳与双向看门狗

> 判定在线不是“我能不能连上它”，而是“我最近有没有收到它”。

每个 orca node 对每个 peer 维护两条时间线：

| 字段           | 含义                                           | 谁更新                     |
| -------------- | ---------------------------------------------- | -------------------------- |
| `last_recv_at` | 最近一次**收到**该 peer 心跳（或它的应答）的时间 | 本 orca node（收包时）     |
| `last_ok_at`   | 最近一次**成功发出**并为该 peer 收到响应的时间 | 本 orca node（请求返回时） |
| `fails`        | 连续失败次数（用于判定 `suspect(unreachable)`） | 本 orca node               |

`POST /cluster/heartbeat`：

```http
POST /cluster/heartbeat
{ "workgroup_id": "orca-demo",
  "orca_node_id": "<43-char base64url public key>",
  "ts": 1763100000000, "nonce": "9f2c1a...",
  "proof": "<HMAC-SHA256(scrypt(password, \"orca-pod\\0\" + workgroup_id), \"orca-pod/heartbeat|...\")>",
  "busy": null,
  "digest": "<members_digest>",
  "self": { "display_name": "...", "endpoints": ["http://10.0.0.2:11811"], "runtime": { ... },
            "max_task_ttl_s": 3600, "models": [ ... ], "default_model": { ... }, "default_reasoning_effort": "high" } }

200 { "from": "<public key>", "busy": null,
      "members_digest": "<hex>",
      "members": [ ...整张目录... ] }          // 仅摘要不一致时，否则为 null
```

- 心跳和 join 一样带**准入证明**（域分离标签 `orca-pod/heartbeat`）；收方先验请求签名与成员资格，再验证明，失败回 `401 bad_proof`（时钟偏差 `clock_skew`、nonce 重放 `nonce_replay`）。
- 证明对不上意味着“它不再属于这个 group”：发方收到 401 立即把对方从成员表移除并记墓碑（不等 offline 计时），收方同样拒绝；双方在下一拍心跳就互相消失。
- **心跳带完整自述**（`self`，字段与 join 请求体相同）：节点启动后才变化的资料（典型是插件晚一步拿到 Host 模型目录）靠它在下一拍传到已认识它的 peer。请求签名覆盖整个 body，准入证明与 nonce 防重放，所以它就是本人的话，收方用它替换该成员的资料；端点照 join 的规则筛查（[§7.7](07-security.md#77-ssrf--候选端点防护)），全部被拒回 `endpoint_refused`，同一组端点的筛查结果复用 60s。不带 `self` 的心跳（旧版本节点）只更新忙闲。
- 摘要不一致 → 对端顺势回一次目录。接收方按 [§3.5](03-membership.md#35-候选端点与墓碑) 处理：只进候选，不声明在线。
- 心跳同时是 keep-alive 与“我还活着”的证明；没有单独 ping。
- 心跳请求超时取当前 `interval` 的一半，别用 30s 默认值。
- 对每个 peer 按 `endpoints` 顺序逐地址拨号：任一成功即可达，成功的地址下一轮排最前；全部失败才计一次失败。

**节奏自适应**：`interval = N` 秒，`N` 是 workgroup 里的 orca node 数（含自己），夹在 2–10s，±10% 抖动。这样每个节点每秒只发约 1 个心跳，全集群总流量 ≈ `N` req/s——线性，而不是固定 2s 下的 `N(N-1)/2` 条链路。代价是判定延迟随 `N` 增长：`suspect` ≈ 1.25 拍、`offline` ≈ 3 拍，10 节点时分别约 12.5s / 30s。成员数一变，下一拍自动换算。

参数：

| 参数            | 默认                              | 说明                                         |
| --------------- | --------------------------------- | -------------------------------------------- |
| `interval`      | `N` 秒，夹在 2–10s（±10% 抖动）   | 集群总流量 ≈ `N` req/s，线性增长             |
| `suspect_after` | `interval × 1.25`（留抖动余量）   | 这么久没收到即可疑                           |
| `offline_after` | `interval × 3`                    | 累计未收到，移出在线集                       |
| `recover_probe` | 15s → 30s 退避                    | offline 后的探测                             |
| `record_ttl`    | 7d                                | offline 记录保留上限，之后修剪               |
| `tombstone`     | 10 min                            | 被移除/修剪的 id 在这段时间内不再从他人目录登记；本人 join 会清除墓碑 |

超时判定用**单调时钟**。墙上时钟只用于显示与 `ts` 校验：墙钟会因休眠、校时跳变，用它算“多久没心跳”会把全网点成 offline。

状态机：

```text
unknown ──(收到对方心跳，或对方应答了我的心跳)──► online
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
D → A: join                                      A 登记 D，回 {self: A, members: [B, C]}
D → B, C: 心跳（并发）                           B/C 回 403 not_a_member
D → B, C: join（并发）                           B/C 登记 D
D → B, C: 重发心跳；B/C 的心跳也各自到达 D         三向心跳稳定；D 出现在所有人的 online 集
```

- 已有 N 个 orca node 时，新 orca node 的开销 = 1 次 join（到 A）+ N-1 次 join 与心跳，全部并发。
- 目录是旧的（漏了 E）：心跳摘要不一致 → 对端回目录 → 本 orca node 把 E 当候选拨号。最多 2 个心跳周期。

### 3.5 候选端点与墓碑

**为什么心跳要回目录**。join 只给一次快照。如果两个 orca node 分别从不同 orca node 加入（比如 A 和 B 短暂分区时，C 跟了 A、D 跟了 B），只靠 join 快照会永久分成两半。心跳响应里的目录就是这条修复通道：请求带摘要，摘要不一致时对端回一次自己的目录。但目录条目**只是候选端点**，不是在线声明；两个 orca node 真正建立心跳边，靠的是互相拨号（被拒就 join，join 的响应又带回目录）。

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

1. **候选**：未知 `orca_node_id` + endpoints 进表，`state=unknown`、来源标 `candidate`；拨号前先过 [§7.7](07-security.md#77-ssrf--候选端点防护) 的地址筛查，之后和其他 peer 一样每拍拨一次（按 endpoints 顺序）。对方不认识我就 join，成功后等对方心跳自然转 online。
2. **已知但 offline**：不复活，只按 `recover_probe` 退避探测。
3. **对端把我修剪掉**（`403 not_a_member` / `404 unknown_orca_node`）：我重新 join 对端（join 会带回它的目录），再补一拍心跳。
4. **修剪**：offline 超过 `record_ttl`（7d）→ 删记录并本地留墓碑；墓碑不传播。墓碑只挡**他人目录**，不挡本人：该节点自己发来、准入证明通过的 join 会清除墓碑并重新登记，否则网关回了 200 却不记录它，之后它的每个签名请求都会被 403。
5. **探测即扩散**：每次 join 对端都会回目录，所以知识沿 join 边继续扩散，不需要额外的 gossip 协议。

> 回答“能不能用 `offline_after` 阻止别人的缓存进入我的表”：不要。`offline_after` 是**在线阈值**，不是**入表过滤器**。该做的是：目录只进候选 + 只有本人能复活 + 被拒就重 join。

### 3.6 目录合并与墓碑

- 合并原则：**按 `orca_node_id` 去重；目录只新增从未见过的节点（`candidate`），绝不修补已有记录**。已有记录的端点、显示名、runtime、模型目录只由该节点本人签名的 join 或心跳（`self`）更新，忙闲只由它本人的心跳更新；第三方目录无权改写（[§7.1](07-security.md#71-workgroup-与密码)）。
- 冲突（同 id 不同端点）：以本人最近一次 join 自述的端点为准；别人目录里的同 id 条目不会覆盖它（真要换 IP，重新 join 一次即可）。
- 删除：只删本地记录，不通知别人；别人会在 `record_ttl` 后自己修剪。
- **踢人（安全语义）**：没有共识，所以“移除 orca node”不是可广播的操作。真正把它踢出去只能**换密码**：改过密码的节点与旧 mesh 的每拍心跳都过不了准入证明（[§3.3](03-membership.md#33-心跳与双向看门狗)），双方在下一拍就互相丢弃，等于被移出。UI 必须这么写，别让用户以为点一下 forget 就安全了。
- 换密码的代价：所有要保留的 orca node 要同步新密码；这是**唯一**的吊销手段，也是它简单的原因。

### 3.7 故障、恢复、休眠

- 网络抖动：`suspect` 是可恢复态；新任务在 suspect 期间暂停路由（只有 `online` 接新任务），但**不取消**在跑的任务。
- 单向不通：`suspect(unreachable)`，UI 提示检查防火墙/代理/端口，而不是“对方关机了”。
- 机器休眠：超时判定用单调时钟，不用墙钟；唤醒后各 peer 按正常的看门狗规则恢复。
- 时钟漂移：`ts` 窗口 ±60s；超过就以独立的 `clock_skew` 错误拒绝，别静默容忍。
- 脑裂（本设计不存在“裂”）：没有主 orca node，没有需要多数派的状态；每个 orca node 各自观测，最多是互相看不见，恢复后靠心跳自动重连。

### 3.8 id 变更、离开

- 改 `orca_node_id`：等同 leave + rejoin；旧记录靠 `record_ttl` 自然消失。
- `POST /cluster/leave`：对方把调用者从自己的表里删掉（记墓碑）；本机 `leave()`（面板的“断开”）逐个通知已知 peer 后清空本地成员表。**不是安全操作**，对方仍可凭密码重新加入。

---
