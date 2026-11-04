# dsh-win7-agent 长期记忆（产品名 Agent，当前 0.4.4）

2026-11-04 重写精简（上一版 2026-11-03）。0.1.x–0.3.x 细节随重构失效，历史叙事留在
`MEMORY-2026-10-07.md.bak` 与 `.workbuddy/memory/*.md`。2026-10-28 `git reset --hard origin/main`
冲掉过本机知识，已被本文件合并回来；被丢弃的本地提交在 tag `backup/local-03b6c12-20261028` 与
`E:\Elon\backups\dsh-win7-agent\`。

## 硬约束
- Win7 SP1 x64：Electron 22.3.27 / Node 16.17.1 / Chromium 108；禁原生模块、无生产依赖、不联网
  （以 `scripts/check-win7-compat.js` 为准）。
- 底座 Cordis（`src/main/runtime/vendor/cordis`）；改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- 只维护 8080 常驻实例；测试一律随机端口 + 临时 AGENT_HOME。
- 交付见 `AGENTS.md`：改完打包**当前平台**（win-x64）、覆盖同名产物、不手动涨版本；「发版」才升版本打全平台；
  未经要求不自动启动应用。git origin=github.com/ElonYsuhan/dsh-win7-agent(main)；「本地提交不要了」→ 先打
  备份 tag + `git format-patch` 再 reset。

## 打包与验收
- 本机跑脚本 `"/d/Program Files/nvm/v16.20.2/node.exe" scripts/x.js`；装依赖用 PATH 上 node 22（lock v3）。
- 真机窗口脚本（theme/drag/shellpage/browser/first-chat/ui/knowledge-panel）**用普通 node 跑**（自己 spawn
  Electron）+ `SMOKE_NO_SANDBOX=1`；拿 Electron 当解释器会静默 skip（exit=0，别被骗）。
- 打包：node ≥20，`node scripts/build-desktop.js win-x64`，须放开沙箱 + 前台 +
  `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`；日志要有 `exe branding applied: Agent.exe`。
- 单入口交付：`release/desktop/Agent-<target>/` 只有 Agent.exe/.app/.AppImage，中间目录在
  `release/.desktop-build/`；镜像 `installers/Agent-<target>/` 同步 `SHA256SUMS.txt` + `build-info.json`
  （uiBuild / packageBuildId 取包内 `desktop-build.json`）。
- 打包后必做：包内文件与源码 cmp（win 前缀 `Agent-<target>/resources/app`，少这层=空串假绿；比较前判非空）。
- **混淆载荷不能 cmp**：`fillAppDir` 混淆 app/knowledge/workflows/icons/markdown.js，源码 vs 包内必然 DIFF
  （不是过期）。核对走 `source-protection.json` 的 `records[].sourceSha256`（**混淆前**哈希，按 path 精确匹配：
  `endsWith('/workflows.js')` 会命中 contracts/workflows.js），或 grep 标记 + `node require` 打印常量；
  变量名会重命名，包内 grep `flowsRenderKey` 是 0 不能当没打进去。纯文本（style.css/index.html）直接 cmp。
- **publish 的目录 rename 会被垫片打回**：node-brokered-fs-shim 让 rename 走 trash，报 `EBUSY ...
  previous-delivery`（某进程把 `release/desktop/Agent-win-x64` 占成 cwd：能写不能改名）→ 手动
  `cp delivery/Agent.exe` + `require('./scripts/desktop-distribution').checksums('release/desktop')` 补校验和，
  跑 desktop-distribution-smoke 兜底。
- NSIS（`scripts/desktop/installer.nsh`）：嵌套 `!include` 只认反斜杠绝对路径；被 include 的 .nsh 不能含非
  ASCII。customInit 比 `HKCU\Software\Agent\OfflineLauncher` 的 BuildId，命中直接 Exec 已装 exe；customInstall
  要显式建桌面快捷方式（isUpdated 分支不重建），末尾调 `SHChangeNotify(SHCNE_ASSOCCHANGED)` +
  Win8 以上 `ie4uinit -ClearIconCache`，否则原地升级后桌面还是旧图标。
- 图标是整条链路：make-logo.py 生成 assets/icons → build-desktop 用 icon.ico 做 exe branding →
  electron-builder 打进安装器 → 安装器刷缓存。自检三处：源码 ico 七帧（16…256）alpha bbox 满幅、安装目录
  `resources/app/assets/icons` 与源码一致、装好的 exe 内嵌七帧同样满幅。「图标还是小」先怀疑 shell 缓存。
## Windows 本机环境
- 全仓 CRLF：跨行 indexOf/slice 断言先归一 `\r\n`→`\n`，否则静默假红；renderer-smoke 的 vm 假 DOM 还要
  getComputedStyle 桩。renderer-smoke 用例在模板字符串里（`\d` 被吃 → `[0-9]`、`(` → `[(]`、注释禁反引号）；
  `app.js` 中英混排（含 `\uXXXX`）用 python 按行替换更稳。macOS BSD grep 不支持 `\|`。
- 从宿主起 Agent.exe：清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`；父进程在宿主树里会 GPU 崩 →
  `Start-Process explorer.exe -ArgumentList '"<exe 全路径>"'`。Bash 吃反斜杠（`$APPDATA`→`C:Users...`）。
- 本机 Electron 窗口宽被压到 960 上限：量 1920/2560 用
  `driver.cdp.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false})`。
- 浏览器 e2e 的 `driver.launch` 必须带 noSandbox；`launch(url)` 起裸 Electron（无 preload），CDP 常在隔离
  世界读不到 `window.dsh` —— 验 preload/IPC 要 `driver.launch('.')`。

## 已知既有红（复现过，别重复查）
- `check:drag` 675/677；`workflow-canvas-e2e-smoke` 必红（wrap/serpentine，HEAD 同红）。
- `knowledge-e2e-smoke`：`内存验收` 循环 `.knowledge-project-folder summary` click null（2026-11-03 stash 基线
  确认）；`update-takeover`（macOS 探针）、`theme-smoke` 74/75（unsafe-eval，CSP 只有 script-src 'self'）、
  `extensions-e2e` 在 Windows 需先 `mkdir -p /e/tmp`。既有必红夹具：installer-smoke、shell-menu-smoke
  （夹具的锅，补丁在 backups）。
- 会话存储服务端优先（`/api/ui-store`），造种子必须写服务端。
- 知识库文档行**不显示解析提示**：parser-worker 的 notice 被 service 写进 jobs.error（成功也写），渲染层只对
  `phase!=='ready'` 画 error；改文案去 `parser-worker.js`。

## 工作流与画布
- 人工节点主入口 `interaction:{version:1,type:'handle'|'review'|'approve',returnTo}`；旧 humanKind/humanModes
  仅在没有 interaction 时生效。**驳回是流程动作**：`submit(decision:'reject')`→node-returned，重置目标与下游，
  attempts/timeline/产物按 attempt 后缀保留；external-checkpoint 重放前须 `resume({confirmExternal:true})`。
- 事件 `src/main/state/workflow-state.js`；退回策略 `src/main/flow/workflow-policy.js`；契约
  `src/main/contracts/workflow-interaction.js`。
- 画布多选整体移动是 LiteGraph 原生行为，只覆写 processNodeSelected；测它：CDP 两次按下 <300ms 判双击、合成
  拖拽先发一次 hover move。折叠 details 里 focus() 静默失效，重绘后要聚焦先展开祖先 details。
- 改单行压缩风格函数后 `node --check` + 括号平衡扫描（少一个 } 会让后续函数掉出 IIFE，报 xxx is not defined）。
- `src/renderer/workflow-auto-layout.js`（纯 UMD，别塞回 workflows.js）：最长路径分层→重心法 4 轮降交叉→
  horizontal/vertical/layered；`fit` 按 `fitScale*4-|ln(长宽比/视口比)|` 挑；环不拒绝布局。入口是 Ribbon
  `#workflowArrange` 下拉，默认 layoutMode=fit，新图在 rAF 里排。`fitGraph(minScale)` 带下限，自适应
  `READABLE_MIN_SCALE=.5`；横/纵/分层仍 `readableGraph()`（产品决策，别改成自动 fit）。
- 正交布线：`route()` 的 startLane/endLane + `elbow()`；穿越检查拆两段判（hits() 对斜线一律 true）；分组键
  `(source,origin_slot)`，间距 12px。Ribbon 顶部锁 69px + 隐藏 `#workflowNodeTypes` 横向滚动条（原生滚动条
  占 17px 会把条撑到 86、画布下跳）。

## 渲染层
- 思考过程=步骤时间线：一轮一个 `details.thinking-block.process-timeline`，每步
  `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`；**状态存 class 不存 data-\***。
- 折叠条摘要行的 chevron/标题/转圈/耗时是**同一批节点复用**（`ensureTimelineSummary`）：`updateRunStatus`
  每 500ms 刷一次，重建 DOM 会让转圈动画反复归零、像一根斜线。运行中耗时一直显示，<1s 才留空。
- 正文**流式就按 markdown 渲染**：delta 只累加 `body.dataset.raw`，`scheduleStreamPaint` 节流（90ms / 长文
  280ms，首帧同步）；收尾事件不带正文时 `endAssistant` 用 raw 兜底，否则报错/被停止时气泡停在 `## ` 源码里。
  markdown.js 支持 `> 引用`（先转义再分行 → 匹配 `&gt;`，要求后面是空格或行尾）与 `---` 分隔线（必须排在
  列表判断前，否则 `- - -` 被当列表项），CSS 一律 `--divider`。
- `#runStatus` 放在 `#messagesInner` 外（否则被 clearMessages 清）；`state.runs` 按会话记账，事件带 sessionId，
  非当前会话只记账不碰 DOM。
- 存储：AGENT_HOME 下 settings.json + sessions + ui-store.json；桥=preload IPC 与 web-bridge HTTP；
  `save()` 返回 ≠ 已落盘，断言磁盘先 `await store.flush()`。
- 剪贴板真源是主进程 `clipboard:write` → preload `dsh.copyText` → `window.copyToClipboard()`；浏览器
  `navigator.clipboard` 要求文档有焦点（窗口不在前台报 NotAllowedError），`execCommand` 在 await 之后丢手势。
- 输入框（contenteditable）：Enter 发送，Ctrl/⌘/Shift+Enter 走 `insertPlainLineBreak()` —— 光标所在顶层块一分
  为二，光标后内容 extractContents 进干净 div 压成纯文本，粘贴的 `<h2>/<strong>` 原样保留。

## 窗口 / 主题 / 排版
- 外观真源 `shell/window-chrome.js`（两个主进程入口都 require）：frame:false + preload 注入自绘
  `.window-controls`（不依赖 titleBarOverlay → Win7 可用）；`TITLEBAR_HEIGHT=44`，改它要同步两份 CSS + 4 个
  smoke。守卫 shell-chrome-smoke / window-controls-smoke（-webkit-app-region 选择器必须挂平台类）。
  主窗口 `minWidth:980` → 桌面端 ≤900 媒体查询进不去（只有 web-bridge 命中）。
- ☰ 应用菜单是渲染层自绘（`src/renderer/app-menu.js`），不是 menu.popup()；原生模板只留加速键。
- 两套主题（#212121 / #ffffff），只用现有 CSS 变量。**分组竖线/分割线一律 `--divider`**（深 #4c4c4c / 浅
  #c9c9c9），别用 `--border`（深 #303030=panel-2、浅 #eee 画在 #f5f5f5 上看不见）。
- 排版：`typography.css` 必须排在 style.css 之前（否则 var 未定义、整页 16px）；6 个 woff2 在 fonts/（OFL）；
  字号只 6 档 12/13/14/16/20/24、字重 400/500/600；新界面禁写字面量；`server/index.js` MIME 要 `.woff2`。
  验收 `typography-smoke` + `npm run check:typography:browser`。

## 样式纪律（都踩过）
- **三个内容页（知识库/能力中心/工作流）共用外壳变量**（style.css 末尾「统一版心」块）：`--page-gutter`
  clamp(20,4vw,56) / `--page-max` **none（铺满，别封 1200）** / `--card-bg` / `--card-border` / `--card-radius` 10 /
  `--card-pad` 14 16。浅色卡必须 `[data-theme=light] …{--card-bg:#f5f5f4;--card-border:#e1e1df}`（`--panel`
  浅色=纯白会融掉）；工作流卡要 `#workflowPage .workflow-card` 才压得过浅色覆盖。版心给直接子块加
  `width:100%`，行内小按钮（`#knowledgeOverview`）要复位 `width:auto`。**页头 `margin:0 0 16px` 会冲掉版心的
  `margin:auto`**（页头贴左、列表居中错位）→ 宽度靠 `width:100%` 铺满，别居中封顶。
- 能力中心页头无副标题，「安装离线扩展包」挂在 `.capability-heading` 里紧跟 h1：`flex-wrap:nowrap` + h1
  `flex:0 0 auto` + 安装条 `flex:1 1 auto;min-width:0`（说明文字 ellipsis），≤760px 才折行 —— 用
  `flex-wrap:wrap` 会让「返回聊天」在 960 宽掉到第二行左侧。
- 同一批选择器写多处时**最后写入的赢** → 末尾放归属明确的收口块并写注释；收口块会压掉前面的 `@media`
  （同特异性），隐藏类用 `#app` 前缀提特异性。**改样式前先比特异性**：
  - 多 ID 布局规则（`#capabilityCenter #mcpList > .x` = 2,1,0）会压死 `:has()` 补丁（1,2,1）—— 连接器卡片
    `height:var(--cap-card-height)` 就这样把 details 展开的工具条顶到卡片外，改成 `height:auto`。
  - 通用 `.modal-card{max-height:calc(100vh-48px);overflow:auto}`（0,1,0，末尾）顶掉更早的同名规则 → 控弹窗
    尺寸必须 `#mcpDetailModal .modal-card`；整卡 `overflow:auto` 会把标题和底部按钮一起滚走，正确做法是卡
    `overflow:hidden` + 内容区自己 `overflow-y:auto`。
  - 危险色要压过 `.workflow-icon-action:hover:not(:disabled)`（0,3,1）：写
    `.workflow-card-actions .workflow-icon-action[data-workflow-action=delete]:hover:not(:disabled)`。
  - 伪元素箭头：`summary::before` 塞 ▸/▾ 会缺字形变「方框套三角」，且被
    `.thinking-block.thinking-active summary::before`（0,2,1）换成转圈；现在用 `span.timeline-summary-chevron`
    （icons.js 的 chevron，`[open]` 转 90°），`::before` 用 `#app` 前缀 `content:none` 压死。
- **列表类 UI 别在定时刷新里无条件重建 DOM**：`workflows.js` 每 1.5s `refresh()`，`renderFlows()` 原来每次
  `textContent=''` 重建卡片 → 新 DOM 没有 `:hover`，「hover 才淡入」的删除按钮一秒闪一次。现在
  `renderFlows(force)`/`renderRuns(force)` 先比数据签名（`flowsRenderKey`/`runsRenderKey`），没变就 return，
  `ResizeObserver` 用 `force` 穿透；删除按钮改常显 muted（hover 转危险色）。
- 图标尺寸真源是 style.css 全局表（`button .icon svg` 20px，0,2,1），单独改要带前缀；viewBox 24 正方形，
  别写非方形宽高（圆会变椭圆）。文字字符当图标（`⌄ ↑ +`）一律换 `data-icon`；`applyIcons(root)` **不含
  root 自身**。新增 `@media(max-width:900px)` 会打碎 renderer-smoke 里 `lastIndexOf` 的断言 → 改遍历。
- 伪元素画分割线**必须 absolute**：窄栏（≤900px）`.sidebar-footer` 是 flex，块级 `::before` 会变 flex 项吃掉
  80% 宽；做法 `position:absolute;left:10%;right:10%;top:0;height:1px;background:var(--divider)`。验证窄栏用
  「临时把容器 display 设成 flex」等价模拟。
- 侧边栏「设置」行：`.sidebar-footer{padding:5px 0 0}` + `#sidebar .footer-button{height:26px;align-items:center;
  line-height:1}` + `.sidebar{padding-bottom:6px}` = 37px。三个坑：① `.sidebar` 的 `row-gap:10px` 要 footer
  `margin-top:-10px` 抵消（否则露 10px 空白+半截字）；② `height:1px` 在 150% 缩放取整成 2 物理像素，配
  `transform:scaleY(.5)`；③ 列表底部用 footer `::after` 14px `linear-gradient(to top,var(--sidebar),transparent)`
  渐隐，**别用 mask 盖 `.sidebar-scroll`**（文字进合成层，子像素抗锯齿全丢）；footer 底色取 `var(--sidebar)`
  不透明并同步 `[data-theme=light]`。
- 面板内按钮（`#knowledgeClose`、`#knowledgeImport`、`#knowledgeImportFolder`）一律 `background:var(--panel-2)`
  + `border:1px solid var(--divider)` + 显式 `color:var(--text)`；用 `--panel`/`--border` 在浅色会融成白底裸字、
  深色 `#303030` 画在同值 `--panel-2` 上等于无边界。
- 知识库详情左栏 `300px`（窄屏 `210px`），不低于 260px；`#knowledgeListResize`（8px 竖条，`left:calc(
  var(--knowledge-list-width,300px) - 4px)`）改 CSS 变量驱动 grid 首列，夹 220~520、松手写 localStorage、双击
  回 300；rAF 节流照 panel.js `bindColResize`（IIFE 私有，自己抄）。测它合成 MouseEvent 要**拆三步**
  （down+move → sleep 等 rAF → up）；探针等 `openLibrary` 出现后 `sleep(500)` 再点（监听器在 init 后半段）。
- 连接器卡（`--cap-card-height:78px`）只放概要，工具清单走 `#mcpDetailModal`（`openMcpDetail/closeMcpDetail`）；
  内置服务也有「详情」，所以 `querySelectorAll('#mcpList .mcp-icon-action').length===0` 不再等于「不能编辑
  删除」，要用 `.danger` 判。

## 其他
- md-skills（65 个）在 `src/main/agent/md-skills/`，系统提示只放 id + 90 字简介。自我验证工具用完必须关浏览器、
  停自起服务。
