# orca-pod

分布式 DSH 对等集群（DSH 插件形态）。设计文档入口：[docs/README.md](docs/README.md)。

- 目标：2–10 台自己的机器，跨 Windows/Linux，互相派任务、回传结果。
- 形态：full mesh、明文 HTTP + 前置代理终止 TLS、A2A 任务面、内容寻址 blob 通道。
- 状态：设计基线（Draft / handoff baseline），尚未开始实现。
