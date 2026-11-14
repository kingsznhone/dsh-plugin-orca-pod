# 07 权限与审批

> 关注：谁有权批准一次工具调用——默认跟随发起节点，以及 grant、升级回路、硬拒绝清单、凭据注入防护。
>
> 章节编号沿用全局编号；认证与传输安全在 08-security.md。

## 9. 权限与审批：跟随发起节点

### 9.1 前提

人只有一双手，也只坐在一块屏幕前。他在 A 上让 agent 去 B 干活，不会跑到 B 的屏幕前点“允许”。所以：

- **审批只发生在 origin**，target 永不弹本地窗；
- **target 的权限不高于发起它的那个会话**——会话是只读，远端就只能读；会话能写工作区，远端就只能写工作区；
- 需要更多权限时，target 通过 A2A 把请求送回 origin，由人在 origin 的卡片上决定。

这条前提排除了两种设计：target 本地审批（无人应答、任务挂死）和 target 自由裁量（origin 无法预期远端能做什么）。

### 9.2 权限模式继承

origin 发起任务时携带会话的 permission mode，target 原样执行：

| origin 会话模式 | target 上的含义 |
|---|---|
| `read-only` | 只读：可读工作区内文件、可跑只读命令；写文件/改状态一律 escalate 或 deny |
| `workspace-write` | 只在工作区内写；出界（家目录、系统目录、其它项目）一律 escalate |
| `danger-full-access` | 全机可用，但 [§9.5](07-permissions.md#95-目标侧硬拒绝清单) 的硬拒绝清单仍然生效 |

三条规则：

- **mode 只能降不能升**：target 可以把 `danger-full-access` 降为 `workspace-write`（配置更严），不能反向；
- mode 随任务签名一起传，target 校验签名后再执行，防止中间人改宽；
- mode 不写进 grant 之外的任何持久状态；任务结束即失效。

### 9.3 Grant

grant 是 origin 对“这一次任务”的授权凭证，随 A2A 请求下发：

```json
{
  "grant_id": "g_01JABC",
  "workgroup_id": "whale-pod",
  "origin_node": "N7K3QM",
  "target_node": "P2W8XA",
  "task_id": "t_01JABD",
  "permission_mode": "workspace-write",
  "workspace": { "kind": "group" },
  "limits": { "max_runtime_s": 3600, "max_write_bytes": 536870912 },
  "nonce": "9f2c...",
  "issued_at": "2026-11-14T04:40:00Z",
  "expires_at": "2026-11-14T05:40:00Z"
}
```

校验：

- 绑定 `(workgroup_id, origin_node, target_node, task_id, nonce)`，五者任一不符即拒；
- 只能**收窄**：target 拿到的 mode 不能高于 origin 会话当时的 mode；
- `expires_at` 到点即失效；任务 cancel / 完成即吊销（target 本地删记录，不需要广播）；
- 无 grant 的请求直接 `deny(missing_grant)`，不接受“老客户端”兼容。

### 9.4 升级回路：任务状态，不是反向调用

```text
target: 工具调用超出继承的 mode
  → 网关（不是 agent）把 task 置为 input-required
  → 把结构化 permission_request 写进 task 的 status.message（data part）
  → 连接结束。target 不拨 origin，不新建任何到 origin 的请求：

    {
      "request_id": "pr_01J",
      "task_id": "t_01JABD",
      "tool": "write_file",
      "target": "workspace:group/src/main.ts",
      "reason": "需要修改入口文件",
      "requested": { "permission_mode": "workspace-write", "paths.write": ["workspace:group"] },
      "expires_in_s": 120
    }

origin: 下一次 tasks/get（或已挂着的 SSE）看到 input-required
  → 用 DSH 现有审批卡片弹（复用 Host 的 approval 机制，人点）
  → 批准：生成新 grant（新 nonce、同 task、窄于等于请求范围），发一条 A2A 后续 message
  → 拒绝：发 message 明确 deny，target 把 task 置 failed(reason=permission_denied)
  → 超时无人应答：origin 自动 deny + tasks/cancel，target 清理任务临时物
```

要点：

- **这不是反向调用。** 全设计只有 origin → target 一个方向；target 没有 origin 的地址，也不需要。所谓“送回 origin”只是把请求写进 task 状态，等 origin 来读。
- **任务记录是唯一权威载体**：`permission_request` 必须能只靠 `tasks/get` 拿到；SSE 只是把同一份数据更早推过去，流断了也不丢。
- **SSE 也不是反向连接**：它是 origin 自己发起的那条 HTTP 请求保持打开，target 在响应里继续写字节。origin 从不监听、也不接受 target 的入站连接。
- 轮询看到 `input-required` 后，origin 的 UI 立刻弹卡片并把 task 标黄；不要等下一次轮询才提示。
- 补发的授权是**同一 task 的后续 message**（带 `taskId` + 新 grant），不是第二个任务，也不是独立的 grant 端点。
- **origin 是唯一能产生“用户同意”的地方**；`decided_by` 必须来自 UI 的人类动作，不能由模型自批。
- 审批卡片要显示：来源节点（display_name + id）、目标路径、命令/工具原文、请求理由、将提升到什么权限。不要把 target 传来的长文本渲染成 HTML（注入）。
- 审批 UI 直接复用 DSH 的 approval 卡片（Host 既有机制），不另做插件面板。
- 同一 task 的升级次数上限（默认 3），超过即 failed 并告警；防止被调用节点反复索权。
- origin 侧支持**预授权**（避免每次都弹）：按 `(workgroup, target, tool)` 记一条本地策略，如“允许 N7K3QM 在 P2W8XA 上跑 shell，单次 ≤15 分钟”。预授权记录进审计。

### 9.5 目标侧硬拒绝清单

硬拒绝 = 与权限模式、grant 都无关，永远不执行（除非人坐在 target 前、在本地显式解除）。这个清单刻意很短：它只保护“做错了就救不回来”和“做完就再也管不了这台机器”的操作。

- 磁盘与引导：分区、格式化、`diskpart`/`mkfs`/`dd` 写裸设备、改引导项；
- 关安全软件、清审计日志、改系统时间同步源；
- 改本插件自己的配置与凭证（`<profile>/plugins/pod/`），以及 DSH 的凭据存储——防止远程把自己锁死或把密码读走。

除此之外**不再硬拒**：

- `~/.ssh`、`~/.aws`、`~/.config/gh`、浏览器 profile 等 → 允许，但默认走 escalate 由 origin 批准（[§9.7](07-permissions.md#97-凭据回传与注入防护)）；
- 装包、改服务、配防火墙、跨系统实验 → 允许，按继承的 mode 与 grant 执行；
- 后台常驻进程 → 允许，但必须登记 PID 与清理方式，否则任务结束时按进程树清理。

### 9.6 ACP `request_permission` 映射

| 继承 mode | 请求的操作 | 结论 |
|---|---|---|
| `read-only` | 读 / 只读命令 | `allow` |
| `read-only` | 写 / 变更类执行（装包、改配置、起服务） | `escalate` → 回 origin（[§9.4](07-permissions.md#94-升级回路任务状态不是反向调用)） |
| `workspace-write` | 工作区内写 | `allow` |
| `workspace-write` | 工作区外写 / 提权命令 | `escalate` |
| `danger-full-access` | 任意 | `allow`，除 [§9.5](07-permissions.md#95-目标侧硬拒绝清单) |
| 任意 | 命中 [§9.5](07-permissions.md#95-目标侧硬拒绝清单) | `deny`（原因写进 task error） |
| 任意 | 无 grant | `deny(missing_grant)` |

实现方式：AcpExecutor 把 ACP 的 permission 请求交给网关策略层，策略层返回三态；`escalate` 时先不回复 ACP（挂起该步），等 origin 的后续 message 到达后决定 `allow`/`deny`。挂起有超时（`expires_in_s`），超时按 `deny` 收尾，避免 ACP 侧永久悬挂。

### 9.7 凭据回传与注入防护

远程节点上经常有 key：`~/.ssh/id_ed25519`、`~/.config/gh/hosts.yml`、`.env`。两种需求同时存在——**要能取回**（开发调试），**又不能被一句话骗走**（prompt injection 的典型外泄路径）。所以做成显式策略，而不是硬规则：

| 配置 `credential_readback` | 行为 |
|---|---|
| `deny` | artifact 里出现凭据类内容 → 拒发，任务标 `failed(credential_blocked)` |
| `ask`（默认） | 检出凭据类内容 → 任务挂 `input-required`，origin 卡片问“是否回传”，人点 |
| `allow` | 直接回传，仅审计 |

检出靠三层：文件路径模式（`*.pem`、`id_*`、`.env*`、`known_hosts`）、内容模式（私钥头、AKIA/ghp_ 前缀、长 base64 高熵串）、以及 agent 主动标注。

另外两条与开关无关的规则：

- **origin 不自动执行回传内容**：拿回来的文本进 artifact，不进下一轮 prompt，除非人明确引用；
- **审批卡片永远显示原文**（转义后），不显示模型复述——防的是“模型说这是无害的”。

---
