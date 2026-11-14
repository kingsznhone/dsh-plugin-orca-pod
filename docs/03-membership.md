# 03 成员与收敛

> 成员关系只有一种来源：直接收到对方的心跳。本章描述加入、心跳、收敛、死亡判定与恢复。

## 3. 成员与收敛

### 3.1 成员状态的判定

| 问题 | 回答 |
|---|---|
| 谁有资格说“某 orca node 存在”？ | 只有该 orca node 自己。别人只能转述端点，不能转述在线。 |
| “在线”由谁判定？ | 收方本地。`last_recv_at` 只由对方心跳更新；收不到就下线，与别人怎么说无关。 |
| 死掉的 orca node 怎么从表里消失？ | 本地过期 + 墓碑 + 修剪。不需要共识，也不需要广播。 |

由此推出三条硬规则：

1. 成员表里只放**直接观测**：我收到过它的心跳，或它成功 join 过我。
2. 心跳里可以携带**目录**（谁存在），但目录条目只是候选端点，永远不提供“它在线上”。
3. 在线判定的唯一输入是本地的 `last_recv_at`；候选目录不得修改它、不得重置退避、不得清除墓碑。

### 3.2 引导与加入

**首次启用（插件安装）**

```text
1. 生成 orca_node_id（[§2.4](02-model.md#24-orca-node-短-id)），写配置
2. 采集 runtime，生成 runtime_digest
3. 起监听（默认 127.0.0.1:11811）
4. 若配置里已有 workgroup_id + 密码：向目录内每个已知端点后台发第一拍心跳
5. 否则进入“未加入”状态，只响应 /health
```

**加入任意 orca node（host + port）**

```text
D（新）                                            A（已在 mesh）
  POST http://A:11811/cluster/join
  { workgroup_id, orca_node_id, display_name, endpoint,
    self, nonce, ts, proof }
                                              ├ 校验 workgroup_id
                                              ├ 校验 proof（§7.2）
                                              ├ 校验 ts 窗口 / nonce 未用过
                                              ├ 校验 orca_node_id 冲突
                                              └ 记录 D（只记 D 的自述）
  200 { self: A, members: [...], members_digest, server_version }

  D 拿到成员表 → 对每个 peer 发第一拍心跳（带 full self）
  → peer 校验签名 → 登记 D → 回心跳（双向计时开始）
  → 漏在别处的成员，靠 members_digest 变化拉全量补上
```

要点：

- **join 只用于引导**：拿目录、完成第一次登记。之后进入 mesh 靠心跳，不需要逐 orca node join。
- **第一拍心跳就是“我在这里”的声明**：带完整 self（≤ 2 KB），对方收到后验签、登记、回拍；**登记即纳入对方的发送列表**（心跳是对称的，不存在只收不发）。后续心跳只带 digest，不再带 self。
- **方向恒为单向出站**：新 orca node 主动连已知 orca node；旧 orca node 不需要能反向连新 orca node（NAT 场景只在 D 能出站时成立）。
- **不广播**：没有 announce 消息、没有 gossip。D 自己去找目录里的每个人，这本身就把“我在”传播出去了。
- **幂等**：同一 `orca_node_id` 重复 join / 重复心跳，端点相同即成功，不重复写表。
- **自动接受**：workgroup 密码正确即接受。想被通知可开 `notify_only`（只发本地通知，不阻塞）。默认自动接受。
- **拒绝**：`401` 用统一文案（不区分“workgroup 不对”和“密码不对”）；`409` 只给 id 冲突（需要人改名，必须可诊断）。

### 3.3 心跳与双向看门狗

> 判定在线不是“我能不能连上它”，而是“我最近有没有收到它”。

每个 orca node 对每个 peer 维护两条时间线：

| 字段 | 含义 | 谁更新 |
|---|---|---|
| `last_recv_at` | 最近一次**收到**该 peer 心跳的时间 | 本 orca node（收包时） |
| `last_ok_at` | 最近一次**成功发出**并为该 peer 收到响应的时间 | 本 orca node（请求返回时） |
| `fails` | 连续失败次数（用于退避） | 本 orca node |

`POST /cluster/heartbeat`：

```http
POST /cluster/heartbeat
{ "from": "P2W8XA", "busy": null,
  "members_digest": "sha256:...",
  "self": { ... } }                                  // 仅首次，或记录变更时

200 { "from": "N7K3QM", "busy": null,
      "members_digest": "sha256:...",
      "members": [{ "orca_node_id": "Z3M4AQ", "endpoint": "http://192.168.1.13:11811" }] }  // 仅摘要不一致时
```

- 摘要不一致 → 对端顺势回一次目录（≤32 条）。接收方按 [§3.5](03-membership.md#35-候选端点与墓碑) 处理：只进候选，不声明在线。
- 心跳同时是 keep-alive 与“我还活着”的证明；没有单独 ping。
- 心跳超时（客户端侧）取 `interval` 的一半，别用 30s 默认值。
- 心跳同时是 keep-alive 与“我还活着”的证明；没有单独 ping。

参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `interval` | 2s（±20% 抖动） | 10 个 orca node = 45 条链路 ≈ 45 req/s |
| `suspect_after` | 3 次 ≈ 6s | 连续未收到 |
| `offline_after` | 6 次 ≈ 12s | 累计未收到，移出在线集 |
| `recover_probe` | 15s → 30s 退避 | offline 后的探测 |
| `record_ttl` | 7d | offline 记录保留上限，之后修剪 |
| `candidate_retry` | 15s → 30s 退避 | 候选端点探测失败后的重试 |

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

### 3.4 收敛时序

```text
t0      D → A: join
t0+5ms  A: 记下 D，返回 {self: A, members: [A, B, C]}
t0+20ms D → B: 第一拍心跳（带 full self）        ← 并发
t0+20ms D → C: 第一拍心跳（带 full self）        ← 并发
t0+25ms B/C: 验签 → 登记 D → 回心跳
t0+2s   三向心跳稳定；D 出现在所有人的 online 集
```

- 已有 N 个 orca node 时，新 orca node 的开销 = 1 次 join + N-1 次心跳，全部并发。
- 目录是旧的（漏了 E）：心跳摘要不一致 → 对端回目录 → 本 orca node 把 E 当候选并探测。最多 2 个心跳周期。
- 候选端点探测失败按 `recover_probe`（15s → 30s）退避；对端回 404 `unknown_orca_node` 时重新 join 一次。

### 3.5 候选端点与墓碑

**为什么心跳要回目录**。join 只给一次快照。如果两个 orca node 分别从不同 orca node 加入（比如 A 和 B 短暂分区时，C 跟了 A、D 跟了 B），只靠 join 快照会永久分成两半：A 只知道 C，B 只知道 D，谁也没有渠道告诉对方“我这边还有个人”。心跳响应里的目录就是这条修复通道：请求带摘要，摘要不一致时对端回一次自己的目录。但目录条目**只是候选端点**，不是在线声明；两个 orca node 真正建立心跳边，靠的是它们互相拨号（候选探测走 join，join 的响应本身又带回目录）。

**要避免的死循环**（把“别人的记忆”当成“它还活着”的证据）：

```text
D 掉线
A 的表里还有 D（旧记录）→ A 在摘要变化时把 D 回给 C
C 收到 → 把 D 当成 online 写进自己的表，并回传给 A
→ A、C 互相刷新，D 永远“活着”
```

解法是把“记录”和“在线”彻底拆开：

| 动作 | 允许吗 |
|---|---|
| 心跳目录给我一个端点 | 允许（进表为 `unknown` 的候选） |
| 心跳目录修改我的 `last_recv_at` | **禁止** |
| 心跳目录把 orca node 标成 `online` | **禁止** |
| 只有该 orca node 自己的心跳能把它标 `online` | 是 |

具体规则：

1. **候选**：未知 `orca_node_id` + endpoint 进表，`state=unknown`；探测循环对它拨一次（join），失败按 `recover_probe` 退避，成功则等对方回心跳自然转 online。
2. **已知但 offline**：不复活，只按退避探测。
3. **404 `unknown_orca_node`**：说明对端已经把我修剪掉；我重新 join 对端（join 会带回它的目录），再补一拍心跳。
4. **修剪**：offline 超过 `record_ttl`（7d）→ 删记录并本地留墓碑；墓碑不传播。
5. **探测即扩散**：每次探测成功都是一次 join，对端会回目录，所以知识沿 join 边继续扩散，不需要额外的 gossip 协议。
6. **上限**：心跳目录每次最多 32 条；同一候选失败按 15s→30s 退避。

> 回答“能不能用 `offline_after` 阻止别人的缓存进入我的表”：不要。`offline_after` 是**在线阈值**，不是**入表过滤器**。该做的是：目录只进候选 + 只有本人能复活 + 404 触发重 join。
### 3.6 目录合并与墓碑

- 合并原则：**按 `orca_node_id` 去重，字段以本人记录为准**；本地只保留 `last_recv_at`/`last_ok_at`/`state`/`fails`。
- 冲突（同 id 不同端点）：以最近一次成功心跳的端点为当前端点，旧端点直接丢弃（真要换 IP，join 一次即可）。
- 删除：只删本地记录，不通知别人；别人会在 `record_ttl` 后自己修剪。
- **踢人（安全语义）**：没有共识，所以“移除 orca node”不是可广播的操作。真正把它踢出去只能**换密码**：换完所有旧签名立即失效，其余 orca node 用新密码重新加入。UI 必须这么写，别让用户以为点一下 forget 就安全了。
- 换密码的代价：所有 orca node 要同步新密码；这是**唯一**的吊销手段，也是它简单的原因。

### 3.7 故障、恢复、休眠

- 网络抖动：`suspect` 是可恢复态；新任务在 suspect 期间暂停路由（只有 `online` 接新任务），但**不取消**在跑的任务。
- 单向不通：`suspect(unreachable)`，UI 提示检查防火墙/代理/端口，而不是“对方关机了”。
- 机器休眠：唤醒后所有 peer 同时超时；用单调时钟避免“睡了 8 小时 = 离线 8 小时”的误判；唤醒后立即对全部 peer 发一拍。
- 时钟漂移：`ts` 窗口 ±60s；超过就拒，并在错误里说明“检查系统时间”，别静默容忍。
- 脑裂（本设计不存在“裂”）：没有主 orca node，没有需要多数派的状态；每个 orca node 各自观测，最多是互相看不见，恢复后靠心跳自动重连。

### 3.8 id 变更、冲突、离开

- 改 `orca_node_id`：等同 leave + rejoin；旧记录靠 `record_ttl` 自然消失。
- 冲突：后到者 `409`；允许同一 orca node 换端点（同 id 同端点幂等）。
- `POST /cluster/leave`：本地不再响应心跳、删除对方记录（best-effort）；**不是安全操作**，对方仍可凭密码重新加入。

---
