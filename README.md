# dsh-evoontology-noahversion

给 DeepSeek Harness 的原生语义层插件：让 agent 在陌生数据上**不靠猜列名**，并且把「口径」变成可 diff、可回退、有证据的资产。

思路来自 [ruc-datalab/EvoOntology](https://github.com/ruc-datalab/EvoOntology)（人大 DataLab，MIT，arXiv 2609.15779）。本仓库是**原生重写**，不是移植：没有 Python，没有 MCP 子进程，没有随包的核心副本。

```
语义 = 版本化的四类节点（术语 / 字段映射 / 约束 / 证据）
     + 一个 SQLite 文件（$DSH_HOME/evoontology/store.db）
     + 8 个工具 + 1 条命令 + 3 个技能
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
2. evo_resolve({intent:'pkgW 换算成瓦后的均值'})
   → 命中映射 + 约束 + 只读查询骨架（带单位换算）
3. 用宿主工具跑查询，回答里写明依赖 v3 的哪条约束
```

**发现记录不对**（数据变了 / 记错了）

```
新证据 + 修正 patch → evo_commit → draft vN+1 → 人确认 → evo_publish
                                    或 evo_revert({version:'vN-1'}) 一句话回退
```

命令行等价物：`/evo status`、`/evo versions`、`/evo diff v0 v1`、`/evo publish v1`、`/evo revert v0`、`/evo discard v2`（删草稿）、`/evo export`、`/evo path`。

## 八个工具

| 工具 | 作用 | 写 |
|---|---|---|
| `evo_status` | 激活版本、五类计数、草稿（含超 7 天悬挂）、最近 run、版本列表 | |
| `evo_browse` | 关键词 → 节点 + 证据 | |
| `evo_resolve` | 意图 → 映射/约束/查询骨架 | |
| `evo_history` | 版本时间线 / 两个版本之间的差异 | |
| `evo_commit` | patch → 草稿版本（幂等、接地校验、`base` 乐观并发） | ✅ |
| `evo_publish` | 激活草稿（旧的转 retired） | ✅ |
| `evo_revert` | 回到历史版本（零成本） | ✅ |
| `evo_export` | 导出 Markdown / JSON 到 `exports/` | 派生物 |

写路径只有三条。`evo_query`（只读执行器）在 P1，见 [roadmap](docs/roadmap.md)。

## 不变量

- **语义必须接地**：`term` / `mapping` / `constraint` 必须引用存在的 `evidence`，commit 时就校验。
- **版本不可变 + copy-on-write**：新版本是全量快照，所以 diff 是两次 SELECT 的事，读路径不递归。
- **单 active 由数据库保证**：`CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status='active'`。
- **patch 幂等**：`version_patch_hash` 唯一索引——同样的 patch 重复提交不会产生新版本。
- **多草稿时不许猜**：`evo_publish` 无参且有两个草稿会拒绝，要求指定 `vN`。

## 仓库结构

```
index.js              把三张座位接起来（tools / commands / skills）
lib/paths.js          环境变量 → 路径（不建目录）
lib/schema.js         四类节点的 body JSON Schema + 校验器
lib/store.js          SQLite：DDL、事务、版本状态机、接地校验
lib/tools.js          八个工具的入参声明与渲染
lib/command.js        /evo 子命令
lib/skills.js         技能发现（front matter + on-demand 正文）
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
- `scripts/_check-plugin.mjs`：60 项端到端——八个工具注册与渲染、空库 status、未激活时 browse 的解释、commit 幂等、缺证据引用被拒、单草稿 publish、多草稿拒绝猜、diff、Markdown/JSON 导出、`/evo` 六个子命令、三个技能加载、注销后座位清空、无多余日志。
- `node --check` 全文件通过；`package.json` 与两份 locale JSON 解析通过。

**已装机验证（2026-11-22）**

- `plugin_manager install_bundle` → `application: applied`，无需重启：`evo_*` 八个工具与 `/evo` 立即出现在会话里；技能目录立刻多出 `build-ontology` / `use-ontology` / `evolve-ontology`（旧的三个技能随卸载消失）。
- 首次 `evo_status` 返回：`存储：C:\Users\Noah_Qiao\.dsh\evoontology\store.db（schema 2）`、`激活版本：无`、`草稿：无`。

**待验证**

- 完整「建 → 用 → 演进」循环在真实数据上的手感（尤其 `evo_resolve` 的骨架在真实提问下的命中率）。
- P1 的 `evo_query` 未实现，所以目前「跑查询」仍由宿主工具完成。

## 已知限制

- **P0 没有数据源连接器**：探测数据靠宿主工具，本插件只存结论。`evo_query` 在 P1。
- **P0 没有面板**：v0.2 的右栏标签页随原生重写下线，P2 以 `store.db` 为源重建（座位决策见 [ADR 0004](docs/decisions/0004-sidebar-right-seat.md)）。
- **P0 没有自动进化**：Builder / Critic / Evaluator 与 held-out 评测是 P3。技能里明确写了「不要假装有」。
- **单机单写者**：SQLite 不支持多写者并发；一个 store 服务一个项目。

## 许可

MIT。上游版权归 Meiduo Chong、Shaole Zhang、Ju Fan、Xiaoyong Du（人大 DataLab）；本仓库的重写由 Noah Qiao 维护。
