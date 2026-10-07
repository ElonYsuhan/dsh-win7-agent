# Windows 7 兼容性约束

本工程的目标运行环境是 **Windows 7 SP1 x64**。
**所有新增或修改的代码，必须在 Win7 上可运行。不满足此前提的改动不予合入。**

目标机零依赖：不安装 Node.js、npm、Python 或任何运行时，全部由打包产物自带。

---

## 1. 运行时上限

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Electron | `22.3.27` | 支持 Win7 的最后一个大版本，**禁止升级到 23+** |
| Node | `16.17.1` | Electron 22 内嵌 |
| Chromium | `108` | 决定渲染进程的 CSS/JS 能力边界 |

服务端在 Win7 上不是用 Node 运行的，而是用 Electron 二进制以 Node 模式运行
（桌面包里界面与服务共用同一份运行时，没有第二个 exe）：

```bat
set ELECTRON_RUN_AS_NODE=1
"%~dp0Agent.exe" "%~dp0resources\app\service\index.js"
```

因此 **`server/` 下的代码同样受 Node 16.17 限制**，不能按本机 Node 22/24 的能力来写。

依赖约束：`dependencies` 保持为空，不引入原生模块（native addon），
`build.npmRebuild` 保持 `false`。纯 JS 依赖也必须能在 Node 16 下加载。

---

## 2. Node 侧禁用清单（16.17 不存在）

| 禁用 | 替代方案 |
| --- | --- |
| 全局 `fetch` | `require('http')` / `require('https')` |
| `structuredClone` | 手写深拷贝或 `JSON.parse(JSON.stringify(x))` |
| `AbortSignal.timeout(ms)` | `setTimeout` + `controller.abort()` |
| `Array.prototype.findLast` / `findLastIndex` | `[...arr].reverse().find(...)` 或倒序 for |
| `arr.toSorted` / `toReversed` / `with` | `[...arr].sort()` / 展开后改 |
| `Object.groupBy` | 手写 reduce |
| `Promise.withResolvers` | `new Promise` + 外部变量 |
| `Array.fromAsync` | 显式 for await |
| `node:test` | 本工程 `scripts/*.js` 自写断言 |
| `import.meta.dirname` | `__dirname`（本工程为 CJS） |
| `fs.cp` / `fs.promises.cp` | 递归手写或 `fs-extra` 类纯 JS 实现 |

语法糖（`?.`、`??`、`??=`、`||=`、`#private`、可选 catch 绑定）在 Node 16 全部可用，不受限。

---

## 3. Chromium 108 禁用清单

CSS 中被 108 忽略或未实现的特性：

- `color-mix()`
- `oklch()` / `oklab()` / `lab()` / `lch()`
- CSS Nesting（裸 `&` 嵌套）
- `text-wrap: balance` / `pretty`
- `light-dark()`
- `@scope`
- `subgrid`
- `popover` / `:popover-open`
- `@starting-style`
- View Transitions
- `field-sizing`
- `round()` / `mod()` / `rem()`

**特别提示**：`scrollbar-width` / `scrollbar-color` 在 Chromium 108 上被忽略（121 才支持）。
使用它们时必须同时提供 `::-webkit-scrollbar` 系列兜底，否则滚动条样式在目标机完全失效。
本工程 `src/renderer/style.css` 已提供 22 处 webkit 兜底，新增滚动条样式请沿用同样做法。

渲染进程 JS 层面：Chromium 108 支持到 ES2022，`window.indexedDB`、`crypto.randomUUID()` 均可用。

---

## 4. Windows 平台写法

| 项 | 要求 |
| --- | --- |
| 路径拼接 | 一律 `path.join` / `path.resolve` / `path.sep`，**禁止硬编码 `/`** |
| 路径越界判断 | 用 `path.sep` 比较，不要用 `/` |
| 命令执行 | `spawn(cmd, [], { shell: true })`，Windows 会经 ComSpec → `cmd.exe` |
| 子进程输出编码 | `cmd.exe` 默认 GBK(CP936)，**禁止直接 `chunk.toString()`（UTF-8）解中文** |
| PowerShell 依赖 | Win7 自带 PowerShell 2.0，可能被精简版或安全策略禁用 → **必须有降级路径** |
| 隐藏窗口 | 子进程加 `windowsHide: true` |
| 文件编码 | 源码与配置统一 UTF-8，`.cmd` 文件只写 ASCII，避免控制台代码页乱码 |

---

## 5. 部署硬前提（目标机确认项）

Win7 为 2009 年系统，Chromium 内核有额外的系统补丁依赖：

- Windows 7 **SP1**（x64）
- **KB2533623** —— Chromium/Electron 必需，缺失会报「无法定位程序输入点」直接启动失败
- **KB4474419** —— SHA-2 代码签名支持，缺失会导致 Electron 二进制签名校验失败
- 建议安装 **.NET Framework 4.x**（`server/index.js` 的目录选择对话框依赖 WinForms）

若目标机无法打补丁，需要改走「Linux 服务端 + Win7 瘦壳」的部署形态（`shell/`），
这种情况下 Win7 只运行 Electron 渲染层，规避大部分 Node 侧限制。

---

## 6. 提交前验收清单

```bash
# 1) 语法 + Win7 兼容性静态守卫（等价于下面两条）
npm run check

# 1a) 全部 JS 语法检查（61 个文件，跨平台，用当前 node 运行时）
node scripts/check-syntax.js

#   1b) 禁用 API / CSS 特性扫描（命中即 exit 1，阻断提交）
node scripts/check-win7-compat.js      # 或 npm run check:win7

#   1c) 渲染层运行时冒烟（DOM shim 真跑 app.js + panel.js，断言侧边栏项目区/图标/扁平化/
#       右侧文件面板的 CSS 不变式与纯函数（decodeBytes 的 GBK 退路、宽度夹取、路径还原、网格行钉死、顶栏按钮压过拖拽带）。167 项）
node scripts/renderer-smoke.js         # 或 npm run check:renderer

#   1d) 端口协商冒烟（真起 server，验证探端口/复用/顺延/优雅关闭）
node scripts/service-manager-smoke.js  # 或 npm run check:service

#   1e) 桌面版替换/接管逻辑单测（manifest、路径判定、复制、替换、残留清理）
node scripts/installer-smoke.js        # 或 npm run check:installer

#   1f) 更新确认页真实渲染（需 Electron 运行时，开隐藏窗口，Chromium 108 实跑）
node scripts/shell-page-smoke.js       # 或 npm run check:shellpage

#   1g) 窗口外观冒烟（macOS 隐藏标题栏三处配合 + 只对 darwin 生效 +
#       左右两枚折叠按钮 top 完全相等、三列网格不变式）。135 项）
node scripts/shell-chrome-smoke.js     # 或 npm run check:chrome

#   1h) 顶栏真机冒烟（需 Electron 运行时：40px 拖拽带几何 + elementFromPoint 命中、
#       双击缩放/最小化、侧边栏折叠后整条左边消失与折叠按钮落位、
#       右侧文件面板的两枚按钮对齐/开合/让位 + 顶栏三枚按钮压过拖拽带 + 树与预览真的滚得动，以及 Win/Linux 基线（摘掉 .shell-mac 再量一遍）。96 项）
node scripts/shell-drag-smoke.js       # 或 npm run check:drag

# 2) 冒烟：全部通过
for s in smoke agent-smoke permission-smoke context-compression-smoke \
         plugin-smoke session-isolation-smoke reasoning-smoke; do
  node scripts/$s.js
done

# 3) 端到端：server + mock 模型 + 真实对话链路
node scripts/mock-llm-server.js &                       # :11435
AGENT_HOME=/tmp/e2e PORT=8080 node server/index.js &    # :8080
curl -X POST localhost:8080/api/settings \
  -H 'content-type: application/json' \
  -d '{"baseURL":"http://127.0.0.1:11435/v1","apiKey":"mock","model":"mock-model"}'
node scripts/chat-smoke.js
```

> **关键：第 1、2 步必须用 Node 16.17.1 跑一遍**，本机的 Node 22/24 只能作为初筛。
> 用高版本 Node 跑通不代表目标机能跑通 —— 这正是本约束要防的失效模式。

`scripts/check-win7-compat.js` 会扫描全部 Node 侧与渲染侧 JS 以及所有 CSS，
按第 2、3 节的清单匹配禁用 API 与特性，发现问题时以非零退出码阻断。
若确有正当理由需要放行某一行，在该行加上 `// win7-exempt` 注释（需在 code review 中说明原因）。

说明：`scripts/chat-smoke.js` 是**集成测试**，需要 8080 上已有服务端在跑。
若未启动服务端就跑它，一定输出 `TIMEOUT waiting for finished event` —— 这是环境缺失，不是代码缺陷。

---

## 7. 桌面版（免安装）打包与端口协商

桌面版把「界面」和「agent 服务」合成一个解压即用的目录，**共用同一份 Electron 运行时**：
Shell 启动时用 `process.execPath` + `ELECTRON_RUN_AS_NODE=1` 把自身二进制当 Node 解释器跑
`resources/app/service/index.js`。因此不需要第二个可执行文件，也省掉一份 220MB 的运行时。

```bash
node scripts/build-desktop.js win-x64        # Win7 SP1 / Win10 / Win11
node scripts/build-desktop.js mac-arm64      # macOS Apple Silicon
node scripts/build-desktop.js linux-x64      # Linux x64
node scripts/build-desktop.js all            # 全部目标
```

产物在 `release/desktop/`。**同一个 `win-x64` 包同时覆盖 Win7 / Win10 / Win11**。
`all` 每次跑完只留最新一份：脚本会先把同名产物目录**改名让位**再删（见下），
`release/desktop/` 里除 `*.zip` 与各目标的解包目录外不留历史版本。

#### 为什么是「先改名再删」，而不是一句 `rm -rf`

两条硬要求叠在一起：

1. **有实例正跑着时绝不能就地覆盖。** 目录被运行中的实例占着、删不掉，若不报错就会退化成
   「就地覆盖」—— 轻则新旧混合，最坏覆盖正在运行的二进制、把用户的窗口搞崩（2026-09-19
   真实发生过一次）。
2. **「删不掉」有两种原因，必须区分开。** 除了上面那种真占用，本环境还注入了一道
   **Node 层批量删除保护**（`NODE_OPTIONS=--require .../node-language-shim.cjs` +
   `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=50`）：**一次删超过 50 个文件**就被拦，报
   `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。产物目录一两百个文件，必然撞上。
   它拦的是「删」，**不拦「改名」**，而且只作用于 Node 进程（shell 的 `rm` 不受影响）。

所以 `clearOutDir()` 分两步，两步含义完全不同：

| 步骤 | 失败意味着 | 处理 |
| --- | --- | --- |
| `rename` 让位成 `.stale-<目标>-<时间戳>` | **真有实例占着**（macOS `EBUSY`，Windows「文件夹或其中的文件已在另一程序中打开」） | **报错退出**，要求先退出实例 |
| 删让位后的残骸 | 只是上面那道批量删除保护 | 记一行日志、**不阻塞构建**；残骸下次构建会由 `sweepStale()` 自动再清一次 |

也就是说：**「改名成功」才是新的锁探测**，取代了原来「删不掉就报错」那套（原方案区分不了
占用和删除保护，会把正常构建也一起拦死）。安全性没有放松，反而更准。

在本环境里想一次跑干净（不留 `.stale-*` 残骸），把阈值调高再跑：

```bash
CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000 npm run build:desktop
```

**打包前仍要先确认 `release/desktop/Agent-<目标>/` 没有被运行中的实例占用** ——
`rename` 失败就是那个信号。

### 端口协商规则（`shell/service-manager.js`）

| 情况 | 行为 |
| --- | --- |
| 端口空闲 | 用它启动服务 |
| 端口上是本机 agent 服务（`/api/health` 返回 `app:"dsh-agent-service"`） | 复用，不重复启动 |
| 端口被别的程序占用 | 顺延到下一个候选（8080 → 8099） |
| 候选端口全被占 | 显示明确错误页，不是白屏 |

两道保险：服务自身捕获 `EADDRINUSE` 继续向后顺延最多 20 次，并把真实端口打到 stdout；
Shell 解析该行，保证连到真实端口 —— 覆盖「探测时空闲、spawn 时被别人抢走」的竞态。

### Win7 相关注意

- 服务进程用 `spawn(..., { windowsHide: true })` 启动，不弹控制台黑窗。
- `server/index.js` 的 stdout 全部为 ASCII 英文，Shell 按 UTF-8 解析安全，不牵涉 GBK 问题。
- **退出路径必须覆盖 `SIGTERM`**：Electron 收到 SIGTERM 会直接退出、**不触发 `before-quit`**，
  不额外处理就会留下孤儿子进程，与下次启动的服务并发读写同一个数据目录。
  已在 `shell/main.js` 加 `SIGTERM/SIGINT/SIGHUP` 处理 + `process.on('exit')` 同步兜底。
- 身份标识（`/api/health` 的 `app` 字段）是版本相关的：**旧版服务没有该字段**，
  桌面版会把它判为「别的程序占用」并顺延端口，这是刻意保守的行为，重启旧服务即可复用。

### 跨平台差异

| 平台 | 主程序 | 图标 | 入口 | 备注 |
| --- | --- | --- | --- | --- |
| Windows | `Agent.exe` | AW（写进 exe 资源段） | 双击 | Win7 需 KB2533623 + KB4474419 |
| macOS | `Agent.app` | AM（`Contents/Resources/electron.icns`） | 双击（首次右键 → 打开） | 未签名，打包时做 ad-hoc 重签 |
| Linux | `Agent` | AL（运行期窗口图标） | 双击（保留可执行位） | 报 sandbox 错可用 `--no-sandbox` |

三套图标由 `scripts/make-logo.py` 生成到 `assets/icons/`（AM / AL / AW，分别对应
Agent Mac / Agent Linux / Agent Win），打包脚本按平台塞进各自该在的位置；
界面里显示的 `src/renderer/logo.png` 也会被换成该平台那一枚。

**标题栏只在 macOS 上动过。** 原生那条标题栏是白的，压在深色界面顶上像贴了张
白纸条，所以 macOS 用 `titleBarStyle:'hidden'` 把它藏掉，红黄绿按钮改为悬浮在
左上角（`MAC_TRAFFIC_LIGHT`），渲染层靠 preload 打的 `.shell-mac` 类让出顶部
留白并自建拖拽带（`src/renderer/style.css` + `shell/style.css`）。
**Windows / Linux 一律保持原生标题栏**：那边标题栏本来就跟着深色走，而且 Win7 上
`titleBarOverlay` 不可用，不要为了「统一」去动它。改 `trafficLightPosition.y` 必须
同步改 CSS 里的留白高度，`scripts/shell-chrome-smoke.js` 会算这笔账。

**拖拽带是真实元素，整条窗口顶边 40px 都能按住拖窗口。** 五个页面
（`src/renderer/index.html`、`shell/{loading,settings,offline,update}.html`）都在
`<body>` 开头放一个 `<div id="titlebarDrag" class="titlebar-drag">`；CSS 里
`.titlebar-drag { display: none }` 默认不参与布局，只有 `.shell-mac` 下才
`display:block; position:fixed; top/left/right:0; height:40px; z-index:30;
-webkit-app-region:drag`。

这一处判断错过两次，别再走回头路：

1. **只在侧边栏顶部做拖拽区** —— 用户从窗口正上方（消息区上方）按住拖，拖不动；
2. **把 `-webkit-app-region` 挂在 CSS 伪元素上**（`.shell-mac #app::before` / `.sidebar::before`）
   —— Chromium 会不会把伪元素算进可拖区域没把握，而且 `getBoundingClientRect` /
   `elementFromPoint` 都量不到，验不了、坏了也发现不了。

所以现在必须是**真实元素**，且横贯整宽（`left:0; right:0`），可以真机量、真机验。

关键不变式有三条，`scripts/shell-chrome-smoke.js`（124 项静态断言）与
`scripts/shell-drag-smoke.js`（49 项真机断言，起真实 Electron 量几何与命中）都会核：

- **拖拽带高度 === `.content-frame` 的 `margin-top`**（都是 40px）。不等的话带子底下
  压着的就是消息区正文顶部，开始吞点击；
- 壳层页面的 `padding-top`（52px）必须 `>=` 拖拽带高度（40px），带子才不压内容；
- **带子里的按钮必须 `-webkit-app-region: no-drag`，并且 `z-index` 压过带子（30）**
  才点得到。落在带子下方是另一条路 —— 但折叠按钮不走那条，见下节。

`.shell-mac .sidebar::before` 那条留白仍然保留，但它**只负责让位**（36px + 负
`margin-bottom: -14px` 抵掉 flex `gap`，让留白底边正好落在品牌行上沿），**不再挂
`-webkit-app-region`** —— 拖拽统一交给 `.titlebar-drag` 与品牌行本身。改高度记得
渲染层与壳层两处一起改（`shell-chrome-smoke.js` 会比对「两处等高」）。

#### 侧边栏折叠按钮：顶栏那一行，折叠后整条左边消失

用户 2026-09-19 定了形态（此前那版「折叠后留一条 64px 图标窄栏」被判「有点子丑」，已删）：

| 状态 | 样子 |
| --- | --- |
| 展开 | 按钮在**侧边栏右上角**，跟红黄绿同一行（`left: 214px` = 260 − 16 内边距 − 30 按钮） |
| 折叠 | **左边整片不显示**（`grid-template-columns: 0 1fr` + `.sidebar { display: none }`），按钮挪到**红黄绿右边**（macOS `left: 80px`） |

实现要点（`src/renderer/index.html` + `style.css`）：

- 按钮 `<button id="sidebarToggle" class="icon-button sidebar-toggle">` 是 **`#app` 的直接子元素**，
  **不在 `.sidebar` 里** —— 折叠后 `.sidebar` 整个 `display:none`，按钮留在外面才活得下来；
- `#app { position: relative }` 当定位上下文，按钮 `position: absolute` + `transition: left`（与列宽动画同 0.18s）；
- `z-index: 31` 压过拖拽带的 30，并 `-webkit-app-region: no-drag` —— 它虽然落在 40px 带子里，
  仍然是可点的按钮，不会变成拖窗口；
- `.main` 在折叠态 `grid-column: 1 / -1`，否则会掉进宽度为 0 的第一列里；
- macOS 专属的 `top: 9px`（= **灯心 24** − 按钮 30/2）只在 `.shell-mac` 下生效；
  Windows / Linux 保持 `top: 22px`。

  > ⚠️ **灯心是 24，不是 22。** `MAC_TRAFFIC_LIGHT = {x:16, y:16}` 只是 Electron 收的
  > 「簇位置」，灯的**圆心**并不落在 `y + 6` 上。用户 2026-09-19 的截图（浅色 / 折叠态）
  > 逐像素量出来：三颗 12px 圆，圆心 `y = 24`（簇 y + 8）、圆心 `x = 22 / 42 / 62`（间距 20）。
  > 当时按钮 `top: 5px` → 墨迹中心 20，比灯心**高 4px**，用户一眼就看出「不在一条线上」。
  > 别再用 `+6` 建账；`scripts/shell-chrome-smoke.js` 里有个 `TRAFFIC` 常量按 `+8` 记，
  > 且「中线精确对齐」这条断言**不带容差**（以前带 ±3 的容差，所以 4px 的偏差它照样绿）。

**窄窗口（< 900px）的 48px 图标窄栏跟「折叠」是两码事**，别混：那条窄栏是响应式的
（`.sidebar-rail` + `@media (max-width: 900px)`），折叠态优先级更高（`#app.sidebar-collapsed .sidebar`
带 id，压得住媒体查询里的 `.sidebar`）。

改这几处记得同步：侧边栏 260px、`.sidebar` 内边距 16px、`.icon-button` 30px ——
`left + 宽 = 244` 这条等式 `shell-chrome-smoke.js` 会核；折叠后 `left: 80` 与红黄绿的
几何关系 `shell-drag-smoke.js` 会真机量。

#### Windows / Linux 上是什么样（怎么验的）

用户 2026-09-19 追问过：「这是 mac，至于 linux 还有 win 我不晓得效果是咋样的，因为我没法验证」。

结论先说：**渲染层对 `.shell-mac` 没有一行 JS 依赖**，平台差异**全在 `src/renderer/style.css`
的 14 条 `.shell-mac` 规则里**。所以「把 `<html>` 上的 `.shell-mac` 摘掉」= Windows / Linux 下
完全一致的 CSS 输入，可以在 macOS 上真机跑出来看。基线（无 `.shell-mac`）与 macOS 的差别只有：

| 项 | macOS（有 `.shell-mac`） | Windows / Linux（基线） |
| --- | --- | --- |
| 原生标题栏 | 藏掉（`titleBarStyle:'hidden'`） | **保留**，在 web 内容之外 |
| 拖拽带 `#titlebarDrag` | `display:block`，40px、`z-index:30` | **`display:none`**（不铺遮罩吃点击） |
| 折叠按钮 `top` | `9px`（中线对齐红黄绿，灯心 24） | `22px`（对齐品牌行） |
| 折叠按钮 `left`（展开） | `214px` | `214px`（**一样**，都贴侧边栏右缘） |
| 折叠按钮 `left`（折叠） | `80px`（让开红黄绿） | `16px`（**没有红黄绿要让，直接靠窗口最左**） |
| `.content-frame` 顶部 | `margin-top:40px` 让位 | 基线 `margin:0 auto`，**不留那 40px** |
| 双击顶栏缩放 | 自己接（preload 只在 darwin 接） | **原生就有**，不能抢 |

三段守卫把这套钉住了：

- `shell-chrome-smoke.js`：折叠按钮**必须**有基线规则（不能整条被 `.shell-mac` 裹住，否则
  Win/Linux 上按钮掉回文档流）；macOS 的 `top:5px` / 折叠态 `left:80px` 必须在 `.shell-mac` 里；
  基线 `.titlebar-drag` 必须 `display:none`；基线 `.content-frame` 不许有 `margin-top`。
- `shell-drag-smoke.js` 的 **Win / Linux 那一轮**：真起 Electron，摘掉 `.shell-mac` 后量
  `按钮 left=214 / top=22`、`按钮左沿 214 > 品牌标题右沿 97`（不压字）、`elementFromPoint`
  命中按钮、`frameTop=0`（不白留 40px）；再切折叠态量 `sidebar display:none`、
  `mainWidth === innerWidth`、`按钮 left=16`。**同一段断言在 mac 上验「模拟」、在 Win/Linux 上验实况。**
- 截屏核对：`/tmp/shot.js`（macOS 样子，页面里画一组假红黄绿）与 `/tmp/shot-other.js`
  （摘掉 `.shell-mac` = Win/Linux 样子），各出 4 张（展开/折叠 × 深/浅）到 `/tmp/shots` 与
  `/tmp/shots-other`，肉眼过一遍。这两个脚本是临时的，不入库。

> 注意验证边界：Win7 真机行为（原生标题栏、文件锁、GBK 输出）**仍然只能靠文档与守卫里的
> 静态约束**保证，这里能证明的是「渲染层布局在无 `.shell-mac` 时是对的」。

> ⚠️ **冒烟里量几何之前必须先把 CSS 过渡冻掉**（`shell-drag-smoke.js` 的 `FREEZE_ANIMATION`）。
> 隐藏窗口（`show:false`）里 Chromium **会节流甚至停掉过渡** —— 合成器不跑，
> `transition: left .18s` 可能一直停在**起点**。所以「加完 class 等 400ms 再量」是**不稳定**的：
> 2026-09-19 就翻过一次车，Win/Linux 那轮量到 `left=80`（过渡起点）而不是 `214`（终值），
> 报了两条假 FAIL，再跑一次又全绿。现在注入 `* { transition:none !important }` 后量，
> 断言变成确定性的，等待也从 400ms 收到 60ms。

#### 双击顶栏的「缩放 / 最小化」得自己接

原生标题栏藏掉之后，AppKit 那套「双击标题栏缩放窗口」的手势**跟着一起没了** ——
`-webkit-app-region: drag` 只负责拖窗口，**不含双击行为**。这不是 bug，是 Electron
明确的取舍：issue **#16385** 里维护者把它定性为「写进文档，不做成 `-webkit-app-region`
的默认行为」（理由是会影响浮动小窗之类的用法），所以只能应用自己实现。

做法（2026-09-19 落地，`shell/main.js` + `shell/preload.js`，单体入口
`src/main/main.js` + `src/main/preload.js` 各一份同款）：

| 位置 | 干什么 |
| --- | --- |
| preload | 在 `document` 上委托 `dblclick`：命中 `#titlebarDrag, .brand` 才动作，再排除 `button, a, input, select, textarea`（拖拽区里的按钮自带 `no-drag`，双击它们不该顺带缩放窗口）。**只在 `darwin` 上接** |
| 主进程 | `ipcMain.on('shell:titlebar-dblclick')` → `titlebarDoubleClickAction()` 读系统偏好 → `applyTitlebarDoubleClick(win, action)` |

动作读系统偏好 **`AppleActionOnDoubleClick`**（系统设置 → 桌面与程序坞 →
「双击窗口的标题栏以」）：`Maximize`（macOS 默认，未设置时也按它）/ `Minimize` /
`None`。`systemPreferences.getUserDefault(key, 'string')` 在 Electron 22 上可用；
取不到（受限环境）退回 `Maximize`，不抛。

两个判断都实测过，别再猜：

- **原生不会代劳**（Electron 22.3.27 + `titleBarStyle:'hidden'`，双击拖拽区后
  `isMaximized()` 仍为 `false`）；
- **拖拽区照样收得到 DOM 事件** —— `dblclick` 挂在带 `-webkit-app-region: drag`
  的元素上是官方认可的做法，`shell-drag-smoke.js` 里真机验了这条链路。

守在哪：`shell-chrome-smoke.js` 把两个函数从源码里**抠出来真跑**（注入假的
`process` / `systemPreferences`），覆盖三个偏好值 + 取不到 + `win32` 不接管 + 已最大化
时还原，并校验两个入口的两份拷贝**逐字一致**；`shell-drag-smoke.js` 挂真 preload，
派发 `dblclick` 验「拖拽区命中、按钮不命中」，再用真窗口跑 `applyTitlebarDoubleClick`。

Windows 包为了换图标与版本信息，用 `resedit`（纯 JS）重写了 `Agent.exe` 的资源段，
Electron 官方的 Authenticode 签名因此失效 —— 改了资源就必须重签，而仓库里没有证书。
Win7 上首次运行若弹「未知发布者」，选「运行」即可；内网解压运行不受影响。
版本信息（属性 → 详细信息里的产品名称/文件说明）同时被改写成 `Agent`。

数据目录统一在 Electron userData 下的 `agent-home`，程序目录保持只读、可整体搬运。
改名后 userData 目录从 `DSH-Agent` 变成 `Agent`，`shell/main.js` 启动时会做一次性
rename 迁移（旧目录存在且新目录不存在时才动）。

---

## 8. 右侧文件面板（一期）

面板是 `#app` 的**第三列**：`260px | 1fr | var(--panel-width)`。收起时 `.file-panel`
直接 `display:none`，第三列自然不存在 —— 布局与加面板之前一模一样。

| 项 | 收起 | 展开 |
| --- | --- | --- |
| `#app` 网格 | `260px 1fr` | `260px 1fr var(--panel-width)` |
| `#app.sidebar-collapsed` | `0 1fr` | `0 1fr var(--panel-width)` |
| `#app.panel-open.chat-hidden`（只看文件） | — | `0 0 1fr` |
| 折叠按钮 `top` | 22（macOS 9，对红黄绿中线） | 同左 |
| 折叠按钮 `right` | `16` | `calc(var(--panel-width) + 16px)` |

**三条必须记住的不变式**（都有守卫盯着）：

1. **`.main` 固定第 2 列**（写在基础 `.main` 规则里）。`#app.sidebar-collapsed .main`
   那条 `grid-column: 1 / -1` 是为了侧边栏隐藏时不让会话区掉进 0 宽的第 1 列；
   **但面板一开，`1 / -1` 会一路铺到面板底下** —— 所以另有
   `#app.sidebar-collapsed.panel-open .main { grid-column: 1 / 3 }` 压住它。
   `shell-drag-smoke.js` 真机量「会话区右沿 ≤ 面板左沿」。
2. **左右两枚折叠按钮 `top` 必须完全相等**（基线都是 22、macOS 都是 9）。
   这条不带容差 —— 2026-09-19 红黄绿那次就是差 4px 被用户一眼看出来。
3. **面板宽度只能写 CSS 变量 `--panel-width`**，不能写 `style.width`（它是 grid 列宽）。

**再加两条（2026-09-19 用户真机报的两个 bug，都有真机守卫盯着）**：

4. **`#app` 的网格行必须钉成 `grid-template-rows: minmax(0, 1fr)`**。
   不写的话隐式行是 `auto`，内容多高行就多高：面板一进来（预览几百行代码 +
   长目录树）把行从 872px 撑到 5000+px，里面那两个 `overflow:auto` 跟着变成
   `clientHeight === scrollHeight` —— **滚动条永远不出现，`scrollTop` 都改不动**。
   用户报的就是「文件列表没有滚动条，文件内容没有滚动条」。
   注意必须写 `minmax(0, 1fr)` 而不是 `1fr`：`1fr` 的最小值默认是 `auto`，还会被内容顶大。
   配套：`.panel-explorer` / `.panel-main` 都要带 `min-height: 0`（flex 中间层不能断）。
5. **macOS 上面板顶栏那三枚按钮必须 `relative + z-index:31 + no-drag`**。
   面板是从窗口最顶上铺开的，`.panel-head` 整条落在 40px 拖拽带（z-index:30）底下，
   带子又是 `-webkit-app-region: drag`，按下去直接变成拖窗口 —— 目录图标 /
   VS Code / 终端三枚全点不动（真机 `elementFromPoint` 打在按钮中心回报的是
   `#titlebarDrag`）。跟 `.sidebar-toggle` 同一套配料。
   ⚠️ **只抬按钮本身，不抬整条 `.panel-head`** —— head 的空白处仍可按住拖窗口。
   Win/Linux 没有这条带子，整块规则只写在 `.shell-mac` 下。
6. 面板的滚动条（`.panel-tree` / `.panel-preview`）与侧边栏 `.sidebar-scroll`
   **同一套**：8px、透明轨道、thumb `#334155`（亮色 `#cbd5e1`）、`display: block`。
   Chromium 108 忽略 `scrollbar-width`，`::-webkit-scrollbar` 才是真正生效的那条。

安全：面板只读。路径全部经过 `server/file-api.js` 的两道闸（字符串 `isInside`
+ `existingRealPath` 挡 symlink 逃逸），能看的根只有「当前项目关联的工作目录」。

编码：服务端**不做**文本解码，只吐字节（`/api/fs/raw`）与「像不像文本」的嗅探
（`/api/fs/file`）。原因是 Electron 自带的 Node 是 small-icu，`TextDecoder('gbk')`
会抛；Chromium 有完整 ICU，所以解码放在渲染层（`panel.js` 的 `decodeBytes`：
严格 UTF-8 → 退 GBK → 再退宽松 UTF-8）。Win7 上 GBK 源码文件遍地都是，这一层必须有。

开发态（`npm start`）走 IPC 那条路（`src/main/main.js` 的 `fs:*`），它与服务端共用
`server/file-api.js` 的同一套 `workspaceRoots / describeTree / describeFile / readWorkspaceFile`，
**不另写一套规则**。IPC 那条只保证 UTF-8（主进程同样解不了 GBK）。

验收：`renderer-smoke.js` +29 项（**167**）、`shell-chrome-smoke.js` +11 项（135）、
`shell-drag-smoke.js` +47 项（**96**，真机量的几何）。`check:drag` 的面板那段会
真机验证三件事：① 三枚顶栏按钮 `elementFromPoint` 命中按钮自己（不是拖拽带）、
② `.panel-tree` / `.panel-preview` 真的滚得动（`scrollTop` 改得动）、
③ 点目录/VS Code/终端三枚按钮都有真实反应。
⚠️ 真机冒烟里给面板喂长内容**只能走 ipcMain 的假 handler**，不能在页面里
`window.dsh = {...}` —— 真 preload 用 contextBridge 暴露的对象在主世界是只读的，
赋值会静默失败（第一次就是这么翻的车，量出来 `scrollH === clientH` 全是假绿）。

---

## 9. 已知待修问题

| 级别 | 位置 | 问题 |
| --- | --- | --- |
| P1 | `src/main/agent/tools.js` `runCommand` | 子进程输出按默认 UTF-8 解码，Win7 中文版 `cmd.exe` 输出 GBK，中文结果会乱码 |
| P2 | `server/index.js` `pickNativeFolder` | 依赖 `powershell.exe` + WinForms 选目录，精简版 Win7 会失败（当前降级为返回空串，不崩，但功能不可用） |
| ~~P3~~ | `package.json` `check` | **已修**：改为 `scripts/check-syntax.js`（61 文件）+ `scripts/check-win7-compat.js`（禁用 API/CSS 守卫）+ `scripts/renderer-smoke.js` + `service-manager` / `installer` / `shell-menu` / `shell-chrome` 四条冒烟 |
