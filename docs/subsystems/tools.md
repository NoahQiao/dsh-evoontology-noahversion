# 工具面 `lib/tools.js`

## 1. 定位与归属

模型能调的全部动作，长在 `ctx.tools` 这个座位上。八个工具，每个一件职责。这里同时是**提示成本**的守门人：每个工具的 schema 都会常驻系统提示，所以「多一个工具」是有价格的。

旧实现有 29 个工具，其中 9 个是同一个进化状态机的不同转移——那是把内部状态机当对外契约暴露了。

## 2. 契约

### 2.1 工具清单

| 工具 | 职责 | 写？ |
|---|---|---|
| `evo_status` | 激活版本、五类计数、草稿（含超期悬挂）、最近 run、版本列表 | — |
| `evo_browse` | 关键词 → 节点 + 证据（`kind` 过滤、`limit`） | — |
| `evo_resolve` | 意图 → 命中的 term/mapping/constraint/evidence + 只读查询骨架 | — |
| `evo_history` | 版本时间线；给 `from`/`to` 则返回差异 | — |
| `evo_commit` | patch → draft 版本（幂等、接地校验、`base` 乐观并发） | ✅ |
| `evo_publish` | 校验 + 激活 draft（旧的转 retired） | ✅ |
| `evo_revert` | active 指回 retired 版本 | ✅ |
| `evo_export` | 导出 Markdown / JSON 到 `exports/` | 写派生物 |

### 2.2 返回形状

所有工具共用同一个 output schema，因此模型只需要理解一种结果：

```ts
{ ok: boolean; tool: string; summary: string; data?: object }
```

`summary` 是**唯一会被模型看到的文本**（`output.render` 只渲染它），所以它必须自洽：读出 `evo_resolve` 的 `summary` 就该知道该写什么查询，不需要再翻 `data`。`data` 保留结构化副本，供将来的面板/资源页使用。

失败不走异常：`execute` 内部捕获，返回 `{ok: false, summary: "evo_commit 失败：<原因>"}`。这样模型能读到原因并自己改 patch，而不是看见一串栈。

草稿的清理**没有**对应工具，走命令 `/evo discard vN`（只对 `draft` 有效）。理由：清理草稿不改变线上语义，却是少数「删了就没了」的动作，做成命令意味着必须是人或人明确要求的；工具留给有版本兜底的写路径。

### 2.3 渲染约定

- 一行一个事实，不缩进超过两层。
- 数字带单位（`min=23841 max=36604，量级符合 mW`）。
- 每个写工具在成功时给出**下一步**（`下一步：用 evo_publish 激活`）。
- 拒绝时给**怎么改**，不只说「失败」（`有 2 个草稿（v1, v2），必须指定…`）。

## 3. 扩展位

| 想加 | 做法 | 注意 |
|---|---|---|
| `evo_query`（P1） | 新工具 + `lib/connector.js` | 必须只读；authorizer 白名单 SELECT/READ/FUNCTION/RECURSIVE；行数 100、单值 1MB、5s 上限 |
| `evo_task_start/finish`（P1） | 写 `task` / `event` 表 | 轨迹真相是 session log，不要自建 trajectory 文件 |
| 危险动作（P3） | `ctx.approval` + `ctx.actionCards` | 不要自己在聊天里问「同意吗」——那不可审计 |
| 只读角色限制（P3） | `ctx.tools.restrict` | Critic 只能 browse；Evaluator 连本体都看不到 |

## 4. 不做

- 不做「一个工具一个内部状态转移」：状态由 `evo_status` 呈现，不靠工具名枚举。
- 不做写查询：语义的可靠性靠证据，而可写的查询意味着证据可被伪造。
- 不在工具里做给人看的排版：`render` 只负责让模型读得懂；给人看的是面板和导出（P2）。
- 不做自动重试：patch 幂等，所以重试的责任交给调用方，工具不隐藏失败。
