# 只读执行器 `lib/query.js` + `lib/source.js`

## 1. 定位与归属

`evo_query` 是插件里**唯一**能碰数据的座位。它和本体层是两种不同的东西：本体层说「这一列是什么」，执行器回答「这一列具体是多少」。分开的理由不是分层好看，而是**证据必须来自能被查到的数据**——如果语义节点由模型凭印象写入、又由模型凭印象自证，整个版本就不可信。

执行发生在 `worker_threads` 里，不是主线程。宿主是 Electron 渲染进程的父进程，一个卡住的同步查询会把整个 Host 的事件循环冻住；线程隔离让「掐掉」成为可能。

## 2. 契约

### 2.1 数据源

| 类型 | 判定 | 打开方式 | 表名 |
|---|---|---|---|
| `sqlite` | 扩展名 `.db` / `.sqlite` / `.sqlite3` / `.db3`，或 `kind: "sqlite"` | `new DatabaseSync(path, { readOnly: true })` | 首个用户表；可用 `table` 指定 |
| `csv` | `.csv` / `.tsv` / `.txt` | 解析成内存表（`DatabaseSync(':memory:')`） | 文件名主干小写，非标识符则 `data`，数字开头加 `t_` |
| `json` | `.json` / `.jsonl` | 对象数组，或「只有一个数组字段的对象」，列取并集 | 同上 |

上限：源文件 32 MB、装载 50000 行（超出丢弃并回报 `dropped`）。`parseCsv` 是手写 RFC 4180（BOM、双引号转义、CRLF、引号内的逗号与分号），不引依赖。

**sqlite 一定以只读打开**。这不是「小心一点」，是让写入在文件层就不可能：`attempt to write a readonly database`。

### 2.2 语句闸门（`assertReadOnlyStatement`）

两道独立的闸，任何一道单独失效都不至于放行写操作：

1. **文本闸**：把字符串字面量、引号标识符、注释按位替换成空格（保持长度），再要求首个关键字是 `SELECT` 或 `WITH`，且第一个 `;` 之后只剩空白。这样 `SELECT ';'` 和 `SELECT 1 -- ;` 不会被误判成多语句，而 `SELECT 1; DROP TABLE t` 会被拒。
2. **authorizer 白名单**：`setAuthorizer` 只放行 `21 SELECT`、`20 READ`、`31 FUNCTION`、`33 RECURSIVE`，其余一律拒绝。`PRAGMA` 是 code 19，`ATTACH` 是 code 24，都过不去。

`prepare()` 本身**不拒绝多语句**（`'SELECT 1; DROP TABLE t'` 会被接受并执行第一条），所以文本闸不是冗余的。

### 2.3 上限

| 项 | 值 | 行为 |
|---|---|---|
| 行数 | `limit`，默认 100、最大 500 | 到上限即停止迭代并置 `truncated` |
| 单值 | 2000 字符 | 截断并标注原长；`BigInt` → 字符串，`Uint8Array` → `<blob N bytes>` |
| 时间 | 5000 ms | `worker.terminate()`，返回 `{ ok: false, timeout: true }` |

### 2.4 返回形状

```ts
{ ok, kind, path, table, tables, columns, rows, truncated, timeout?, error? }
```

失败时**也回传 `tables`**，好让上层说「这个文件里有 mon_4b」。`formatTable` 生成定宽文本表（`NULL`、列宽上限 28、超过 20 行只显示前 20 并注明剩余行数），`render` 之外的结构化副本留给面板（P2）。

### 2.5 已知代价：超时会漏一个文件句柄

`node:sqlite` 没有 `interrupt`，也没有 `sqlite3_progress_handler` 的绑定——同步查询一旦跑起来，父线程唯一能做的就是杀掉那个线程。而线程被杀时，它持有的 SQLite 文件句柄**不会被 Windows 回收**（句柄属于进程，不属于线程），于是：

- 被超时掐掉的 `sqlite` 查询会在 Host 进程里留下一个打开的只读句柄，直到 DSH 重启；
- `csv` / `json` 不受影响（内存表，无文件句柄）；
- 实测：正常查询 0 ms 释放，超时查询 1.5 s 后仍 `EBUSY`。

接受这个代价的理由：另一条路是不隔离、让卡住的查询冻住整个 Host，那更糟。缓解手段是文档与提示里反复说「加 `WHERE` 或 `LIMIT`」，把超时当异常而不是常态。

## 3. 扩展位

| 想加 | 做法 | 注意 |
|---|---|---|
| 新文件格式（`parquet` / `xlsx`） | 在 `openSource` 的 `KINDS_BY_EXT` 加分支 | 仍然只能产出只读连接 |
| 新连接器（Postgres / DuckDB） | 新增 `DataSourceConnector`（P4） | `query()` 必须只读；`describe()` 要能产出候选列 |
| 更细的体积控制 | `CELL_LIMIT` / `MAX_SOURCE_BYTES` | 改值要同步 `query.md` 与提示文案 |

## 4. 不做

- **不做写查询**。语义的可靠性靠证据，可写意味着证据可被伪造。要改本体走 `evo_commit`。
- **不做连接池 / 常驻连接**。每次查询独立进程模型，换来的是「查完就干净」；P1 的数据规模不值得为连接复用引入生命周期。
- **不自动改写 SQL**。`evo_resolve` 给骨架是文本，改写交给人或 agent——自动改写会让「为什么这条查询是对的」无法追溯。
- **不在执行器里做单位换算**。换算属于语义层（constraint 节点），执行器只管把值取回来。
