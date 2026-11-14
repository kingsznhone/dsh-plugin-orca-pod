# 02 系统模型

> 本章定义系统的静态结构：两条平面、orca node 的职责、orca node 如何描述自己，以及 orca node 之间的信任与连接关系。

## 2. 系统模型

### 2.1 两条独立平面

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
  → 对方收到 → 登记本 orca node → 回心跳（双向计时开始）
  → 双向心跳 + 本地看门狗
  → 在线集变化 → 任务路由候选集变化
  → 漏掉的成员靠 members_digest 变化拉全量，≤2 个心跳周期收敛
```

任务面不负责成员发现；控制面不负责执行任务。两者共用一个 HTTP server，鉴权方式相同（同一把派生密钥），但权限与状态严格分开。

### 2.2 每个 orca node 的职责

- 对外：A2A server（接收任务）、A2A client（发起任务）、控制面端点。
- 对内：成员观测、任务存储、LocalExecutor、工作区管理、DSH 生命周期。
- 安全：密码派生密钥、请求签名校验、grant 执行、硬拒绝清单。
- 可观测：`trace_id`、`task_id`、peer 状态、工作区用量、审批记录。

### 2.3 部署形态

| 形态 | 监听 | TLS | 适用 | 备注 |
|---|---|---|---|---|
| 单机开发 | `127.0.0.1:11811` | 无 | 本机两进程、联调 | 仍然要密码，只是短一点 |
| 局域网直连 | `0.0.0.0:11811` 或私网 IP | 无（明文） | 家庭/办公室可信网络、VPN | 密码必须够强；跨网段建议走代理 |
| 反代 + 域名 | `127.0.0.1:11811` | Caddy / nginx | 公网、跨网段、多网卡 | 证书与 HSTS 归代理 |
| 内建 mTLS（后续） | 任意 | orca node 自己 | Phase 4+ | 需要 CA 分发与轮换 |

### 2.4 orca node 短 id

- **生成时机**：插件安装/首次启用时生成一次，写入插件配置并持久化（随 profile 存放，不进 git 仓库）。
- **格式**：短到能在日志和 UI 里念出来——6 字符，Crockford Base32 字母表 `0123456789ABCDEFGHJKMNPQRSTVWXYZ`（无 I/L/O/U，避免 1/0 混淆）。展示为 `N7K3QM`。
- **可改**：UI/配置可手改成任意合法短 id（也允许小写，落库统一大写）。改完必须重启监听并向各 peer 重新发心跳（[§3.8](03-membership.md#38-id-变更冲突离开)）。
- **持久化**：写在插件配置（如 `<profile>/plugins/pod/config.json`），含 `orca_node_id`、`display_name`、`endpoint`、`workgroup_id`、密码引用。
- **不是安全主体**：认证靠 workgroup 密码；短 id 只用于日志、指标、UI、任务元数据。任何人可把 id 改成 `AAAAAA`，安全性不因此变化。
- **改名语义**：改 id 等价于“离开 + 重新加入”。旧 id 在别人的表里会成为一条逐渐过期的记录；推荐 UI 在改名时提示“其余 orca node 会自己清掉旧记录”。
- **冲突**：join 时若目标 workgroup 已有同 id 且端点不同 → `409 orca_node_id_conflict`，UI 建议 `N7K3QM-2`。若端点相同（同一 orca node 重复 join）→ 幂等成功。

### 2.5 orca node 自述记录（SelfRecord）

`GET /cluster/members` 的元素，也是 join 响应里 `self` 的内容：

```json
{
  "orca_node_id": "N7K3QM",
  "display_name": "书房台式机",
  "endpoint": "http://192.168.1.11:11811",
  "workgroup_id": "orca-dev",
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
  "max_task_ttl_s": 3600,
  "joined_at": "2026-11-14T04:01:02Z",
  "server_version": "0.1.0"
}
```

Linux orca node 的 `os` 形如：

```json
{ "family": "linux", "name": "Ubuntu", "version": "24.04.1 LTS", "kernel": "6.8.0-45-generic", "libc": "glibc 2.39" }
```

字段规则：

- `runtime` 与整个记录只出现在需要签名的接口里，公网匿名不可读。
- `available_bytes` 是采集瞬间值，会变；它不进 `runtime_digest`（否则心跳每次都要拉全量）。`digest` 只覆盖稳定字段：os/cpu/memory.total/gpus/dsh/plugin/caps。
- `workspace` 只报**用量与配额**，不含路径；真实目录由目标 orca node 自己解析。忙闲是动态字段：`busy` 为 `null` 或 `{ "task_id", "origin_orca_node", "since" }`，由本人写、心跳刷新；origin 的 UI 据此显示“B 正在跑 X”。
- `max_task_ttl_s` 是本机单任务硬预算（`task_timeout_s`，默认 3600），随 self record、心跳成员记录与 Agent Card 公布；origin 派任务时据此拆解，超时的任务会被目标机直接杀掉（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。
- `endpoint` 只有一个：多端点会引入选路、切换和指纹不一致，收益不值这个复杂度；跨网段、公网、NAT 穿透都靠代理或 VPN 把这个地址变得可达（[§4.3](04-transport.md#43-反向代理注意事项)）。
- 采集失败不阻塞启动：缺字段就省略，并在 `runtime.error` 里写原因。

### 2.6 runtime 采集

runtime 的用途只有一个：让 origin 在派任务前判断“那台机器能不能干这个活”。

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

### 2.7 刷新与一致性

- 心跳只带 `runtime_digest` 与 `members_digest`。
- 收到 digest 与本地缓存不一致 → `GET /cluster/members` 拉全量（缓存 30s，避免风暴）。
- 目录里每条记录的“新鲜度”由本地的 `last_recv_at`/`last_ok_at` 体现，不由记录内的字段体现。
- 记录只有本人能写：**其他 orca node 绝不改写某条记录的内容**，也不替它声明在线。这条规则是不需要版本号的基石（[§3.1](03-membership.md#31-成员状态的判定)）。

---
