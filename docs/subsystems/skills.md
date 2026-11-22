# 技能 `lib/skills.js`

## 1. 定位与归属

技能不是工具目录，是**判据**：什么时候该用、用了算什么算对、什么情况下不许做。

工具名和参数由 `ctx.tools.schemas` 自然可见，技能的正文只写那些「不写下来 agent 一定会做错」的东西。所以三份 SKILL.md 加起来不到 200 行，且刻意不罗列工具清单。

## 2. 契约

```
skills/<dir>/SKILL.md   →   一个 SkillCandidate
```

- 目录名固定三项：`build-ontology`、`use-ontology`、`evolve-ontology`（顺序即目录里的声明顺序）。
- front matter 只解析标量：`name`、`description`、`whenToUse`（都必填；不做 block scalar，不做嵌套）。
- `list()` 返回 `{candidates, complete: true}`，每个 candidate 带 `name / description / whenToUse / invocation{modelInvocable, userInvocable} / source:'bundled' / provider:'evoontology' / path / resourceBase{kind:'directory', path} / rank / locator`。
- `get(candidate)` 读同目录 `SKILL.md` 的正文（front matter 之后）返回 `content`。
- 注册方式：`ctx.effect(() => ctx.skills.registerProvider(() => createSkillProvider(log)))`。

## 3. 三份技能的分工

| 技能 | 回答的问题 | 不做什么 |
|---|---|---|
| `build-ontology` | 先看什么、记什么、怎么算记对了 | 不讲查询技巧 |
| `use-ontology` | 写查询之前必须检索什么、回答里必须带什么 | 不教建本体 |
| `evolve-ontology` | 分歧从哪来、patch 怎么写、什么算「变好了」 | 不假装有自动演化 |

三份都写明「提交 ≠ 生效」和「发布要人确认」——这是整个设计里最容易在对话中被忽略的一条。

## 4. 已知限制

- front matter 解析器只认 `key: value` 单行。想写 `description: |` 多行块就得引真 YAML（会多一个依赖或一段手写解析，暂不划算）。
- `resourceBase` 指向目录而不是 `SKILL.md`，所以技能正文里引用 `references/*.md` 需要相对路径（P0 的三份技能没有 references）。
- 技能目录在 `apply` 时静态扫描一次；运行中新增目录不会出现（要重装或重启）。

## 5. 不做

- 不通过 `ctx.systemPrompt.section` 注入技能内容：那会把正文压进每个会话的开头，和「按需检索」的设计相反。
- 不给每个工具写一份技能：工具契约属于 `docs/subsystems/tools.md`，不是给模型看的。
- 不在技能里写死路径：store 位置由环境变量决定，技能只说「用户的数据」。
