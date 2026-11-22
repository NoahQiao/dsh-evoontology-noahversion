# 右栏面板

**定位与归属**：浏览器侧的唯一产物（`client.js`）。它回答一个问题——「本体层现在是什么样、上次改了什么」，而这件事不应该靠 agent 转述。数据全部经 Host 的 `/evo` 命令取回，面板自己不读数据库、不调工具、不发 HTTP。

## 1. 契约

### 1.1 加载形态

`package.json` 声明两处，缺一不可：

```json
"exports": { ".": "./index.js", "./client": "./client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "immediately": true, "inject": ["@deepseek-ai/dsh-api-remotes", "…"] }
}
```

`client.js` 用浏览器模块表注册，id **必须**等于包名：

```js
window.__ModuleLoader__.load({
  id: '@noah/dsh-evoontology',
  factory(require) {
    const React = require('react')          // 由宿主提供，不要自带副本
    return { inject: ['slots', 'locale', 'remote', 'sessions', 'sidebarRightTabs'], apply(ctx) { … } }
  }
})
```

无构建步骤：没有打包器、没有 JSX、没有 TS。`h = React.createElement`，样式是内联对象。

### 1.2 座位

右侧栏的一个标签页要**注册两次，且两处的 `id` 必须相同**：

| 注册 | 作用 |
| --- | --- |
| `ctx.sidebarRightTabs.register({ id, kind, title, keepMounted, guide })` | 定义类型：出现在右栏「+」列表里 |
| `ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id, locale, inject }, Body)` | 提供正文：座位按有效 `kind` 定义的 `id` 派发 |

两者都包在 `ctx.effect` 里，卸载时自动注销。`id`、`kind`、`key` 三个字符串必须一致，写错的表现是**标签页能打开但正文空白**——这是本层最容易踩的坑。

`inject()` 返回的 `t` 与 `load` 作为 props 传给 `Body`；`useTabInfo()` 由框架注入，本面板不用它（不需要知道是否浮动、是否全屏）。

### 1.3 数据通路

```
Body → load('/evo status --json') → ctx.get('remote.commands').execute(sessionId, line, [])
     → { ok, value: { result: { kind: 'success', text } } } → JSON.parse(text)
```

- `sessionId` 取 `ctx.get('uiSession').current.getSnapshot().key`，取不到再退回 `ctx.sessions.list.getSnapshot()` 里 `retainedBy.mainView > 0` 的那条。
- 失败一律抛错，`Body` 落到错误态并显示「刷新」；不吞异常。
- 两条命令：`/evo status --json`（全量快照）与 `/evo diff <from> <to> --json`（节点级差异）。载荷形状由 `lib/command.js` 的 `snapshot()` 与 diff 分支定义，**面板与命令各改一半就会对不上**，所以两边都有断言（`scripts/_check-client.mjs` 用固定 fixture）。

### 1.4 三态与选择

| 状态 | 显示 |
| --- | --- |
| `loading` / `error` | 一行提示 + 刷新按钮（错误态显示消息原文） |
| 空（没有激活版本，也没有任何版本） | 引导：先用 `evo_commit` + `evo_publish` 建一版 |
| 就绪 | 激活版本 + 计数、版本列表、任务行、存储路径 |

点列表里任意版本 → 与**激活版本**对比（不是与相邻版本），差异区出现 `+ / - / ~` 与边的增减。再点同一个版本取消选择。

## 2. 扩展位

| 想做的事 | 怎么做 |
| --- | --- |
| 在标题栏加一个指示 | `sidebar.right.pane.tab.title` 是独立槽位，可按 key 注册 |
| 加右键菜单项 | `sidebar.right.tab.menu.item` |
| 让面板知道自己是浮动还是停靠 | 用 `useTabInfo()` |
| 换语言 | 只改 `zh` / `en` 两份字典，代码里没有硬编码文案 |

## 3. 不做

- **不直读 `store.db`**：浏览器里没有 `node:sqlite`，也没有文件系统；要在前端读库必须新开 HTTP 端点，那是另一条信任边界。
- **不新增面板专用工具**：`/evo` 命令是 Host 侧已有能力的一层薄封装，工具表保持 11 个。理由：工具是给模型看的，面板是给人看的，两者的生命周期不同。
- **不写死颜色**：样式只用 `rgba(128,128,128,α)` 分隔线、透明度与相对字号，跟随宿主主题。美术图才允许自选色。
- **不弹窗**：`alert` / `confirm` / `prompt` 一律不用，交互靠点击与就地渲染。

## 4. 验证与已知限制

离线自检（`node scripts/_check-client.mjs`，33 项）在 `vm` 里按浏览器方式执行 `client.js`：模块 id、`inject` 列表、两次注册的 id 一致性、三态渲染文本、点击版本触发的 `/evo diff v2 v1 --json`、差异区三个分组、以及「样式里没有颜色字面量 / 没有弹窗 API」。

**已知限制**：`Browser` 侧组件由桩实现驱动（`useState` 只存值、`useEffect` 同步执行），能验证渲染逻辑与数据通路，**不能**验证真实 React 的调度、`keepMounted` 的挂载保持、以及主题 token 的实际取值。这些必须在重启 DSH 后肉眼确认一次。
