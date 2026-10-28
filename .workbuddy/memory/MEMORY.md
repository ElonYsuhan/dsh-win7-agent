# dsh-win7-agent 长期记忆（产品名 Agent，当前 0.4.3）

2026-10-17 重写：0.1.x 时代的细节（14 段链、329 条 renderer、单 agent、DSH 命名）已随
0.1.3–0.3.4 的重构失效，历史叙事留在 `MEMORY-2026-10-07.md.bak` 与 daily logs（2026-09-18/19/20/23）。
2026-10-28 合并：`git reset --hard origin/main` 后上游版曾冲掉 Windows 本机知识，已合并回来；
被丢弃的本地提交 03b6c12 备份在 tag `backup/local-03b6c12-20261028` 与
`E:\Elon\backups\dsh-win7-agent\local-commit-20261028\`（更早的 r30 在 `r30-20261016\`）。

## 硬约束（别碰）
- **Win7 SP1 x64 可跑**：Electron 22.3.27 / Node 16.17.1 / Chromium 108。禁原生模块、无生产依赖、
  不联网。禁用清单以 `scripts/check-win7-compat.js` 为准。
- **架构底座是 Cordis**（`src/main/runtime/vendor/cordis`），执行与持久化在插件里。
  改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- **只维护 8080**（用户常驻实例）。打包/测试不要动它，测试一律随机端口 + 临时 AGENT_HOME。
- **交付规则见 `AGENTS.md`**：改完必须打包**当前开发平台**（这台是 Windows → `win-x64`），覆盖同名产物、
  不手动涨版本号；用户说"发版"才升版本并打全平台。未经用户要求不自动启动应用。
- git：`origin` = github.com/ElonYsuhan/dsh-win7-agent，main。用户说"本地提交不要了" →
  `git reset --hard origin/main`（**先打备份 tag + `git format-patch`**）。用 `git worktree add <dir> HEAD`
  （symlink node_modules）可在旧版本上跑同一份脚本，分清「这轮引入的」与「本来就红的」。

## 怎么跑验收
- 用 Electron 内置 Node 16.17.1 跑脚本（mac：`ELECTRON_RUN_AS_NODE=1 …/Electron.app/Contents/MacOS/Electron scripts/x.js`）。
  **Windows 本机**：`"/d/Program Files/nvm/v16.20.2/node.exe" scripts/<x>.js`（npm 8.19.4 可用；装依赖要用
  PATH 上的 npm 10.9.7 / node 22 —— lock 是 v3，npm 8 写不动）。
- 默认链 **约 50 段**（`npm run check`，**清单以 package.json 的 check 为准，别背数**）：runtime-architecture /
  cordis / layered-agent / syntax / win7 / settings-migration / renderer / dialogs / web-bridge / platform /
  ui-store / self-validate / service-manager / installer / update-takeover / startup-build-metadata / shell-menu /
  shell-chrome / navigation-guard / window-controls / plugin / mcp / knowledge×3 / workflows / document-mcp / agent /
  llm-stream / concurrency×2 / release-retention / desktop-distribution / source-protection / licensing / agent-ux /
  tasks×2 / extensions / workflow-*×6。
- **真机窗口脚本要「用普通 node 跑」**（它们自己 spawn Electron）+ `SMOKE_NO_SANDBOX=1`：
  `check:theme` `check:drag` `check:shellpage` `check:browser` `check:first-chat` `check:ui`。
  直接拿 Electron 当解释器跑 `shell-drag-smoke.js` 会**静默 skip**（exit=0，别被骗）。
- 打包：Node ≥20（Windows 本机 `/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe
  scripts/build-desktop.js win-x64`），**必须放开沙箱 + 前台**（后台任务拿不到授权），
  带 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`；日志须有 `exe branding applied: Agent.exe`。
  产物是**单入口**（2026-10-24 交付契约）：`release/desktop/Agent-<target>/` 里只有 `Agent.exe`
  （win NSIS 安装器）/ `Agent.app` / `Agent.AppImage`，中间目录在 `release/.desktop-build/`；
  构建链入口 `scripts/desktop-distribution.js`（`build-desktop.js <target>` 转调它）。
  仓库镜像在 `installers/Agent-<target>/`，改完要同步 `installers/SHA256SUMS.txt` + `build-info.json`。**0.4.3 起有源码保护（obfuscate/terser）**，
  node_modules 需装 `javascript-obfuscator` + `terser`（devDeps，锁里已有）。
- 打包后必做：包内与 zip 内改动文件哈希对源码逐字节一致（mac 前缀
  `Agent-mac-arm64-<v>/Agent.app/Contents/Resources/app`，win/linux 是 `Agent-<target>/resources/app`；
  少这层前缀 → 取到空串 `e3b0c44298fc1c14`，看着像「包坏了」）。
- **NSIS 两个坑（2026-10-28，`scripts/desktop/installer.nsh`）**：① 嵌套 `!include` 只认反斜杠绝对路径，
  写成 `E:/...` 会报 `!include: could not find`（误导：文件明明在）；② 被 include 的 `.nsh` **不能含非 ASCII**，
  无 BOM UTF-8 的中文注释直接 `Bad text encoding`（行号指向第一处中文），注释一律英文。
  Windows 单文件包的启动体验：`installer.nsh` 的 `customInit` 在 `.onInit` 里比对
  `HKCU\Software\Agent\OfflineLauncher` 的 BuildId，命中就 `Exec` 已装 exe 后 `Quit`（此阶段 Quit 不建窗口），
  所以第二次双击分发包 = 直启；`customInstall` 要显式 `CreateShortCut "$DESKTOP\Agent.lnk"`，
  因为 electron-builder 在 `isUpdated` 分支不重建桌面快捷方式。实测：首装 9.5s（解包物理成本）、
  直启 0.65s、桌面快捷方式 0.53s。

## Windows 本机环境（这台开发机，2026-10-14/16/28 踩过）
- **全仓 CRLF**：任何跨行的 `indexOf('…\n')` / `slice` 断言先归一 `\r\n`→`\n`，否则**静默假红**
  （renderer-smoke / window-controls-smoke 的 functionFrom 都栽过）。renderer-smoke 的 vm 假 DOM 还要补
  `getComputedStyle` 桩（新对齐逻辑会调它）。
- **Windows 上必红的既有夹具**（代码没问题，是夹具的锅）：installer-smoke（`/opt/...` 被挂成 `E:\opt\...`、
  只读父目录在 Windows 上锁不住目录 → 用「活进程把目录当 cwd」做真锁）、shell-menu-smoke（注入宿主 path 后
  `resolve('/tmp/…')` 变形）。修复补丁在 `E:\Elon\backups\dsh-win7-agent\r30-20261016\` 与
  `local-commit-20261028\`。
- **从自动化宿主启动 Agent.exe**：① 宿主带 `ELECTRON_RUN_AS_NODE=1` + NODE_OPTIONS shim，不清 env 会被当
  纯 Node 跑 → `env -u ELECTRON_RUN_AS_NODE -u NODE_OPTIONS`；② 父进程在宿主树里（`Start-Process` 也算）→
  GPU 反复崩 `FATAL: GPU process isn't usable. Goodbye.`，且命令结束被 job 回收；
  **唯一稳的起法：借 explorer.exe 当父进程** `Start-Process explorer.exe -ArgumentList '"<exe 全路径>"'`
  → ppid=explorer、无 flag 也稳、跨工具调用存活。别据此给 README 加 `--no-sandbox`。
- Windows 无 `shasum` → 用 `sha256sum`；**空串比空串会得出全量假绿**，比较前先判非空。
- Bash 吃反斜杠：`$APPDATA` 在 Bash 里变 `C:Users...`；本机 PowerShell 工具 stdout 不回传 →
  探查类命令 `Out-File` 到临时文件再读。

## 已知既有红（2026-10-17 / 10-20 在 HEAD worktree 上复现过，别重复查）
- `check:drag` 675/677：`面板：渲染出 80 行目录…[目录行=0]`、`终端历史靠 replay[sid:""]`。
- `update-takeover-smoke`：macOS 上 `processOwnsPackage` 探针失败；`document-mcp-smoke`：
  `reading 'result'` of undefined；`theme-smoke` 74/75（renderer 报 `unsafe-eval`，CSP 只有 `script-src 'self'`）。
- 会话存储是**服务端优先**（`/api/ui-store`），localStorage 只是兜底 —— 测试造种子必须写服务端，
  否则页面起来就被覆盖（2026-10-17 在 check:ui 上踩过，表现为探针 steps=0）。
- 浏览器 e2e 里 `driver.launch(...)` **必须带 `noSandbox`**，否则窗口刚起就 `CDP_DISCONNECTED`（不是环境问题）。

## 工作流（2026-10-20 后）
- 人工节点主入口是 `interaction:{version:1,type:'handle'|'review'|'approve',returnTo}`，旧的
  `humanKind/humanModes` 只在没有 `interaction` 时生效（兼容配置）。新加的人工节点默认 `handle`。
- **驳回是流程动作**：`submit(decision:'reject')` → `node-returned` 事实，把目标（默认最近的上游人工办理节点）
  及下游重置为 pending，attempts/timeline/产物文件按 attempt 后缀保留；另有 `external-checkpoint` 暂停点，
  重放旧 rest/agent/tool 前必须 `resume({confirmExternal:true})`。
- 事件类型在 `src/main/state/workflow-state.js`；退回策略在 `src/main/flow/workflow-policy.js`
  （`returnTarget` / `interactionView`）；契约在 `src/main/contracts/workflow-interaction.js`。
- 浏览器版 `check:workflows:interaction:browser` / `check:workflows:v2:browser` / `check:workflows:browser`
  都在跑；后者靠 `delete n.properties.interaction` 固定测旧表单。画布多选整体移动是 LiteGraph 原生行为，
  只覆写 `processNodeSelected`；测它：CDP 两次按下间隔 <300ms 会被判双击（断言按 node id）、
  合成拖拽要先发一次 hover move（`last_mouse` 只在 mousemove 里更新）。
- **折叠 details 里的 focus() 静默失效**：子元素 `display:none` 时 focus 无效，activeElement 停在 body。
  重绘后要聚焦必须先展开祖先 details（`renderStructured` 的 `redraw` 已内联）。
- 改这种压缩风格的单行函数后务必 `node --check` + 括号平衡扫描：少一个 `}` 会让后续函数掉出 IIFE 作用域，
  症状是莫名的 `xxx is not defined`。

## 画布布局与连线（2026-10-28）
- 排版算法全在 `src/renderer/workflow-auto-layout.js`（纯函数，UMD，**别塞回 workflows.js**）：
  最长路径分层 → 重心法 4 轮降交叉 → `horizontal`/`vertical`/`layered` 三种落位；
  `fit` 是三种里按 `fitScale*4 - |ln(长宽比/视口比)|` 挑一个。**环不再拒绝布局**（接在最深层之后）。
- 入口是 Ribbon 的 `#workflowArrange` **下拉菜单**（不是直接执行），默认 `layoutMode='fit'`；
  新图在 `requestAnimationFrame` 里排，因为 `canvas.canvas.width` 要等 resize 后才准。
- 缩放：`fitGraph(minScale)` 带下限，自适应用 `READABLE_MIN_SCALE=.5`；横向/纵向/分层仍
  `readableGraph()`（100% 可读 + 长图定位起始节点）—— 这是既有产品决策，别改成"自动 fit"。
- 连线正交布线的**扇出分道**：`route()` 的 `startLane/endLane` 垂直偏移 + `elbow()` 拐点；
  穿越检查必须拆两段判（`hits()` 对斜线一律 return true）。分组键是 `(source, origin_slot)`，间距 12px。
- 对账打包源码：`source-protection.json` 的 `records[].sourceSha256` 是**混淆前**内容的哈希，
  必须按 `path` 精确匹配——`endsWith('/workflows.js')` 会先命中 `src/main/contracts/workflows.js`。

## 渲染层架构（改之前先懂这几条）
- **思考过程 = 步骤时间线**（2026-10-17 P0）：一轮一个 `details.thinking-block.process-timeline`，
  每步 `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`；标题由 `toolStepTitle()` 翻人话；
  折叠条 summary = `思考中…（N 步）` → `已执行 N 步 · 3.2s`。
- **状态存 class 不存 data-\***：过程走 `innerHTML` 存进 `session.processHtml`，class 能原样回来。
- `session.processTimeline` + `legacyProcessHtml` 是新格式；老会话只有纯文本时摘要保持「思考过程」，
  不会出现「已执行 0 步」。
- 过程记录与 DOM 解耦：后台会话走 `processRecord()` 的游离节点，事件照样记账，不碰当前画布。
- 运行状态行 `#runStatus` 放在 `#messagesInner` **外面**（否则被 `clearMessages()` 清掉），
  500ms 刷新；`applyRunState` 起停、`endThinking` 停。
- 并发：`state.runs` 按会话记账；事件都带 sessionId，非当前会话只记账不碰 DOM。
- 存储：`AGENT_HOME` 下 settings.json + sessions + ui-store.json；桥两条腿 = preload IPC（开发态）
  与 `web-bridge.js` HTTP（打包壳）。`save()` 返回 ≠ 已落盘，断言磁盘要先 `await store.flush()`。

## 窗口外观（0.4.3 起）
- 真源 `shell/window-chrome.js`（两个主进程入口 `shell/main.js` 与 `src/main/main.js` 都 require 它，
  **别各写一套**）：`frame:false` + **自绘窗口按钮**（preload 注入 `.window-controls`），
  不依赖 titleBarOverlay → **Win7 也能用**。preload 按 chrome 模式打 `shell-window` +
  `shell-mac`(40px) / `shell-win`(48px)；双击顶栏 win32=maximize。
  守卫：shell-chrome-smoke + window-controls-smoke（CSS 里所有 `-webkit-app-region` 选择器必须挂平台类）。
- **应用菜单（☰）是渲染层自绘的**（`src/renderer/app-menu.js` + `.app-menu`），不是 `menu.popup()`：
  原生弹层两列顶边差 17px、16px 字号、配色不跟主题，且没有任何样式入口。主进程只 `send('app:menu-open')`
  和收 `app:menu-invoke` 白名单执行；原生模板留着只为**加速键**，并且 Alt 已不再翻出菜单栏。
  ☰ 只在带 `#app` 的主界面注入，启动页没有。

## 主题 / 视觉
- 两套主题：灰黑（`--bg #212121`）与白（`--bg #ffffff`），去蓝青、去渐变、去普通阴影，
  语义色只留给错误/警告/成功与代码高亮。新增样式一律用现有 CSS 变量。
- 验收门 `check:theme`（真 Electron，双主题、对比度、hover、focus、截图写 `release/validation/`）。
- **改面板结构后要顺手查检查脚本里的选择器**：`.panel-head` 在 0.1.3 重构后已无人创建，
  theme-smoke 探它会假红（2026-10-17 已改成 `.panel-tabbar`）。

## 样式改动的两条纪律（都踩过）
- **量间距用脚本，别用眼睛**：真窗口读盒模型 + 段间距（`/tmp/sb-measure.js` 那套），
  2026-10-17 侧边栏靠它发现品牌行下留了 24px、分组标题和第一行贴死 0px。
- **CSS 同一批选择器被不同人写进不同位置时，最后写入的赢**。别逐处改：在**文件末尾**放一个
  明确归属的收口块（本项目叫「侧边栏纵向节奏」），前面的块只管尺寸/配色，并写注释说明归属。

## 环境坑（近期各踩过）
- macOS 自带 **BSD grep，不支持 `\|`**：`grep "a\|b"` 静默返回空（2026-10-17 因此误判四次）。
  多模式用 Grep 工具或 `grep -E`。
- `scripts/renderer-smoke.js` 的用例在**模板字符串**里：正则的 `\d` 会被吃掉反斜杠 → 用 `[0-9]`；
  注释里不能有反引号、不能有块注释起始符。
- `src/renderer/app.js` 字符串有真中文也有 `\uXXXX`：Edit 按字面匹配易失配，改用 python 按行替换。
- 沙箱起不来时子进程会 `GPU process isn't usable. Goodbye.` 自杀 —— 子进程 env 里的
  `ELECTRON_RUN_AS_NODE` 必须是 `'1'`，空串会被当成 GUI 模式。

## 其他
- md-skills（65 个技能）随包在 `src/main/agent/md-skills/`，系统提示只放 id + 90 字简介。
- 自我验证工具：`browser_launch/act/eval/**browser_close**`、`test_run`、`wait_ready`、`validate_ledger`。
  验证完必须 `browser_close` + 停掉自己起的服务。