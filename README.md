# dsh-evoontology-noahversion

把 [EvoOntology](https://github.com/ruc-datalab/EvoOntology)（面向 Data Agent 的自进化 Ontology Layer）
移植成 [DeepSeek Harness](https://github.com/deepseek-ai) 原生插件（DSH bundle）。

> 本仓库是**个人移植分支**，不代表上游立场；上游问题请提到上游仓库。

## 上游是什么

EvoOntology（人大 DataLab，MIT，[arXiv 2609.15779](https://arxiv.org/abs/2609.15779)）为 Data Agent
提供一层**带版本、可自我进化**的语义层（Ontology Layer）：

- **Content Layer** —— 类型化语义图，5 类节点：Term / Mapping / Relation / Constraint / Evidence
- **Schema Layer** —— 定义节点的字段、允许的关系类型与合法引用模式
- **Tool Layer** —— 对外暴露确定性的 MCP 工具；session 初始化只注入极简 manifest，记录按需检索

生命周期：`Build → Use → Record → Evolve → Evaluate → Publish/Reject`。Candidate 必须在配对评估中
稳定优于 Parent 才发布为 `ontology_vN+1`，否则保留 Parent。上游实测（论文四 backbone 分析子集）：
DDR-Bench 69.5 → 89.5、BIRD EX 63.6 → 72.4。

## 这里做了什么

上游的插件形态只覆盖 Claude Code 与 Codex（各自的 marketplace 清单 + skills + 一个 stdio MCP
server），宿主契约不是 DSH 的契约。本项目把同一份确定性核心接到 DSH 的插件模型上，形态是**一个 bundle**：

```
bundle @noah/dsh-evoontology
├── cordis.patch.yml          # 两行 insert
│   ├── evoontology-skills    # 本包 index.js：把 Python 核心铺到 $DSH_HOME，注册技能与 evo 命令
│   └── evoontology-mcp       # @deepseek-ai/dsh-mcp-client：stdio 拉起 Python MCP server
├── index.js                  # Host 插件（export apply + inject ['skills','commands']）
├── client.js                 # 右栏「EvoOntology」标签页：版本的只读视图
├── python/evoontology/       # 随包附带的零依赖上游核心（28 文件，~720 KB）
├── skills/                   # 上游三个技能，工具名已改写为 mcp__evo__<tool>
└── locale/ icon.svg          # 插件列表里的标题、说明与图标
```

三点设计取舍：

1. **不重写核心。** 上游核心是零依赖纯 Python，29 个工具 + workspace/版本/session 状态机都在里面。
   直接以 stdio MCP 挂进 DSH，比在 JS 里重写一遍确定性逻辑可靠得多。
2. **技能必须由 JS 注册。** DSH 的 `ctx.skills` 是独立 Host 服务，配置型 MCP bundle 带不了技能；
   没有技能的描述，agent 根本不会知道有这套能力。所以 index.js 做两件事：把核心铺到
   `$DSH_HOME/evoontology/python`（这样 MCP 行的 `cwd` 与仓库路径解耦），再用
   `ctx.skills.registerProvider` 注册三个技能。
3. **面板不碰 MCP。** 浏览器侧拿不到 MCP 工具的句柄，右栏面板改走一个只读的 `evo` 命令
   （Host 直接扫工作区目录回 JSON）。它不占工具表，也不阻塞对话。

## 上游能力 → DSH 落点

| 上游能力 | DSH 侧 | 状态 |
| --- | --- | --- |
| 29 个确定性 MCP 工具 | `mcp__evo__<tool>`（`@deepseek-ai/dsh-mcp-client` 行） | 已接通（见"验证记录"） |
| build / evolve / explore 三套工作流 | 三个 DSH skill，由 index.js 注册 | 已注册 |
| `.evoontology/` 工作区与版本目录 | 复用上游实现，工具参数 `workspace` 传入 | 复用 |
| EvolutionSession 状态机与门控 | 复用上游实现（tool 层） | 复用 |
| 离线 HTML 探索器（`explore-ontology`） | 复用上游 `visualize_ontology` | 复用 |
| 版本状态可视化 | 右栏「EvoOntology」标签页 + `evo` 只读命令 | 已实现，待重启验证 |

## 侧边栏面板

右栏的「+」里会多一个 **EvoOntology** 标签页，只读展示 `$DSH_HOME/evoontology/workspace` 的现状：

- 版本列表，带活动版本标记，每个版本显示 5 类节点（term / mapping / relation / constraint / evidence）计数与合计
- 最近一次演化 run 的状态、parent / candidate / 已接受版本、轮次与预算、终止原因、更新时间
- 离线探索器 HTML 的路径、任务轨迹数量、工作区路径
- 工作区还空着时给一句引导（让 agent 用 `build-ontology` 技能建层）

数据来自 Host 侧的 `evo` 命令（`status` / `versions` / `runs`），只读、不写工作区、不经过 MCP 子进程。
面板内容在打开与点「刷新」时更新。

## 文档

架构与设计写在 `docs/` 里，每个子系统一篇契约文档（定位与归属 / 契约 / 扩展位 / 不做），
先写清设计再改代码：

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 分层图、组件职责、激活顺序、三条运行时数据流 |
| [docs/subsystems/mcp-bridge.md](docs/subsystems/mcp-bridge.md) | `evo` MCP 行的逐项配置契约与理由 |
| [docs/subsystems/skills.md](docs/subsystems/skills.md) | `ctx.skills.registerProvider` 契约与 front matter 限制 |
| [docs/subsystems/host-plugin.md](docs/subsystems/host-plugin.md) | `index.js` 为什么要把核心铺到 `$DSH_HOME` |
| [docs/subsystems/upstream-core.md](docs/subsystems/upstream-core.md) | vendored 核心的同步、运行前提与已知限制 |
| [docs/subsystems/client-sidebar.md](docs/subsystems/client-sidebar.md) | 右栏面板的注册契约、命令桥与返回形状 |
| [docs/decisions/](docs/decisions/README.md) | 四条关键取舍的原因与代价 |
| [docs/roadmap.md](docs/roadmap.md) | v0.1 能力接入 / v0.2 侧边栏 / v0.3 候选 |

## 安装

前置：`python` 命令可用（Python ≥ 3.10）。本机实测用的是
`C:\Users\Noah_Qiao\AppData\Local\Programs\Python\Python314\python.exe`。

```powershell
# 安装本地目录为 bundle（不要用 dsh plugin add，desktop profile 由应用托管）
# 在 DSH 会话里用 plugin_manager：action=install_bundle，target=<本仓库绝对路径>
```

首次安装返回 `application: applied`，技能与工具**当场可用，不必重启**。只有"替换已装包的
JS 实现"这种升级路径才提示 `restart-required`——升级到 v0.2（新增 `client.js` 与 Host 命令）属于后者，
装完需要重启 DSH。

装完后：

- 插件列表里出现 **EvoOntology semantic layer**，图标是三段层叠 + 回转箭头
- 技能目录里多出 `build-ontology` / `evolve-ontology` / `explore-ontology`
- Agent 可调用 `mcp__evo__browse_semantics` 等 29 个工具
- 右栏「+」里多出 **EvoOntology** 标签页（v0.2 起）

### 换解释器

```powershell
$env:DSH_EVOONTOLOGY_PYTHON = 'C:\path\to\python.exe'
```

`cordis.patch.yml` 里 `command` 写成 `!!js process.env.DSH_EVOONTOLOGY_PYTHON || 'python'`，
未设置时退回 PATH 上的 `python`。

### 停用与清理

关闭 bundle 只移除技能与工具；已经铺到 `$DSH_HOME/evoontology/` 的 Python 核心**不会自动删除**
（那是运行时数据，不是包内文件）。要彻底清掉：

```powershell
Remove-Item -Recurse -Force "$HOME\.dsh\evoontology"
```

## 从上游同步

`python/` 与 `skills/` 都是从上游 checkout 复制生成的，不要手改；改完上游重新跑一遍：

```powershell
pwsh -File scripts/sync-from-upstream.ps1 -Upstream D:\dsworkspace\evoontology
```

脚本做四件事（幂等）：复制 `evoontology/` 包 → 复制三个 skill 目录 → 把技能正文里的裸工具名
改写成 `mcp__evo__<tool>`（按名字长度降序替换，已带前缀的不重复加）→ 写 `python/UPSTREAM.txt`
记录上游版本，index.js 用它判断是否需要重新铺核心。

## 验证记录

已实际执行（2026-11-22，Windows 11 + Python 3.14.0 + DSH 0.2.2-rc.5 desktop）：

- 上游核心以 `python -m evoontology.runtime.mcp_server --store <tmp>` 启动，`initialize` 返回
  `protocolVersion 2025-06-18`，`tools/list` 返回 **29 个工具**（此前文档里"只暴露 2 个工具"
  的说法只适用于 Claude Code 插件的技能层约束，MCP 服务本身是全量的）
- `scripts/sync-from-upstream.ps1` 跑通：28 个 Python 文件 + 3 个技能，改写 7 个文件、70 处工具引用
- `plugin_manager install_bundle` 返回 `application: applied`——**首次安装无需重启 DSH**
- `!!js dshHomePath('evoontology/...')` 求值正确：核心被铺到 `C:\Users\Noah_Qiao\.dsh\evoontology\python`，
  工作区落在 `...\.dsh\evoontology\workspace`；MCP 子进程以该 python 目录为 cwd 启动成功
  （目录里出现了运行时生成的 `__pycache__`），所以 `python -m` + cwd 的取值方式成立，不需要 `PYTHONPATH`
- 3 个技能 `build-ontology` / `evolve-ontology` / `explore-ontology` 在装入后立即出现在会话技能目录里
- 29 个 `mcp__evo__*` 工具全部对模型可见，且真实调用 `mcp__evo__list_versions`（workspace 指向
  `C:\Users\Noah_Qiao\.dsh\evoontology\workspace`）返回 `{"status":"ok","active_version":null,"versions":[]}`；
  资源服务 `evo` 也出现在 MCP resource server 列表里

尚未验证：

- 插件详情页的图标与中英标题渲染（需要在 GUI 里肉眼看）
- 完整的 build → evolve → publish 生命周期（需要一个真实数据集和 SQLite 数据源）

v0.2 面板（2026-11-22，离线验证，未涉及 GUI）：

- `client.js` 通过 `node --check`；`package.json` 与两份 locale 通过 JSON 解析
- 用伪 Cordis ctx 跑 `index.js` 的 `apply`，对合成工作区调用 `evo` 命令的 `handler`：
  `status` 返回 `active: v2`、`v1(total=6) v2(total=9,active)`、`latestRun` 取最新 run、
  `trajectories: 2`、`visualizations: 1`；`runs` 按新→旧返回；未知子命令返回 `kind: 'error'`；
  空目录返回 `exists: true, versions: 0`（面板落空态）
- 在 `vm` 里执行 `client.js` 并抓 factory，用伪 ctx 跑 `apply`：slot 名/key、tab 定义、
  `inject()` 提供的 `t` 与 `load` 全部符合座位契约
- 用 hook 打桩驱动面板重渲染（`load` 走真实的 `remote.commands` 解析路径），三态都渲染正确：
  有数据 → 版本计数 + 活动标记 + run 明细（含 `2026-11-22 11:19:41` 时间格式）+ 探索器路径
  + 轨迹数 + 工作区路径；空工作区 → 引导文案；命令失败 → 错误信息与重启提示

v0.2 尚未验证（需要重启 DSH 后肉眼确认）：

- 右栏「+」里出现 `EvoOntology`、点开有正文、刷新按钮生效
- 命令桥在真实会话下的 `sessionId` 解析与 `remote.commands` 返回值形状

## 已知限制

- **只有 SQLite 只读回放**：上游 `workflow.py` 的内置执行器是 bounded SQLite replay，其它数据源
  需要宿主工具配合；接 MySQL/Postgres 要另写连接器。
- **核心是随包副本**：没有做成 pip 依赖。好处是零安装、离线可用；代价是升级要重跑同步脚本。
- **Windows 优先**：本仓库只在 Windows + Python 3.14 上跑过；Python 侧本身是跨平台的。

## 与上游的关系

- 上游版权：Copyright © Meiduo Chong，MIT License
- 本项目为 DSH 移植版，派生部分同样以 MIT 发布，保留上游版权声明（见 [LICENSE](LICENSE)）
