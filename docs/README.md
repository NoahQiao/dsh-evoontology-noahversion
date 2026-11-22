# 文档索引

本仓库按 DeepSeek Harness（下称 DSH）上游仓库的惯例写文档：**每个子系统一篇契约文档，字段与边界先写清，再动代码**。文档是设计的唯一真相，代码是文档的实现；两者不一致时先改文档，再改代码。

## 怎么读

| 想干什么 | 读哪篇 |
|---|---|
| 一页看懂这个插件由哪些层组成、运行时发生了什么 | [architecture.md](architecture.md) |
| 想知道 29 个 `mcp__evo__*` 工具从哪来 | [subsystems/mcp-bridge.md](subsystems/mcp-bridge.md) |
| 想知道 agent 怎么发现「建本体 / 演进本体 / 浏览本体」 | [subsystems/skills.md](subsystems/skills.md) |
| 想知道 `index.js` 为什么要往 `$DSH_HOME` 铺文件 | [subsystems/host-plugin.md](subsystems/host-plugin.md) |
| 想知道上游核心改没改、怎么升级 | [subsystems/upstream-core.md](subsystems/upstream-core.md) |
| 想知道侧边栏面板怎么注册、数据怎么到浏览器 | [subsystems/client-sidebar.md](subsystems/client-sidebar.md) |
| 想知道当初为什么这么选 | [decisions/](decisions/README.md) |
| 想知道哪些做完了、哪些还没做 | [roadmap.md](roadmap.md) |

## 文档约定

沿用 DSH 上游 `docs/subsystems/*.md` 的结构，每篇固定四段：

1. **定位与归属**——这个子系统是什么、属于谁、依赖谁。
2. **契约**——字段、方法、事件、失败语义。凡是代码要以某个形状存在的地方，这里写死。
3. **扩展位**——别人可以往哪挂东西；以及挂上去之后的优先级与冲突规则。
4. **不做**——明确写出来的非目标。这条最重要：没有「不做」，边界会在一轮轮迭代里被吃掉。

## 与其他文档的关系

- `README.md`：面向使用者（怎么装、怎么开、怎么卸）。
- `docs/`（本目录）：面向维护者（为什么这么设计、改动会牵动什么）。
- `python/UPSTREAM.txt`：面向溯源（当前 vendored 的是上游哪个版本）。
- `skills/*/references/*.md`：上游技能自带的参考资料，属于**上游内容**，由 `scripts/sync-from-upstream.ps1` 覆盖，不要手改。
