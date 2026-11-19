# 11 未决问题

> 尚未决定的问题、留待讨论的设计与暂缓项集中在这里；定了就写进 DECISIONS（或并入对应章节）并从这里删掉。每一项都写明**当前行为**——正文里的描述就是这个行为，这里只回答“以后可能怎么改”。

## 11. 未决问题

> 已有结论、不再列为未决：并发策略（单槽，[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）、发布式目录（不做）、结果文本与工作区分层（[§6.11](06-execution.md#611-任务结果与交回的文件)）、文件通道（[§5.6](05-tasks.md#56-文件交换blob-通道)）、公开面只有 `/health`（[§4.6](04-transport.md#46-公开面)）、密码轮换（解散重建，[§7.1](07-security.md#71-workgroup-与密码)/[§7.3](07-security.md#73-密钥与密码的分发)）、迟到结果（不处理，[§8.2](08-reliability.md#82-orca-node-失联任务不重发读不到就记失败)）、多端点（`endpoints` 有序列表，逐地址拨号，[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）、按任务选模型（节点自述目录 + `pod.model`，[§6.15](06-execution.md#615-按任务选择模型)）、结论文本 32 KiB 截断（[§6.11](06-execution.md#611-任务结果与交回的文件)）、工作区配额（[§6.13](06-execution.md#613-配额清理跨平台)）、挂起任务恢复遇到槽被占时 429、由上游决定重试（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）、agent 侧密钥隔离（不做；任务只有一跳，执行器会话里没有 `send`，是非对抗性约束，[§7.9](07-security.md#79-权限跟随发起-orca-node)）、显式 `permission_mode` 只能比会话更窄（[§7.10](07-security.md#710-权限模式继承)）、权限请求即请求升级本任务的模式（[§7.12](07-security.md#712-升级回路任务状态不是反向调用)）。

### 待讨论

1. **密码分发方式**：二维码、剪贴板、系统钥匙串/密码管理器，选哪个作为默认？自动生成后怎么让人确认“对面拿到的是同一串”。当前：带外手工传递，向导接收明文。
2. **大文件传输**：Range/断点续传要不要做、阈值取多少（比如 >64 MiB 才分片）；跨网段重传成本如何。当前：发布的文件整体流式下载、失败重来，没有大小上限。
3. **超过 10 个 orca node 的行为**：UI 提示 O(n²) 心跳负荷即可，还是直接拒绝加入？当前：不检查、不提示（心跳节奏随成员数自适应，总流量线性增长）。
4. **局域网自动发现**（mDNS / UDP 广播）：当前不做，host+port 手动加入已够；若做，要接受“网段内可见”的隐私代价。
5. **Windows 路径测试矩阵**：8.3 短名、junction、`\\?\`、保留名（`CON`/`NUL`/`aux`）、尾随点——作为实现 checklist，当前无阻塞。节点本身不做路径规范化（[§6.8](06-execution.md#68-目录边界)）。
6. **自述记录变更的传播与 digest 范围**：当前，`members_digest` 只覆盖 `id|endpoints|runtime_digest`（不含忙闲、模型目录与在线状态）；忙闲随心跳更新；模型目录与默认 model/effort、端点、显示名、runtime、预算随 join 与每次心跳的完整自述（`self`）刷新；节点启动后才拿到 Host 模型目录时，下一拍心跳就传到已认识它的 peer。
7. **跨节点追踪**：当前没有跨节点 trace id（`trace_id` 字段已删除），排查一个任务要分别看 origin 的派发日志与 target 的任务记录。

### 暂缓

8. **指标**：当前没有任何指标导出，也没有结构化日志。设想过 `pod_peer_state`、`pod_tasks_terminal_total{state,reason}`、`pod_auth_failures_total{reason}`、`pod_approvals_total`、`pod_blob_*` 等；若做，建议只读的 `/metrics`，要求成员身份。
9. **`message/stream`（SSE）、`tasks/resubscribe`、push notification**：当前都没有，任务进度只能轮询 `tasks/get`；反向代理侧也就不需要关缓冲。若做 SSE，tracker 升级成持有一条流，push 需要 webhook 鉴权、重试与 SSRF 防护。

---
