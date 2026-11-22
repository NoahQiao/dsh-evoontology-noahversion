# 0007 接地在 commit 时校验，不在 publish 时

- 日期：2026-11-22
- 状态：**已实现**（`lib/store.js` 的 `groundingProblems()`）
- 相关：[0006](0006-sqlite-single-file.md)

## 背景

「语义必须引用证据」是这个项目的第一性质。问题是校验点放在哪：

- **publish 时校验**：草稿可以是任意形状，最后一刻才拒绝。
- **commit 时校验**：每个中间态都合法。

## 决策

**commit 时校验**。`term` / `mapping` / `constraint` 的 `body.evidence` 必须引用**同版本**存在的 `evidence` 节点，否则整笔 patch 失败。

## 理由

1. **畸形中间态是 bug 的温床**：如果草稿可以无接地，那么任何读草稿的路径（面板、导出、diff）都必须自己再校验一遍，或者容忍垃圾。
2. **失败要近距离**：agent 在 commit 的那一刻还握着上下文（它刚跑完 probe），此时告诉它「`ev.pkgW` 不存在」它能立刻改。等到 publish 再说，它已经忘了刚才想记什么。
3. **幂等哈希要稳定**：patch 的哈希基于最终内容，如果允许「无接地草稿 → 事后补证据」，同一个语义会有多个合法哈希。
4. **publish 仍然要校验**：commit 后的草稿理论上自洽，但 `discard` / 手工改库 / 并发都可能破坏它。所以 publish 前再跑一次同样的检查，代价是一次 SELECT。

## 代价

- 一次 patch 必须**自包含**：新增 `term` 时不能引用「即将在下一笔 patch 里补上的证据」。这逼着人把「观测 + 结论」放在同一笔提交里——这恰恰是想要的形状。
- 一条 evidence 引用多个 term 时，删 evidence 必须同时删/改那些 term，否则 commit 会被拒。这是对的，但要写进技能里（已写）。

## 反例（为什么不选另一种）

「先攒草稿、最后统一校验」听起来更宽容，但它把「什么时候算完成」从数据结构里抹掉了——而「一个版本就是一个自洽的语义快照」正是这个项目对 agent 的核心承诺。

## 验证

- `_check-store.mjs`：无接地 `term` 被拒（报 `does not validate` / 找不到 evidence）。
- `_check-plugin.mjs`：`evo_commit` 引用不存在的 `ev.missing` → `ok: false` 且不改库。
