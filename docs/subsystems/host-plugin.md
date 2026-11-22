# Host 插件（`index.js`）

## 定位与归属

本仓库唯一的 JavaScript 代码。它在 Host（Cordis 插件树）里做两件很小的事：**把 Python 核心铺到 `$DSH_HOME`**、**把三个技能注册进技能目录**。它不注册工具、不画界面、不碰工作区内容。

- 文件：`index.js`（174 行），ESM。
- 导出：`name`、`inject = ['skills']`、`apply(ctx, config)`。
- 归属：本仓库。上游没有这部分。

## 契约

### 导出形状

```js
export const name = 'dsh-evoontology'
export const inject = ['skills']          // 激活前先等 skills 服务就绪
export function apply(ctx, config) { ... }
```

`inject` 声明了依赖，Cordis 保证 `apply` 执行时 `ctx.skills` 已存在。**所有资源注册都必须包在 `ctx.effect()` 里**——插件被卸载或配置变更时，Cordis 靠 effect 的返回值做清理。

### `stagePython(log)`

| 步骤 | 行为 |
|---|---|
| 比较 | `python/UPSTREAM.txt` 与 `$DSH_HOME/evoontology/python/UPSTREAM.txt` 是否一致，并检查 `evoontology/runtime/mcp_server.py` 是否存在 |
| 一致 | 什么都不做（幂等，避免每次激活都重写 700KB） |
| 不一致/缺失 | `cpSync(sourcePython, staged, { recursive: true, force: true })` |
| 结果 | `$DSH_HOME/evoontology/python/evoontology/...` |

**为什么要有这一步**：`cordis.patch.yml` 里的 `!!js` 只能求值出绝对路径，而 MCP 行的 `cwd` 必须是绝对路径。如果直接写「仓库目录」，插件被 link 安装、被移动、被复制到另一台机器，配置就废了；`dshHomePath()` 是 DSH 文档里唯一保证存在的路径助手，所以让 `index.js` 把代码搬到 `dshHomePath` 之下，配置里就只剩相对 `$DSH_HOME` 的路径。代价见 [decisions/0002](../decisions/0002-stage-core-into-dsh-home.md)。

### `dshHome()`

优先 `process.env.DSH_HOME`，否则 `join(homedir(), '.dsh')`。**不要**改成读 `profileContext`：该服务不暴露目录字段。

### 日志

`apply` 里先探测 `ctx.logger` 的类型，可用则用之，否则 `console.warn('[evoontology] ...')`。`stagePython` 的失败只记日志、不抛——铺核心失败时技能仍可注册（只是调工具会报错），比整个插件不可用要好。

## 扩展位

- **加一次性初始化步骤**：放进 `apply`、在 `registerProvider` 之前，并保证幂等。
- **加 Config**：`export const Config = Schema`（Cordis 会在详情页生成表单）。当前没有可调项，故意不导出。
- **包内路径**：`packageDir = dirname(fileURLToPath(import.meta.url))`，所有包内路径都从它派生；不要用 `process.cwd()`。

## 不做

- 不注册工具或命令（工具来自 MCP 行；命令留给 [client-sidebar](client-sidebar.md) 需要时再加）。
- 不写 `ctx.systemPrompt.section`。
- 不在 `apply` 里做异步初始化却不 await：`stagePython` 是同步的，这样 MCP 行的 `cwd` 一定已就绪。
