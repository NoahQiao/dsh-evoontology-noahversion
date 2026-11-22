# 侧边栏面板（`client.js`）— 设计稿，尚未实现

> 状态：**设计**。本文描述 v0.2 的目标形态，代码尚未落地。任何与实现不一致之处以本文为准；落地后把「设计」改回「实现」并补验证记录。

## 定位与归属

给本插件加一个**浏览器侧**的只读面板：在 DSH 右侧栏里看本体层——有哪些版本、活动版本是哪一版、有哪些概念类别与数量、最近一次演化 run 的终态、可视化 HTML 的入口。

- 归属：本仓库 `client.js`（包内浏览器产物）+ Host 侧新增的若干 `/evo` 命令。
- 座位：**右侧栏（`rightbar`）**，不是左侧栏。理由见下面「为什么不是左侧栏」。

## 为什么是右侧栏

DSH 有两处可以挂常驻 UI：

| 座位 | 形态 | 代价 |
|---|---|---|
| **右侧栏** `sidebar.right.pane.tab` | 与浏览器 / 文档 / 文件并列的**标签页**，每会话各自布局，可浮动、可分屏 | 只在「中栏是会话」时可见 |
| 左侧栏 `sidebar.panellist`（dsh-notes 的用法） | 左栏底部一个图标，点开**占据整个中栏** | 中栏被面板占掉后右侧栏不可见；本插件是「配合对话使用的旁路信息」，占中栏是反客为主 |

本插件的核心使用场景是「跟 agent 对话的同时看本体状态」，右侧栏正是这个语义。选它。

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
      "inject": ["@deepseek-ai/dsh-client-runtime"]
    }
  }
}
```

`inject` 里写的是**运行时**（React 等由浏览器模块表提供，不要自己装 React、不要 CDN/UMD）。`immediately: true` 表示页面加载即注册，不必等首次交互。

### 浏览器产物形态

```js
window.__ModuleLoader__.load({
  id: '@noah/dsh-evoontology',        // 必须等于包名
  factory(require) {
    const React = require('react')
    return {
      inject: ['slots', 'locale', 'remote', 'sessions'],
      apply(ctx) { /* 注册 tab + 面板正文 */ },
    }
  },
})
```

factory 必须**无副作用**：样式、定时器、监听器一律在 `apply` 里用 `ctx.effect` / `ctx.on` 注册并返回清理函数。

### 两次注册同一 id

右侧栏的 tab 类型与 tab 正文是两处注册，用同一个 `id` 关联：

```js
apply(ctx) {
  // 1) 把 "evo" 变成一种可打开的右侧栏标签
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: 'evo',
    kind: 'evo',                       // 自定义 kind，优先级压过内置 kind
    title: () => 'EvoOntology',
    keepMounted: true,                 // 切走再切回不重建，避免重复拉数据
    canOpen: () => true,
  }))

  // 2) 面板正文
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
    ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'evo' }, EvoPane)
  ))
}
```

同 id 注册两次会抛错，所以两处都要在 `ctx.effect` 里以「返回注销器」的方式成对存在。正文组件可通过框架注入的 `useTabInfo()` 拿到 `{ sidebar: { expanded, fullscreen }, panel: { id, isFloating }, tab: { visible, navigation, actions } }`。

### 数据通路：Client 不能直连 MCP 工具

MCP 工具只存在于 Host 的工具表里，浏览器侧没有它们的句柄。已验证可行的通路是**命令桥**（照 `dsh-notes` 的做法）：

```text
Client:  ctx.get('remote.commands').execute(sessionId, '/evo status', [])
   →  { ok: true, value: { result: { kind: 'success', text: '<JSON 字符串>' } } }

Host:    ctx.commands.register({
           name: 'evo status',
           description: 'Return ontology versions and active version as JSON',
           input: { hint: 'no arguments' },
           handler: async () => ({ kind: 'success', text: JSON.stringify(payload) }),
         })
```

要点：

- **Host 侧直接读工作区文件即可**（`$DSH_HOME/evoontology/workspace/.evoontology/active.json` 等），不必绕回 Python 进程——面板是只读视图，读 JSON 比拉一个 MCP 子进程便宜得多。
- 返回值一律 `JSON.stringify` 成字符串再塞进 `text`；Client 侧 `JSON.parse`。
- `sessionId` 取 `ctx.get('uiSession').current.getSnapshot().key`。
- 只读命令（`/evo status`、`/evo versions`、`/evo runs`）；**写操作一律回到对话里由 agent 调 MCP 工具**，面板不给按钮直接改数据。

### 打开方式

- 用户从右侧栏的「+」菜单选 `EvoOntology`。
- 或 agent 侧不参与；面板不主动弹出（避免打断用户）。

## 面板内容（v0.2 建议范围）

| 区块 | 数据来源 | 交互 |
|---|---|---|
| 版本列表 + 活动标记 | `active.json` + 各版本目录名 | 点一行看该版本的 5 类节点计数 |
| 节点计数 | 各版本目录下的 JSON | 只读 |
| 最近演化 run | `evolution/runs/<id>/` 的终态字段 | 链接到结局浏览器 HTML |
| 可视化入口 | `visualizations/*.html` | 用 DSH 内建浏览器标签打开 |

不做编辑、不做保存、不做运行按钮。

## 样式与文案

- 只用宿主 token（`--dsw-alias-*`）与内建控件，不写死颜色、不自带设计系统。
- 可见文案走 Client 的 locale 服务；新增中英两份 key。
- **不要**替换应用根节点、不要往 `document.body` 追加第二个应用、不要读别的插件的 DOM 猜位置。

## 未决问题

1. **`remote.commands` 之外是否还有更直接的 Host→Client 推送**（例如面板需要随本体版本变化自动刷新）。当前设计靠用户切回标签页时重拉；若要求实时，需要确认 `ctx.commands` 能否主动推事件，或改用 Host 侧 `ctx.emit` + Client `ctx.on` 的会话事件。
2. **右侧栏在「中栏不是会话」时不可见**——如果用户用左侧面板模式（如读书插件）工作，evo 面板会一起消失。这是宿主行为，不接受为此改造。
3. **浮动/分屏布局下正文是否收到 `tab.navigation` 更新**：需要在实现时以 `useTabInfo()` 实测为准。

## 不做

- 不做左侧栏 global panel（会抢中栏）。
- 不做编辑表单（写操作归 agent + MCP 工具）。
- 不为面板新增 MCP 工具。
- 不在浏览器侧直连 HTTP 打 Python（上游没有 HTTP 服务）。
