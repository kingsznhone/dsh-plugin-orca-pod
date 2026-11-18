# 重构方案（第四轮）：mesh 是一张节点表，节点是对象

> 状态：**已实施**（2026-11-19 起草并经 owner 确认，分支 `refactor/classes`，基于 `3424cb3`；偏差见 §10）。
> 前三轮已完成：D41 目录与 class，D42 自由函数与单一来源，D43 插件侧状态机（`Pod`）。三轮的规则继续有效，摘要见 §1。
> 范围：`src/mesh/` 重写，`src/task/delegation.ts` 并入 mesh，`src/api/` 的集群路由与鉴权，`src/node/orca-node.ts` 改名并瘦身，`src/plugin/` 改用节点寻址，**`src/cli/` 整个删除**，节点私钥迁入 DSH 凭据库，任务内的文件交接改由执行器完成，`test/` 与 `scripts/` 跟着改，文档。
> **这一轮会改线协议**：join 与 heartbeat 合并成 `hello`，每个请求在 header 里同时带密码证明和 Ed25519 签名，答复也要签名，老版本节点不再互通。**分层放宽**：mesh 移到 task 之上。**只保留 DSH 插件形态**：独立运行（`orca-node serve`、`orca-pod install`）和 CLI 一起删除。派发日志的记录形状也会随按节点寻址而变（见 §7）。
>
> owner 已确认的决定（2026-11-19）：
> 1. 线协议可以直接改，不做兼容；
> 2. 分层可以放宽；
> 3. 不拆 LocalNode / RemoteNode，只有一个 `OrcaNode` 类，自己也在表里，用 node id 判断（M1）；
> 4. 共享资源用**作用域内的单例**，不用模块级全局变量：一个 data_root 一个 `SqliteDb`，一个 `Orca` 实例一个 `MeshContext`（M5，理由见 §5）；
> 5. workgroup 派生密钥只放在内存里，不落盘（§3.6）；
> 6. 节点私钥用 base58 编码后放进 `ctx.credentials`，作用是证明节点本身没有被冒充（§3.6）；
> 7. 只保留 DSH 插件这一种运行方式，删掉独立运行和整个 CLI（§3.7）。CLI 原本是给任务里的 agent 回连本机 gateway 用的；单跳任务（D39）之后，它只剩取文件和发布文件两个用途，改由执行器代办（§3.8）；
> 8. 每个发往对端的请求都在 header 里同时携带 workgroup 证明和 Ed25519 签名，答复也由对端签名（§3.3）；
> 9. 一台机器一个 orca 节点：profile 只切换能力组合，身份、密码、设置都是整台机器共用一份；`reset` 一并删除，不分情况（§3.9）。

## 0. 为什么还要一轮

三轮之后每个 class 都干净，但 mesh 的对象模型不对：读者心里的模型是“mesh 是一张节点表，表里每个节点（包括自己）都是一个对象，要用哪个节点就调它的方法”；代码里的现实是“节点的状态分散在五个类里，调用方拿 URL 寻址，每个服务都要拿到 membership、client、profile 才能干活”。

| 问题 | 证据 |
| --- | --- |
| **一个节点的状态散在多处** | 状态机在 `PeerEntry`（`membership.ts`），上次成功的地址在 `EndpointDialer.preferred`，URL→id 映射在 `HttpPeerClient.dialed`，筛查结论在 `EndpointDialer.verdicts` 和 `ClusterRoutes.screened` 各一份，自己的资料在 `SelfProfile` |
| **自己不在表里** | `Workgroup.digest`、`Workgroup.roster`、`ClusterRoutes.members`、`ClusterRoutes.roster`、`plugin/panel.ts:46`、`tools.ts:218` 都在拼 `[...membership.list(), profile.peer()]` |
| **join 与 heartbeat 是同一个握手，却写了两遍** | 两者的请求体都是 `Admission` + 自述（`mesh/wire.ts`）。分开后多出一套补救：`heartbeatWithRejoin` 遇到 404/403 先 join 再重发，`assertAnsweredBy` 调两处，鉴权分 `join` / `member` 两级，admission 分两个签名域，`joinAll` / `joinAt` / `Pod.joinPeers` / `serve --peer` 各自做“join 之后再补 join” |
| **按 URL 寻址** | `Delegation.sendTask(peerUrl, …)` 要靠 `client.known(peerUrl)` 反查节点；派发日志、tracker、broker 的键都是 `peer URL|task id`；`panel.ts` 和 `tracker.ts` 用 `client.idOf(peer)` 找发布者。同一个节点换了地址就成了“另一个 peer” |
| **依赖层层传递** | `Delegation(identity, client, membership, dispatches, options)`、`Workgroup(key, membership, client, profile, options)`、`BlobFetcher(registry, workgroup, client, selfId)`、`Gateway(profile, membership, tasks, blobs, key)`：这些协作者都是为了“按 URL 找到节点再用它”才需要的 |
| **组密码只在 join / 心跳的请求体里证明，答复没有签名** | Ed25519 签名每个请求都带（`Authorization: Pod …`，`core/signing.ts:92`），但密码派生的 HMAC 证明只在 `/cluster/join`、`/cluster/heartbeat` 的请求体里。派任务、查任务、取文件这些请求，接收方只查成员表（`api/access.ts:87`），所以改了密码的节点在下一次心跳失败之前，还能凭旧身份发几秒请求。答复只比对它声明的 id，内容本身没有签名，明文 HTTP 上的中间人可以改任务结果和成员表 |
| **机密落在 DSH 凭据库之外** | 插件每次启动都把派生密钥 `key_base64` 写进 `<data_root>/config.json`（`plugin/pod.ts:328`），拿到这个文件就等于拿到准入能力，违反 DSH 凭据规范的“配置只放引用名，不放机密”；节点私钥在 `<data_root>/identity.json` |
| **两种运行形态、一个只为回连而存在的 CLI** | 独立运行（`serve` / `install` / `config.json` / `loadConfig` / `endpointWriteback`）和插件形态各有一套启动与配置路径。CLI 有 8 个子命令，但任务里的 agent 只用 `fetch` 和 `publish`（`task/prompt.ts:45-49`）；宿主 agent 用的 `members` / `send` / `status` / `wait` 与 `orca_pod` 工具重复（`wait` 已经被 tracker 的自动通知取代）。为了它们，网关还要保留 `local` 访问级别和 `/cluster/blob`、`/cluster/members` 这两条本地路由 |
| **一个 SQLite 文件开了三个连接** | `createPersistentStorage` 用同一个 `storeDbPath(data_root)` 构造 `SqliteTaskStore`、`SqliteFileBlobStore`、`SqliteDispatchStore`，每个各开一个 `SqliteDb` |

## 1. 继续有效的约束

- 服务用 class，协作者用构造器参数属性；没有容器、`XDeps`、端口接口、`createX` 工厂。
- 构造器不写盘、不联网、不启计时器（`SqliteDb` 与 `OptionalService` 是写明的例外）。
- D42 的 R1–R10、D43 的 H1–H6 照旧：单处使用的小函数内联，class 专用的写成 `private`，不留只为测试存在的公开面，一个事实一个所有者，顺序约束进结构，名字说是什么。
- 测试用真实对象和 `vi.spyOn`，**设计不为测试让步**。
- 仅类型的环也算违规，`test/architecture.test.ts` 的两个允许清单保持为空。

本轮改动的一条：分层从 `core ← {mesh, executor} ← task ← api ← node ← {cli, plugin}` 改为 **`core ← executor ← task ← mesh ← api ← node ← plugin`**（`cli` 删除，§3.7）。派发任务是“对一个节点做的事”，所以 mesh 在 task 之上；task 只剩本机执行（runner、record、store、grants、workspace）、线上形状和派发日志。

## 2. 本轮的判定规则

| 规则 | 内容 |
| --- | --- |
| **M1 mesh 是一张表** | `Mesh` 持有 `Map<OrcaNodeId, OrcaNode>`，**自己也在表里**；“是不是自己”只看 `node.id === mesh.selfId`，不拆 LocalNode / RemoteNode 两个类 |
| **M2 要用哪个节点，就调它的方法** | 派发、查询、取消、审批、取文件都是 `OrcaNode` 的方法；调用方先 `mesh.resolve(ref)` 拿到节点，此后不再传 URL |
| **M3 一个节点的状态只在它自己身上** | 状态机、自述、可拨地址、上次成功的地址、URL 别名，都是这个 `OrcaNode` 的字段 |
| **M4 只有一种握手** | join 与 heartbeat 合并为 `hello`。初次接触和保活是同一个请求，区别只是 digest 是否为空、签名有没有接收方 id |
| **M5 共享的东西按资源只有一份，按 orca 实例划作用域** | 一个 data_root 一个 `SqliteDb`；一个 orca 实例一份 `MeshContext`，节点从它那里取 client、日志、本地 blob，不再逐个传参。**不用模块级全局变量**（owner 已确认，理由见 §5） |

## 3. 目标形状

### 3.1 类

```ts
// mesh/context.ts：一个 orca 实例里所有节点共用的东西，构造一次，原样交给每个节点
export class MeshContext {
  constructor(
    readonly identity: NodeIdentity,
    readonly workgroupId: WorkgroupId,
    readonly key: Buffer,               // 密码派生的 workgroup key（§7.1）
    readonly client: HttpPeerClient,    // 只负责签名 + 发送，target 必填
    readonly dispatches: DispatchLog,
    readonly blobs: FileBlobRegistry,   // 本机发布的文件
    readonly screening: EndpointScreen, // 候选地址的筛查结论缓存，原来的 dialer.verdicts 与 ClusterRoutes.screened 合并
    readonly clock: MeshClock,
    readonly logger: NodeLogger,
  ) {}
}

// mesh/orca-node.ts：表里的一个节点，可能是自己
export class OrcaNode {
  constructor(private readonly ctx: MeshContext, readonly id: OrcaNodeId, …) {}

  get isSelf(): boolean;
  view(): PeerView;                       // 自己的记录也走这里，不再有 SelfProfile
  describe(self: SelfDescription): void;  // 远端：对方签了名的自述；自己：本机推送的变化

  // 证据与状态机（原 PeerEntry）：heard / answered / missed / reassess / expired / due
  // 拨号（原 EndpointDialer 的按节点状态）：dialOrder()、prefer()、别名 URL

  hello(request: HelloRequest): Promise<HelloResponse>; // 按 dialOrder 逐个地址试，并记下成败

  sendTask(input, { signal, agentId }): Promise<TaskView>;
  getTask(taskId, signal?): Promise<TaskView>;
  cancelTask(taskId, signal?): Promise<TaskView>;
  approve(view): Promise<TaskView>;
  deny(view, reason?): Promise<TaskView>;
  fetchBlob(blobId, signal?): Promise<OpenedBlob>;      // 自己：本地磁盘；别人：按 dialOrder 下载
}

// mesh/mesh.ts：节点表与跨节点的事
export class Mesh {
  readonly events: EventBus<MembersEvent>;
  readonly self: OrcaNode;

  get(id): OrcaNode | undefined;
  list(): OrcaNode[];                      // 包含自己
  resolve(ref: string): OrcaNode;          // id、唯一的显示名、或 URL；找不到就报 unknown_peer
  digest(): string;                        // 对外担保的目录（自己 + 在线/可疑成员）的摘要

  probe(url: string): Promise<OrcaNode>;   // 原来的 join：向一个种子地址握手
  seed(urls: Iterable<string>): void;      // 启动时的种子；没应答的由心跳循环按退避重试
  leave(): Promise<OrcaNodeId[]>;

  start(): void; stop(): void;             // 心跳循环（原 HeartbeatLoop）

  // 收到对方 hello 时由路由调用：登记/刷新发送者，返回答复
  answer(caller, request, screenedEndpoints): HelloResponse;
}
```

`Mesh` 把 `Membership`、`Workgroup`、`HeartbeatLoop` 合并进来（墓碑、时序、`mergeRemote` 这类跨节点逻辑留在 `Mesh`）；`OrcaNode` 吸收 `PeerEntry`、`EndpointDialer` 的按节点部分、`Delegation`、`BlobFetcher`、`SelfProfile`。`HttpPeerClient` 只剩签名、截止时间、读取上限，不再维护 `dialed` / `idOf` / `known` / `learn` / `forget`，也不需要 `self` 和 `roster` 参数，`target` 改为必填。

`OrcaNode` 只引用 `MeshContext`，不引用 `Mesh`，所以没有类型环。需要整张表的事（合并别人的目录、算 digest、墓碑）由 `Mesh` 做：`mesh` 构造 hello 请求 → `node.hello(req)` 负责拨号和自己的证据 → `mesh` 合并返回的成员。

### 3.2 自己

`mesh.self` 是一个普通的 `OrcaNode`，状态恒为 `online`，`due()` 恒为 false（心跳循环跳过它）。它的自述由本机推送，而不是从心跳里读：

- 监听绑定后：`mesh.self.describe({ …, endpoints })`
- 模型目录变化（`models.changes`）：推一次
- 任务槽变化（`tasks.events`）：推 `busy`

`SelfProfile` 删除。拼 `[...list(), self]` 的六处全部改成 `mesh.list()`。派给自己的任务仍然走本机 loopback HTTP（和现在一样），所以 `sendTask` 不需要判断 `isSelf`；只有 `fetchBlob` 在 `isSelf` 时直接读本地磁盘（`BlobFetcher` 现在就是这么做的）。

### 3.3 一种握手：`hello`；每个请求都带两样证明

**请求与答复的 header**（所有节点间路由都一样，不只 hello）：

```text
请求  Authorization: Pod id=<发起方>; wg=<workgroup_id>; target=<接收方|空>; ts=…; nonce=…;
                        sig=<Ed25519(输入)>; proof=<HMAC-SHA256(workgroup key, 输入)>
      输入 = "orca-pod/request" | 方法 | target | 路径+查询 | sha256(body) | ts | nonce | workgroup_id

答复  Pod-Reply: id=<应答方>; sig=<Ed25519("orca-pod/reply" | 请求 nonce | status | sha256(body))>
```

- `proof` 证明发起方知道组密码，所以在组内；`sig` 证明请求出自这个节点，而且内容、路径和接收方都没被改过。两样都对才进路由。
- 成员闸门从“查成员表”改成“验 `proof`”：改了密码的节点，下一个请求就被拒（401），不用再等心跳。成员表只决定谁在线、往哪里拨，不再管准入。
- 答复由应答方签名，并且绑定请求的 nonce，这样一个答复不能被挪去冒充另一个请求的答复。发起方在 `HttpPeerClient` 里统一验签：已知节点的答复必须来自它；第一次联系时，答复里的 `id` 就是 TOFU 记下的身份。
- **文件下载例外**：答复是流式的，事先算不出 sha256，所以答复签名只覆盖 status 和 `blob_id`。收完后按内容的 sha256 校验，因为文件本来就按 sha256 命名（§3.8）。
- 内容仍然是明文传输。这一轮只保证完整性和来源，不做加密。
- HMAC 用内存里那把派生密钥（§3.6），每个请求的开销可以忽略。
- 收到请求时的检查：时间偏差在 60 秒内、nonce 没用过、不早于本进程启动；这些检查由签名和 proof 共用。

**hello**：

```text
POST /cluster/hello            access: "hello"（接收方 id 未知时允许空 target，其余与所有路由相同）
请求 body = { self: SelfDescription, busy, digest }
答复 body = { self: SelfRecord, members_digest, members: PeerView[] | null }
```

- **接收方**：header 检查通过 → 筛查对方声明的端点 → `mesh.answer`：登记或刷新发送者（显式成员、在线）→ digest 不同才附上成员表。请求体里不再有 `Admission`，因为准入已经在 header 里证明过了。
- **发送方**：已知节点时签名绑定它的 id，答复必须来自同一个 id；第一次联系是 TOFU。成功后刷新对方自述和证据，把 `members` 并入候选。
- **不再需要**：`/cluster/join`、`/cluster/heartbeat`、`JoinRequest/Response`、`HeartbeatRequest/Response`、`Admission` / `AdmissionKind` / `mesh/admission.ts`（HMAC 并入 `core/signing.ts`）、访问级别 `join` 与 `local`、`heartbeatWithRejoin` 里 404/403 后补 join 的逻辑、`joinAll` / `joinAt`、`Pod.joinPeers`。对方删掉了我们的记录也没关系：下一次 hello 本身就会重新登记。
- 访问级别只剩 `public`（`/health`、Agent Card）、`hello` 和 `member`。
- **只有种子 URL 能碰陌生人**（§7.1 不变）：种子来自配置的 `peers`、记住的 peers、`connect` 工具或面板。别人目录里的地址只能进候选，拨之前照旧筛查（§7.7）。
- `/cluster/leave`、`/cluster/members`、`/health`、Agent Card 不变。

### 3.4 按节点寻址

- 工具和面板的 `peer` 参数接受 **节点 id、唯一的显示名、或 URL**，统一走 `mesh.resolve`。URL 必须是某个已知节点声明过的地址，或者曾经拨通它的地址（别名记在该节点身上）。
- 派发日志条目从 `peer: string`（URL）改为 `node: OrcaNodeId`。tracker 和 broker 的键改为 `node id|task id`。通知文案显示 `显示名 (id 前缀)`。
- `panel.ts` 与 `tracker.ts` 里用 `client.idOf(peer)` 找发布者的地方，直接用 `node.id`。
- CLI 整个删除（§3.7），`peerClient` 里的 roster 回填逻辑也就随之消失。

### 3.5 本机共享资源与组装

- `SqliteDb` 每个 data_root 一个：`Orca` 打开一次，再交给三个 store（`new SqliteTaskStore(db)`，以此类推），`stop()` 时只关一次。
- 原 `node/orca-node.ts` 的组装类改名为 **`Orca`**（`node/orca.ts`），意思是“这个进程里的这一个 orca 实例”，以免与表里的 `OrcaNode` 混淆。字段：`config`、`identity`、`events`、`models`、`db`、`tasks`（runner）、`workspace`、`mesh`。`profile`、`client`、`membership`、`delegation`、`blobs` 这些公开字段删除，统一从 `mesh` 进入。
- 插件侧：`PodRun = { orca: Orca; port }`。consumer 依旧只拿到 `pod` 一个参数，读法是 `pod.run?.orca.mesh.resolve(peer)`。

### 3.6 机密：都在 DSH 凭据库，派生物只在内存

| 机密 | 存在哪 | 怎么用 |
| --- | --- | --- |
| workgroup 密码 | `ctx.credentials` 的引用 **`ORCA_POD_PASSWORD`**（固定名字，整台机器一份，§3.9） | `Pod` 启动时读一次，派生出 workgroup key（scrypt）交给 `Orca`。**key 只在内存里，不写进任何文件**；`OrcaNodeConfig.key_base64` 删除，`Orca` 构造时直接接收 `key: Buffer` |
| 节点私钥（Ed25519） | `ctx.credentials` 的记录 **`credentialKey('orca-pod', 'node')`** → `{ kind: 'grant', payload: { ed25519: <base58 私钥种子> } }` | `Pod` 启动时读出；记录不存在就用 `modifyRecord` 生成并写入（`modifyRecord` 写入时独占，同时启动的两个进程只会得到同一把钥匙，替代现在的文件锁）。公钥由私钥推导 |

- 两个名字都是固定的：凭据库本来就是整个 DSH home 一份，而一台机器只有一个节点（§3.9）。所以设置项 `workgroup_password_ref`、`passwordRefFor` 以及“换 workgroup 时沿用密码”的分支都删掉：换 workgroup 不改密码的引用名，用户只在要换密码时才填。
- **迁移**：不迁移。按 profile 存的旧身份、旧任务库都不读，节点用新身份重新入组（与 README 现在“不读取、不迁移任何旧位置”的规则一致）。
- **外部修改凭据**：订阅 `credentials/reference-updated`（密码）和 `credentials/record-updated`（私钥）。事件涉及这两个名字时，排队重启一次（走 `Pod` 的串行队列）。面板上的 `password_set` 改用 `ctx.credentials.describe(ref)`，不再读内存里缓存的密码。
- **`reset`**：整台机器的节点回到初始状态，没有分支：删掉密码（`unset`）、私钥记录（`deleteRecord`）、设置文件和 `peers.json`。
- `core/identity.ts` 只剩纯函数：私钥 ↔ base58、签名、验签，不再读写文件。`requireIdentity` / `loadOrCreateIdentity` / `identityPath` / `withFileLock` 的用法全部删除。

### 3.7 只有插件形态；CLI 删除

- 删除 `src/cli/` 整个目录（`main`、`orca-pod`、`serve`、`install`、`send`、`status`、`wait`、`publish`、`fetch`、`log`、`members`、`shared`）、`package.json` 的 `bin`，以及 `test/cli.test.ts`、`test/install.test.ts`。
- `node/config.ts` 删掉持久化部分：`configPath`、`loadConfig`、`validateConfig`、`saveConfig`、`endpointWriteback`、`PersistedIdentitySchema`。`OrcaNodeConfig` 只在内存里由 `Pod` 组装：settings + 节点 id + data_root。`config.json` 不再写。
- data_root 里只剩设置文件（§3.9，不含机密）、SQLite、工作区、`state/`、`peers.json`。
- 网关删掉访问级别 `local` 以及只为 CLI 存在的路由（`/cluster/blob`）。`/cluster/members` 留给对端检查用，访问级别是 `member`。
- `scripts/harness_run.ts` 改为在一个进程里起两个 `Orca`，走真实的 loopback 网络和 echo 执行器（与 `test/support/harness.ts` 同一套），不再 build + spawn。`scripts/cross.ts`（跨机器手测）也改为在进程内构造 `Orca`，身份和密码由命令行参数给出。这些都是开发脚本，不随包发布。
- `skills/orca-node/` 改写为介绍 `orca_pod` 工具的用法；`references/add-machine.md` 改为“在新机器上装 DSH 和这个插件，然后在面板里填 workgroup 和密码”。
- `ORCA_POD_IN_TASK` 继续保留：执行器拉起的 `dsh` 子进程如果也加载了本插件，插件见到这个变量就不启动节点、也不提供 `send`（D39 不变）。`ORCA_POD_CLI` / `ORCA_POD_DATA_ROOT` 删除。

### 3.8 任务里的文件由执行器交接

任务里的 agent 运行在另一个 `dsh` 进程里，看不到本插件的工具。原来它通过 CLI 回连本机 gateway 来取文件和发布文件；现在改由执行器在任务开始前、结束后代办，agent 只读写普通目录。

```text
发起方                                     目标节点
orca_pod send { peer, text, files: [本地路径 | <node>/<sha256>] }
  ├ 本地路径：注册到本机 blob（DiskBlobRegistry），得到 <self>/<sha256>
  └ metadata.pod.files = [{ ref, name }]  ─────────▶  runner 在执行前：
                                                       逐个 mesh.get(ref.node).fetchBlob(ref.blob)
                                                       → 写入 <cwd>/inbox/<task_id>/<name>，校验 sha256
                                                       preamble 列出这些路径
                                                     agent 把要交回的文件放进 <cwd>/outbox/<task_id>/
                                                     任务结束（completed / failed）后，runner：
                                                       注册 outbox 里的每个文件 → artifacts: [{ artifactId: <self>/<sha256>, name }]
tracker 通知里列出 artifacts  ◀────────────────
orca_pod fetch { ref, output }  → mesh.get(node).fetchBlob → 写到 output（经 sandboxPolicy 检查可写），校验 sha256
```

- `orca_pod` 工具新增 `fetch` 方法，`send` 新增 `files` 参数。`publish` 不再单独提供，因为发起方要交出去的文件都通过 `send` 的 `files` 带上。
- 数量和大小限制沿用现有的 `max_workspace_files` / `max_workspace_bytes`，outbox 另设上限（与 echo 的 `max_artifacts` 统一）。超出时任务照常结束，多出来的文件在结论里说明。
- 输入文件取不到（发布方离线、文件已过期）时，任务直接 `failed(input_unavailable)`，不再让 agent 自己重试。
- preamble 里关于 CLI 的四行换成：“输入文件在 `inbox/<task_id>/`；要交回的文件放进 `outbox/<task_id>/`”。

### 3.9 一台机器一个节点，所有 profile 共用

owner 的定义：一个 orca node 代表“这台机器上装的 DSH 可以被连接”。profile 只是切换这台机器的能力组合，不是另一个节点。所以身份、密码、设置、任务库、工作区整台机器只有一份，所有 profile 共用。

- **data_root 固定为 `$DSH_HOME/orca-pod`**。`defaultDataRoot` 不再看 `DSH_PROFILE_DIR` 和 loader 的 `baseUrl`，`DATA_ROOT_ENV`、`profileDirFrom` 删除；设置项 `data_root` 也删除。测试和开发脚本直接给 `Orca` 传目录。
- **设置不再存在 profile 的插件配置里。** DSH 的 `configEditor` 只能写当前 profile 的 patch（`dsh-config-editor` README：“Home patch 和命令行 overlay 参与优先级解析，但不作为写入目标”），没法让所有 profile 共用。所以设置改存到 **`$DSH_HOME/orca-pod/settings.json`**（不含机密，原子写入）：
  - 插件的 `Config` 只剩不属于节点的开关（目前只有 `skill_injection`），其余字段从 schema 里删掉；
  - 面板保存设置 = 写这个文件，然后 `Pod` 原地重启。宿主不再因为写配置而重启插件，所以 `PodStores.writeConfig` 的 `restartsOnWrite` 分支、`HostPodStores` 里 `configEditor` 那一半、`inject` 里的 `configEditor` 都删除；
  - 这推翻了 D43 K2 “设置就是插件配置”这一条，D44 里要写明。
- **同时只有一个进程跑节点。** 两个 DSH 进程同时开着时（比如桌面版加一个终端里的 `dsh`），它们读的是同一份设置，用的是同一个端口。后启动的那个在监听时会遇到 `EADDRINUSE`，`Pod` 把它映射成 `failed`，提示“本机的 orca 节点已在另一个 DSH 进程中运行”。端口本身就是锁，不再另加锁文件。
  - 前提是**绑定端口必须是 `Orca.start()` 的第一步**。现在的顺序是先 `tasks.start()`（会把中断的任务标成失败）和 `delegation.start()`（会把在途派发标成 unknown），后 `gateway.listen`。后启动的进程会在绑定失败之前，就把正在运行的那个进程的任务改掉。所以改为：先绑定端口，绑定成功后才打开 `SqliteDb`、恢复任务和派发记录；`createPersistentStorage` 也从构造阶段挪到 `start()` 里。
- 执行器拉起的 `dsh --profile acp` 子进程如果也加载了本插件，见到 `ORCA_POD_IN_TASK` 就不启动节点（§3.7）。

## 4. 逐文件清单

| 现在 | 之后 |
| --- | --- |
| `mesh/membership.ts`（384） | `PeerEntry` → `OrcaNode`；目录、墓碑、时序 → `Mesh`；`heartbeatIntervalMsFor` 等常量留在 `mesh/timings.ts` |
| `mesh/workgroup.ts`（283） | → `Mesh`（`probe` / `leave` / `answer` / 合并目录 / 事件），大部分删除 |
| `mesh/heartbeat.ts`（49） | → `Mesh.start/stop` 的私有循环 |
| `mesh/dialer.ts`（69） | 按节点的 `preferred` → `OrcaNode`；`verdicts` → `MeshContext.screening` |
| `mesh/self-profile.ts`（107） | 删除，变成 `mesh.self` |
| `mesh/blob-fetcher.ts`（48） | → `OrcaNode.fetchBlob` |
| `mesh/peer-client.ts`（283） | 删掉 URL→id 映射，`target` 必填；请求带 `proof`，答复验签（§3.3）；`remoteError` 不变 |
| `mesh/admission.ts` | 删除；HMAC 并入 `core/signing.ts` |
| `mesh/wire.ts` | `HelloRequest/Response`，不再有 `Admission` |
| `core/signing.ts` | header 增加 `wg` / `proof`；新增答复签名与验签 |
| `core/identity.ts` | 只剩纯函数：私钥 ↔ base58、签名、验签；不再读写文件 |
| `task/delegation.ts` | `rpc` 与 grant 签名 → `mesh/orca-node.ts`（或 `mesh/rpc.ts`）；`Delegation` 类删除 |
| `task/dispatch-log.ts`、`dispatch-store.ts` | 条目字段 `peer` → `node` |
| `task/runner.ts`、`task/record.ts` | 执行前把 `metadata.pod.files` 取到 `inbox/<task_id>/`；结束后发布 `outbox/<task_id>/`，生成 artifacts（§3.8） |
| `task/prompt.ts` | preamble 去掉 CLI，改为说明 inbox / outbox |
| `task/wire.ts` | `PodTaskMetadata` 增加 `files: [{ ref, name }]` |
| `executor/acp/executor.ts` | 子进程环境变量只保留 `ORCA_POD_IN_TASK` |
| `core/wire/peer.ts` | `JoinResponse`、`HeartbeatResponse` → `HelloResponse` |
| `api/cluster-routes.ts` | `join` + `heartbeat` → `hello`；`screened` 缓存移到 `MeshContext.screening` |
| `api/access.ts` | 访问级别只剩 `public` / `hello` / `member`；`member` 改为验 `proof`，不再查表 |
| `api/blob-routes.ts` | 删掉 `/cluster/blob`（本地路由） |
| `api/gateway.ts`、`a2a-routes.ts` | 构造参数改为 `mesh`、`tasks`、`key` |
| `node/orca-node.ts` | → `node/orca.ts`（`Orca`）；构造时接收 `identity` 和 `key`，不再读文件；只打开一个 `SqliteDb` |
| `node/config.ts` | 删掉持久化（`configPath` / `loadConfig` / `validateConfig` / `saveConfig` / `endpointWriteback`）；`key_base64` 删除；`defaultDataRoot` 固定为 `$DSH_HOME/orca-pod`，`DATA_ROOT_ENV` / `profileDirFrom` 删除 |
| `node/settings.ts` | 删掉 `workgroup_password_ref`、`data_root` 两个字段和 `passwordRefFor` |
| `plugin/config.ts` | `Config` 只剩 `skill_injection` |
| `plugin/bundle.ts` | `inject` 去掉 `configEditor`；不再根据 profile 计算 data_root |
| `plugin/pod.ts` | 从凭据库读密码和私钥（没有就生成），派生 key；订阅凭据变更事件；设置读写 `$DSH_HOME/orca-pod/settings.json`，改完原地重启；`EADDRINUSE` 映射为“已在另一个进程中运行”；`addPeer` → `mesh.probe`；`joinPeers` → `mesh.seed(...)`；`PodRun.orca`；不再写 `config.json` |
| `plugin/stores.ts` | `PodStores` 增加私钥记录的读、生成与删除，以及 `describe`；设置改为读写文件，`configEditor` 与 `restartsOnWrite` 删除 |
| `plugin/tools.ts` | 按节点寻址；`send` 增加 `files`；新增 `fetch` |
| `plugin/panel.ts`、`tracker.ts`、`broker.ts`、`panel-api.ts` | 按节点寻址；`peer` 字段语义改为“id / 名字 / URL”，返回时带 `node`；`password_set` 改用 `describe` |
| `plugin/skill.ts`、`skills/orca-node/**` | 改写为介绍 `orca_pod` 工具；add-machine 改为“装 DSH 和插件” |
| `src/cli/**`、`package.json` 的 `bin` | 删除 |
| `scripts/harness_run.ts`、`scripts/cross.ts` | 在进程内构造 `Orca`，不再 spawn CLI |
| `test/cli.test.ts`、`test/install.test.ts` | 删除；其余测试中按文件构造身份的地方改成内存身份 |
| `test/architecture.test.ts` | 分层改为 `core ← executor ← task ← mesh ← api ← node ← plugin` |

## 5. 考察过但没采用的

| 方案 | 不采用的理由 |
| --- | --- |
| 模块级全局单例（`Mesh.current`、`Db.current`） | ① 测试和 harness 会在一个进程里起多个节点组网（`test/support/harness.ts` 一次起 N 个，另有 17 个测试文件直接构造节点），全局变量会让这些测试没法写；② 插件热重载时新旧 fiber 可能短暂共存，模块级的 `current` 会在旧实例还没停完时被覆盖，而 `Pod` 的串行队列正是为了保证“旧的停完新的才起”。M5 的做法（一个资源一份、一个 orca 实例一个 `MeshContext`）同样去掉了层层传参，又没有这两个问题 |
| LocalNode / RemoteNode 两个类 | owner 否决：多出一层建模。自己与别人只在三处行为不同（不发心跳、状态恒为在线、取文件读本地盘），用 `isSelf` 判断就够了 |
| 派给自己的任务直接调本机 runner，不走 HTTP | 会绕过鉴权和 grant 路径，`sendTask` 也得为自己单独写一条分支；loopback 的成本可以忽略 |
| 彻底删掉 `leave` | 主动离开能让对方立刻知道，而不是等 3 个心跳周期，代价只有一条路由 |
| 保留 CLI，用每次启动生成的本地 token 代替私钥鉴权 | 删掉 CLI 之后就不需要了：任务里的 agent 只读写 inbox / outbox，宿主 agent 用工具 |
| 通过 ACP `session/new` 的 `mcpServers` 给任务里的 agent 注入 fetch / publish 工具 | 执行器已经支持配置 `mcp_servers`，但这需要再起一个 MCP 服务，并给它一套本地鉴权，复杂度又回来了。执行器代办文件交接不需要任何回连通道。如果以后确实需要 agent 在任务中途按需取文件，再考虑这条路 |
| 私钥用 `credentialRef`（形如环境变量名的引用）存 | 引用会回落到环境变量和 `.env`，而且整个 DSH home 共用一个命名空间；`credentialKey('orca-pod', …)` 记录归本插件所有，`modifyRecord` 写入时独占，更适合存一把只能生成一次的钥匙 |

## 6. 迁移顺序

每步结束都要 `npm run check` 通过；涉及 mesh、task、plugin 的步骤还要通过 `npm run harness`。

0. 基线：`npm run check`、`npm run harness` 通过。
1. **一个库一个连接**：`SqliteDb` 由 `createPersistentStorage` 打开一次，三个 store 接收 `db`。行为不变。
2. **文件由执行器交接**：`send` 的 `files`、工具的 `fetch`、runner 的 inbox / outbox、preamble 改写（§3.8）。CLI 这时还在，但任务里不再用它。
3. **删掉 CLI 和独立运行**：删除 `src/cli/` 和 `bin`，删除 `config.json` 的持久化和 `key_base64`（派生 key 只在内存），删除 `local` 访问级别和 `/cluster/blob`；harness 和 cross 脚本改为在进程内运行；skill 改写（§3.7）。
4. **一台机器一个节点，机密进凭据库**：data_root 固定为 `$DSH_HOME/orca-pod`；设置改存 `settings.json`，插件 `Config` 只剩 `skill_injection`；`Orca.start()` 先绑定端口；私钥存成 `credentialKey('orca-pod', 'node')` 记录，密码固定为 `ORCA_POD_PASSWORD`；订阅凭据变更事件，`password_set` 改用 `describe`；`reset` 一并删除（§3.6、§3.9）。完成后要在真实 DSH 上用两个 profile 实测一次。
5. **分层改动**：架构测试改为新分层；`task/delegation.ts` 原样移到 `mesh/`。纯移动。
6. **节点对象**：`OrcaNode` / `Mesh` / `MeshContext` 落地，自己进表，`SelfProfile`、`Membership`、`Workgroup`、`HeartbeatLoop`、`EndpointDialer`、`BlobFetcher`、`Delegation` 合并进去。**这一步线协议不变**（hello 还没引入，`Mesh` 内部仍然发 join / heartbeat），这样第 6 步和第 7 步的回归可以分开定位。调用方暂时用 `mesh.resolve(url)` 过渡。
7. **hello 与 header 证明**：线协议换成 `/cluster/hello`；每个请求在 header 里带 `proof`，答复签名；成员闸门改为验 `proof`；加入种子和带退避的重试；删除 rejoin、`Admission`、`join` 访问级别（§3.3）。
8. **按节点寻址**：工具、面板、tracker、broker、派发日志改用节点；`HttpPeerClient` 删掉 URL 映射。
9. **`Orca` 改名与瘦身**：`node/orca-node.ts` → `node/orca.ts`，删掉转手的公开字段，`PodRun.orca`。
10. **文档**：D44、术语表、组装说明、文件表、README；更新 memory。

## 7. 行为变化与风险

| 变化 | 说明 |
| --- | --- |
| **线协议不兼容** | 新旧版本节点互相不认识（旧节点 POST `/cluster/heartbeat` 会得到 404，新节点的 header 旧节点也验不过）。已获同意，不做兼容 |
| **只能作为 DSH 插件运行** | `orca-node` / `orca-pod` 命令消失，systemd 等无宿主部署不再支持；已装过的机器要改成 DSH + 插件。已获同意 |
| **改了密码的节点立刻被拒** | 以前要等下一次心跳失败（几秒）；现在每个请求都验 `proof`，下一个请求就是 401 |
| **答复被篡改会被发现** | 答复签名验不过就按 `peer_error` 处理；文件按内容的 sha256 校验 |
| **启动时没连上的 peer 会自动重试** | 现在 boot 时 join 失败就只记一行日志，之后不会再试；改成种子后，心跳循环会按 `recoverProbeMs` 退避重试，直到连上或被手动移除 |
| **任务里的 agent 不再自己取文件和发布文件** | 输入文件由发起方在 `send` 时用 `files` 声明，执行前就放进 inbox；agent 想在任务中途按需取一个没声明的文件，已经做不到。交回的文件放进 outbox，由执行器发布 |
| **一台机器一个节点** | 已经按 profile 建过节点的机器，会得到一个新身份（新的节点 id），需要重新入组；旧的按 profile 存的数据不读、不迁移。之后 data_root 里没有任何机密 |
| **设置不再出现在 profile 的插件配置里** | 改存 `$DSH_HOME/orca-pod/settings.json`；profile patch 里现有的 orca-pod 字段会被 `Config` 当作未知字段忽略，面板要重新填一次 |
| **两个 DSH 进程同时运行** | 只有先绑定端口的那个跑节点，另一个显示“已在另一个进程中运行”，它的工具不可用 |
| **修复：后启动的进程会改动正在运行的进程的任务** | 现在 `start()` 先恢复任务、后绑定端口，绑定失败的进程已经把对方正在跑的任务标成失败。改为先绑定端口 |
| **外部改了凭据会触发重启** | DSH 设置页、`.credentials.yaml`、或同一 workgroup 的另一个 profile 改了密码，本节点会排队重启一次，用上新密码 |
| **派发日志的记录形状变了** | 老条目只有 `peer`（URL）。读取时用 `mesh.resolve(url)` 补出 `node`；补不出的条目照旧保留，状态记为 `unknown`，tracker 不再恢复跟踪它 |
| **工具的 `peer` 参数语义变宽** | 以前只接受 URL，现在还接受 id 和显示名。显示名重名时报错，并列出候选的 id |
| **`not_a_member` 消失** | 准入改由每个请求的 `proof` 证明；对方删掉了我们的记录也不影响请求，下一次 hello 就会重新登记 |
| 风险：第 6 步改动量大 | membership / formation / transport / watchdog / heartbeat-* 等测试大约有 400 处引用要重写；先把测试改到新 API 上，断言不动 |
| 风险：DSH 凭据事件的实际行为 | `credentials/record-updated` 在 Windows 上对外部编辑的触发时机还没实测；第 4 步要在真实 DSH 上验证一次 |

## 8. 文档同步

- `docs/02-model.md` §2.4：一台机器一个身份，存在凭据库，base58。
- `docs/03-membership.md` §3.2、§3.3：join 与心跳合并为 hello，种子与重试。
- `docs/04-transport.md`：header 格式、答复签名、访问级别。
- `docs/05-tasks.md`、`docs/06-execution.md`：inbox / outbox，`send` 的 `files`，工具 `fetch`，preamble。
- `docs/07-security.md` §7.1、§7.3、§7.9：每个请求两样证明；机密只在凭据库；派生 key 只在内存；`IN_TASK` 只剩插件这一处。
- `docs/09-implementation.md`：组装（`Orca`）、文件表、分层，删掉独立运行和 CLI 的章节。
- `docs/12-handoff.md`、`README.md`：只有插件形态，删掉 CLI 和 `install` 的说明。
- `docs/DECISIONS.md`：新增 D44（M1–M5、分层改动、协议不兼容、header 双证明与答复签名、机密只在凭据库、只保留插件形态、执行器交接文件、一台机器一个节点、设置改存 settings.json 并推翻 D43 K2）。
- 术语表：orca node = 表里的一个节点（包括自己）；`Orca` = 本进程的这个实例。

## 9. 不做的事

- 不引入共识、gossip 广播，也不改目录合并规则（`docs/03-membership.md` 的 §3.5、§3.6 不变）。
- 不做传输加密（TLS），本轮只保证完整性和来源。
- 不改 grant、权限模式、ACP 会话管理。
- 不改 `/orca-api/*` 的路径；响应里的 `peer` 字段会多一个 `node`。

## 10. 实施记录与偏差

按 §6 的顺序做完，`npm run check` 与 `npm run harness` 全绿。和方案不同或方案没写到的地方：

- **步骤 1 与步骤 4 合并了开库时机**：`SqliteDb` 的构造只命名文件，`open()` 在 `Orca.start()` 里、绑定端口之后才调；三个 store 的语句在第一次使用时才 prepare（构造时库还没开）。`test/start-order.test.ts` 钉住“绑定失败的进程没碰正在运行的进程的任务”。
- **`Orca` 公开的字段**：`config`、`identity`、`events`、`models`、`mesh`、`dispatches`、`tasks`、`workspace`，另有 `publish(path)`（登记本机文件）；`blobs` 是私有的。方案里的 `profile`、`client`、`membership`、`delegation` 全部删除。
- **`Mesh` 的接口**：除方案里的 `get/list/resolve/digest/probe/seed/leave/start/stop/answer` 外多了 `require`（找不到抛 `unknown_orca_node`）、`peers()`（不含自己）、`remove`、`mergeRemote`、`evaluate`、`emitMembersIfChanged`、`setIntervalMs`、`screening`、`workgroupId`；`seed` 返回 `{ reached, pending }`，种子的退避重试在心跳循环里；`answer` 的第三个参数是网关筛查过的端点。
- **`hello` 的请求体**：`{ self, busy, digest }`，`digest` 必填；答复 `{ self, members_digest, members | null }`。`HttpPeerClient.call` 返回 `{ body, from }`，`from` 是答复的签名者。答复头名为 `Pod-Reply`；请求头里 id 字段写作 `id=`（方案里是 `id=`，原先的 `orca_node_id=` 不再接受）。
- **旧派发日志条目**：读取时只把缺失的 `node` 补成 `null`，**没有**用 `mesh.resolve(url)` 去推 `node`（方案里的写法）：地址别名只在内存里，重启后一个也没有，推不出；`tracker` 跳过 `node` 为空的条目，面板仍用旧的 `peer` 显示它。
- **`membership` 测试**：`membership.test.ts` 按新对象模型重写（`test/support/mesh.ts` 的手动时钟节点表）；“失败几次后丢弃候选”由 `OrcaNode.missed` 的返回值加 `Mesh.remove` 在测试里复现，真实流程（`greet`）由 formation / watchdog 的集成测试覆盖。
- **没做**：在真实 DSH 上用两个 profile 实测（§6 步骤 4、§7 风险“DSH 凭据事件的实际行为”）。凭据事件的订阅与重启逻辑由单测和假宿主验证，`credentials/record-updated` 在 Windows 上对外部编辑的触发时机仍未实测。
