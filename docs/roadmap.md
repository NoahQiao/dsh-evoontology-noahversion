# 路线图

范围与理由见 [native-redesign.md](native-redesign.md)；本文件只记录**当前进度**。

## 已交付：P0（v1.0.0）

- [x] `lib/store.js`——SQLite schema、接地校验、patch 幂等、copy-on-write 版本、单 active 索引、publish/revert/discard
- [x] 八个工具：`evo_status` / `evo_browse` / `evo_resolve` / `evo_history` / `evo_commit` / `evo_publish` / `evo_revert` / `evo_export`
- [x] `/evo` 命令：`status | versions | diff | publish | revert | export | path`
- [x] 三个技能：`build-ontology` / `use-ontology` / `evolve-ontology`
- [x] 删除 Python 核心、MCP 行、`client.js` 与同步脚本
- [x] 离线自检：存储 15 项、插件 60 项
- [x] 装机验证：8 个工具 + `/evo` + 3 个技能在当前会话可见
- [ ] **面板**：v0.2 曾实现（读 JSON 工作区），P2 以 `store.db` 为数据源重建

## P1：用起来（v1.1.0，已交付）

- [x] `evo_query`——唯一只读执行器。`sqlite` / `csv` / `json` 三种源；authorizer 白名单（`SELECT` / `READ` / `FUNCTION` / `RECURSIVE`）；行数上限 100、单值 2 KB、5 s 超时（worker 线程 + `terminate()`）。契约见 [subsystems/query.md](subsystems/query.md)
- [x] `evo_task_start` / `evo_task_finish`——任务闭环，写 `task` / `event` 表；轨迹真相是 session log，不自建轨迹文件
- [x] `ctx.systemPrompt.section` 注入一行状态（`本体 v3 · 4 term · 2 mapping · 今天发布`），正文按需检索；无激活版本时不注入
- [x] 离线自检：存储 15 项、插件 62 项、P1 面 55 项
- [ ] **待实测**：判据「建完一次语义层后，第二次分析同一份数据时不读原始 schema 也能写对查询」需要一次真实的两轮对话来验证
- 已知代价：被超时掐掉的 `sqlite` 查询会在 Host 进程里留一个只读句柄直到重启（见 [query.md §2.5](subsystems/query.md)）

## P2：看见

- [x] 右栏 tab 读 `store.db`（座位决策见 [decisions/0004](decisions/0004-sidebar-right-seat.md)；`client.js` 经 `/evo status --json` 取数，浏览器不碰数据库）
- [x] Host → Client 数据通路走 `/evo status --json`（不新增 HTTP 端点，不新增工具）
- [x] 版本差异视图：节点级的 `+ / - / ~` 与边的 `+ / -`，点一个版本即对比激活版本
- 判据：用户不需要让 agent 转述，就能看出「这次改了什么、为什么」
- **部分达成**：改了什么、在哪些节点上一目了然；「为什么」（`evidence.probe` 摘要）还没进面板——节点只有 `kind` 与 label。下一步是把 `evo_history` 的 evidence 摘要一并放进 `/evo diff --json`，但那会让单次对比的载荷变大，值得先看真实使用频率再定
- 离线自检：面板 33 项（`scripts/_check-client.mjs`）
- **待实测**：需要重启 DSH 后肉眼确认右栏「+」里的「EvoOntology」标签页

## P3：自己变好

- [ ] `workflowEngine` 驱动的进化循环：Builder（产出候选 patch）→ Critic（找反例，只能 browse）→ Evaluator（held-out 题集打分）
- [ ] `ctx.actionCards` 做发布闸门：接受 / 拒绝 / 再跑一轮
- [ ] 预算与停止条件（轮数上限、分数无提升即停）
- 判据：同一批问题，第三轮的答案比第一轮少一次人工纠错，且能指出是哪个机制带来的

## P4：接数据源

- [ ] `DataSourceConnector`：`describe()` 产出可命名的候选列，`query()` 只能只读
- [ ] 把 `evo_resolve` 的骨架变成**可执行**的（当前只是文本骨架）
- [ ] 恢复上游 benchmark 适配器的思路（BIRD / DDR / InsightBench），用 P3 的评测链
- 判据：新接一个数据源不需要改插件代码

## 长期不做

多租户、实时同步、自动改写 SQL、自动接受、把语义正文塞进系统提示。理由见 [architecture.md](architecture.md#7-不做)。
