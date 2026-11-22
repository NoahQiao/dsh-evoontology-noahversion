# 侧边栏面板（`client.js` + `/evo` 命令）

> 状态：**实现**（v0.2.0）。本文描述已落地的形态；「未实测」项见文末验证记录。

## 定位与归属

给本插件加一个**浏览器侧**的只读面板：在 DSH 右侧栏里看本体层——有哪些版本、活动版本是哪一版、每个版本 5 类节点各多少、最近一次演化 run 的终态、离线探索器与轨迹文件在哪。

- 归属：本仓库 `client.js`（包内浏览器产物）+ Host 侧 `index.js` 里注册的 `evo` 命令。
- 座位：**右侧栏（`rightbar`）**，不是左侧栏。理由见「为什么不是左侧栏」。

## 为什么不是左侧栏

DSH 有两处可以挂常驻 UI：

| 座位 | 形态 | 代价 |
|---|---|---|
| **右侧栏** `sidebar.right.pane.tab` | 与浏览器 / 文档 / 文件并列的**标签页**，每会话各自布局，可浮动、可分屏 | 只在「中栏是会话」时可见 |
| 左侧栏 `sidebar.panellist` | 左栏底部一个图标，点开**占据整个中栏** | 中栏被面板占掉后右侧栏不可见，且每次要离开对话 |

本插件的使用场景是「跟 agent 对话的同时看本体状态」，右侧栏正是这个语义。选它。

## 契约

### 包清单（`package.json`）

```jsonc
{
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-api-remotes",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-layout",
        "@deepseek-ai/dsh-client-ui-sidebar-right"
      ]
    }
  }
}
```

`inject` 列的是本产物依赖的**已装 client 包**（`remote.commands` 来自 api-remotes / connection，`locale` 来自 client-locale，`slots` 来自 layout，右栏座位与 `sidebarRightTabs` 来自 sidebar-right）。React 由浏览器模块表提供，不在 `inject` 里、也不在依赖里。

### 浏览器产物形态

```js
window.__ModuleLoader__.load({
  id: '@noah/dsh-evoontology', // 必须等于包名
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'locale', 'remote', 'sessions', 'sidebarRightTabs'],
      apply(ctx) { /* 注册 tab 定义 + 面板正文 + 命令调用 */ },
    }
  },
})
```

factory 无副作用：locale 档位、tab 定义都在 `apply` 里用 `ctx.effect` 注册并返回注销器。

### 两次注册同一个 id

```js
ctx.effect(() => ctx.sidebarRightTabs.register({
  id: TAB_ID,               // = '@noah/dsh-evoontology'
  kind: 'evo',              // 自定义 kind，优先级压过内置 kind
  title: () => t('tab.title'),
  keepMounted: true,        // 切走再切回不重建、不重拉
  guide: { order: 40, title: () => t('tab.title'), description: () => t('tab.description') },
}), 'dsh-evoontology: evo tab type')

ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: TAB_ID,              // 与上面的 id 同一个字符串
  locale: NS,
  inject: () => ({ t, load }),
}, EvoPane))
```

要点：

- 座位按**有效 kind 定义的 `id`** 派发正文，所以 slot 的 `key` 必须等于定义的 `id`。两处用同一个常量 `TAB_ID`，改名只改一处。
- 同 id 二次注册会抛错；注销器交给 `ctx.effect` 管。
- `guide` 让它出现在右栏「+」的类型列表里（`order: 40` 排在文档/浏览器之后）。
- 不注册 `sidebar.right.pane.tab.title` 自定义标题：`title()` 捕获值已在 tab 条上显示。

### 数据通路：Client 不能直连 MCP 工具

MCP 工具只存在于 Host 的工具表，浏览器侧没有句柄。通路是**命令桥**：

```text
Client  ctx.get('remote.commands').execute(sessionId, '/evo status', [])
   →  { ok: true, value: { result: { kind: 'success', text: '<JSON>' } } }
   →  JSON.parse(result.text)

Host    ctx.commands.register({ name: 'evo', input: { hint: 'status | versions | runs' }, handler })
```

- Host 侧**直接读工作区文件**，不绕回 Python 进程：面板只读，读 JSON 比拉一个 MCP 子进程便宜，且不占 `python` 依赖。
- 工作区路径 = `DSH_EVOONTOLOGY_WORKSPACE`（若设置）否则 `$DSH_HOME/evoontology/workspace`——与 `cordis.patch.yml` 里 `--store` 指向的目录一致。
- 所有回复都 `JSON.stringify` 进 `text`，Client 只解析一种形状。
- 只读命令：`status` / `versions` / `runs`。**写操作一律回到对话里由 agent 调 MCP 工具**，面板不给按钮改数据。
- `sessionId` 取 `ctx.get('uiSession').current.getSnapshot().key`，回落 `ctx.sessions.list` 里 `retainedBy.mainView > 0` 的那条。

### 命令返回的形状

```jsonc
{
  "ok": true,
  "workspace": "...", "exists": true,
  "activeVersion": "v2",
  "versions": [{ "version": "v2", "active": true, "total": 9,
                 "counts": { "terms": 5, "mappings": 0, "relations": 0, "constraints": 4, "evidence": 0 } }],
  "runs": [/* 最近 5 条，新→旧 */],
  "latestRun": { "dir": "run_2", "runId": "run_2", "status": "incomplete", "parentVersion": "v2",
                 "currentCandidate": "c2", "acceptedVersion": null, "round": 0, "budget": 3,
                 "endReason": null, "updatedAt": "..." },
  "trajectories": 2,
  "visualizations": [{ "file": "v2.html", "path": "..." }],
  "generatedAt": "..."
}
```

`counts` 只统计 `terms/mappings/relations/constraints/evidence` 五个文件的行数——与上游 `store.counts()` 同口径。

## 面板内容

| 区块 | 数据来源 | 交互 |
|---|---|---|
| 版本列表 + 活动标记 | `active.json` + `versions/<v>/*.json` | 只读；每行显示 5 类计数与合计 |
| 最近演化 run | `evolution/run_<n>/run.json` 白名单字段 | 只读；显示状态 / parent / candidate / 轮次预算 / 终止原因 / mtime |
| 离线探索器 | `visualizations/*.html` | 只显示前 3 个绝对路径（由用户自行用文件浏览器打开） |
| 轨迹数 + 工作区路径 | `trajectories/*.json` 计数 | 只读 |
| 空态 | `versions` 为空 | 引导文案：用 build-ontology 技能建层 |

刷新只在挂载与点「刷新」时发生（`keepMounted: true` 保证切走切回不重建）。

## 样式与文案

- 只用中性色（`rgba(128,128,128,α)` 的分隔线、`opacity` 做层级），**不写死任何 color/background**，随宿主主题走。
- 可见文案全部走 `ctx.locale.register(NS, { zh, en })` + `ctx.locale.bind(NS)`，中英两份 key。
- 不替换应用根节点、不往 `document.body` 追加第二个应用、不读别的插件的 DOM。

## 验证记录

已实测（`node` 直接 `import('index.js')` + 伪 ctx 跑 `apply`，对合成工作区调 `handler`）：

- `status` → `exists: true`、`active: v2`、版本 `v1(total=6) v2(total=9,active)`、`latestRun` 取最新 `run_2`、`trajectories: 2`、`visualizations: 1`。
- `runs` → 新→旧 `run_2,run_1`；`versions` → `["v1","v2"]`；未知子命令 → `kind: 'error'`。
- 空工作区 → `exists: true`、`versions: 0`、`runs: 0`（面板落空态）。
- `client.js` 通过 `node --check`；`package.json` 与两份 locale 通过 JSON 解析。

未实测（需要重启后肉眼确认）：

- 右栏「+」里出现 `EvoOntology` 条目、点开有正文、刷新按钮生效。
- 命令桥在真实会话下的 `sessionId` 解析与 `remote.commands` 返回值形状。

## 未决问题

1. **版本变化后何时自动重拉**：目前靠用户切回标签页或点刷新。要实时得确认 Host 能否经会话事件推给 Client（`ctx.commands` 只有请求-响应）。此外 `keepMounted: true` 意味着切回也不会重建，所以「切回即重拉」目前不成立，需要显式刷新。
2. **右侧栏在「中栏不是会话」时整体隐藏**——宿主行为（`RightbarRoot` 的 `visible = activePanelId === null`），不接受为此改座位。

## 不做

- 不做左侧栏 global panel（会抢中栏）。
- 不做编辑表单 / 运行按钮（写操作归 agent + MCP 工具）。
- 不为面板新增 MCP 工具。
- 不在浏览器侧直连 HTTP 打 Python（上游没有 HTTP 服务）。
- 不在面板里内嵌可视化 HTML（用宿主浏览器的地址族去开，面板只给路径）。
