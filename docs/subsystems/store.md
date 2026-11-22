# 存储层 `lib/store.js`

## 1. 定位与归属

唯一的真相。一个 SQLite 文件（`$DSH_HOME/evoontology/store.db`，WAL 模式），进程内用 `node:sqlite` 打开。上层所有工具都只是这个文件的视图；没有任何状态活在内存里等下次重启丢掉。

为什么不是「一个目录一堆 JSON」（旧实现）：五个 JSON 文件没有跨文件原子性，`active.json` 和 `versions/` 可能一个写成了另一个没写成；diff 要手写；引用完整性靠自觉。数据库把这些变成一行 DDL。

## 2. 契约

### 2.1 表

| 表 | 主键 | 说明 |
|---|---|---|
| `meta` | `key` | `schema_version`（当前 `2`） |
| `version` | `id`（`v0`, `v1`, …） | `status ∈ {draft, active, retired}`；`patch_hash` 唯一（幂等）；`parent_id`；`summary` / `limitations` / `metrics` |
| `node` | `(version_id, node_id)` | `kind ∈ {term, mapping, constraint, evidence, relation}`；`body` 是 JSON |
| `edge` | `(version_id, src, dst, type)` | 两个外键都指向 `node(version_id, node_id)`，所以边不可能悬空 |
| `evidence` | `(version_id, evidence_id)` | `node` 里 evidence 的展开副本，便于按 digest 判过期 |
| `question` / `task` / `event` / `evaluation` / `run` | — | P1/P3 用，P0 已建表但只有 `status()` 读 `run` |

两个索引是设计的一部分：

```sql
CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status = 'active';
CREATE UNIQUE INDEX version_patch_hash    ON version(patch_hash);
```

第一条让「只有一个 active」成为数据库不变量，不是约定；第二条让重复提交同一个 patch 不会产生新版本。

### 2.2 方法

| 方法 | 语义 |
|---|---|
| `status()` | 激活版本、计数、草稿、超 7 天悬挂草稿、最近 run、评测数、版本列表 |
| `activeVersion()` / `listVersions()` / `getVersion(id)` | 版本读取 |
| `counts(versionId)` | 五类节点计数 + 边数 + 合计 |
| `nodes(versionId, kind?)` / `node()` / `edges()` / `evidence()` | 内容读取 |
| `search(versionId, text, kind?, limit)` | `label LIKE` 或 `body LIKE` 的只读检索 |
| `applyPatch(patch, {createdBy})` | 校验 + 生成 draft；幂等；返回 `{id, created, hash}` |
| `publish(id)` | draft → active（旧的转 retired）；**先校验接地** |
| `revert(id)` | retired → active（零成本回退） |
| `discard(id)` | 删除草稿及其 evidence 行 |
| `workingSet()` / `groundingProblems()` | 校验内部自用，也可被工具复用 |

`applyPatch` 的 patch 形状：

```json
{
  "summary": "一句话",
  "limitations": ["已知局限"],
  "base": "v3",
  "nodes": { "upsert": [{ "id": "t.x", "kind": "term", "label": "…", "body": {} }], "remove": ["t.y"] },
  "edges": { "upsert": [{ "src": "c.x", "dst": "t.x", "type": "association" }], "remove": [{ "src": "a", "dst": "b", "type": "association" }] }
}
```

### 2.3 三条不变量

1. **接地**：`term` / `mapping` / `constraint` 的 `body.evidence` 必须引用**同版本**存在的 `evidence` 节点。commit 时就校验，不等 publish。
2. **版本不可变 + copy-on-write**：新版本先整份复制父版本的 node/edge/evidence 行，再应用 deltas。所以「版本 = 全量快照」，读路径不需要顺着 `parent_id` 递归，diff 是两次 `SELECT` 的事。代价是节点行数 × 版本数——在几百节点的规模上无所谓。
3. **单 active**：由部分唯一索引保证。publish/revert 的事务里先把旧 active 置 retired 再置新的，否则会撞索引。

## 3. 扩展位

- 新节点类型：`lib/schema.js` 的 `KINDS` + `BODY_SCHEMA` 各加一项；表不用改。
- 新边类型：`EDGE_TYPES` 加一项。
- 迁移：`meta.schema_version` 现在是 `2`；改表结构时在 `openStore()` 里按版本号顺序迁移，**不要**直接改 DDL 让旧库静默不匹配。

## 4. 不做

- 不做跨库 join：一个 store 就是一个项目的语义。
- 不做软删除：草稿直接 `discard`，历史版本靠 status 表达，不靠 `deleted_at`。
- 不存样本行：`evidence.result` 只放结论摘要（`min=23841 max=36604` 这种），原始数据在数据源那边。
- 不实现查询引擎：`node:sqlite` 只用来存语义，不拿来当分析仓库。
