# Host 插件（`index.js`）

## 定位与归属

本仓库唯一的 Host 侧 JavaScript 代码。它在 Cordis 插件树里做三件很小的事：**把 Python 核心铺到 `$DSH_HOME`**、**把三个技能注册进技能目录**、**注册一个只读的 `evo` 命令给右栏面板取数**。它不注册工具、不画界面、不写工作区。

- 文件：`index.js`（约 360 行），ESM。
- 导出：`name`、`inject = ['skills', 'commands']`、`apply(ctx, config)`。
- 归属：本仓库。上游没有这部分。

## 契约

### 导出形状

```js
export const name = 'dsh-evoontology'
export const inject = ['skills', 'commands']   // 激活前先等这两个服务就绪
export function apply(ctx, config) { ... }
```

`inject` 声明了依赖，Cordis 保证 `apply` 执行时 `ctx.skills` / `ctx.commands` 已存在。**所有资源注册都必须包在 `ctx.effect()` 里**——插件被卸载或配置变更时，Cordis 靠 effect 的返回值做清理。

### `stagePython(log)`

| 步骤 | 行为 |
|---|---|
| 比较 | `python/UPSTREAM.txt` 与 `$DSH_HOME/evoontology/python/UPSTREAM.txt` 是否一致，并检查 `evoontology/runtime/mcp_server.py` 是否存在 |
| 一致 | 什么都不做（幂等，避免每次激活都重写 700KB） |
| 不一致/缺失 | `cpSync(sourcePython, staged, { recursive: true, force: true })` |
| 结果 | `$DSH_HOME/evoontology/python/evoontology/...` |

**为什么要有这一步**：`cordis.patch.yml` 里的 `!!js` 只能求值出绝对路径，而 MCP 行的 `cwd` 必须是绝对路径。如果直接写「仓库目录」，插件被 link 安装、被移动、被复制到另一台机器，配置就废了；`dshHomePath()` 是 DSH 文档里唯一保证存在的路径助手，所以让 `index.js` 把代码搬到 `dshHomePath` 之下，配置里就只剩相对 `$DSH_HOME` 的路径。代价见 [decisions/0002](../decisions/0002-stage-core-into-dsh-home.md)。

### 技能 provider

见 [skills.md](skills.md)。一句话：`ctx.effect(() => ctx.skills.registerProvider(() => createProvider(log)))`，读包内 `skills/*/SKILL.md` 的 front matter 产出 candidate，`get()` 时返回正文。

### `evo` 命令（只读）

给右栏面板取数的唯一通路。契约细节见 [client-sidebar.md](client-sidebar.md)，这里只记形状：

```js
ctx.effect(() => ctx.commands.register({
  name: 'evo',
  description: 'EvoOntology 语义层只读状态：status / versions / runs（不修改工作区）。',
  input: { hint: 'status | versions | runs' },
  async handler(invocation) {
    // 从 invocation.rawInput 剥掉 "/evo" 前缀取子命令
    // 一律 { kind: 'success', text: JSON.stringify(payload) }
  },
}))
```

| 子命令 | 返回 |
|---|---|
| `status`（缺省） | 工作区存在性、活动版本、各版本 5 类计数、最近 5 条 run、轨迹数、可视化路径、生成时间 |
| `versions` | 只有工作区、活动版本、版本列表 |
| `runs` | 最近 20 条 run |
| 其他 | `{ kind: 'error', text: 'unknown action: …' }` |

读取的目录固定为 `DSH_EVOONTOLOGY_WORKSPACE`（若设置）否则 `$DSH_HOME/evoontology/workspace`，与 MCP 行 `--store` 指向同一棵目录树；**只读**，不 mkdir、不写任何文件。

注册用 `try/catch` 单独包住：命令注册失败不应该把技能一起带下线。

### `dshHome()`

优先 `process.env.DSH_HOME`，否则 `join(homedir(), '.dsh')`。**不要**改成读 `profileContext`：该服务不暴露目录字段。

### 日志

`apply` 里先探测 `ctx.logger` 的类型，可用则用之，否则 `console.warn('[evoontology] ...')`。`stagePython` 与命令注册的失败只记日志、不抛——铺核心失败时技能仍可注册（只是调工具会报错），比整个插件不可用要好。

## 扩展位

- **加一次性初始化步骤**：放进 `apply`、在 `registerProvider` 之前，并保证幂等。
- **加 Config**：`export const Config = Schema`（Cordis 会在详情页生成表单）。当前没有可调项，故意不导出。
- **加命令**：与 `evo` 同形——包在 `ctx.effect`、返回 `{kind,text}`、失败用 `kind: 'error'`。命令名不要占用宿主已有的斜杠命令。
- **包内路径**：`packageDir = dirname(fileURLToPath(import.meta.url))`，所有包内路径都从它派生；不要用 `process.cwd()`。

## 不做

- 不注册工具（工具来自 MCP 行）。
- 不写 `ctx.systemPrompt.section`。
- 不在 `apply` 里做异步初始化却不 await：`stagePython` 是同步的，这样 MCP 行的 `cwd` 一定已就绪。
- `evo` 命令不提供任何写操作——写路径只属于 agent + MCP 工具。
