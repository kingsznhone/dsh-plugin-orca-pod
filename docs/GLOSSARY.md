# 术语表

> 这些词在这套文档里只有一个意思；命名上的取舍也记在这里。
>
> 章节编号沿用全局编号。

## 3. 术语与命名约定

| 术语 | 含义 |
|---|---|
| **workgroup_id** | 集群命名空间 + 凭证作用域，如 `whale-pod`。正则 `[a-z0-9][a-z0-9-]{1,31}`。 |
| **node_id** | 6 字符短 id，节点的显示标签；同一 workgroup 内唯一，非安全主体。 |
| **Peer** | 同一 workgroup 内、本节点已知的另一个节点。 |
| **SelfRecord** | 节点对自己的描述（endpoint、runtime、工作区用量、忙闲），只能由本人写。 |
| **members_digest** | 排序后的成员记录摘要，用于“我落后了没有”的比对，不表达在线状态。 |
| **hint** | 心跳里捎带的 `(node_id, endpoint)` 候选，**不是**在线声明，见 [§10.5](02-architecture.md#105-hints候选与墓碑死节点为什么不会复活)。 |
| **candidate** | 由 hint 引入、尚未直接收到其心跳的节点，不进正式成员表。 |
| **tombstone** | 本地的“别再试它”标记，带过期时间；不传播。 |
| **workspace** | 节点上自动分配的持久目录，跨任务、跨 session 保留上下文。 |
| **group workspace** | 就是上面那个 `workspace`；本文有时强调“单节点一份”时这么叫。 |
| **session** | DSH / ACP 的会话状态，绑定 `(workgroup_id, origin_node, context_id)`。 |
| **context_id** | A2A 的逻辑会话 id，把多个 task 归到同一串工作里。 |
| **grant** | origin 签发的单任务授权，绑定 origin/target/task/nonce，随任务结束失效。 |

**命名注意：** `workgroup_id`、`workspace`、`session` 三者不能混用。DSH GUI 里把项目目录叫“工作区”，本文的 `workspace` 指的是被调用节点上自动分配的那份执行目录；代码与日志里不允许用裸的 `workspace` 表示命名空间。

**图里的调用关系：**

```text
Workgroup: whale-pod
Full mesh (<= 10 nodes), 唯一拓扑
```

---
