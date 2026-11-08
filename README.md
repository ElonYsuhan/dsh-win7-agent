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

### 模型网络与代理

模型列表、OpenAI 兼容聊天和 Ollama 请求使用 **Agent 服务所在机器**的网络：优先读取显式环境变量，其次使用 macOS 或 Windows 当前用户的手动 HTTP/HTTPS 系统代理；Linux 使用环境变量。变量依次为 `AGENT_MODEL_PROXY`、`AGENT_HTTPS_PROXY` / `AGENT_HTTP_PROXY`、`HTTPS_PROXY` / `HTTP_PROXY`（及对应小写形式）、`AGENT_PROXY`、`ALL_PROXY` / `all_proxy`。值可为 HTTP 或 HTTPS 代理地址；`direct` / `off` 表示显式直连，空值忽略。无模型界面代理设置；系统代理仅读取主机和端口，不会自动读取系统钥匙串或集成代理认证。系统代理变化在短缓存期后生效。

回环、私有 IP、单标签主机名、`.local`、`.home.arpa` 和 `NO_PROXY` / `no_proxy` 列表始终直连；系统代理的例外列表也会用于系统代理配置。其他解析到私有 IP 的域名不会自动判定为内网，请加入例外列表。代理错误、无法读取系统配置以及已识别但不支持的 PAC/WPAD 或纯 SOCKS 配置会报错，不保证识别 Windows 的所有自动检测设置；这些场景需配置受信任的 HTTP(S) 代理或使用经过验证的系统网络方案。Linux 桌面代理、Windows WinHTTP、MCP/工具/浏览器及其他应用不由此适配器接管。

HTTPS 模型请求经 CONNECT 保留目标服务器的 TLS 证书与主机名验证；HTTP 明文模型请求可能被代理读取，请勿用于传输敏感信息。内网代理与模型服务须自行信任并正确配置证书，不能关闭证书校验。

### 会话中的模型断线重连

Agent 会话中的模型请求遇到临时连接中断、TLS 握手断开、响应流中断、超时及 HTTP 408/502/503/504 时，默认最多自动重试 5 次（每个模型步骤最多 6 次请求，等待间隔依次为 1、2、4、8、16 秒；请求耗时另计）。界面显示重连进度，可随时停止；整轮期限和无人值守任务的请求、令牌、输出预算仍生效。密钥错误、证书错误、代理配置错误、HTTP 429 等不自动重试。达到上限会结束当前轮并提示，但会话和已完成的工具结果保留，可在网络恢复后继续。

重连重新发起**当前模型请求**，不是接续服务器原来的字节流；未完成的正文或工具调用片段会丢弃，不会自动重放已完成的工具步骤。OpenAI 兼容 SSE 须以 `[DONE]` 或 `finish_reason` 完成，Ollama 流须以 `done: true` 完成，否则视为中断。服务端可能已处理或计费失败前的模型请求，重试可能产生额外费用；模型后续仍可能自主提出新工具调用，不能把它当作跨崩溃的严格恰好一次执行保证。此机制只覆盖 Agent 会话内的模型请求，不接管模型列表、MCP、浏览器或其他应用的网络连接。

### 生成式界面

P0–P4 源码已接通：有界 Surface/Component/State/Action 协议、混合消息、版本化会话事实、Vue/Naive UI/ECharts 渲染、交互参数持久化、统一确认、Agent 回传、流式修订、取消与恢复。普通产品在发送前声明当前渲染器支持的版本和组件，模型只会收到对应工具与规范；没有渲染能力时保持纯文本，不暴露 `render_ui`/`update_ui`。旧 v1 消息继续读取，v2 新增筛选器、表格、进度、流程图、离线地图和静态沙箱页面；生成的 HTML/SVG/CSS 可直接显示在聊天消息内，脚本、表单、外链和网络访问被禁用。未知未来版本仍按不透明数据保留且不执行。

地图使用用户明确授权的固定 `cesium@1.104.0` 离线包，仅显示无影像、无地形的椭球和地点标记，并随包固定本地 IAU 数据；WebGL 不可用或上下文丢失时明确降级为经纬度示意图。Vue、Naive UI、ECharts、Vite、Vue 插件、TypeScript 和 Cesium 均为固定开发依赖，实际浏览器代码离线分发并保留第三方许可；根 `@types/node` 已按明确授权恢复为 `16.18.126`。隔离 Electron 22.3.27/Node 16.17.1/Chromium 108 已覆盖真实组件、业务选择、地图与降级、窄屏触控、CSP 和离线资源，但尚未完成 Win7 真机、Android WebView、操作系统输入法及屏幕阅读器验收。交互按钮仍需服务端定义匹配、参数已保存且会话空闲，后续工具沿用原权限与审批。详见 [生成式界面协议](docs/GENERATIVE-UI.md)。

## 验证

```bash
npm run check
npm run check:node16
npm run typecheck:core
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

## 从仓库获取安装程序

仓库镜像目录提供 [Windows x64 离线安装程序](installers/Agent-win-x64/Agent.exe)和 [macOS Apple Silicon 应用](installers/Agent-mac-arm64/Agent.app)。各平台构建来源可能不同，以 [安装程序说明和构建记录](installers/README.md)为准。Mac 应用内的 Electron 文件超过 GitHub 普通 Git 推送的单文件大小限制，远程分发需另行解决；本目录不使用 LFS 指针。

桌面三层防护、独立发布代码签名及授权申请短标识的实现与限制见 [桌面安全说明](docs/DESKTOP-SECURITY.md)。构建前需在构建机初始化独立发布签名身份：`node scripts/desktop/release-signing.js init`；私钥仅留在构建机，不进入安装包。正式系统证书签名和可信在线更新仍需单独配置与验收。

授权签发工具支持桌面与内网浏览器统一登录，固定账号 `admin` / `admin123`，不提供注册。服务和私钥保留在签发电脑，登录后可查看内网访问地址；关闭工具即停止服务。详见 [软件授权](docs/SOFTWARE-LICENSING.md)。

工作流画布随侧栏和属性面板尺寸变化同步重绘，保持节点位置与视角；流程页面隐藏顶部会话/项目名称，返回聊天后恢复。整理布局不弹成功通知；流程引用栏和消息输入区采用无边框的柔和底色，适配深浅主题。

新建流程默认自带开始与结束节点并连好一条线，创建后可直接保存；需要从零搭建时在「更多创建方式」里选「空白流程」。画布左侧工具条提供「连接线」与「驳回线」两个图标：前者从端口拖出普通流转线，后者从节点或连线拖到上游的人工环节松开，即添加一条驳回线；点击连线后右侧的「连线设置」与连线右键菜单也能设置同一目标。连线级目标优先于节点级设置，删除被引用的人工环节会自动清理引用。

内置 `workflow-process-designer` 业务流程设计 Skill：以固定版本的 Camunda 官方 BPMN Skill 与 OMG BPMN 2.0.2 建模原则为依据，适配本地审批、驳回补正和重提契约。AI 调用流程目录时按需取得指南；能力中心可停用。支持标准 `.skill.pgk` 离线包，来源、许可和能力边界见 [流程设计规范](docs/WORKFLOW-DESIGN-SKILL.md)。

内置 `workflow-suggestion` 流程匹配 Skill：会话里讨论或准备实施某件事时，按目标、步骤、人工环节、交付产物四道关与已保存流程比对，确认匹配才用 `workflow_suggest` 在消息里给出「开启工作流」卡片，并写明覆盖点与缺口。推荐是只读操作，不改流程定义、不创建实例；用户点击后才发起执行并直接进入该流程的执行实例页面。

条件分支按有序规则选择一路并提供默认出口，汇合节点接收当前有效路径；驳回补正后重新选路并保留历史。未选路径不会执行，暂不支持并行会签或角色审批权限。

授权签发工具的内网地址支持点击打开和逐条复制，便于分享给内网管理员。

AI 流程设计保存后直接提供“编辑流程”和“发起流程”入口；发起后进入真实执行实例的人工待办，不自动通过审批。

界面通用边框与分隔线采用更淡的中性色，深浅主题统一适配。

流程连线统一从蓝色输出端过渡至绿色输入端，端口贴合卡片边缘，编辑图与执行图采用同一颜色方向。

流程图以带箭头的实线显示正向分支，条件出口在线上标注分支名称，避免将跳过审批误认为驳回。驳回退回路径只在人工节点显式指定退回目标后，才以标注“驳回→目标”的虚线画出；未指定时运行时仍退回最近的上游人工办理环节，但画布不自动派生虚线，避免每条顺序连线都被读成驳回。

画布右键按目标给出操作：空白处是「恢复100%」和「适应全部」，卡片上是删除该节点及其全部连线，连线上是删除该条连线；删除只改当前草稿，保存后才生效。
