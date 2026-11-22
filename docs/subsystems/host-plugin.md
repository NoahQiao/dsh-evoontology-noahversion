# Host 插件 `index.js`

## 1. 定位与归属

把三张座位接起来，并且只管生命周期：注册、注销、关闭文件句柄。业务逻辑一律不在这里。

```js
export const name = 'dsh-evoontology'
export const inject = ['tools', 'commands', 'skills']
export function apply(ctx) { … }
```

## 2. 契约

### 2.1 座位

| 座位 | 注册 | 生命周期 |
|---|---|---|
| `ctx.tools` | `register(definition)` → 注销器 | 包在 `ctx.effect` 里，随插件卸载回收 |
| `ctx.commands` | `register({name, description, input:{hint}, handler})` | 同上 |
| `ctx.skills` | `registerProvider(() => provider)` | 单独一个 `ctx.effect` |

一个 `StoreHolder` 被所有工具共享：第一次调用时 `openStore()`，全部注销时 `close()`。**不要在 `apply` 期间打开数据库**——插件激活时值不值得我们付一次 I/O 和一次「文件坏了怎么办」的分支。

### 2.2 失败策略

- 某个工具注册失败（重名/被限制）→ 记 warning、跳过，其余继续。一个坏工具不该让整个插件失效。
- 命令注册失败 → 同理。
- 技能 provider 出错 → provider 内部按目录 try/catch，坏目录只 log。
- 卸载顺序：先逆序注销、再 `holder.close()`。顺序反了会留下引用已关闭数据库的工具。

### 2.3 环境变量

| 变量 | 默认 | 用途 |
|---|---|---|
| `DSH_EVOONTOLOGY_STORE` | `<DSH_HOME>/evoontology/store.db` | 单个 store 文件 |
| `DSH_EVOONTOLOGY_HOME` | `<DSH_HOME>/evoontology` | `runs/`、`exports/`、`cache/`、`viz/` 的父目录 |
| `DSH_HOME` | `~/.dsh` | 宿主提供 |

`lib/paths.js` 只计算路径，**不建目录**：写入方（导出、run 产物）在写之前 `mkdirSync(parent, {recursive:true})`。

## 3. 扩展位

- 想加常驻提示：`ctx.systemPrompt.section({name, order, text})`——只在 P3 加一行状态，且不要与别的插件重名（同层重名会 throw）。
- 想加面板：`dsh.client` 段 + `client.js`（P2）。P0 没有客户端产物，`package.json` 里也没有 `dsh.client`。
- 想加配置项：`export const Config` + settings card，把 `storePath` / `maxRows` / `budgetRounds` 变成可调值而不是硬编码。

## 4. 不做

- 不在 `apply` 里做 I/O（除了技能目录 stat）。
- 不捕获并吞掉真实错误：注册期的失败要 log，运行期的失败要返回给模型。
- 不注册 `run_code`（保留名，注册会失败）。
- 不假设自己独占 `store.db`：多进程场景由 SQLite 的 WAL + 事务处理，插件不做文件锁。
