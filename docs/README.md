# 文档

本目录按 DSH 上游仓库的惯例组织：**每个子系统一篇四段式契约文档**（定位与归属 / 契约 / 扩展位 / 不做），取舍写 ADR，进度写路线图。

先写清楚、再写代码。与代码不一致时，契约文档优先，代码是 bug。

## 怎么读

| 你想知道 | 读这篇 |
|---|---|
| 这东西是什么、为什么这样分层 | [architecture.md](architecture.md) |
| 语义存在哪、版本怎么保证不自相矛盾 | [subsystems/store.md](subsystems/store.md) |
| 模型能调什么、返回长什么样 | [subsystems/tools.md](subsystems/tools.md) |
| 查数为什么只读、超时怎么掐掉 | [subsystems/query.md](subsystems/query.md) |
| 技能怎么被注册、为什么只有三份 | [subsystems/skills.md](subsystems/skills.md) |
| 插件怎么接进宿主、环境变量有哪些 | [subsystems/host-plugin.md](subsystems/host-plugin.md) |
| 右栏标签页怎么挂、为什么它不读数据库 | [subsystems/client-sidebar.md](subsystems/client-sidebar.md) |
| 为什么重写掉了 Python 版本 | [decisions/0005](decisions/0005-native-rewrite.md) |
| 接下来做什么 | [roadmap.md](roadmap.md) |
| 更远的形态（提案，非现状） | [native-redesign.md](native-redesign.md) |

## 约定

1. **四段式**：定位与归属 → 契约 → 扩展位 → 不做。第四节必须写，它是防止文档变成愿望清单的唯一手段。
2. **状态标注**：ADR 顶部写「已实现 / 提案 / 已取代」。`native-redesign.md` 是提案，与代码不一致是正常的。
3. **只写契约与边界**：生成式的清单（配置枚举、工具全表）由代码定义，不在这里重复。
4. **验证分开写**：已验证的和没验证的分段，不要把「跑通一次」写成「已验证」。

## 目录

```
docs/
├── README.md            你在这里
├── architecture.md      分层、组件职责、数据流、边界
├── native-redesign.md   原生重写的完整设计提案（含数据模型与阶段）
├── roadmap.md           P0–P4 进度与判据
├── subsystems/
│   ├── store.md         存储层契约（版本 / 节点 / 任务与事件）
│   ├── tools.md         工具面契约（11 个工具）
│   ├── query.md         只读执行器契约（闸门 / 白名单 / 上限 / 超时代价）
│   ├── skills.md        技能面契约
│   ├── host-plugin.md   Host 插件生命周期与环境变量
│   └── client-sidebar.md 右栏标签页契约（加载形态 / 座位 / 命令桥）
└── decisions/
    ├── 0001 … 0002      已取代（MCP 桥 + 铺 Python 核心）
    ├── 0003             技能必须由 JS 注册（仍成立）
    ├── 0004             面板坐右侧栏（P2 已实现）
    ├── 0005             原生重写
    ├── 0006             单文件 SQLite
    └── 0007             接地在 commit 时校验
```
