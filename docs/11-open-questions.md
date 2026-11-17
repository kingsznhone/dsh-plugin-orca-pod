# 11 未决问题

> 尚未决定的问题、留待讨论的设计与暂缓项集中在这里；定了就写进 DECISIONS（或并入对应章节）并从这里删掉。每一项都写明**当前行为**——正文里的描述就是这个行为，这里只回答“以后可能怎么改”。

## 11. 未决问题

> 已有结论、不再列为未决：并发策略（单槽，[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）、发布式目录（不做）、结果文本与 `notes/` 分层（[§6.11](06-execution.md#611-任务结果与产物)）、文件通道（[§5.6](05-tasks.md#56-文件交换blob-通道)）、Agent Card 公开（[§4.6](04-transport.md#46-agent-card)）、密码轮换（解散重建，[§7.1](07-security.md#71-workgroup-与密码)/[§7.3](07-security.md#73-密钥与密码的分发)）、迟到结果（不处理，[§8.2](08-reliability.md#82-orca-node-失联任务不重发origin-不替它判死)）、多端点（`endpoints` 有序列表，逐地址拨号，[§2.5](02-model.md#25-orca-node-自述记录selfrecord)）、按任务选模型（节点自述目录 + `pod.model`，[§6.15](06-execution.md#615-按任务选择模型)）、结论文本 32 KiB 截断（[§6.11](06-execution.md#611-任务结果与产物)）、工作区配额（[§6.13](06-execution.md#613-配额清理跨平台)）、挂起任务恢复遇到槽被占时 429、由上游决定重试（[§6.9](06-execution.md#69-单槽执行一个-orca-node-同一时间只做一件事)）。

### 待讨论

1. **密码分发方式**：二维码、剪贴板、系统钥匙串/密码管理器，选哪个作为默认？自动生成后怎么让人确认“对面拿到的是同一串”。当前：带外手工传递，向导与 `orca-pod install` 接收明文。
2. **大文件传输**：Range/断点续传要不要做、阈值取多少（比如 >64 MiB 才分片）；跨网段重传成本如何。当前：发布的文件整体流式下载、失败重来，没有大小上限。
3. **超过 10 个 orca node 的行为**：UI 提示 O(n²) 心跳负荷即可，还是直接拒绝加入？当前：不检查、不提示（心跳节奏随成员数自适应，总流量线性增长）。
4. **局域网自动发现**（mDNS / UDP 广播）：当前不做，host+port 手动加入已够；若做，要接受“网段内可见”的隐私代价。
5. **Windows 路径测试矩阵**：8.3 短名、junction、`\\?\`、保留名（`CON`/`NUL`/`aux`）、尾随点——作为实现 checklist，当前无阻塞。节点本身不做路径规范化（[§6.8](06-execution.md#68-目录边界)）。
6. **agent 侧密钥隔离**（留待讨论）：当前，ACP 子进程继承 `ORCA_POD_DATA_ROOT`，该目录下有 `identity.json`（私钥）、`config.json`（`key_base64`）；工作组口令在 `$DSH_HOME/.credentials.yaml`，agent 以同一个 OS 用户运行，同样读得到；CLI 直接读私钥以本节点身份签名，agent 也可以不带 `--local-task` 直接发根任务。子任务的 `hop`/`chain`/`root`/`root_origin` 由 CLI 在客户端拼装，`ORCA_POD_PARENT_TASK` 只被 CLI 读取、没有人设置，agent 要自己带 `--local-task`。方向：密钥目录与工作区分离；CLI 改调回环控制端点、由节点代签并强制注入父链与收窄后的权限；执行器按任务注入父任务 id。
7. **显式 `permission_mode` 的方向**：当前，`orca_pod` 的 `send` 显式给出 `permission_mode` 时覆盖会话继承的模式（可以比会话更宽），CLI `--permission-mode` 同理；target 本机上限仍然生效。要不要改成只允许在会话模式之下收窄，读不到会话模式时按 `read-only`？
8. **预授权策略与按节点白名单**：当前没有。任何成员都能派任务，每个权限请求都要人点；也没有“允许 X 在 Y 上跑 shell、≤15 分钟”这类 origin 侧预授权，没有按 `orca_node_id` 限制谁能派任务。
9. **自述记录变更的传播与 digest 范围**：当前，`members_digest` 只覆盖 `id|endpoints|runtime_digest`；忙闲随心跳更新；模型目录与默认 effort 只在 join 时随自述登记，已存在的记录不会被后续 join 刷新模型目录，端点/显示名/runtime/预算则会。节点启动后才拿到 Host 模型目录时，已认识它的 peer 要等记录被重新建立才看到变化。
10. **`idempotency_key` 与跨节点追踪**：当前，任务类型里有 `idempotency_key` 字段，但没有任何代码读取；没有重复提交去重，也没有跨节点 trace id（`trace_id` 字段已删除）。同一条 `message/send` 提交两次就是两个任务。
11. **候选端点拨不通时的处理**：当前，候选（`unknown`）每拍都被拨号一次，失败不退避，也不会被修剪（修剪只针对曾经 online 又 offline 的记录）。

### 暂缓

12. **指标**：当前没有任何指标导出，也没有结构化日志。设想过 `pod_peer_state`、`pod_tasks_terminal_total{state,reason}`、`pod_auth_failures_total{reason}`、`pod_approvals_total`、`pod_blob_*` 等；若做，建议只读的 `/metrics`，要求成员身份。
13. **`message/stream`（SSE）、`tasks/resubscribe`、push notification**：当前都没有，任务进度只能轮询 `tasks/get`；反向代理侧也就不需要关缓冲。若做 SSE，tracker 升级成持有一条流，push 需要 webhook 鉴权、重试与 SSRF 防护。

---
