# 路线图

按「先写清设计，再落地验证」的节奏推进。每一版都必须有**可复现的验证记录**（写进 README 的「验证记录」小节），否则不算交付。

## v0.1 — 能力接入（已完成）

目标：让 DSH 会话能直接用 EvoOntology 的全部能力。

- [x] `cordis.patch.yml` 两行：技能注册 + MCP stdio
- [x] `index.js`：铺核心到 `$DSH_HOME`、注册 3 个技能
- [x] `scripts/sync-from-upstream.ps1`：搬核心 + 改写工具名
- [x] `locale/{en,zh}.json`、`icon.svg`
- [x] 装机验证：`install_bundle` 返回 `applied`（免重启）；`$DSH_HOME` 下出现 28 个 .py；`mcp__evo__list_versions` 返回 `{"status":"ok"}`；29 个 `mcp__evo__*` 全部可见
- [x] 架构文档（本目录）

**v0.1 遗留未验证**：详情页图标与中英标题的实际渲染；完整 `build → evolve → publish` 生命周期跑通一次（需要真实数据集）。

## v0.2 — 侧边栏面板（已实现，待重启验证）

目标：不打断对话地看本体层状态。契约见 [subsystems/client-sidebar.md](subsystems/client-sidebar.md)，座位决策见 [decisions/0004](decisions/0004-sidebar-right-seat.md)。

- [x] `client.js`：注册 `evo` 右侧栏标签 + 面板正文（`sidebarRightTabs.register` + `sidebar.right.pane.tab` 同 id 两次注册）
- [x] Host 侧只读命令：`evo status` / `evo versions` / `evo runs`（`ctx.commands.register`，扫工作区直接回 JSON）
- [x] 面板内容：版本列表 + 活动标记、5 类节点计数、最近 run 终态、探索器路径、轨迹数、工作区路径、空态引导
- [x] 中英 locale key（`ctx.locale.register`）
- [x] `package.json`：`exports["./client"]` + `dsh.client`
- [x] 离线验证：伪 ctx 跑 `apply`，对合成工作区验 `status`/`versions`/`runs`/未知子命令/空工作区
- [ ] 装机验证（重启后）：右栏「+」出现 EvoOntology、正文渲染、刷新生效

**升级路径注意**：替换已安装包的 JS 实现需要重启 DSH（`restart-required`），这与 v0.1 的「新装免重启」不同。

## v0.2.1 — 面板体验补强（候选）

- [ ] 面板随版本变化自动刷新（需要确认 Host→Client 的会话事件能否承载，走 ADR 而不是硬塞定时器）
- [ ] 点版本行展开该版本的 5 类节点明细（现在只有计数）
- [ ] 用宿主浏览器标签打开 `visualizations/*.html`（现在是显示路径）

## v0.3 — 上游可扩展性（候选，未承诺）

这三条来自对本项目的评估：上游目前是「能插件化但不可扩展」。若确实需要，按此顺序推进，且**优先提 PR 给上游**而不是在 vendored 副本里改。

- [ ] 候选一：把 `runtime/tools.py` / `runtime/ops.py` 的硬编码分派表改成 `importlib.metadata.entry_points` 发现（成本低、收益明确）
- [ ] 候选二：`benchmarks/registry.py` 的 `_BUILTINS` 同样改 entry_points
- [ ] 候选三：语义层数据驱动（5 类节点从 `@dataclass(frozen=True)` 变为可注册），牵动 store / validate / renderer，风险最高，需单独 ADR

## 不打算做

- 内置 Python 解释器或自动 `pip install`
- 多用户 / 云端工作区同步
- 在面板里做写操作（编辑本体一律回会话里由 agent + MCP 工具执行）
