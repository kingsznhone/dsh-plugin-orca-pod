# Orca Pod 文档

Orca Pod 是 DeepSeek Harness 的一个插件：把 2–10 台装了 DSH 的机器组成对等集群，任意节点都能向其他节点派任务、取回进度与结论。

文档只有两份，按用途分：

| 文档 | 回答什么 |
| --- | --- |
| [design.md](design.md) | 它是什么、为什么这样设计：身份与组网、传输与接口、任务、执行、安全、可靠性、未决项 |
| [implementation.md](implementation.md) | 代码在哪、怎么装配、面板与客户端 bundle、测试与构建发布 |

装好插件后的使用说明在仓库根 [README.md](../README.md)（英文版：[README.en.md](../README.en.md)）。

## 快速开始

1. 在每台机器上安装（跑节点的 profile 与执行任务的 `acp` profile 都要装）：
   - 桌面版：在「设置 → 插件」里安装 `dsh-plugin-orca-pod`（桌面 profile 由应用管理，命令行无权写入）。
   - 其它 profile（`web`/`headless`/`acp`）：`dsh plugin --profile <name> add dsh-plugin-orca-pod`。

2. 打开 DSH 的「设置 → Orca Pod」：填 workgroup（小写字母/数字/连字符）、密码（≥12 字符）、监听地址与端口（默认 `127.0.0.1:11811`）。
3. 在一台上点「连接节点」，填另一台的 `host:port` 与同一个密码；两边面板出现彼此后，mesh 会自己补全。
4. 发任务：在会话里让 agent 调 `orca_pod` 的 `send`（目标写节点 id 或唯一显示名），或直接用面板。

密码在组外手工传递（密码 = 成员资格）；一台机器只跑一个节点，端口就是互斥锁。

## 约定

- 文档描述**当前代码的行为**，不写版本兼容与变更日志；代码与文档不一致时以代码为准，并修文档。
- 改协议、语义或安全边界时同步更新 `design.md` 对应章节；实现结构变化更新 `implementation.md`。
- 未定与暂缓项只放在 `design.md` §8，不做决定前不散落在正文。
- 旧文档（01–12、arch、DECISIONS）已并入这两份，git 历史里仍可查。

## 状态

设计与实现一致：身份、组网、传输、任务、执行、安全、可靠性均已实现并有测试覆盖；未决项见 design.md §8（密码分发、大文件、>10 节点、mDNS、Windows 路径、digest 范围、trace id），指标与 SSE 暂缓。
