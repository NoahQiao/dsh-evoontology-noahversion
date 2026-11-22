# dsh-evoontology-noahversion

把 [EvoOntology](https://github.com/ruc-datalab/EvoOntology)（面向 Data Agent 的自进化 Ontology Layer）
移植成 [DeepSeek Harness](https://github.com/deepseek-ai) 原生插件。

> **状态：仓库已初始化，插件实现尚未开始。** 本 README 只描述目标与边界，不含"已实现"声明。

## 上游是什么

EvoOntology（人大 DataLab，MIT，[arXiv 2609.15779](https://arxiv.org/abs/2609.15779)）为 Data Agent
提供一层**带版本、可自我进化**的语义层（Ontology Layer）：

- **Content Layer** —— 类型化语义图，5 类节点：Term / Mapping / Relation / Constraint / Evidence
- **Schema Layer** —— 定义节点的字段、允许的关系类型与合法引用模式
- **Tool Layer** —— 只向 Agent 暴露 `browse_semantics`（找概念）与 `resolve_semantics`（解析成表字段映射），
  session 初始化只注入极简 manifest，记录按需检索

生命周期：`Build → Use → Record → Evolve → Evaluate → Publish/Reject`。Candidate 必须在配对评估中
稳定优于 Parent 才发布为 `ontology_vN+1`，否则保留 Parent。上游实测（论文四 backbone 分析子集）：
DDR-Bench 69.5 → 89.5、BIRD EX 63.6 → 72.4。

## 为什么要移植

上游的插件形态**只覆盖 Claude Code 与 Codex**：靠各自的 marketplace 清单 + skills + 一个 stdio MCP server。
那套东西的宿主契约（`plugin.json` / `.mcp.json` / SKILL.md 目录约定 / marketplace.json）不是 DSH 的契约。
DSH 侧需要的是原生 bundle：由 Cordis 托管的服务、工具、配置与 profile 集成。

因此本项目的核心工作量不是"复制文件"，而是**把上游的确定性核心接到 DSH 的插件模型上**，并决定
哪些能力留在 Python、哪些改写成 DSH 原生工具。

## 计划的形态（待实现）

| 上游能力 | DSH 侧的落点 | 状态 |
| --- | --- | --- |
| `browse_semantics` / `resolve_semantics` | DSH 工具 | 待设计 |
| build / evolve / explore 三个 skill 工作流 | DSH skill 或 agent preset | 待设计 |
| ontology store + 版本目录（`.evoontology/`） | 复用上游核心 or 重写 | 待定 |
| EvolutionSession 状态机与门控 | 服务 + 工具 | 待设计 |
| 离线 HTML 探索器 | 保留（静态文件） | 待定 |
| 27 个确定性 ops | 精简，只暴露 DSH 需要的 | 待设计 |

## 与上游的关系

- 上游版权：Copyright © Meiduo Chong，MIT License
- 本项目为 DSH 移植版，派生部分同样以 MIT 发布，保留上游版权声明（见 [LICENSE](LICENSE)）
- 本项目是**个人移植分支**，不代表上游立场；上游问题请提到上游仓库

## 开发环境

- Windows（主要）、Python ≥ 3.10、Node/pnpm（DSH 插件构建）
- 计划中的本地安装路径：以本地 bundle 形式装进 DSH `desktop` profile
