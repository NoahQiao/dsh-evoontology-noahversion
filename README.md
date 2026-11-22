# dsh-evoontology-noahversion

给 DeepSeek Harness 的原生语义层插件：让 agent 在陌生数据上**不靠猜列名**，并且把「口径」变成可 diff、可回退、有证据的资产。

思路来自 [ruc-datalab/EvoOntology](https://github.com/ruc-datalab/EvoOntology)（人大 DataLab，MIT，arXiv 2609.15779）。本仓库是**原生重写**，不是移植：没有 Python，没有 MCP 子进程，没有随包的核心副本。

```
语义 = 版本化的四类节点（术语 / 字段映射 / 约束 / 证据）
     + 一个 SQLite 文件（$DSH_HOME/evoontology/store.db）
     + 11 个工具 + 1 条命令 + 3 个技能 + 1 行系统提示
```

设计文档见 [`docs/`](docs/README.md)，当前状态见 [roadmap](docs/roadmap.md)。

## 为什么需要它

拿本机的 `mon_4b.csv` 举例（20 行，4B 模型推理的资源轨迹）：

| 列 | 字面理解 | 实际 |
|---|---|---|
| `pkgW` | 「封装，瓦」 | 27 927 这个量级不可能是瓦，是 **mW**（27.9–36.6 W） |
| `gpuPct` | 「GPU 占比 %」 | 出现 177.5 和 143.6，**超 100** ——它是相对基线的倍数 |

两次分析之间没人记得这些，下一个 agent 还会按列名猜一遍。语义层就是把这些结论连同「你凭什么这么说」（一条可复跑的查询）一起存下来，下次直接用。

## 安装

```powershell
# 在 DSH 里（不是 shell）
plugin_manager action=install_bundle target=D:\dsworkspace\dsh-evoontology-noahversion
```

`application: applied` 即生效：工具、`/evo` 命令、三个技能当场可用。
（替换已安装的**同一个包**的 JS 实现时才需要重启 DSH。）

卸载与清理：

```powershell
plugin_manager action=remove_bundle target=@noah/dsh-evoontology
# remove_bundle 不删这两样，手动清：
Remove-Item -Recurse -Force "$HOME\.dsh\profiles\desktop\node_modules\@noah\dsh-evoontology"
Remove-Item -Recurse -Force "$HOME\.dsh\evoontology"
```

## 怎么用

三个技能就是三条使用说明书（`build-ontology` / `use-ontology` / `evolve-ontology`），agent 会在合适的时机自动加载。工具层面的骨架：

**建一次**（对一份数据）

```
1. 用宿主工具探测数据（SELECT MIN/MAX/COUNT DISTINCT，读几行样本）
2. evo_commit({summary, nodes:{upsert:[
       证据  {id:'ev.pkgW', kind:'evidence', body:{source, probe, result}},
       术语  {id:'t.package_power', kind:'term', body:{definition, unit, evidence:['ev.pkgW']}},
       映射  {id:'m.mon_4b.pkgW', kind:'mapping', body:{table, column, term, transform:'value/1000 → W', evidence:['ev.pkgW']}},
       约束  {id:'c.gpuPct.ratio', kind:'constraint', body:{kind:'ratio', subject:'m.mon_4b.gpuPct', value:'baseline multiple', evidence:['ev.gpuPct']}}
   ]}})
3. evo_history({from:'v0', to:'v1'}) 看 diff
4. evo_publish()   ← 人确认这一步
```

**每次分析**（同一份数据）

```
1. evo_status()                      看有没有激活版本
2. evo_task_start({question:'pkgW 换算成瓦后的均值是多少'})
   → 把问题钉在当前激活版本上；之后的每次查询都自动记进这个任务
3. evo_resolve({intent:'pkgW 换算成瓦后的均值'})
   → 命中映射 + 约束 + 只读查询骨架（带单位换算）
4. evo_query({source:'D:\\data\\mon_4b.csv', sql:'SELECT AVG(pkgW)/1000 AS avg_w FROM mon_4b'})
   → 只读、单条、最多 100 行、5 秒上限
5. evo_task_finish({answer:'平均 31.9 W（依赖 v1 的 c.unit.mW）'})
```

**发现记录不对**（数据变了 / 记错了）

```
新证据 + 修正 patch → evo_commit → draft vN+1 → 人确认 → evo_publish
                                    或 evo_revert({version:'vN-1'}) 一句话回退
```

命令行等价物：`/evo status`、`/evo versions`、`/evo diff v0 v1`、`/evo publish v1`、`/evo revert v0`、`/evo discard v2`（删草稿）、`/evo export`、`/evo path`。

## 十一个工具

| 工具 | 作用 | 写 |
|---|---|---|
| `evo_status` | 激活版本、五类计数、草稿（含超 7 天悬挂）、最近 run、任务统计、版本列表 | |
| `evo_browse` | 关键词 → 节点 + 证据 | |
| `evo_resolve` | 意图 → 映射/约束/查询骨架 | |
| `evo_history` | 版本时间线 / 两个版本之间的节点级差异 | |
| `evo_query` | 唯一只读执行器：一条 `SELECT`/`WITH`，sqlite / csv / json | |
| `evo_task_start` | 把「这次要回答什么」钉在已发布版本上 | ✅ |
| `evo_task_finish` | 收尾任务（幂等） | ✅ |
| `evo_commit` | patch → 草稿版本（幂等、接地校验、`base` 乐观并发） | ✅ |
| `evo_publish` | 激活草稿（旧的转 retired） | ✅ |
| `evo_revert` | 回到历史版本（零成本） | ✅ |
| `evo_export` | 导出 Markdown / JSON 到 `exports/` | 派生物 |

写路径只有三条（commit / publish / revert）。`evo_query` 的只读性是**执行层**保证的：文本闸（只放 `SELECT`/`WITH`）+ authorizer 白名单（`SELECT`/`READ`/`FUNCTION`/`RECURSIVE`），契约见 [docs/subsystems/query.md](docs/subsystems/query.md)。

## 右栏面板

右栏「+」里的 **EvoOntology** 标签页：激活版本与五类计数、版本列表（点一个版本就和激活版本对比，出 `+ / - / ~`）、任务进行中/完成/失败、存储路径。

它不经过模型，也不读数据库——数据是经 Host 的 `/evo status --json` 与 `/evo diff <from> <to> --json` 拿的快照。契约见 [docs/subsystems/client-sidebar.md](docs/subsystems/client-sidebar.md)。

```
/evo status          人读的六行摘要
/evo status --json   面板用的结构化快照
/evo diff v1 v2      两个版本之间改了什么
```

## 不变量

- **语义必须接地**：`term` / `mapping` / `constraint` 必须引用存在的 `evidence`，commit 时就校验。
- **版本不可变 + copy-on-write**：新版本是全量快照，所以 diff 是两次 SELECT 的事，读路径不递归。
- **单 active 由数据库保证**：`CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status='active'`。
- **patch 幂等**：`version_patch_hash` 唯一索引——同样的 patch 重复提交不会产生新版本。
- **多草稿时不许猜**：`evo_publish` 无参且有两个草稿会拒绝，要求指定 `vN`。

## 仓库结构

```
index.js              把四张座位接起来（tools / commands / skills / 提示行）
lib/paths.js          环境变量 → 路径（不建目录）
lib/schema.js         四类节点的 body JSON Schema + 校验器
lib/store.js          SQLite：DDL、事务、版本状态机、接地校验、任务与事件
lib/source.js         数据源识别与装载（sqlite 只读 / csv / json）
lib/query.js          语句闸门、worker 超时、行/值上限、文本表
lib/query-worker.js   线程内执行 + authorizer 白名单
lib/tools.js          十一个工具的入参声明与渲染
lib/command.js        /evo 子命令
lib/skills.js         技能发现（front matter + on-demand 正文）
client.js             右栏标签页（经 /evo 命令取数，不碰数据库）
skills/*/SKILL.md     建 / 用 / 演进三份判据
cordis.patch.yml      一行 insert
docs/                 架构、子系统契约、ADR、路线图
```

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_EVOONTOLOGY_STORE` | `<DSH_HOME>/evoontology/store.db` | 换一个 store 文件（多项目用） |
| `DSH_EVOONTOLOGY_HOME` | `<DSH_HOME>/evoontology` | `runs/`、`exports/`、`cache/`、`viz/` 的父目录 |

数据不出本机：只存证据摘要（`probe` + 结论）与语义，不存样本行。

## 验证记录

**已离线验证（无头，不依赖 GUI）**

- `scripts/_check-store.mjs`：15 项存储不变量——空库、接地拒绝、v0 落地、patch 幂等、publish、计数、v1 copy-on-write 继承、`base` 乐观并发、唯一 active、revert、草稿不能 revert、悬空边拒绝、`relation` 拒绝、检索、discard。
- `scripts/_check-plugin.mjs`：62 项端到端——十一个工具注册与渲染、空库 status、未激活时 browse 的解释、commit 幂等、缺证据引用被拒、单草稿 publish、多草稿拒绝猜、diff、Markdown/JSON 导出、`/evo` 子命令、三个技能加载、注销后座位清空、无多余日志。
- `scripts/_check-client.mjs`：33 项面板——模块 id、`inject` 列表、两次注册的 id 一致（写错会白屏）、三态渲染、点版本触发 `/evo diff`、差异分组、样式无颜色字面量、无弹窗 API。
- `scripts/_check-query.mjs`：55 项 P1 面——语句闸门 11 项（含 `SELECT ';'` 通过、`SELECT 1; DROP TABLE t` 拒绝）、csv 引号/转义/分号、类型推断、sqlite 写入被 authorizer 拒、行数上限、聚合、缺表提示、5 s 内超时、超长 cell 截断、任务闭环（无激活版本拒绝开任务、同会话只允许一个 running、被拒的查询也记事件、finish 幂等、跨会话隔离）、`/evo status|diff`、提示行（单行、含版本号、1.5 s 缓存、无激活版本时不注入）、dispose 清座位。
- `node --check` 十个模块全部通过；`package.json` 与两份 locale JSON 解析通过。

**已装机验证（2026-11-22）**

- `plugin_manager install_bundle` → `application: applied`，无需重启：`evo_*` 工具与 `/evo` 立即出现在会话里；技能目录立刻多出 `build-ontology` / `use-ontology` / `evolve-ontology`。
- 首次 `evo_status` 返回：`存储：C:\Users\Noah_Qiao\.dsh\evoontology\store.db（schema 2）`、`激活版本：无`、`草稿：无`。
- Electron 进程内 `node:sqlite` 可用（`24.21.0 / 44.7.0`），宿主不需要额外运行时。

**待验证**

- P1 的验收判据：「建完一次语义层后，第二次分析同一份数据时不读原始 schema 也能写对查询」——需要一次真实的两轮对话。
- 提示行在真实会话里的组装位置（`order: 62` 是否与相邻 section 冲突）。
- 右栏标签页在真实宿主里的渲染：座位派发、主题 token、`keepMounted` 的保持。离线自检只能证明渲染逻辑与数据通路，证不了 React 调度。
- 完整「建 → 用 → 纠正」循环在真实数据上的手感（尤其 `evo_resolve` 骨架在真实提问下的命中率）。

## 已知限制

- **超时会漏一个文件句柄**：`node:sqlite` 没有 `interrupt`，只能说杀掉查询线程；线程被杀时它持有的 sqlite 只读句柄不会被回收，直到 DSH 重启。csv/json 不受影响。见 [docs/subsystems/query.md](docs/subsystems/query.md)。
- **面板是只读的**：能看版本、计数、差异，不能改；发布仍需模型调用 `evo_publish` 或 `/evo publish`。差异只到节点级（`kind` + label），evidence 的 `probe` 摘要还没进面板（见 [roadmap](docs/roadmap.md) P2 的「部分达成」）。
- **没有自动进化**：Builder / Critic / Evaluator 与 held-out 评测是 P3。技能里明确写了「不要假装有」。
- **单机单写者**：SQLite 不支持多写者并发；一个 store 服务一个项目。

## 许可

MIT。上游版权归 Meiduo Chong、Shaole Zhang、Ju Fan、Xiaoyong Du（人大 DataLab）；本仓库的重写由 Noah Qiao 维护。
