# 0006 一个 SQLite 文件，而不是一目录 JSON

- 日期：2026-11-22
- 状态：**已实现**（`lib/store.js`）
- 相关：[0005](0005-native-rewrite.md)

## 背景

v0.1/v0.2 的存储是上游的形状：`active.json` + `versions/<v>/{terms,mappings,relations,constraints,evidence}.json` + `trajectories/*.json` + `evolution/run_<n>/run.json`。

它有三个无法靠「小心一点」解决的问题：

1. **没有跨文件原子性**：publish 要同时改 `active.json` 和写新版本目录，进程在两次写之间死掉，磁盘上就是「激活了一个不存在的版本」。
2. **diff 要手写**：`evo_history` 的 `+2 节点 / ~1 节点` 是自己遍历两组 JSON 算出来的，逻辑与校验逻辑重复。
3. **引用完整性靠自觉**：节点里写 `evidence: ['ev.pkgW']`，那个节点没了也没人知道——直到渲染时 KeyError。

## 决策

单个 SQLite 文件 + `node:sqlite`，进程内打开，WAL 模式。版本是 **copy-on-write 全量快照**。

## 理由

1. **原子性免费**：`BEGIN IMMEDIATE … COMMIT` 让「改版本、改 active、写证据」要么全成要么全败。
2. **不变量下沉到数据库**：`CREATE UNIQUE INDEX version_single_active ON version(status) WHERE status='active'` 让「只有一个 active」不再依赖代码正确性。同理 `version_patch_hash` 唯一索引让 patch 幂等成为约束而不是 if 判断。
3. **diff 变成两次 SELECT**：全量快照意味着两个版本可以按 `node_id` 直接比对，不需要沿 `parent_id` 递归。
4. **引用完整性由外键保证**：`edge(version_id, src)` 与 `edge(version_id, dst)` 都指向 `node`，悬空边在插入时就被拒绝。

## 代价

- **空间放大**：节点行数 × 版本数。几百个节点、几十个版本在几 MB 量级，可以接受；如果将来单本体上万节点，要改成 delta 存储。
- **copy-on-write 的隐式要求**：新版本必须先把父版本的行整份复制过来，再应用 changes。漏掉这一步会撞 `FOREIGN KEY constraint failed`（第一次实现就踩了）。
- **只支持单机**：SQLite 不适合多写者。当前形态是一个项目一个 store，够用。

## 不采用的替代

- **上游的目录形态**：见背景三条。
- **LanceDB / 向量库**：语义层要的是「精确检索 + 结构约束」，不是相似度。向量可以在 P4 作为 `resolve` 的补充，但不能当真相。
- **JSONB 之类内存对象 + 定期落盘**：进程崩了就丢，且没法 diff 历史状态。

## 验证

`scripts/_check-store.mjs` 覆盖：空库、接地拒绝、v0 落地、幂等、publish、计数、v1 继承、`base` 乐观并发、唯一 active、revert、draft 不能 revert、悬空边拒绝、`relation` 拒绝、检索、discard。
