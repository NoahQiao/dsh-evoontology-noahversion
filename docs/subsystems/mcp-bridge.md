# MCP 桥（`evo` 行）

## 定位与归属

一条 `@deepseek-ai/dsh-mcp-client` 配置行，把上游的 MCP 服务挂进 DSH 的工具表。它是**唯一**向 agent 暴露工具的地方：插件自己的 `index.js` 不注册任何工具。

- 声明位置：`cordis.patch.yml` 第二行，`id: evoontology-mcp`。
- 实现归属：DSH 官方 `@deepseek-ai/dsh-mcp-client`，本仓库不 fork。
- 子进程归属：本仓库 `python/evoontology/`（经 `index.js` 铺到 `$DSH_HOME` 后运行）。

## 契约

| 配置项 | 取值 | 为什么 |
|---|---|---|
| `serverName` | `evo` | 决定工具名前缀 `mcp__evo__*`；技能里的改写也基于它，改名要同步改 `scripts/sync-from-upstream.ps1` |
| `transport` | `stdio` | 上游 `mcp_server.py` 是手写 stdio JSON-RPC，不支持 HTTP |
| `command` | `!!js process.env.DSH_EVOONTOLOGY_PYTHON \|\| 'python'` | 允许用环境变量换解释器，不必改文件 |
| `args` | `-m evoontology.runtime.mcp_server --store <dshHomePath('evoontology/workspace')>` | `python -m` 会把 cwd 放进 `sys.path`，所以不需要 `PYTHONPATH`；`--store` 只是**缺省工作区** |
| `cwd` | `!!js dshHomePath('evoontology/python')` | 必须指向含 `evoontology/` 包的目录，否则 `-m` 找不到模块 |
| `env` | `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1` | Windows 控制台默认 GBK，中文节点名会乱码或直接 `UnicodeEncodeError` |
| `toolCallTimeoutMs` | `300000` | 建/演进本体跑真实查询并重写工作区，远超一次 fetch |
| `startupTimeoutMs` | `30000` | Python 冷启动 + 导入 |
| `failOnStartupError` | `false` | Python 不在 PATH 时不能让整个 profile 起不来；失败留到首次工具调用再报 |
| `reconnect` | `enabled`，500ms→30s，10 次 | 上游进程被 OOM 杀掉或解释器被换掉时自愈 |

### 工具命名

DSH 把 MCP 工具名规范化为 `mcp__<serverName>__<rawName>`，因此 29 个工具在会话里叫 `mcp__evo__browse_semantics` 等。上游技能正文里写的是裸名（`browse_semantics`），同步脚本按**名字长度降序**整体替换，避免 `resolve_semantics` 与 `resolve_ontology_task` 这类前缀互相吞掉。

### 工作区参数

29 个工具全部接受 `workspace`（绝对路径 / `.evoontology` 容器 / 项目根）。`--store` 只是省略该参数时的兜底。语义：`evoontology/workspace.py:35 resolve_workspace()` 只做 `resolve()`，**不 mkdir**，目录在首次写入时才创建，所以传一个还不存在的 `--store` 是安全的。

## 扩展位

- **换解释器**：`DSH_EVOONTOLOGY_PYTHON`。
- **换工作区**：调用工具时显式传 `workspace`，比改 `--store` 更局部。
- **加参数**：直接在 `args` 里追加；上游 `main()` 只认 `--store` 与 `--version`。

## 不做

- 不做 `streamable-http` 传输：上游没有 HTTP 监听。
- 不做工具白名单/裁剪：29 个全给。上游 Claude Code 插件只宣传 2 个读写工具，那是**技能层的话术约束**，不是服务端能力；在 DSH 里由技能正文决定「先用哪个、什么时候用」，而不是由传输层阉割能力。
- 不把 `--version` 写进 `args`：留空表示跟随工作区当前活动版本，硬编码会把版本钉死在配置里。
