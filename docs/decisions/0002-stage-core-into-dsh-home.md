# 0002 激活时把核心铺到 `$DSH_HOME`

> **已取代**：原生重写（[0005](0005-native-rewrite.md)）不再有需要铺到 `$DSH_HOME` 的 Python 核心。本文保留为决策历史。

- 日期：2026-11-22
- 状态：生效

## 背景

MCP 行的 `cwd` 必须是绝对路径，且必须指向含 `evoontology/` 包的目录。`cordis.patch.yml` 里的 `!!js` 表达式可以求值，但能拿到的东西有限：DSH 文档只保证 `dshHomePath(segment)` 这个助手，以及 `process.env`。

## 选项

| 方案 | 优点 | 代价 |
|---|---|---|
| A. `cwd: !!js process.env.DSH_PROFILE_DIR + '/node_modules/@noah/dsh-evoontology/python'` | 不复制 | 强依赖安装布局（link / pnpm 符号链接 / 打包方式一变就坏）；测试时没法在别的目录跑 |
| B. `cwd` 写仓库绝对路径 | 最直接 | 完全不可移植，换机器/换目录即废 |
| C. 激活时把 `python/` 复制到 `$DSH_HOME/evoontology/python`，`cwd` 用 `dshHomePath('evoontology/python')`（选中） | 配置只含相对 `$DSH_HOME` 的路径；link 安装、移动仓库都不影响 | 多一份磁盘副本（700KB）；升级后需重新激活才更新；卸载要手动清 |
| D. 用 `PYTHONPATH` 环境变量把包目录挂进 `sys.path`，`cwd` 随便 | 不复制 | 仍要给出一个绝对路径给 `PYTHONPATH`，问题只是挪了个位置；而且 mcp-client 会清洗子进程环境变量 |

## 决策

选 **C**。`index.js` 的 `stagePython()` 比较 `python/UPSTREAM.txt` 与已铺副本的 `UPSTREAM.txt`，不一致才 `cpSync`，幂等；`apply` 里同步执行，保证 MCP 行的 `cwd` 一定已就绪（这也是 patch 里 skills 行排在 MCP 行之前的原因）。

## 理由

把「路径」这个不可靠的输入，换成「`$DSH_HOME` + 固定相对路径」这个确定的输出。`$DSH_HOME` 是 DSH 自己管理的目录，卸载插件时用户能明确知道该删哪里。

## 代价与缓解

- **多一份副本**：700KB，可接受。
- **升级要重新激活**：README 写明「改完核心后重装 / 重启」。
- **卸载不自动清理**：DSH 的 `remove_bundle` 不删插件运行期数据（这是一条通用规则，见项目记忆），README 给出 `Remove-Item -Recurse -Force "$HOME\.dsh\evoontology"`。
- **可能铺到只读的 HOME**：失败时只记日志、不抛异常——技能仍可注册，工具调用会报错，比整个插件不可用更好。
