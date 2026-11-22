# 上游核心（`python/`）

## 定位与归属

`python/evoontology/` 是 [ruc-datalab/EvoOntology](https://github.com/ruc-datalab/EvoOntology) 的**字节级副本**，版权归上游（MIT）。本仓库只做搬运与打包，不改一行 Python。

- 同步入口：`scripts/sync-from-upstream.ps1`（默认读 `D:\dsworkspace\evoontology`）。
- 溯源文件：`python/UPSTREAM.txt`（upstream 仓库、版本、来源路径、同步时间）。
- 运行位置：`$DSH_HOME/evoontology/python/`（由 `index.js` 铺过去）。

## 契约

### 同步脚本做什么

1. 复制上游 `evoontology/` 到 `python/evoontology/`，排除 `__pycache__/` 与 `*.pyc`。
2. 复制三个技能目录到 `skills/`。
3. 对 `skills/**/*.md` 把 29 个裸工具名改写成 `mcp__evo__<name>`，把 `` `evo-semantic` MCP tool(s) `` 改成 `` `evo` ``。
4. 写 `python/UPSTREAM.txt`。

脚本幂等：重复运行只会在内容有变化时改动文件。**唯一允许手改的地方是 `index.js` / `cordis.patch.yml` / `docs/` / `README.md`。**

### 运行前提

| 项 | 要求 |
|---|---|
| Python | ≥ 3.10（实测 3.14.0 通过）；必须是 PATH 上的 `python`，或用 `DSH_EVOONTOLOGY_PYTHON` 指定 |
| 第三方依赖 | **无**。上游 `pyproject.toml` 的 `dependencies = []`，纯标准库 |
| 网络 | 不需要。上游不发起任何网络请求 |
| 平台 | Windows 优先（本项目实测平台）；Linux/macOS 未验证 |

### 工作区

```text
$DSH_HOME/evoontology/workspace/          # --store 缺省值
└── .evoontology/                         # 上游的容器目录
    ├── versions/<version>/               # 5 类节点 JSON + evidence
    ├── active.json                       # 当前活动版本
    ├── trajectories/                     # 任务轨迹
    ├── evolution/runs/<run_id>/          # 演化运行记录与预算
    └── visualizations/*.html             # 结局浏览器
```

`resolve_workspace()` 只 resolve 不 mkdir；目录在首次写入时创建。

## 扩展位

- **换上游版本**：更新 `-Upstream` 指向的新 checkout，跑脚本，看 `git diff` 里只有内容变化、没有本仓库的改动被吞掉。
- **换解释器**：`DSH_EVOONTOLOGY_PYTHON`。
- **加 Python 侧能力**：**不要**直接改 `python/`。要么提 PR 给上游，要么在本仓库新增一个 Python 模块并在 `cordis.patch.yml` 的 `args` 里切换到它（目前没有这个模块）。

## 不做

- 不修改上游核心的任何文件（含「小修一下 import」）。
- 不做 `pip install`（上游是零依赖；一旦引入依赖，插件会从「零安装」变成「要装 Python 环境 + 装包」）。
- 不把核心发布成 PyPI 包（见 [decisions/0001](../decisions/0001-bundle-over-python-package.md)）。
- 不内置 Python 解释器：体积与平台矩阵成本远超收益。

## 已知限制（继承自上游，非本插件的缺陷）

1. **数据源只有 SQLite 只读回放。**`workflow.py:239 execute_query` 的注释写明 *Built-in bounded SQLite replay; other environments use host tools*——接 MySQL / DuckDB / 数据湖要走 `record_ontology_task_event` 由宿主机执行。
2. **5 类节点固定不可扩展**（Term / Mapping / Relation / Constraint / Evidence，`ontology/models.py` 里是 `@dataclass(frozen=True)`）。
3. **节点类型规则写在 markdown 里**（`skills/*/references/ontology-schema.md`），没有机器校验。
