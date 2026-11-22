# 原生重设计：如果从零开始，把 EvoOntology 做成 DSH 原生插件

> **状态**：设计提案（proposal）。本文**不描述已发布的代码**，描述的是"如果不受迁移成本约束，我会怎么设计"。
> 已发布实现的契约与边界见 [architecture.md](architecture.md)；本文与它冲突时，本文不是现状，是主张。
>
> **前提**：允许丢弃上游 Python 核心、丢弃 MCP 子进程、丢弃 29 个工具的形状、丢弃五类 `@dataclass`、丢弃现有目录布局、丢弃全部技能文档。
> **不允许丢弃**：它要解决的问题（agent 与数据环境之间的语义鸿沟），以及"版本化 / 可回滚 / 证据接地"这三条性质。

---

## 0. 一句话结论

一个**单进程 TypeScript Host 插件** + 一个**SQLite 本体库** + **三个 subagent 角色** + **一套 12 个工具的面**。

没有 Python，没有子进程，没有手写 JSON-RPC，没有 `save_version` → `annotate` → `publish` 这种三步写协议，没有一个只读面板要绕道命令桥才能拿到数据。

---

## 1. 三条不可让的性质

任何架构决定都要能回答"它服务于哪一条"。回答不了的就是装饰。

| 编号 | 性质 | 违反它的具体后果 |
|---|---|---|
| **P1** | 语义是**项目资产**，不是会话上下文 | 换个会话、换个 agent，同一个"`pkgW` 是 mW 不是 W"要重新推理一遍；上下文一压缩，语义就丢 |
| **P2** | 语义只能被**观察到的数据**接地 | 一旦允许"凭常识推断列含义"，本体层就退化成一篇作文，写错的语义比没有语义更危险（会稳定地错） |
| **P3** | **用法产生证据，证据驱动版本** | 语义无法被证伪，也就无法变好；"自进化"变成"自抖动"——每轮都在改，没有任何一轮可证明更好 |

由 P3 直接推出一条硬约束：**每个结论都要能追到一个可复现的观察，每个版本都要能追到一次可复算的评测**。所以版本必须不可变、评测必须留痕、回滚必须是 O(1)。

---

## 2. 五个架构决定

### D1 · 用 `ctx.tools.register` 而不是 MCP 子进程

**选它**：工具是 Host 进程内的注册项，schema 由 DSH 自己校验与渲染，没有子进程启动、没有 stdout 协议、没有 `PYTHONIOENCODING` 这类环境变量。

**为什么**：当前实现里，`evo` 这一行 MCP 的失败面有六层——`python` 在不在 PATH、`cwd` 里有没有包、`python -m` 能不能 import、有没有 `__pycache__` 写权限、stdio 探测能不能协商成功、JSON-RPC 手写实现有没有边界 bug。每一层都要在文档里写一段"如果这里失败会怎样"。换成进程内注册，前五层直接消失。

**代价**：与上游 Claude Code / Codex 插件不再共享同一份实现。但这个代价是假的——它们共享的只是 `plugin.json` 的**形状**，不是实现；而且它们本来也不共享。

**契约**（方法签名已核对 `ctx.tools`）：

```ts
ctx.tools.register(definition: ToolDefinition, options?: ToolRegistrationOptions): () => void
ctx.tools.restrict(filter: ToolRestriction): () => void   // ← subagent 权限收紧用这个
ctx.tools.guard(guard: ToolGuard): () => void
```

### D2 · 用 `node:sqlite` 而不是一目录 JSON

**选它**：本体存成一个 `store.db`，`node:sqlite` 内置（**本机 Node v24.21.0 已实测可用**，导出 `DatabaseSync / StatementSync / Session / constants / backup`）。

**为什么**：现在的形态是 `versions/<v>/{terms,mappings,relations,constraints,evidence}.json` + `active.json`。这套形态有三个绕不开的痛点：

1. **没有事务**。`active.json` 和 `versions/` 之间没有原子性，进程在中间被杀就得到一个半写版本。
2. **diff 靠自己实现**。而"版本演化"的核心操作就是 diff。
3. **5 个文件之间的引用完整性靠代码自觉**。一条 `relation` 指向不存在的 `term`，只有渲染时才炸。

SQLite 一次给齐：WAL 单写多读、外键、`CHECK` 约束、按版本号做视图、`snapshot` 备份。

**代价**：人不能直接 `cat` 出来看。补一个 `evo_export --format md|json` 工具即可，导出物是**派生物**，不是真相。

### D3 · 用 subagent 而不是主 agent 手搓流程

**选它**：Builder / Critic / Evaluator 是三个独立 subagent，各自有独立的上下文、工具子集、模型选择。

**为什么**：现在的构建流程是"主 agent 读 SKILL.md，然后在对话里一步步调工具"。这有三个结构性问题：

1. **上下文污染**：Builder 见过的数据样本、走过的弯路，全都留在主会话里，压缩一次就丢一次。
2. **评测者不自洽**：让同一个上下文既建本体又判对错，等于让它给自己打分。
3. **不能并行**：Critic 挑刺和 Prober 探数据本来可以同时跑。

**契约**（已核对 `ctx.subagents`）：

```ts
ctx.subagents.registerProvider(provider: SubagentProvider): () => void
ctx.subagents.startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
ctx.subagents.sendMessage(sender, targetId, content, options): Promise<MessageId>
```

配套 `ctx.tools.restrict()` —— Builder 拿写工具，Evaluator **只**拿只读工具，权限是靠服务收紧的，不是靠 prompt 里写"请不要写"。

### D4 · 用 `workflowEngine` 跑循环，而不是插件自己的 `while`

**选它**：进化循环是一张 workflow 图（诊断 → 归因 → 打补丁 → 评测 → 决策），由 `ctx.workflowEngine.start(request)` 驱动。

**为什么**：一轮进化可能跑 20 分钟、十几个子步骤。插件自己维护 `while + 状态文件`，就要自己实现取消、重入、断点、进度上报。而 DSH 的 workflow 已经把这些做完了，并且**落进 session log** —— 意味着进化过程本身是可回放的。

**契约**：`ctx.workflowEngine.start(request: WorkflowStartRequest): WorkflowRun`（签名已核；`request` 的具体字段形状以 workflow 服务的 Provider 文档为准，本文不臆造）。

### D5 · 版本不可变 + 单行激活指针

**选它**：`version` 表只有 `draft / active / retired` 三种状态，并且用**数据库约束**保证"任何时刻最多一个 active"：

```sql
CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status = 'active';
```

**为什么**：现在的 `active.json` 是"一个文件写着当前版本号"，正确性完全靠写到它的那段代码。放在索引里，任何路径想制造两个 active 都会被数据库拒绝——包括将来别人写的、你没想到的路径。

回滚从"重建一个版本"变成"改一行的 status"，这是 P3 要的 O(1)。

---

## 3. 分层

```
┌──────────────────────────────────────────────────────────────────────┐
│ L4  Surface                                                          │
│   tools(12)   skills(3)   commands(/evo)   systemPrompt(manifest)    │
│   right sidebar tab   action cards   plugin page   settings card     │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 只通过服务调用
┌──────────────────────────────────────────────────────────────────────┐
│ L3  Orchestration                                                    │
│   workflowEngine 图:  build → probe → commit → evaluate → publish    │
│                      evolve → diagnose → attribute → patch → judge   │
│   subagents:  Builder(写)  Critic(挑刺,只读)  Evaluator(只读+只跑题)  │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 纯函数 + 事务
┌──────────────────────────────────────────────────────────────────────┐
│ L2  Reasoning                                                        │
│   resolve(intent) → 接地载体(mapping + constraint + 查询骨架)          │
│   browse(term)    → 相关对象 + 证据                                   │
│   diff(v1,v2)     → 语义变化                                          │
│   validate(patch) → schema / 引用完整性 / 接地性                      │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 事务边界
┌──────────────────────────────────────────────────────────────────────┐
│ L1  Ontology Store   store.db (SQLite, WAL, FK, 单 active 约束)       │
│     version · node · edge · evidence · question · task · evaluation   │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ 适配器
┌──────────────────────────────────────────────────────────────────────┐
│ L0  Data Access   DataSourceConnector（每源一个实现）                  │
│     sqlite(内置)  csv/parquet(node:fs + 流式)  http  host-tool(桥)     │
│     契约: describe() 只读 · query(sql|plan) 只读 · 行数/字节/超时上限  │
└──────────────────────────────────────────────────────────────────────┘
```

**一条硬规矩**：箭头只能往下。L4 不许碰 store，L2 不许碰 connector 之外的 IO，L0 不许认识"本体"这个概念。

---

## 4. 数据模型 v2

```sql
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- schema_version · created_at

CREATE TABLE version (
  id          TEXT PRIMARY KEY,              -- 'v0', 'v1', ...
  parent_id   TEXT REFERENCES version(id),   -- 演化来源，可为空（v0）
  status      TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
  summary     TEXT NOT NULL DEFAULT '',
  limitations TEXT NOT NULL DEFAULT '[]',    -- JSON array
  metrics     TEXT NOT NULL DEFAULT '{}',    -- JSON，评测快照
  created_by  TEXT NOT NULL,                 -- 'builder:<run_id>' | 'user'
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status = 'active';

CREATE TABLE node (
  version_id TEXT NOT NULL REFERENCES version(id) ON DELETE CASCADE,
  node_id    TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('term','mapping','relation','constraint','evidence')),
  label      TEXT NOT NULL,
  body       TEXT NOT NULL,                  -- JSON，形状由 kind 决定（JSON Schema 校验）
  PRIMARY KEY (version_id, node_id)
);

CREATE TABLE edge (                          -- 语义连接，五种受控类型
  version_id TEXT NOT NULL,
  src        TEXT NOT NULL,
  dst        TEXT NOT NULL,
  type       TEXT NOT NULL CHECK (type IN ('association','hierarchy','composition','equivalence','derivation')),
  note       TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (version_id, src, dst, type),
  FOREIGN KEY (version_id, src) REFERENCES node(version_id, node_id) ON DELETE CASCADE,
  FOREIGN KEY (version_id, dst) REFERENCES node(version_id, node_id) ON DELETE CASCADE
);

CREATE TABLE evidence (                      -- 可复现的观察，node(kind=evidence) 是它的陈述面
  version_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  source     TEXT NOT NULL,                  -- 'sqlite:mon_4b#mon_4b.pkgW'
  probe      TEXT NOT NULL,                  -- 可重跑的查询/命令
  result     TEXT NOT NULL,                  -- 结果摘要（不是全量数据）
  digest     TEXT NOT NULL,                  -- 结果哈希，用于判断"证据是否仍然成立"
  created_at TEXT NOT NULL,
  PRIMARY KEY (version_id, evidence_id)
);

CREATE TABLE question (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  origin      TEXT NOT NULL CHECK (origin IN ('user','history','generated')),
  provenance  TEXT NOT NULL DEFAULT '[]',
  split       TEXT NOT NULL DEFAULT 'construction' CHECK (split IN ('construction','validation','heldout')),
  data_source TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE task (
  id            TEXT PRIMARY KEY,
  question_id   TEXT NOT NULL REFERENCES question(id),
  version_id    TEXT NOT NULL REFERENCES version(id),
  session_id    TEXT,                        -- DSH session：轨迹天然可回放，不再自建 trajectories/
  status        TEXT NOT NULL CHECK (status IN ('running','completed','failed','interrupted')),
  final_answer  TEXT,
  started_at    TEXT NOT NULL,
  ended_at      TEXT
);

CREATE TABLE event (                         -- append-only，一次工具调用一行的真相
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,                    -- 客户端生成，保证重试幂等
  seq      INTEGER NOT NULL,
  tool     TEXT NOT NULL,
  args     TEXT NOT NULL,
  result   TEXT NOT NULL,
  error    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, event_id)
);

CREATE TABLE evaluation (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,                 -- 'v0' | 'v1@round3'
  role        TEXT NOT NULL CHECK (role IN ('parent','candidate','judge')),
  question_id TEXT,
  metrics     TEXT NOT NULL,                 -- JSON
  verdict     TEXT NOT NULL CHECK (verdict IN ('pass','fail','uncertain')),
  created_at  TEXT NOT NULL
);

CREATE TABLE run (
  id                TEXT PRIMARY KEY,
  parent_version    TEXT NOT NULL REFERENCES version(id),
  candidate_version TEXT,
  status            TEXT NOT NULL CHECK (status IN ('running','accepted','rejected','incomplete')),
  round             INTEGER NOT NULL DEFAULT 0,
  budget            INTEGER NOT NULL,
  end_reason        TEXT,
  started_at        TEXT NOT NULL,
  ended_at          TEXT
);
```

四个设计要点：

1. **`node` 用一张表装五类**，不像现在拆成五个 JSON 文件。`kind` 只影响 `body` 的 schema 校验，不制造五套存储代码。
2. **`edge` 是语义连接**，`relation` 这个 `kind` 不再需要——它原本就是在表达"边"。少一类节点，就少一套校验、少一处"这两个东西到底哪个是节点哪个是边"的歧义。
   > 如果你更想保住上游的"五类节点"心智模型，保留 `kind='relation'` 也行，但必须只允许 `relation` 出现在 `edge` 里，不能又当节点又当边。
3. **`evidence.digest`** 是 P2 的落点：数据变了、digest 对不上，相关语义自动标记为"待复核"。这是"接地"从口号变成机制的唯一办法。
4. **`task.session_id`** 指向 DSH session。轨迹不再由插件自己写 JSON，直接读 `ctx.sessionQuery.readSession(sessionId)` / `listEvents(sessionId)` —— 那里已经是完整、有序、可回放的真相。

---

## 5. 工具面：12 个

少不是目的，**少到每个都有唯一职责**才是目的。当前 29 个工具里，有 9 个是"进化运行的十几种状态转移各开一个"，那本质是 RPC 暴露了内部状态机。

| # | 工具 | 职责 | 写？ | 闸门 |
|---|---|---|---|---|
| 1 | `evo_status` | 激活版本、计数、最近 run、待决闸门 | — | — |
| 2 | `evo_browse` | 关键词 → 语义对象 + 证据（分页） | — | — |
| 3 | `evo_resolve` | 分析意图 → 接地载体（mapping + constraint + 查询骨架） | — | — |
| 4 | `evo_history` | 版本时间线；`diff(from,to)` | — | — |
| 5 | `evo_commit` | 提交 patch → 生成 draft 版本；`patch_hash` 幂等 | ✅ | — |
| 6 | `evo_publish` | 校验 + 激活 draft | ✅ | **人工** |
| 7 | `evo_revert` | active 指回历史版本 | ✅ | **人工** |
| 8 | `evo_export` | 导出为 Markdown / JSON（派生物） | — | — |
| 9 | `evo_task_start` | 开题（问题文本或 `question_id`） | ✅ | — |
| 10 | `evo_query` | 只读 SQL（authorizer + 行数/字节/超时上限） | ✅ | — |
| 11 | `evo_task_finish` | 落答案 + 自动评测（若该题有判定器） | ✅ | — |
| 12 | `evo_evolve` | 启动/推进一轮进化 | ✅ | 启动=人工 |

**为什么写路径是三条（commit / publish / revert）而不是现在的 27 条 ops**：

- `commit` 接 patch（增删改节点与边），一次事务落一个 draft。现在要 `save_version` 写 5 个文件、再 `annotate` 补 summary/limitations/links——两步之间失败就得到一个"有内容但没注解"的畸形版本。
- `publish` 只做一件事：校验 + 切 active。**校验失败不允许部分成功**。
- `revert` 是 D5 的直接收益，改一行 status。

**为什么 `evo_query` 只读**：所有语义的正确性最终都要落在"数据能答出这个问题"上。如果查询能写，本体层的证据就可以被伪造。

**工具数对 prompt 成本的影响**：每个工具在系统提示里是一段 schema 描述。29 个工具 ≈ 6–8K token 常驻，且大部分时间用不到。12 个工具里 `evo_evolve` 那种长周期动作，schema 只保留"启动"和"查询进度"两个入参，其余状态由 `evo_status` 呈现。

---

## 6. 编排：三个角色，两条信号通路

```
                    ┌───────────────┐
   construction     │   Builder     │  写工具: read/browse/commit
   workload ───────▶│  (subagent)   │  产出: patch(vN → vN+1 draft)
                    └───────┬───────┘
                            │ patch
                    ┌───────▼───────┐
                    │   Critic      │  只读: browse + evidence
                    │  (subagent)   │  产出: 质疑清单（未接地/过度概括/自相矛盾）
                    └───────┬───────┘
                            │ 驳回 or 放行
                    ┌───────▼───────┐
   heldout         │  Evaluator    │  只读: 问题 + 候选输出
   questions ─────▶│  (subagent)   │  产出: evaluation 行（pass/fail/uncertain）
                    └───────┬───────┘
                            │ metrics
                    ┌───────▼───────┐
                    │  Human gate   │  action card: accept / reject / inspect diff
                    └───────────────┘
```

三条设计规矩：

1. **Builder 只产出 patch，不产出整版**。整版重写会让 diff 变成"全部替换"，评审就失去了抓手。
2. **Critic 与 Builder 不共享上下文**。Critic 拿到的是 `patch + 该 patch 引用的 evidence`，拿不到 Builder 的推理过程。**这是给"作者偏见"设的物理隔离**。
3. **Evaluator 只看题和输出，不看本体**。它一旦看到本体结构，就会开始"理解设计意图"，评测立刻失去独立性。它通过工具权限（`ctx.tools.restrict`）被限制成"只读 + 只能跑题"。

**人类闸门用 action card，不用聊天里问一句**。理由：聊天里问的同意无法被审计、无法被延后处理、换个客户端就丢了。`ctx.actionCards.register(kind)` + `act(callId, verb, payload)` 是 DSH 的既有机制，同意/拒绝/回滚各是一个 verb，落进 session log。

---

## 7. 原生落点清单

"原生"不是"用 DSH 的 API"，而是**每个能力都长在 DSH 提供的对应座位上**，而不是自己在旁边搭一个。

| 能力 | DSH 座位 | 本设计 |
|---|---|---|
| 模型能调的动作 | `ctx.tools` | 12 个 `evo_*` 工具 |
| 何时该用 | `ctx.skills` | 3 个技能（建 / 演进 / 浏览），只写时机，不写实现 |
| 人手动触发 | `ctx.commands` | `/evo`（`status` / `open` / `revert`） |
| 常驻线索 | `ctx.systemPrompt.section` | **一行**：当前版本号 + 节点数 + 是否有待决闸门 |
| 会话边界内的可见性 | `ctx.systemPrompt.context` | 仅当本会话绑定了工作区才注入 |
| 长周期流程 | `ctx.workflowEngine` | 进化图 |
| 子角色 | `ctx.subagents` | Builder / Critic / Evaluator |
| 危险动作同意 | `ctx.actionCards` + `ctx.approval` | publish / revert / evolve-start |
| 轨迹 | `ctx.sessionQuery` | 直接读 session log，不自建 |
| 面板 | `ctx.sidebarRightTabs` + `ctx.slots` | 右侧栏 tab（沿用 v0.2 的座位） |
| 节点详情 | 资源类型（`dsh-resource://<type>/...`） | 点一个 term 在右栏开成文档页 |
| 配置 | `Config` schema + settings card | `storePath` / `dataSources` / `judgeModel` / `budgetRounds` / `maxRows` |
| 存储 | `store.db`（`node:sqlite`） | 唯一的真相文件 |

**关于 `systemPrompt.section`**：当前实现刻意没用它（同层重名会抛错）。原生化之后仍然要克制——**只有一行**。把语义层全塞进系统提示，等于把"按需检索"退回"全量注入"，那是 2023 年的做法。

---

## 8. 存储布局

```
$DSH_HOME/evoontology/
  store.db            # 唯一真相（WAL + 两个 -wal/-shm 附属文件）
  runs/<run_id>/      # 每次进化的产物：patch.json · diff.md · report.json
  exports/            # evo_export 的派生物，可随时删
  cache/              # connector 的查询缓存，可随时删
  viz/                # 派生的可视化 HTML，可随时删
```

规矩：**只有 `store.db` 和 `runs/` 是不可重建的**。`exports/`、`cache/`、`viz/` 删掉都能再生成——所以"清干净"的语义是"删掉后面三个目录不影响任何结论"。

---

## 9. 安全与边界

| 面 | 做法 |
|---|---|
| 数据源只读 | connector 只暴露 `describe` / `query`，SQLite 用 `mode=ro` + authorizer 白名单（只放行 SELECT / READ / FUNCTION / RECURSIVE，禁 attach、pragma、`load_extension`） |
| 资源上限 | 行数 100（截断即标记 `truncated`）、单值 1MB、语句 5s、结果 256KB |
| 数据不出本机 | 证据只存**摘要 + digest + 可重跑的查询**，不存样本行；导出目录不进版本库 |
| 数据里的提示注入 | **数据读出来一律是数据**。`evo_query` 的结果不参与"下一步该调什么"的决策，只参与"这条证据成立不成立"的判定 |
| 写操作 | `publish` / `revert` / `evolve` 走 approval；`commit` 只写 draft，不改变线上语义 |
| 越界写 | connector 的 `query` 之外，插件**不写**用户数据目录；`store.db` 在 `$DSH_HOME` 下，与用户项目隔离 |

---

## 10. 失败模式与对策

写设计文档最有价值的部分是这张表——它逼你说清"哪里会坏"。

| # | 失败 | 表现 | 对策 |
|---|---|---|---|
| 1 | 数据变了 | 证据 digest 对不上 | 相关节点自动标 `stale`，`evo_resolve` 返回时带警告；不静默使用 |
| 2 | 两个进程同时 commit | 版本号冲突 | 版本号由 `version` 表事务内自增；冲突方重试（patch 是幂等的） |
| 3 | draft 永久悬挂 | 一堆没人 publish 的 draft | `evo_status` 把超过 N 天的 draft 列为"待清理"，提供 `evo_commit --discard` |
| 4 | 进化无收益但一直跑 | 预算烧完、版本没变好 | 每轮必须先算 parent 基线，**没有基线不允许提候选**（无基线=不可判定） |
| 5 | 评测被优化 | metrics 涨、真实变差 | held-out 题不对 Builder 可见；`evaluation.role='judge'` 单独记录，与 candidate 分数分列 |
| 6 | 本体膨胀 | 节点数上千，resolve 变慢 | 节点必须有 `workload` 引用（每个节点回答"哪类问题需要它"），无引用节点在 publish 时降级为 `retired` |
| 7 | 查询超时 | 大表全扫 | 5s 上限 + `truncated` 标记 + 建议 `LIMIT`；不做自动改写（自动改写 SQL 会制造新的正确性问题） |
| 8 | 模型换了判定标准漂移 | 同一题两轮判定不同 | 评测记录 `judgeModel` + prompt 版本；换判定器 = 新的一条 `evaluation` 基线，不覆盖旧的 |
| 9 | 用户卸载 | 数据留下 | 只有 `store.db` + `runs/` 需要用户决定去留，其余可删；README 写一条命令 |
| 10 | 数据源不可达 | connector describe 失败 | 降级为"只能用已有证据"，`evo_resolve` 明确标注"当前不可复验" |

---

## 11. 分阶段交付

每阶段独立可用，不做"大爆炸"。

| 阶段 | 交付 | 判定完成的标准 |
|---|---|---|
| **P0** | `store.db` + schema + `evo_commit`/`evo_publish`/`evo_status` | 能在没有 agent 的情况下用 CLI 建一个版本、激活、回滚 |
| **P1** | 12 个工具全量 + `evo_query` 的 authorizer | 一次完整"开题 → resolve → query → finish"落库，轨迹可回放 |
| **P2** | 右侧栏 tab 直连 `store.db`（不再绕命令桥）+ 节点资源页 | 面板与 `evo_status` 返回一致；点节点能开文档页 |
| **P3** | Builder/Critic/Evaluator + 进化 workflow + action card 闸门 | 一轮进化能产出 parent/candidate 两组评测，且人能 accept/reject |
| **P4** | 多数据源 connector（csv/parquet/http/host-tool） | 换一个非 SQLite 源，P1 的流程不用改代码 |

**P0 之前先做的事**：把这份文档里"待核"的三处查清并补进文档。**文档里留着"待核"，代码就不许先写**。

### 待核结论（2026-11-22 已查清）

| 待核项 | 结论 |
|---|---|
| `ToolDefinition` 的只读/危险注解 | **不存在**。`ctx.tools` 的方法只有 `register/restrict/get/executable/resolve/definitions/schemas/setExecutor/execute/guard/checkGuards`，字段只有 `output / execute / timeoutMs / isConcurrencySafe / presentCall / presentResult / projectContent / finalizeContent`。只读性只能靠实现自觉 + `ctx.approval` / `ctx.actionCards` 这类独立座位表达。→ P3 的"Critic 只能 browse"要靠 `ctx.tools.restrict` 而不是注解。 |
| 资源类型注册服务名 | Host Service 目录里**没有** resource/resources 服务（`actionCards` / `approval` / `systemPrompt` / `workflowEngine` 是相邻的 key）。`dsh-resource://` 属 client 侧，P2 才需要，届时查 `docs/subsystems/client-resources.md`。 |
| `WorkflowStartRequest` 字段 | 仍未展开（P3 才用到）；`ctx.workflowEngine.start(request): WorkflowRun` 的签名已核，字段以 workflow 服务文档为准。 |
| `node:sqlite` 可用性 | Node v24.21.0 提供 `DatabaseSync / StatementSync / Session / constants / backup`；Host 进程本身就是 Electron 44.7 + Node 24，进程内可用。→ D2 成立。 |


---

## 12. 与现状的对照：删什么，为什么

| 现状 | 原生化之后 | 为什么删 |
|---|---|---|
| Python 核心 + `python -m evoontology.runtime.mcp_server` | 进程内 TS | 六层失败面变成一层 |
| 手写 JSON-RPC stdio（`mcp_server.py`） | 不存在 | 没有跨进程边界 |
| 29 个工具 | 12 个 | 内部状态转移不该成为对外契约 |
| `save_version` → `annotate` → `publish` 三步 | `commit` → `publish` 两步（注解随 patch 走） | 减少畸形中间态 |
| 五类节点拆 5 个 JSON 文件 | 一张 `node` 表 + `kind` | 少五套读写/校验代码 |
| `active.json` | `version.status` + 唯一索引 | 让数据库保证"只有一个 active" |
| 自建 `trajectories/*.json` | `task.session_id` + session log | 轨迹已经有真相源，别再抄一遍 |
| 主 agent 在对话里手搓构建 | Builder/Critic/Evaluator subagent | 上下文隔离 + 权限收紧 + 可并行 |
| 右栏面板走 Host 命令桥拿 JSON | 面板直接读 `store.db`（Host Remote） | 少一跳，少一个"命令返回形状"契约 |
| 技能文档里手写 29 个工具名 | 技能只写时机与判断，工具名由 `ctx.tools` 目录自然可见 | 文档与工具面解耦，改名不用改 14 个 md |
| 5 类节点 dataclass 固定 | `kind` + 每 kind 一份 JSON Schema | 扩展一类节点 = 加一个 schema 文件，不动存储层 |

**保留不动的三样**：`EvolutionAdapter` 的评测接口形状（它是对的）、只读 SQL 的 authorizer 策略（它是对的）、右侧栏的座位选择（它是对的）。

---

## 13. 明确不做

1. **不做多租户**。一个 `store.db` 服务一个项目；要共享语义就导出/导入，不做权限模型。
2. **不做实时同步本体**。本体是版本化的，不是 CRDT。
3. **不自动改写用户的 SQL**。改写会引入新的正确性问题，比慢更危险。
4. **不让 Builder 看 held-out**。哪怕用户要求"就这一次"。
5. **不在系统提示里注入语义正文**。只注入一行状态；正文靠 `evo_browse` / `evo_resolve` 按需取。
6. **不做"全自动接受"**。进化可以全自动**提议**，不接受全自动**生效**。
7. **不承诺跨数据源语义可迁移**。同一概念在两个源里的粒度可能不同，那本身就是需要记录的语义，不是需要抹平的差异。
