# orca-pod

分布式 DSH 对等集群（DSH 插件形态）。设计文档入口：[docs/README.md](docs/README.md)。

- 目标：2–10 台自己的机器，跨 Windows/Linux，互相派任务、回传结果。
- 形态：full mesh、明文 HTTP + 前置代理终止 TLS、A2A 任务面、内容寻址 blob 通道。
- 代码：单包 [`packages/orca-pod`](packages/orca-pod/README.md)（库 + DSH host bundle，运行时只依赖 fastify）。
- 状态：Phase 0 可运行——`/health`、join 与心跳登记、`/a2a`（`message/send`/`tasks/get`/`tasks/cancel`、Echo 脚本机、单槽）、`/blobs` 上传/下载/直链、`pod_*` 四个插件工具；Windows ↔ Hyper-V Ubuntu 跨机 join 与任务往返已验证。

```bash
npm install
npm run typecheck
npm test
```
