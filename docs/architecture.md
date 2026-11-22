# 架构

一句话：**一个 SQLite 文件，八个工具，一条命令，三个技能**。没有子进程，没有 Python，没有 MCP 桥。

这份文档描述的是**已经实现的 P0**。设计意图与更远的阶段见 `native-redesign.md`（提案），本文件与代码不一致时以本文件为准。

---

## 1. 定位与归属

| 问题 | 回答 |
|---|---|
| 这个插件解决什么 | agent 面对陌生数据时的「agent–data gap」：列名不等于含义，同一个指标在两份数据里口径不同，答案对不上却没人记得为什么 |
| 它产出什么 | 一个**版本化的语义层**：术语、字段映射、约束、以及支撑它们的证据。可以被检索、被 diff、被回退 |
| 它不做什么 | 不做 ETL、不做数据源同步、不做查询引擎、不做自动应答。它只提供「口径从哪来」 |
| 它住在哪 | 宿主进程内的 Host 插件；真相是 `$DSH_HOME/evoontology/store.db` |
| 谁在用它 | 主 agent 通过 `evo_*` 工具；用户通过 `/evo` 命令；技能通过「何时该用」引导前两者 |

**为什么不做成一个独立的语义服务**：语义层每个会话都在用，但每次用的数据量很小（几十到几百个节点）。跨进程边界换来的隔离收益，抵不过六层失败面（解释器、依赖、路径、协议、超时、版本）的代价。这是一个有意的取舍，不是偷懒。

---

## 2. 分层

```
┌───────────────────────────────────────────────────────────────┐
│  L5 旁路观察  右栏标签页 client.js（只读 /evo 命令的快照）        │
├───────────────────────────────────────────────────────────────┤
│  L4 surface   工具 evo_*   命令 /evo   技能 build/use/evolve   │
│               提示行（systemPrompt.section，一行状态）           │
├───────────────────────────────────────────────────────────────┤
│  L3 语义操作   commit · publish · revert · resolve · diff      │
│               任务闭环 task_start / task_finish · 只读查询     │
├───────────────────────────────────────────────────────────────┤
│  L2 不变量     接地校验 · patch 幂等 · 单 active · 版本不可变   │
├───────────────────────────────────────────────────────────────┤
│  L1 存储      node / edge / evidence / version（node:sqlite）  │
├───────────────────────────────────────────────────────────────┤
│  L0 数据源    evo_query：sqlite 只读 / csv / json 装载          │
│               （worker 线程执行，可被掐断）                      │
└───────────────────────────────────────────────────────────────┘
```

箭头只能往下。P1 起 L0 由本插件接管（`lib/source.js` + `lib/query.js`），因为「证据必须来自能被查到的数据」这条要求不能寄望于宿主恰好有合适工具：执行器只有一条只读路径，authorizer 白名单就是它的全部权限。

L5 在浏览器里，物理上不存在往下的箭头——它只能经 `/evo` 命令拿数据（见 [subsystems/client-sidebar.md](subsystems/client-sidebar.md)）。这不是保守，是边界：前端进程里没有文件系统，也不该有。

---

## 3. 组件职责

| 文件 | 职责 | 不该做的事 |
|---|---|---|
| `index.js` | 把四张座位接起来（工具 / 命令 / 技能 / 提示行），管生命周期 | 不含业务逻辑 |
| `lib/store.js` | 建表、校验、事务、版本状态机、任务与事件 | 不打印、不格式化给人看 |
| `lib/schema.js` | 四类节点的 body JSON Schema + 校验器 | 不碰数据库 |
| `lib/source.js` | 数据源识别与装载（sqlite 只读 / csv / json） | 不执行查询 |
| `lib/query.js` | 语句闸门、worker 超时、行/值上限、文本表 | 不做单位换算 |
| `lib/query-worker.js` | 线程内实际执行 + authorizer 白名单 | 不接触语义层 |
| `lib/tools.js` | 十一个工具的入参声明与人类可读渲染 | 不直接拼 SQL（除只读检索） |
| `lib/command.js` | `/evo` 的子命令分派 | 不实现只有工具才做得好的事（如导出写文件） |
| `lib/skills.js` | 技能发现（前 matter 解析 + on-demand 正文） | 不解释工具清单 |
| `lib/paths.js` | 环境变量 → 路径 | 不建目录（写入处才建） |
| `client.js` | 右栏标签页：版本列表、任务行、版本差异 | 不读数据库、不新增工具、不写死颜色 |
| `skills/*/SKILL.md` | 何时用、判据、禁止事项 | 不复述工具名与参数 |

---

## 4. 四条运行时数据流

**构建（build）**

```
用户给数据 → evo_query 探测（MIN/MAX/COUNT DISTINCT）→ 结论
   → evo_commit(patch{evidence, term, mapping, constraint}) → draft vN
   → 人看 evo_history 的 diff → evo_publish → active vN
```

**使用（use）**

```
用户提问 → evo_task_start(把问题钉在 active 版本上) → evo_resolve(intent)
   → evo_query 跑只读查询（带单位换算）→ 回答 + 说明依赖哪个版本
   → evo_task_finish(答案)
```

**纠正（correct）**

```
发现分歧（记录与数据不符 / 两个答案口径不同）
   → 新 evidence（重跑 probe）→ evo_commit 修正 patch → draft vN+1
   → 人确认 → evo_publish（或 evo_revert 一句话回退）
```

**提示（ambient）**

```
每次会话组装系统提示 → section('evoontology-status')
   → 读缓存的 status（TTL 1.5 s）→ 一行：「本体 v3 · 4 term · 2 mapping …」
   → 没有激活版本时不注入任何文字
```

**旁路观察（panel）**

```
右栏标签页打开/刷新 → /evo status --json → 版本列表 + 计数 + 任务行
   → 点某个版本 → /evo diff <active> <选中> --json → + / - / ~ 分组
   → 全程只读，不经过模型
```

---

## 5. 关键边界

1. **上游语义零改写**：上游 ruc-datalab/EvoOntology 的节点类型与「证据驱动版本」的思路被保留，但实现是重写的——因为它的 27 个 ops 是内部状态机的 RPC 暴露，不是稳定契约。
2. **语义必须接地**：`term` / `mapping` / `constraint` 在 commit 时就必须引用存在的 `evidence`，不是等到 publish 才查。理由：畸形中间态越少越好。
3. **版本不可变 + 单 active**：`version.status ∈ {draft, active, retired}`，靠部分唯一索引 `version_single_active` 让数据库保证「只有一个 active」。回退只改一行 status，因此是零成本的。
4. **数据不出本机**：证据只存 `source` + `probe` + `result` 摘要，不存样本行。导出目录不进版本库。
5. **读与写分开**：所有写语义的路径只有三条（commit / publish / revert）。`evo_query` 是唯一执行器，且永远只读——语义的证据如果可以被写伪造就失去意义。它的权限由 authorizer 白名单表达，不靠自觉。
6. **不进系统提示正文**：系统提示里只有一行状态（版本号、计数、发布距今），语义内容一律按需检索。理由是提示是常驻成本，而语义层可以很大。
7. **浏览器不碰数据库**：面板只能经 Host 的 `/evo` 命令读快照。要在前端直读 `store.db` 就得新开 HTTP 端点，那是另一条信任边界，不值得为一块面板开。

---

## 6. 扩展位

| 想加的东西 | 加在哪 | 代价 |
|---|---|---|
| 一类新节点（如 `unit`） | `lib/schema.js` 加 schema + `KINDS` 加一项 | 不动存储层（表结构是 `kind` + body） |
| 一个新数据源 | P4 的 `DataSourceConnector`（`describe` / `query`） | 需要 authorizer 与行数/超时上限 |
| 新的一条 CLI 子命令 | `lib/command.js` 的 switch | 极低 |
| 面板 | 已实现：右栏标签页经 `/evo` 命令取数（`client.js`） | 浏览器不能直连数据库，所以数据通路必须是命令桥 |
| 自动进化 | P3：Builder/Critic/Evaluator 子角色 + workflow | 需要 held-out 题集与 action card 闸门 |

---

## 7. 不做

- **不做多租户**。一个 `store.db` 服务一个项目；共享语义靠导出/导入。
- **不做实时同步**。本体是版本化的，不是 CRDT。
- **不自动改写 SQL**。改写会引入新的正确性问题，比慢更危险。
- **不把语义正文塞进系统提示**。只注入一行状态（P3），正文按需检索。
- **不做「全自动接受」**。可以全自动提议，不接受全自动生效。
