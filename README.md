# Agent

[简体中文](README.md) | [English](README.en.md)

基于真实 Cordis 运行时的本地 Agent，面向离线内网使用，最低支持 Windows 7 SP1 x64。模型可部署在内网服务器；文件、命令和工作区操作由 Agent 服务所在机器执行。

产品原名为 DSH Agent，仓库目录沿用 `dsh-win7-agent`。旧用户目录迁移与数据保护规则见交付文档。

## 功能

- 流式对话、多会话、历史记录、取消执行与上下文压缩。
- 工作区文件读取、写入、编辑、搜索与本地命令执行，经过权限和人工审批边界。
- 工作流画布、节点配置、人工处理、执行实例、定时任务和产物归档。
- SQLite 知识库、文档导入、检索和版本记录。
- 内置文档 MCP 提供基础 Word、Excel 读写；支持可信本地 stdio 和内网 Streamable HTTP MCP 服务。
- Skill 按需加载，以及由 Cordis 管理生命周期的工具和运行时插件。
- 桌面默认启动并管理本机 Agent 服务，也可在服务设置中连接内网远程服务。

MCP、Skill 和插件是否可用取决于启用状态、权限、运行环境及实际调用结果。内置 Excel 工具保存公式但不计算公式；文档工具不等同于完整 Office 排版引擎。

## 兼容与离线边界

交付运行时固定为 **Electron 22.3.27 / Node 16.17.1 / Chromium 108**。不得自动升级、增加未经授权的生产依赖或在目标机下载运行组件。客户端资源随包分发，模型和外部工具服务使用配置的可信内网地址。

目标 Windows 机器无需安装 Node.js、npm 或 Python。静态兼容检查、内嵌 Node 测试和 Win7 真机验收必须分别报告，通过构建不代表通过真机验收。

## 开发

构建机使用 Node.js 20.19.5 或更新版本及 npm；这不改变目标机内嵌运行时版本。首次准备依赖和打包工具缓存可能需要网络，离线构建应预先准备这些资源。

```bash
npm ci
npm start
```

在应用设置中配置模型服务的 Base URL、API Key 和模型名称。Base URL 示例为 `http://SERVER:11434/v1`；推荐使用支持工具调用的 OpenAI 兼容 `/v1/chat/completions` 服务。

## 验证

```bash
npm run check
npm run check:node16
npm run check:workflows:properties:browser
npm run check:workflows:canvas:browser
```

根据改动补充相关真实界面、运行时和目标系统验证。`check:node16` 使用 Electron 内嵌 Node 16.17.1 执行测试。

## 构建与交付

```bash
npm run build:desktop:win
# 明确发版时，构建全部五个平台
npm run build:desktop
```

| 平台 | 默认交付入口 |
| --- | --- |
| Windows x64 | `release/desktop/Agent-win-x64/Agent.exe` |
| macOS Apple Silicon | `release/desktop/Agent-mac-arm64/Agent.app` |
| macOS Intel | `release/desktop/Agent-mac-x64/Agent.app` |
| Linux x64 | `release/desktop/Agent-linux-x64/Agent.AppImage` |
| Linux ARM64 | `release/desktop/Agent-linux-arm64/Agent.AppImage` |

Windows 的 `Agent.exe` 是完整离线安装运行入口，安装后使用稳定的程序位置和快捷方式。macOS 的 `.app` 为标准应用包。Linux 需要相应系统依赖与执行权限验证。

每个平台目录仅保留一个交付入口；统一校验文件为 `release/desktop/SHA256SUMS.txt`，中间产物位于 `release/.desktop-build/`。旧 ZIP 仅用于显式指定的内部排查。日常任务不自动递增版本，最终回复提供安装包所在文件夹的可点击绝对路径链接。

默认流水线包含源码压缩、混淆、逐模块保护和清单验证；ASAR 不是加密，内置密钥不保证绝对保密。发布包执行离线授权策略，授权公钥缺失应构建失败。可信在线更新、签名与回滚须独立验收，不能将本地新包接管视为在线更新完成。

## 数据与安全

- 桌面服务数据保存在 Electron 用户数据目录下的 `agent-home`；独立服务使用 `AGENT_HOME`。更新不得覆盖会话、知识库或离线能力包。
- 远程服务模式下，工作区位于服务所在机器；本地文件不会自动变成远程服务器文件。
- 模型会接收任务所需的上下文、文件内容和工具结果；请配置可信模型服务并保留适当的写入与命令审批。
- 恢复会话可以恢复上下文，不会自动重放结果不确定的外部副作用。

## 扩展与架构

契约、纯流程策略、状态 reducer 和上层执行插件分层；Cordis 负责组装和生命周期。新能力通过运行时服务与插件接入，已有工具插件保留兼容适配器。

Skill 是操作指引，MCP 是工具协议，插件提供运行时能力，三者职责不同。离线扩展统一采用 formatVersion 1 清单：`.skill.pgk`、`.mcp.pgk`、`.plugin.pgk`，兼容旧 `.agentpkg`；安装与启用分离。

## 文档与协作

- [项目规则](AGENTS.md)：今后的 Git 提交标题和正文统一使用中文，必要的标识符保留原文；中英文 README 同步维护。
- [架构](docs/ARCHITECTURE.md)
- [Win7 兼容规范](docs/WIN7-COMPAT.md)
- [桌面交付、更新、源码保护与性能](docs/DESKTOP-DELIVERY.md)
- [离线扩展包](docs/EXTENSION-PACKAGES.md)
- [插件开发](docs/PLUGINS.md)
- [软件授权](docs/SOFTWARE-LICENSING.md)
- [独立服务部署](server/README.md)
