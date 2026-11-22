---
name: build-ontology
description: 给一份数据集建立/扩充本体层（语义层）。当用户要在某个库、CSV 或表上"反复做分析、口径要稳"，或明确说"建本体 / 建语义层 / 把这些列说清楚"时使用。流程是：先探测真实数据，再把结论作为带证据的节点提交成版本。
whenToUse: 用户提出要为一个数据集建立语义层，或现有语义层缺术语/映射/约束需要补充。
---

# 建本体

本体层不是文档，是**可以被工具检索、被版本控制、被证据约束的资产**。所以这份技能只讲三件事：先看什么、记什么、怎么算记对了。

## 一、先探测，别先命名

列名会骗人。`pkgW` 不一定是瓦，`gpuPct` 可能超过 100。**任何术语在记录之前，必须有一条来自真实数据的证据**。

探测就用 `evo_query`（唯一执行器，只读、单条语句、csv/json 自动装载成表）。每一条你想记下来的判断，都先问：

1. 这个值域和列名一致吗？（算 MIN/MAX/AVG/COUNT DISTINCT）
2. 这个单位能被数据本身证实吗？（比如几千的整数 + 列名 W → 更可能是 mW）
3. 每个取值代表什么？（枚举列的 distinct 值 + 频次）
4. 这份数据和业务对象怎么对上？（一行 = 什么？主键是什么？）

拿不到证据的猜测可以记，但必须记成 `limitation`，不能记成 `constraint`。

## 二、记什么：四类节点

| kind | 记什么 | 必须包含 |
|---|---|---|
| `evidence` | 一条可复跑的观测 | `source`（哪个数据源/表）、`probe`（你跑的查询或命令）、`result`（结论摘要，不是全量数据） |
| `term` | 一个业务概念 | `definition`、单位或口径、`evidence` |
| `mapping` | 字段 → 术语 | `table`、`column`、`term`、必要时 `transform`（如 `value/1000 → W`）、`evidence` |
| `constraint` | 取值规则 | `kind`（unit / range / enum / ratio / pattern）、`subject`（作用在哪个 term 或 mapping 上）、`value`、`evidence` |

节点 id 用稳定前缀：`ev.` / `t.` / `m.` / `c.`，后面跟业务名（`t.package_power`、`m.mon_4b.pkgW`）。id 是版本之间做 diff 的唯一依据，**不要用序号**。

关系用边，不要用节点：`association` / `hierarchy` / `composition` / `equivalence` / `derivation`。边必须是两个已存在节点之间。

## 三、怎么算记对了

- **接地**：`term`、`mapping`、`constraint` 的 `body.evidence` 必须引用同版本的 `evidence` 节点 id。不接地的 patch 会被 `evo_commit` 直接拒绝——这不是形式主义，它保证任何结论都能被复验。
- **一个 patch 一件事**：一次 commit 只做一个连贯的判断（"把 mon_4b 的 8 个列映射清楚"）。这样 publish 前的 diff 可读，出错时能精确回退。
- **幂等**：同样的 patch 重复提交不会产生新版本，所以重试是安全的。
- **提交 ≠ 生效**：`evo_commit` 只产生草稿；`evo_publish` 才切换线上语义。构建阶段先提交、看 diff、再发布。

## 四、顺序

1. `evo_status`：有没有激活版本？已有就先在它上面增量改，不要凭空重建。
2. 探测数据（`evo_query`），**边探边记**：先 3-5 条 evidence，再第一批 term / mapping。
3. `evo_commit` 一个 patch（含 summary 与 limitations）→ 读返回的计数。
4. 继续提交直到覆盖了这份数据的主要列和主要口径。
5. `evo_publish` 激活；`evo_export` 导出一份 Markdown 供人评审。

## 五、不要做

- 不要为了"看起来完整"编造 constraint。空着比编错好。
- 不要把整份数据或样本行写进 `result`——只写能支撑结论的摘要（原则是：数据不出本机，导出的都是语义）。
- 不要在没跑过的情况下写 `probe`。
- 不要用 `relation` 当节点 kind（已废弃，用边）。
- 一个数据集类目数超过几十列时，不要一次全记：先记**用户真正会问的那几列**，其余留待使用中补充。
