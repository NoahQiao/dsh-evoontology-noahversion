# 架构

本插件把 [ruc-datalab/EvoOntology](https://github.com/ruc-datalab/EvoOntology) 的自进化本体层（evolvable ontology layer）接入 DSH，让它成为 DSH 会话里可直接调用的能力。本文是改动任何文件前先读的那一页。

## 一句话

上游核心是**零依赖 Python 程序 + 手写 JSON-RPC 的 MCP 服务**；DSH 原生消费 MCP，所以插件的主要工作不是「重写本体引擎」，而是**把上游正确地放进 DSH 的装配模型里**：一条 MCP 行提供 29 个工具，一个 Host 插件把 3 个技能注册进技能目录。

## 分层

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 浏览器（DSH Web Client）                                              │
│   技能目录、工具调用卡片                                              │
│   [计划] 右侧栏 evo 面板 —— docs/subsystems/client-sidebar.md         │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ Connection RPC（DSH 内建）
┌───────────────────────────────▼──────────────────────────────────────┐
│ Host（Cordis 插件树）                                                 │
│                                                                      │
│  @noah/dsh-evoontology（本仓库 index.js，Host 插件）                  │
│    · stagePython()  python/  ──copy──▶  $DSH_HOME/evoontology/python  │
│    · ctx.skills.registerProvider()  3 个技能进技能目录                │
│                                                                      │
│  @deepseek-ai/dsh-mcp-client（官方行，我们只填 config）               │
│    · stdio 拉起 python -m evoontology.runtime.mcp_server              │
│    · 工具自动命名 mcp__evo__<rawName>，共 29 个                       │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ JSON-RPC over stdio
┌───────────────────────────────▼──────────────────────────────────────┐
│ 上游核心（python/evoontology，零依赖，版权归上游）                    │
│    ontology/  runtime/  evolution/  trajectory/  evaluation/          │
│    trigger/  visualization/  workflow.py  workspace.py                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ 读写
                       $DSH_HOME/evoontology/workspace
                       （.evoontology 容器：版本、轨迹、证据、
                         演化运行记录、可视化 HTML）
```

## 组件与职责

| 组件 | 文件 | 职责 | 不负责 |
|---|---|---|---|
| `@noah/dsh-evoontology` | `index.js` | 铺核心、注册技能 provider | 提供工具、渲染 UI、读写工作区内容 |
| `evo` MCP 行 | `cordis.patch.yml` | 启动 MCP 子进程、暴露 29 个工具、超时与重连 | 技能、界面 |
| 上游核心 | `python/evoontology/` | 本体建模、版本化、演化循环、评估、可视化 | 与 DSH 的任何耦合 |
| 上游技能 | `skills/*/SKILL.md` | 教 agent 在什么时机调哪些工具 | 执行本体逻辑 |

## 激活顺序（重要）

`cordis.patch.yml` 里两行的顺序是刻意安排的，不是排版：

1. `evoontology-skills`（本插件）先 `apply`，把 `python/` 铺到 `$DSH_HOME/evoontology/python`。
2. `evoontology-mcp` 后激活，其 `cwd` 由 `!!js dshHomePath('evoontology/python')` 求值。

如果顺序反过来，MCP 行的 `cwd` 会指向一个还没铺好的目录，子进程直接起不来。这条依赖没有类型系统保护，只能靠注释与本文维持。

## 运行时数据流

### 建本体（build）

```text
用户：给我这个库建本体
  → agent 命中 skill build-ontology（技能目录自动暴露描述）
  → 读 SKILL.md，按其中流程依次调用
      mcp__evo__configure_ontology_project
      mcp__evo__prepare_ontology_workload
      mcp__evo__save_version
      mcp__evo__publish_ontology_build
  → 上游把版本写进 workspace，返回 run 记录
  → 工具结果回到会话；publish 会产出可视化 HTML
```

### 演进（evolve）

```text
mcp__evo__start_evolution_run    开一轮 run，冻结轮次预算
  → start_ontology_task         把问题钉到某个语义版本
  → execute_ontology_query      跑真实查询（SQLite 只读回放）
  → record_ontology_task_event  记录真实工具调用与结果
  → finish_ontology_task        落 trajectory
  → begin/record_evolution_round  诊断→归因→补丁→评测循环
  → accept_evolution / record_evolution_evaluation / extend_evolution_budget
  → finalize_evolution_run      终态 + 结局浏览器
```

### 使用（use）

```text
browse_semantics   按自然语言找概念（term / mapping / relation / constraint）
resolve_semantics  把概念解析到落点对象与 SQL
```

## 关键边界

1. **上游核心零改动。** `python/` 是从上游复制来的字节级副本，任何修改都会在下次 `scripts/sync-from-upstream.ps1` 时被覆盖。要改行为只能改 DSH 侧（`index.js`、`cordis.patch.yml`、`skills/` 里的改写在同步脚本中做）。
2. **路径不写死。** 仓库可能被换目录、被 link 安装、被复制到别的机器；因此配置里只用 `!!js dshHomePath(...)` 与 `process.env.DSH_EVOONTOLOGY_PYTHON`，绝不出现 `D:\...` 或 `C:\Users\...`。
3. **数据只在本机。** 上游不联网；工作区落在 `$DSH_HOME`，不进用户仓库、不进 git。
4. **卸载要能清干净。** 卸载 bundle 不会删 `$DSH_HOME/evoontology`（详见 [decisions/0002](decisions/0002-stage-core-into-dsh-home.md)），README 里写明手动清理命令。

## 不做

- 不重写本体引擎，也不 fork 上游核心（见 [decisions/0001](decisions/0001-bundle-over-python-package.md)）。
- 不把 MCP 行做成配置型 bundle：技能必须由 JS 注册，配置型 bundle 挂不了（见 [decisions/0003](decisions/0003-skills-via-js-not-config.md)）。
- 不用 `ctx.systemPrompt.section` 硬塞使用说明：同层重名或 order 非有限值会直接抛错，发现入口交给技能目录。
- 不做跨机器同步、不做云端存储、不做多用户隔离。
