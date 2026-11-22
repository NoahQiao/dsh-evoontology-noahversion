# 决策记录（ADR）

每条记录一件事：**当时有几个选项、为什么选这个、代价是什么**。改主意时不要删旧记录，追加新的一条并在旧条目顶部标注「被 000N 取代」。

| 编号 | 决策 | 状态 |
|---|---|---|
| [0001](0001-bundle-over-python-package.md) | 用 DSH bundle + vendored 核心，而不是发 PyPI 包 | 生效 |
| [0002](0002-stage-core-into-dsh-home.md) | 激活时把核心铺到 `$DSH_HOME`，而不是直接在原地跑 | 生效 |
| [0003](0003-skills-via-js-not-config.md) | 技能由 JS 插件注册，而不是配置型 MCP bundle | 生效 |
| [0004](0004-sidebar-right-seat.md) | 面板坐右侧栏，不坐左侧栏 | 待实现 |
