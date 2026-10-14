# 桌面菜单、独立顶栏与跨平台检查（0.1.1）

检查日期：2026-10-14（Asia/Shanghai）。目标运行时：Electron 22.3.27 / Node 16.17.1 / Chromium 108。

## 本次修改

应用统一使用独立的 48px 顶栏。应用图标、会话/项目标题、侧栏开关、刷新、打开链接及文件面板开关在顶栏中排列；侧边栏、聊天区、文件面板均从顶栏下方开始，不再使用覆盖在内容之上的透明拖拽带。

- macOS 保留左侧原生红黄绿，顶栏为其预留 88px。
- Windows 使用右侧自绘最小化、最大化/还原、关闭按钮，兼容 Win7，不依赖 titleBarOverlay。
- Linux 读取 GNOME/KDE 窗口按钮左右偏好；读取失败时使用右侧。左右两种布局均为 132px 控制组预留 144px，图标与页面按钮使用独立布局。
- 启动、离线、更新、服务设置页也使用同一顶栏。只看文件时保留顶栏，提供“返回聊天”入口。
- 最大化图标和可访问名称随窗口状态切换；按钮可用键盘聚焦，拖拽区不拦截按钮点击。双击顶栏在 Windows/Linux 切换最大化；macOS 尊重系统偏好。

修正上一版 macOS 原生菜单没有真正清除的问题。Electron 22 的 macOS 实现对 `setApplicationMenu(null)` 直接返回，因此仅检查 `getApplicationMenu() === null` 不足以证明原生菜单已清除。本次改用空菜单实例替换，Windows/Linux 继续移除菜单对象。[Electron 菜单实现](https://raw.githubusercontent.com/electron/electron/v22.3.27/lib/browser/api/menu.ts)

首次直接聊天、会话持久化、事件流建连、原生文件/链接桥接、中文目录选择和独立终端等上一轮修复继续保留。

## 验证结果

默认 `check` 的全部 17 个阶段使用 Electron 22 内置 Node 16.17.1 运行通过，包含语法、Win7 兼容性、设置迁移、自验证、插件和 Agent 检查。

| 检查 | 结果 | 覆盖 |
| --- | --- | --- |
| 渲染层行为 | 344/344 | 原有 UI/首会话/会话恢复、动态标题、展开状态、返回聊天 |
| 顶栏静态契约 | 78/78 | 独立 header、内容高度、各平台按钮空间、全部窗口入口 |
| 窗口控制 | 78/78 | 最小化/最大化/还原/关闭、Linux 左右偏好、两个 preload 与状态推送 |
| Electron 22 菜单与编辑快捷键 | 10/10 | 先安装旧 Agent/Edit/Service/View 菜单，再替换；输入框与编辑器全选、撤销、重做 |
| Electron 22 几何与功能回归 | 754/754 | 80 种布局、命中测试、无重叠、原生窗口操作，以及原编辑器/终端/滚动/拖宽回归 |
| 真实首次直接聊天 | 19/19 | 无项目/无会话，自动建会话、运行收尾、第二轮上下文、双端保存、刷新恢复 |
| HTTP 桥接 | 15/15 | SSE 首次建连、并发收尾、原生目录与链接 |
| 平台分支模拟 | 36/36 | Windows/Linux 路径、shell 参数、换行、输出字节、多终端、目录选择和包依赖 |
| UI 存储 / 服务管理 / 安装器 | 17/17、21/21、57/57 | 存储、服务生命周期及更新流程 |
| 会话并发 / HTTP 并发 | 25/25、22/22 | worker 和事件归属 |

80 种布局输入：macOS 原生按钮预留、Windows 右侧、Linux 左侧、Linux 右侧 × 640/1000px 窗口 × 深/浅主题 × 正常/侧栏折叠/面板打开/折叠加面板/只看文件。所有布局均未发现窗口按钮、应用图标或操作按钮之间的碰撞；内容区不进入顶栏。

实际原生运行验证为 macOS。Windows/Linux 通过平台逻辑与 Chromium 中的布局模拟检查；尚未在 Windows/Linux 真机上验证原生窗口管理器行为。macOS 原生红黄绿属于系统视图，webContents 截图不包含它们，已检查其预留区域。

检查使用隔离临时目录；聊天只调用本机模型替身，没有读取模型密钥或修改用户设置。

## 新版产物

四个平台的 ZIP 均已构建。包内 16 个相关运行文件与最终源码逐字节一致；所有包的版本为 0.1.1；macOS 的 ad-hoc 签名通过 `codesign --verify --deep --strict`。

| 平台 | ZIP |
| --- | --- |
| Windows x64 | `release/desktop/Agent-win-x64-0.1.1.zip` |
| macOS ARM64 | `release/desktop/Agent-mac-arm64-0.1.1.zip` |
| Linux x64 | `release/desktop/Agent-linux-x64-0.1.1.zip` |
| Linux ARM64 | `release/desktop/Agent-linux-arm64-0.1.1.zip` |

解包目录也带版本号，例如 `Agent-mac-arm64-0.1.1/`。构建没有覆盖当前登记的旧版应用目录。完全退出旧版后打开新版；仅重复点击已运行的旧版会聚焦旧窗口，不会重新加载主进程代码。

布局截图、几何记录和运行日志位于 `release/validation/`。服务设置入口为 macOS `Cmd+,`，Windows/Linux `Ctrl+,`。

复跑默认检查：`npm run check`。窗口检查：`npm run check:menu:runtime`、`npm run check:drag`；首次聊天：`npm run check:first-chat`。受限环境中真实窗口测试可按已有脚本要求设置 `SMOKE_NO_SANDBOX=1`，并允许隔离测试服务监听本机端口。
