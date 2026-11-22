# 技能（ctx.skills）

## 定位与归属

DSH 的技能目录（skill catalog）是 agent 发现能力的唯一入口：技能摘要进系统提示，正文按需加载。上游把能力教给 Claude Code / Codex 靠的是 `SKILL.md` 约定；DSH 有同名但**不同形状**的契约，必须由 Host 插件用 `ctx.skills.registerProvider` 注册，配置文件挂不上。

- 实现：`index.js` 的 `createProvider()` / `candidateOf()` / `splitFrontMatter()`。
- 内容：`skills/{build-ontology,evolve-ontology,explore-ontology}/SKILL.md`（上游副本 + 工具名改写）。
- 归属：注册代码属于本插件；正文内容属于上游。

## 契约

`ctx.skills.registerProvider(create)` 接收一个工厂，返回注销函数；工厂拿到的 `control` 是 `{ signal, invalidate }`。provider 形状：

```js
{
  name: 'evoontology',
  async list() -> { candidates, complete: true },
  async get(candidate) -> { ...summary, content } | undefined,
}
```

每个 candidate 必须提供 `SkillSummary` 的字段，外加 `rank` 与 `locator`：

| 字段 | 本仓库取值 | 说明 |
|---|---|---|
| `name` | `SKILL.md` front matter 的 `name` | 缺省回落目录名 |
| `description` | front matter 的 `description` | **决定 agent 是否在正确时机命中**，是这段代码里最关键的一个字段 |
| `whenToUse` | front matter 有则带上 | 可选 |
| `invocation` | `{ modelInvocable: true, userInvocable: true }` | 用户也能 `/build-ontology` 直接点 |
| `source` | `'bundled'` | 随 bundle 交付 |
| `provider` | `'evoontology'` | 用于界面分组 |
| `path` | `skills/<dir>/SKILL.md` 绝对路径 | 用户在技能面板能看到来源 |
| `resourceBase` | `{ kind: 'directory', path: skills/<dir> }` | 让 `references/*.md` 可被读物机制打开 |

`list()` 返回 `{ candidates, complete: true }` 表示「这就是全集」，DSH 不会再去找别的 provider 补。`get(candidate)` 按 `candidate.locator`（本仓库就是 SKILL.md 路径）返回正文；正文是去掉 front matter 之后的部分。

### front matter 只支持标量

`splitFrontMatter()` 用 `/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/` 截块，然后逐行按第一个 `:` 切 `key: value`，并剥掉成对引号。**不支持** 块标量（`|` / `>`）、数组、嵌套。上游三个 SKILL.md 恰好都是单行 `name:` + `description:`，所以够用；如果将来上游改成块标量，这里会静默截断——那时应当引入真正的 YAML 解析，而不是继续加正则。

## 扩展位

- **加技能**：往 `skills/` 放目录，并把目录名加进 `SKILL_DIRS`（顺序即目录顺序）。不扫描目录是刻意的：技能名字进系统提示，多一个就多一份提示预算。
- **换 provider 名**：改 `PROVIDER`，会改变界面里的分组标签。
- **`get()` 的懒加载**：目前每次调用都读盘；若将来 SKILL.md 变大，可加内存缓存 + `control.invalidate` 失效。

## 不做

- 不把 `references/*.md` 也注册成技能：它们是技能正文的附件，靠 `resourceBase` 暴露。
- 不用 `ctx.systemPrompt.section` 手写一段「本插件能干什么」：同层重名或 `order` 非有限值会直接抛错，且与技能目录重复。
- 不在注册失败时中断插件：单个目录读失败只 `log` 并跳过（`list()` 里的 `try/catch`），否则一个坏文件会让三个技能全没了。
