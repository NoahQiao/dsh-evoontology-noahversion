# 0001 用 DSH bundle + vendored 核心，而不是发 PyPI 包

> **已取代**：原生重写（[0005](0005-native-rewrite.md)）删掉了 MCP 桥与 Python 核心。本文保留为决策历史，其中的形态已不存在。

- 日期：2026-11-22
- 状态：生效

## 背景

上游 EvoOntology 的「原味」交付方式是 `pip install` 一个包，再让宿主把 MCP 服务起起来。DSH 的插件单位是 bundle（`package.json` + `cordis.patch.yml`），一次 `plugin_manager install_bundle` 就能装上。

## 选项

| 方案 | 优点 | 代价 |
|---|---|---|
| A. 发 PyPI 包（`evoontology`），DSH 侧只留 MCP 配置 | 版本管理干净、核心唯一来源、别人也能用 | 用户要先 `pip install`；plugin_manager 装完还不能用，得再装一次 Python 包；离线/内网机器基本废掉 |
| B. bundle 内 vendored 核心（选中） | 一次安装即用，零 Python 依赖，离线可用 | 核心是副本，与上游版本会漂移；包体积 700KB；上游修 bug 要手动同步 |
| C. 运行时 `git clone` 上游 | 永远最新 | 要网络、要 git、版本不可复现，且用户环境不可控 |

## 决策

选 **B**。核心复制进 `python/`，由 `scripts/sync-from-upstream.ps1` 搬运，`python/UPSTREAM.txt` 记录版本，`git diff` 就是升级审阅面。

## 理由

本插件的目标读者是**已经装了 DSH 的人**，他们的机器上不一定有可用的 Python 包管理环境。相比之下，上游的核心是零依赖纯标准库，复制成本极低（700KB，28 个文件），把「复制」换成「让用户再装一套东西」不划算。

## 代价与缓解

- **漂移**：同步脚本幂等，升级 = 跑脚本 + 看 diff + 提交；`UPSTREAM.txt` 让「当前是哪个版本」永远可查。
- **无法享受上游的 pip 生态**：上游本来也没有生态（零依赖）。
- 若将来上游把核心拆成多个包、或开始引入依赖，这条决策要重审。
