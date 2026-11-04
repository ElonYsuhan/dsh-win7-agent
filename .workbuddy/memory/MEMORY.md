# dsh-win7-agent 长期记忆（产品名 Agent，当前 0.4.4）

2026-11-04 重写精简（上一版 2026-11-03）。0.1.x–0.3.x 的细节已随重构失效，历史叙事留在
`MEMORY-2026-10-07.md.bak` 与 `.workbuddy/memory/*.md` 日志。2026-10-28 `git reset --hard origin/main`
冲掉过本机知识，已被本文件合并回来；被丢弃的本地提交在 tag `backup/local-03b6c12-20261028` 与
`E:\Elon\backups\dsh-win7-agent\`。

## 硬约束
- Win7 SP1 x64 可跑：Electron 22.3.27 / Node 16.17.1 / Chromium 108；禁原生模块、无生产依赖、不联网
  （清单以 `scripts/check-win7-compat.js` 为准）。
- 架构底座 Cordis（`src/main/runtime/vendor/cordis`）；改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- 只维护 8080 常驻实例；测试一律随机端口 + 临时 AGENT_HOME。
- 交付规则见 `AGENTS.md`：改完打包**当前开发平台**（win-x64）、覆盖同名产物、不手动涨版本；用户说
  「发版」才升版本并打全平台；未经要求不自动启动应用。
- git：origin=github.com/ElonYsuhan/dsh-win7-agent(main)。「本地提交不要了」→ 先打备份 tag +
  `git format-patch` 再 `reset --hard origin/main`。

## 打包与验收
- 本机跑脚本用 `"/d/Program Files/nvm/v16.20.2/node.exe" scripts/x.js`；装依赖用 PATH 上的 node 22
  （lock 是 v3，npm 8 写不动）。
- 真机窗口脚本（theme/drag/shellpage/browser/first-chat/ui/knowledge-panel）要**用普通 node 跑**（自己
  spawn Electron）+ `SMOKE_NO_SANDBOX=1`；拿 Electron 当解释器跑会静默 skip（exit=0，别被骗）。
- 打包：node ≥20，`node scripts/build-desktop.js win-x64`，须放开沙箱 + 前台 +
  `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`；日志要有 `exe branding applied: Agent.exe`。
- 单入口交付：`release/desktop/Agent-<target>/` 只有 Agent.exe/.app/.AppImage，中间目录在
  `release/.desktop-build/`；仓库镜像 `installers/Agent-<target>/` 同步 `SHA256SUMS.txt` + `build-info.json`
  （uiBuild / packageBuildId 取包内 `desktop-build.json`）。
- 打包后必做：包内改动文件与源码 cmp（win 前缀 `Agent-<target>/resources/app`；少这层 = 空串假绿）。
  比较前判非空（空串比空串=全量假绿）；无 shasum 用 sha256sum。
- **混淆载荷不能 cmp**：`fillAppDir` 把渲染层 app.js/knowledge.js/workflows.js/icons.js/markdown.js 混淆，
  源码 vs 包内必然 DIFF（不是过期）。核对走 `source-protection.json` 的 `records[].sourceSha256`
  （**混淆前**哈希，按 path 精确匹配——`endsWith('/workflows.js')` 会先命中 contracts/workflows.js），
  或 grep 标记 + `node require` 包内模块打印常量。混淆后变量名会重命名，包内 grep `flowsRenderKey` 是 0，
  别当「没打进去」。纯文本（style.css / index.html）直接 cmp。
- **publish 的目录 rename 会被垫片打回**：NODE_OPTIONS 注入的 node-brokered-fs-shim 让 rename 走 trash，
  报 `EBUSY ... rename ... previous-delivery`（某进程把 `release/desktop/Agent-win-x64` 占成 cwd：能写不能
  改名/删）→ 手动 `cp delivery/Agent.exe`，再 `require('./scripts/desktop-distribution').checksums(...)`
  补校验和，跑 desktop-distribution-smoke 兜底。
- NSIS（`scripts/desktop/installer.nsh`）：嵌套 `!include` 只认反斜杠绝对路径；被 include 的 .nsh 不能含
  非 ASCII（注释一律英文）。customInit 比 `HKCU\Software\Agent\OfflineLauncher` 的 BuildId，命中直接 Exec
  已装 exe；customInstall 要显式建桌面快捷方式（isUpdated 分支不重建），末尾调
  shell32::SHChangeNotify(SHCNE_ASSOCCHANGED) + Win8 以上 `ie4uinit -ClearIconCache` —— 否则原地升级后
  桌面还是旧图标，用户会以为「安装没更新资源」。
- 图标改动是整条链路：make-logo.py 生成 assets/icons → build-desktop 用 icon.ico 做 exe branding →
  electron-builder 打进安装器 → 安装器刷缓存。自检三处：源码 ico 七帧（16/24/32/48/64/128/256）alpha bbox
  满幅、安装目录 `resources/app/assets/icons` 与源码同尺寸同内容、装好的 exe 内嵌七帧同样满幅。
  用户说「图标还是小」先怀疑 shell 缓存，别急着改设计。

## Windows 本机环境
- 全仓 CRLF：跨行 indexOf/slice 断言先归一 `\r\n`→`\n`，否则静默假红；renderer-smoke 的 vm 假 DOM 还要
  getComputedStyle 桩。`renderer-smoke.js` 用例在模板字符串里（`\d` 被吃 → 用 `[0-9]`、`(` → `[(]`、
  注释里不能有反引号）；`app.js` 同时有中文与 `\uXXXX`，用 python 按行替换更稳。macOS BSD grep 不支持 `\|`。
- 从自动化宿主起 Agent.exe：清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`；父进程在宿主树里会 GPU 崩 →
  `Start-Process explorer.exe -ArgumentList '"<exe 全路径>"'`。Bash 吃反斜杠（`$APPDATA`→`C:Users...`）。
- 本机 Electron 窗口宽度被压到 960 上限：量 1920/2560 布局用
  `driver.cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})`。
- 既有必红夹具（夹具的锅）：installer-smoke、shell-menu-smoke；修复补丁在 backups 目录。
- 浏览器 e2e 的 `driver.launch` 必须带 noSandbox；`driver.launch(url)` 起的是裸 Electron（无 preload），
  CDP 常在隔离世界、`window.dsh` 读不到 —— 验 preload/IPC 必须 `driver.launch('.')` 起真实主进程。

## 已知既有红（复现过，别重复查）
- `check:drag` 675/677；`workflow-canvas-e2e-smoke` 本机必红（wrap 路由 / serpentine，HEAD 同红）。
- `knowledge-e2e-smoke`：`内存验收` 循环 `.knowledge-project-folder summary` click null（2026-11-03 用 stash
  基线确认）；`update-takeover`（macOS 探针）、`theme-smoke` 74/75（renderer 报 unsafe-eval，CSP 只有
  `script-src 'self'`）、`extensions-e2e` 在 Windows 需先 `mkdir -p /e/tmp`。
- 会话存储服务端优先（`/api/ui-store`），造种子必须写服务端。
- 知识库文档行**不显示解析提示**：parser-worker 的 notice 被 service 写进 jobs.error（成功也写），渲染层
  只对 `phase!=='ready'` 画 error；改文案去 `parser-worker.js`。文档行标题单行省略（nowrap+ellipsis）。

## 工作流
- 人工节点主入口 `interaction:{version:1,type:'handle'|'review'|'approve',returnTo}`；旧 humanKind/humanModes
  仅在没有 interaction 时生效。**驳回是流程动作**：`submit(decision:'reject')`→node-returned，重置目标与
  下游，attempts/timeline/产物按 attempt 后缀保留；external-checkpoint 重放旧 rest/agent/tool 前须
  `resume({confirmExternal:true})`。
- 事件类型 `src/main/state/workflow-state.js`；退回策略 `src/main/flow/workflow-policy.js`；契约
  `src/main/contracts/workflow-interaction.js`。
- 画布多选整体移动是 LiteGraph 原生行为，只覆写 processNodeSelected；测它：CDP 两次按下 <300ms 判双击、
  合成拖拽先发一次 hover move。折叠 details 里 focus() 静默失效，重绘后要聚焦先展开祖先 details。
- 改单行压缩风格函数后 `node --check` + 括号平衡扫描（少一个 } 会让后续函数掉出 IIFE，报 xxx is not defined）。

## 画布布局与连线
- `src/renderer/workflow-auto-layout.js`（纯 UMD，别塞回 workflows.js）：最长路径分层→重心法 4 轮降交叉→
  horizontal/vertical/layered；`fit` 按 `fitScale*4-|ln(长宽比/视口比)|` 挑；环不再拒绝布局。入口是 Ribbon 的
  `#workflowArrange` 下拉，默认 layoutMode=fit，新图在 rAF 里排。
- `fitGraph(minScale)` 带下限，自适应 `READABLE_MIN_SCALE=.5`；横/纵/分层仍 `readableGraph()`（产品决策，
  别改成自动 fit）。
- 正交布线扇出分道：`route()` 的 startLane/endLane + `elbow()`；穿越检查拆两段判（hits() 对斜线一律 true）；
  分组键 `(source, origin_slot)`，间距 12px。
- 流程 Ribbon（`workflow-ribbon.css`）：顶部条锁 69px + 隐藏 `#workflowNodeTypes` 横向滚动条（原生滚动条
  占 17px 会把条撑到 86、画布下跳）；分组竖线用 `--divider`。

## 渲染层
- 思考过程=步骤时间线：一轮一个 details.thinking-block.process-timeline，每步
  `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`；**状态存 class 不存 data-\***（走 processHtml 存回来）。
- 折叠条摘要行的 chevron/标题/转圈/耗时是**同一批节点复用**（`ensureTimelineSummary`）：`updateRunStatus`
  每 500ms 刷一次，重建 DOM 会让转圈动画反复归零、看着像一根斜线。运行中耗时一直显示，<1s 才留空。
- 助手正文**流式就按 markdown 渲染**：delta 只累加 `body.dataset.raw`，`scheduleStreamPaint` 节流（90ms /
  长文 280ms，首帧同步）；收尾事件不带正文时 `endAssistant` 用 raw 兜底 —— 否则报错/被停止时气泡永远停在
  `## ` `**` 源码里。markdown.js 支持 `> 引用`（先转义再分行 → 匹配 `&gt;`，要求后面是空格或行尾）与
  `---` 分隔线（必须排在列表判断前，否则 `- - -` 被当列表项），CSS 一律用 `--divider`。
- `#runStatus` 放在 `#messagesInner` 外（否则被 clearMessages 清）；`state.runs` 按会话记账，事件带
  sessionId，非当前会话只记账不碰 DOM。
- 存储：AGENT_HOME 下 settings.json + sessions + ui-store.json；桥两条腿 = preload IPC 与 web-bridge HTTP；
  `save()` 返回 ≠ 已落盘，断言磁盘先 `await store.flush()`。
- 剪贴板：`navigator.clipboard.writeText` 要求 document 有焦点，窗口不在前台就 `NotAllowedError`；
  `execCommand('copy')` 在 await 之后用会丢用户手势。真源是主进程 `clipboard:write` → preload `dsh.copyText`
  → 渲染层 `window.copyToClipboard()`，别在业务里直接调浏览器 API。
- 输入框（contenteditable）：Enter 发送，Ctrl/⌘/Shift+Enter 走 `insertPlainLineBreak()` —— 光标所在顶层块
  一分为二，光标后内容 extractContents 进干净 div 并压成纯文本，粘贴的 `<h2>/<strong>` 原样保留。

## 窗口 / 主题 / 排版
- 窗口外观真源 `shell/window-chrome.js`（两个主进程入口都 require）：frame:false + preload 注入自绘
  `.window-controls`（不依赖 titleBarOverlay → Win7 可用）；`TITLEBAR_HEIGHT=44`，改它要同步两份 CSS +
  4 个 smoke。守卫 shell-chrome-smoke / window-controls-smoke（所有 -webkit-app-region 选择器必须挂平台类）。
  主窗口 `minWidth:980` → 桌面端 ≤900 的媒体查询进不去（只有 web-bridge 端命中）。
- ☰ 应用菜单是渲染层自绘（`src/renderer/app-menu.js`），不是 menu.popup()；原生模板只留加速键，Alt 不翻菜单。
- 两套主题（灰黑 #212121 / 白 #ffffff），去蓝青渐变阴影，只用现有 CSS 变量。**分组竖线/分割线一律
  `--divider`**（深 #4c4c4c / 浅 #c9c9c9），别用 `--border`（深 #303030 等于 panel-2、浅 #eee 画在 #f5f5f5 上看不见）。
- 排版：`typography.css` 必须排在 style.css 之前（否则 var 未定义、整页 16px）；6 个 woff2 在 fonts/（OFL）；
  字号只 6 档 12/13/14/16/20/24（caption/small/base/heading/title/display）、字重 400/500/600；新界面禁写字面量；
  `server/index.js` 的 MIME 要 `.woff2`。验收 `typography-smoke` + `npm run check:typography:browser`。

## 样式纪律（都踩过）
- **三个内容页（知识库 / 能力中心 / 工作流）共用一套外壳变量**（style.css 末尾「统一版心」块）：
  `--page-gutter` clamp(20,4vw,56) / `--page-max` **none（铺满，别封 1200）** / `--card-bg` / `--card-border` /
  `--card-radius` 10 / `--card-pad` 14 16。新页面一律用这套变量。浅色卡片必须
  `[data-theme=light] …{--card-bg:#f5f5f4;--card-border:#e1e1df}`（`--panel` 在浅色=纯白会融掉）；工作流卡要
  `#workflowPage .workflow-card` 才压得过 `[data-theme=light] .workflow-card`。版心规则给直接子块加
  `width:100%`，行内小按钮（`#knowledgeOverview`）要复位 `width:auto`。**页头 `margin:0 0 16px` 会冲掉版心的
  `margin:auto`**（页头贴左、列表居中错位一截）→ 宽度靠 `width:100%` 铺满，别居中封顶。
- 能力中心页头无副标题，「安装离线扩展包」整条挂在 `.capability-heading` 里紧跟 h1：`flex-wrap:nowrap` +
  h1 `flex:0 0 auto` + 安装条 `flex:1 1 auto;min-width:0`（说明文字 ellipsis），≤760px 才折行 —— 靠
  `flex-wrap:wrap` 自然换行会让「返回聊天」在 960 宽掉到第二行左侧。
- 同一批选择器写进多处时**最后写入的赢** → 末尾放明确归属的收口块并写注释。收口块会反过来压掉前面的
  `@media`（同特异性）；隐藏类用 `#app` 前缀提特异性。改样式前先比特异性：
  - 多 ID 的布局规则（`#capabilityCenter #mcpList > .x` = 2,1,0）会压死 `:has()` 补丁（1,2,1）—— 连接器卡片
    `height:var(--cap-card-height)` 就是这样把 `details` 展开的工具条顶到卡片外的，改成 `height:auto`。
  - 通用 `.modal-card{max-height:calc(100vh-48px);overflow:auto}`（0,1,0，末尾）会顶掉同名 0,1,0 更早规则 →
    要控弹窗尺寸必须写 `#mcpDetailModal .modal-card`；`overflow:auto` 放整卡会把标题和底部按钮一起滚走，
    正确做法是卡 `overflow:hidden` + 内容区自己 `overflow-y:auto`。
  - 危险色要压过 `.workflow-icon-action:hover:not(:disabled)`（0,3,1）：写
    `.workflow-card-actions .workflow-icon-action[data-workflow-action=delete]:hover:not(:disabled)`。
  - 伪元素箭头同理：`summary::before` 塞 ▸/▾ 会缺字形变「方框套三角」，还会被
    `.thinking-block.thinking-active summary::before`（0,2,1）换成转圈。现在用 `span.timeline-summary-chevron`
    （icons.js 的 chevron，`[open]` 转 90°），`::before` 用 `#app` 前缀 `content:none` 压死。
- **列表类 UI 不要在定时刷新里无条件重建 DOM**：`workflows.js` 每 1.5s `refresh()`，`renderFlows()` 原来
  每次 `textContent=''` 重建卡片 → 新 DOM 没有 `:hover`，「hover 才淡入」的删除按钮一秒闪一次。现在
  `renderFlows(force)`/`renderRuns(force)` 先比数据签名（`flowsRenderKey`/`runsRenderKey`），没变就 return，
  `ResizeObserver` 用 `force` 穿透；删除按钮改常显 muted 色（hover 转危险色）。
- 图标尺寸真源是 style.css 全局表（`button .icon svg` = 20px，0,2,1）；单独改要带前缀。viewBox 是 24 正方形，
  别写非方形宽高（会把圆压成椭圆）。用文字字符当图标（`⌄` `↑` `+`）一律换 `data-icon` 图标库；
  `applyIcons(root)` **不含 root 自身**。新增 `@media(max-width:900px)` 会打碎 renderer-smoke 里
  `lastIndexOf` 找最后一块的断言 → 改成遍历。
- 伪元素画分割线**必须 absolute**：窄栏（≤900px）`.sidebar-footer` 是 flex，普通块级 `::before` 会变成 flex
  项、吃掉 80% 宽把内容挤走。做法 `position:absolute; left:10%; right:10%; top:0; height:1px;
  background:var(--divider)`。验证窄栏用「临时把容器 display 设成 flex」等价模拟。
- 侧边栏底部「设置」行几何：`.sidebar-footer{padding:5px 0 0}` + `#sidebar .footer-button{height:26px;
  align-items:center;line-height:1}` + `.sidebar{padding-bottom:6px}` = 整块 37px。三个坑：① `.sidebar` 有
  `row-gap:10px`，footer 必须 `margin-top:-10px` 抵消，否则露 10px 空白 + 半截字；② `height:1px` 在 150% 缩放
  被取整成 2 物理像素，要配 `transform:scaleY(.5)`；③ 列表底部用 footer `::after` 14px
  `linear-gradient(to top, var(--sidebar), transparent)` 渐隐，**别用 mask 盖 `.sidebar-scroll`**（整块文字进
  合成层、子像素抗锯齿全丢）；footer 底色取 `var(--sidebar)` 不透明并同步 `[data-theme=light]` 那条。
- 面板内按钮（`#knowledgeClose`、`#knowledgeImport`、`#knowledgeImportFolder`）一律 `background:var(--panel-2)`
  + `border:1px solid var(--divider)` + 显式 `color:var(--text)`；别用 `--panel`/`--border`（浅色会融成白底裸字、
  深色 `#303030` 画在同值 `--panel-2` 等于无边界）。
- 知识库详情网格左栏 `300px`（窄屏 `210px`），别低于 260px；宽度可拖拽：`#knowledgeListResize`（8px 竖条，
  `left:calc(var(--knowledge-list-width,300px) - 4px)`）改 CSS 变量驱动 grid 首列，拖拽夹 220~520、松手写
  `localStorage['dsh-knowledge-list-width']`、双击回 300；rAF 节流照 panel.js `bindColResize`（IIFE 私有，
  跨模块自己抄小份）。测它合成 MouseEvent 必须**拆三步**（down+move → sleep 等 rAF → up）；真窗口探针等
  `openLibrary` 出现后还要 `sleep(500)` 再点（监听器挂 init 后半段，立刻点=no-op，现象是 pane 宽 0）。
- 连接器卡片（`#capabilityCenter #capConnectors`，`--cap-card-height:78px`）只放概要，工具清单走
  `#mcpDetailModal`（`openMcpDetail/closeMcpDetail`）；内置服务也有「详情」按钮，所以
  `querySelectorAll('#mcpList .mcp-icon-button').length===0` 不再等于「不能编辑删除」，要用 `.danger` 判。

## 其他
- md-skills（65 个）在 `src/main/agent/md-skills/`，系统提示只放 id + 90 字简介。
- 自我验证工具：browser_launch/act/eval/browser_close、test_run、wait_ready、validate_ledger；
  用完必须关浏览器、停自起服务。
