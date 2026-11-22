# 0005 原生重写：从 MCP 子进程迁到进程内工具

- 日期：2026-11-22
- 状态：**已实现**（v1.0.0；架构见 [../architecture.md](../architecture.md)）
- 取代：[0001](0001-bundle-over-python-package.md)、[0002](0002-stage-core-into-dsh-home.md)

## 背景

v0.1/v0.2 的形态是「bundle 里塞一份上游 Python 核心 + 一条 `dsh-mcp-client` 行」。它能跑通，但每一次调用都要穿过六层：

```
浏览器? → Host 插件 → MCP stdio → Python 子进程 → 上游 ops 状态机 → JSON 文件
```

其中任意一层出问题，症状都是「工具没反应」：Python 不在 PATH、`cwd` 指向的目录还没被铺好、子进程编码不一致、协议版本不匹配、超时、上游状态机把错误包成 ok。

更根本的问题是**上游 ops 的形状与我们的语义不匹配**：27 个 ops 里有一半是同一个进化状态机的转移（`begin_round` / `record_round` / `record_evaluation` / `extend_budget` / `mark_incomplete` / `finalize`），那是它的内部状态机，不是稳定契约。把它原样端上来，等于把「实现细节」当「对外接口」交付给模型。

## 决策

**删掉子进程与 Python 核心，用 `ctx.tools` 在宿主进程内实现语义层。**

- 存储：`node:sqlite`（Node 24 内置，Host 进程就是 Node 24）替代「一目录 JSON」。
- 工具：8 个替代 29 个，写路径只有三条。
- 数据访问：P0 不接管，探测数据用宿主已有能力；P4 再长 `DataSourceConnector`。

## 理由

1. **失败面从六层降到一层**：没有解释器、没有 PATH、没有 `cwd` 铺核心、没有协议协商。唯一的外部依赖是 Node 自带的 SQLite。
2. **语义形状自己说了算**：工具按「问题」设计（看状态/找语义/提交/发布/回退），不按上游状态机设计。模型只需要理解一种返回形状。
3. **原子性**：`active.json` 与 `versions/` 的跨文件一致性原来靠自觉，现在靠事务 + 部分唯一索引。
4. **零安装**：不再需要 Python；`files` 里只有 JS 与 Markdown。

## 代价

- 放弃上游 27 个 ops 的现成实现：进化循环（P3）要重写，而不是接线。这是有意的——那部分本来就不该以 RPC 形式暴露。
- 上游的 benchmark 适配器（BIRD / DDR / InsightBench）暂时用不上；P4 恢复数据源协议时再谈。
- 上游升级无法「同步」过来，只能对照 `native-redesign.md` 重新吸收思路。`scripts/sync-from-upstream.ps1` 已删除。

## 验证

- `scripts/_check-store.mjs`：15 项存储不变量（接地、幂等、copy-on-write、单 active、回退、悬空边、relation 拒绝、discard）。
- `scripts/_check-plugin.mjs`：60 项端到端（八个工具的注册与渲染、空库、草稿流转、多草稿拒绝猜、diff、导出、`/evo` 六个子命令、三个技能、注销后座位清空）。
