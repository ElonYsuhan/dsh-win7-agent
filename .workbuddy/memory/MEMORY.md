# dsh-win7-agent 长期记忆（产品名 Agent，当前 0.4.4）

2026-10-17 重写、2026-11-03 合并去重。0.1.x 时代细节已随 0.1.3–0.3.4 重构失效，历史叙事留在
`MEMORY-2026-10-07.md.bak` 与 daily logs。2026-10-28 `git reset --hard origin/main` 曾冲掉本机知识，
已合并回来；被丢弃的本地提交备份在 tag `backup/local-03b6c12-20261028` 与 `E:\Elon\backups\dsh-win7-agent\`
（`local-commit-20261028\`、更早的 `r30-20261016\`）。

## 硬约束
- Win7 SP1 x64 可跑：Electron 22.3.27 / Node 16.17.1 / Chromium 108；禁原生模块、无生产依赖、不联网
  （清单以 `scripts/check-win7-compat.js` 为准）。
- 架构底座是 Cordis（`src/main/runtime/vendor/cordis`）；改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- 只维护 8080 常驻实例；测试一律随机端口 + 临时 AGENT_HOME。
- 交付规则见 `AGENTS.md`：改完打包**当前开发平台**（这里是 win-x64）、覆盖同名产物、不手动涨版本；
  用户说「发版」才升版本并打全平台；未经要求不自动启动应用。
- git：origin=github.com/ElonYsuhan/dsh-win7-agent(main)。用户说「本地提交不要了」→ 先打备份 tag +
  `git format-patch` 再 `reset --hard origin/main`。

## 打包与验收
- 本机跑脚本用 `"/d/Program Files/nvm/v16.20.2/node.exe" scripts/x.js`；装依赖用 PATH 上的 node 22
  （lock 是 v3，npm 8 写不动）。
- 真机窗口脚本（check:theme/drag/shellpage/browser/first-chat/ui）要**用普通 node 跑**（自己 spawn Electron）
  + `SMOKE_NO_SANDBOX=1`；拿 Electron 当解释器跑 shell-drag 会静默 skip（exit=0，别被骗）。
- 打包：node ≥20，`node scripts/build-desktop.js win-x64`，须放开沙箱 + 前台 +
  `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`；日志要有 `exe branding applied: Agent.exe`。
- 单入口交付：`release/desktop/Agent-<target>/` 只有 Agent.exe / .app / .AppImage，中间目录在
  `release/.desktop-build/`；仓库镜像 `installers/Agent-<target>/` 要同步 `SHA256SUMS.txt` +
  `build-info.json`（uiBuild / packageBuildId 取自包内 `desktop-build.json`）。
- 打包后必做：包内改动文件与源码逐字节 cmp（win 前缀 `Agent-<target>/resources/app`；少这层 = 空串假绿）。
- **混淆载荷不能靠 cmp**：`fillAppDir` 把渲染层混淆压缩，包内 `icons.js`/`knowledge.js`/`app.js`/`markdown.js`
  全是 `_0x` 变量 + 属性重命名版，**源码 vs 包内逐字节 cmp 必然全 DIFF，不是过期**。核对方法：
  纯文本资源（style.css / index.html）可 cmp；混淆载荷走 `source-protection.json` 的 sourceSha256，
  或 grep 标记（如「添加文件夹」/「knowledge-empty-state」）+ `node require` 包内模块打印关键常量
  （如 `LIMITS.fileBytes`）确认功能改动到位。
- **publish 的目录 rename 会被垫片打回**：NODE_OPTIONS 注入的 node-brokered-fs-shim 让 rename 走 trash，
  报 `EBUSY ... rename ... previous-delivery`。2026-11-03 遇到 `release/desktop/Agent-win-x64` 被某进程占成
  cwd（能往里写文件、不能改名/删除）→ 只能手动 `cp delivery/Agent.exe`，再
  `require('./scripts/desktop-distribution').checksums('release/desktop')` 补校验和，跑
  desktop-distribution-smoke 兜底。
- NSIS（`scripts/desktop/installer.nsh`）：嵌套 `!include` 只认反斜杠绝对路径；被 include 的 .nsh 不能含
  非 ASCII（注释一律英文）。customInit 比 `HKCU\Software\Agent\OfflineLauncher` 的 BuildId，命中直接 Exec
  已装 exe；customInstall 要显式建桌面快捷方式（isUpdated 分支不重建），并在末尾调
  shell32::SHChangeNotify(SHCNE_ASSOCCHANGED) + Win8 以上 ie4uinit -ClearIconCache 刷图标缓存 —— 否则
  原地升级后桌面还是旧图标，用户会以为「安装没更新资源」（2026-11-03）。
- 图标改动是整条链路，缺一环就白改：make-logo.py 生成 assets/icons 全套 → build-desktop 用 icon.ico 做
  exe branding（日志 exe branding applied）→ electron-builder 打进安装器 → 安装器刷缓存。自检三处：
  源码 ico 七帧（16/24/32/48/64/128/256）alpha bbox 满幅、安装目录 resources/app/assets/icons 与源码
  同尺寸同内容、装好的 exe 内嵌七帧同样满幅。用户说「图标还是小」先怀疑 shell 缓存，别急着改设计。

## Windows 本机环境
- 全仓 CRLF：跨行 indexOf/slice 断言先归一 `\r\n`→`\n`，否则静默假红；renderer-smoke 的 vm 假 DOM
  还要 getComputedStyle 桩。
- 既有必红夹具（夹具的锅，非代码）：installer-smoke、shell-menu-smoke；修复补丁在 backups 目录。
- 从自动化宿主起 Agent.exe：清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`；父进程在宿主树里会 GPU 崩 →
  借 explorer 当父进程 `Start-Process explorer.exe -ArgumentList '"<exe 全路径>"'`。
- 无 shasum 用 sha256sum；**空串比空串=全量假绿**，比较前判非空。Bash 吃反斜杠（`$APPDATA`→`C:Users...`）。
- macOS BSD grep 不支持 `\|`；`renderer-smoke.js` 用例在模板字符串里（`\d` 会被吃掉，用 `[0-9]`；
  注释里不能有反引号）。`app.js` 同时有中文与 `\uXXXX`，用 python 按行替换更稳。

## 已知既有红（复现过，别重复查）
- `check:drag` 675/677；`workflow-canvas-e2e-smoke` 本机必红（wrap 路由 / serpentine 那几条，HEAD 基线同红）。
- `knowledge-e2e-smoke` 既有红：`内存验收` 循环 `.knowledge-project-folder summary` click null
  （2026-11-03 用 stash 基线复跑确认，死点前的断言都能跑过）；update-takeover（macOS 探针失败）、
  document-mcp（reading 'result' of undefined）、theme-smoke 74/75
  （renderer 报 unsafe-eval，CSP 只有 script-src self）。
- 知识库文档行**不再显示解析提示**：parser-worker 的 notice 会被 service 写进 jobs.error（成功也写），
  渲染层只对 `phase!=='ready'` 的文档画 error；改提示文案要去 `parser-worker.js`，别在渲染层找。
  文档行标题单行省略（nowrap+ellipsis），解析中 phase 标签保留。
- 会话存储服务端优先（`/api/ui-store`），造种子必须写服务端；浏览器 e2e 的 `driver.launch` 必须带 noSandbox。

## 工作流
- 人工节点主入口 `interaction:{version:1,type:'handle'|'review'|'approve',returnTo}`；旧 humanKind/humanModes
  仅在没有 interaction 时生效。**驳回是流程动作**：`submit(decision:'reject')`→node-returned，重置目标与下游，
  attempts/timeline/产物按 attempt 后缀保留；external-checkpoint 重放旧 rest/agent/tool 前须
  `resume({confirmExternal:true})`。
- 事件类型 `src/main/state/workflow-state.js`；退回策略 `src/main/flow/workflow-policy.js`；契约
  `src/main/contracts/workflow-interaction.js`。
- 画布多选整体移动是 LiteGraph 原生行为，只覆写 processNodeSelected；测它：CDP 两次按下 <300ms 判双击、
  合成拖拽先发一次 hover move。折叠 details 里 focus() 静默失效，重绘后要聚焦先展开祖先 details。
- 改单行压缩风格函数后 `node --check` + 括号平衡扫描（少一个 } 会让后续函数掉出 IIFE，报 xxx is not defined）。

## 画布布局与连线
- `src/renderer/workflow-auto-layout.js`（纯 UMD，别塞回 workflows.js）：最长路径分层→重心法 4 轮降交叉→
  horizontal/vertical/layered；`fit` 按 `fitScale*4-|ln(长宽比/视口比)|` 挑一个；环不再拒绝布局。
  入口是 Ribbon 的 `#workflowArrange` 下拉，默认 layoutMode=fit；新图在 rAF 里排。
- `fitGraph(minScale)` 带下限，自适应 `READABLE_MIN_SCALE=.5`；横/纵/分层仍 `readableGraph()`
  （产品决策，别改成自动 fit）。
- 正交布线扇出分道：`route()` 的 startLane/endLane + `elbow()`；穿越检查拆两段判（hits() 对斜线一律 true）；
  分组键 `(source, origin_slot)`，间距 12px。
- 对账打包源码：`source-protection.json` 的 sourceSha256 是**混淆前**哈希，按 path 精确匹配
  （`endsWith('/workflows.js')` 会先命中 contracts/workflows.js）。

## 渲染层
- 思考过程=步骤时间线：一轮一个 details.thinking-block.process-timeline，每步
  `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`；**状态存 class 不存 data-\***（走 processHtml 存回来）。
- 助手正文**流式就按 markdown 渲染**：delta 只累加 `body.dataset.raw`，
  `scheduleStreamPaint` 节流重排（90ms / 长文 280ms，首帧同步）；收尾事件不带正文时
  `endAssistant` 用 raw 兜底 —— 否则报错/被停止时气泡永远停在 `## ` `**` 源码里。
  markdown.js 支持 `> 引用`（先转义再分行 → 匹配 `&gt;`，且要求后面是空格或行尾）与
  `---` 分隔线（必须排在列表判断前，否则 `- - -` 被当列表项），CSS 一律用 `--divider` 画线。
- `#runStatus` 放在 `#messagesInner` 外面（否则被 clearMessages 清）；`state.runs` 按会话记账，
  事件带 sessionId，非当前会话只记账不碰 DOM。
- 折叠条摘要行的 ▸/▾ 图标、标题、转圈、耗时是**同一批节点复用**（`ensureTimelineSummary`）：`updateRunStatus` 每 500ms 刷一次，重建 DOM 会让转圈动画反复归零、看着像一根斜线。运行中耗时必须一直显示（已结束步之和 + 进行中步未落账增量），<1s 才留空。
- 存储：AGENT_HOME 下 settings.json + sessions + ui-store.json；桥两条腿 = preload IPC 与 web-bridge HTTP；
  `save()` 返回 ≠ 已落盘，断言磁盘先 `await store.flush()`。
- 剪贴板：`navigator.clipboard.writeText` 在 Electron 里要求 document 有焦点，窗口不在前台就
  `NotAllowedError: Document is not focused`（渲染层只能静默失败）；`execCommand('copy')` 在 await 之后
  用会丢用户手势。真源是主进程 `clipboard:write`（publicChannels 放行）→ preload `dsh.copyText` →
  渲染层 `window.copyToClipboard()`（IPC → 浏览器 API → execCommand 兜底），别在业务代码里直接调浏览器 API。
- 输入框（contenteditable）：Enter 发送，Ctrl/⌘/Shift+Enter 走 `insertPlainLineBreak()` —— 光标所在顶层块
  一分为二，光标后的内容 extractContents 进干净 div 并压成纯文本，粘贴的 <h2>/<strong> 原样保留。
- 用 `BrowserDriver.launch(url)` 起的是裸 Electron（无 preload），CDP 常在隔离世界里，`window.dsh` 读不到；
  要验 preload/IPC 必须 `driver.launch('.')` 起真实主进程。

## 窗口 / 主题 / 排版
- 窗口外观真源 `shell/window-chrome.js`（两个主进程入口都 require 它）：frame:false + preload 注入自绘
  `.window-controls`（不依赖 titleBarOverlay → Win7 可用）；`TITLEBAR_HEIGHT=44`，改它要同步两份 CSS +
  4 个 smoke。守卫：shell-chrome-smoke / window-controls-smoke（所有 -webkit-app-region 选择器必须挂平台类）。
- ☰ 应用菜单是渲染层自绘（`src/renderer/app-menu.js`），不是 menu.popup()；原生模板只留加速键，Alt 不再翻菜单。
- 两套主题（灰黑 #212121 / 白 #ffffff），去蓝青渐变阴影，只用现有 CSS 变量。**分组竖分隔线用 `--divider`**
  （深 #4c4c4c / 浅 #c9c9c9），别用 `--border`：深色里它等于 panel-2、浅色 #eee 画在 #f5f5f5 上看不见。
- 排版：`typography.css` 必须排在 style.css 之前（否则 var 未定义、整页 16px）；6 个 woff2 在 fonts/（OFL）；
  字号只 6 档 12/13/14/16/20/24、字重 400/500/600；新界面禁写字面量；`server/index.js` 的 MIME 要 `.woff2`。
  验收 `typography-smoke` + `npm run check:typography:browser`，细节见 `docs/TYPOGRAPHY.md`。

## 样式纪律（都踩过）
- **三个内容页（知识库 / 能力中心 / 工作流）共用一套外壳变量**：style.css 末尾「统一版心」块里的
  `--page-gutter`(clamp(20,4vw,56)) / `--page-max`(**none = 铺满**，2026-11-04 用户要求，别再封 1200) /
  `--card-bg` / `--card-border` / `--card-radius`(10) / `--card-pad`(14 16)；
  新增此类页面一律用这套变量，别再单独写 padding/卡片样式。
  浅色卡片必须走 `[data-theme=light] …{--card-bg:#f5f5f4;--card-border:#e1e1df}` 特判（`--panel` 在浅色
  等于纯白，会和白底融掉）；工作流卡要 `#workflowPage .workflow-card` 才压得过 `[data-theme=light] .workflow-card`。
  版心规则会给直接子块加 `width:100%`，行内小按钮（如 `#knowledgeOverview`）要单独复位 `width:auto`。
  **页头的 `margin: 0 0 16px` 会冲掉版心的 `margin:auto`** → 一旦给内容设了 max-width，页头贴左、
  列表居中，错位一截；所以宽度必须靠 `width:100%` 铺满，别用居中封顶。
  能力中心页头（2026-11-04）已无副标题，「安装离线扩展包」整条挂在 `.capability-heading` 里紧跟 h1：
  `flex-wrap:nowrap` + h1 `flex:0 0 auto` + 安装条 `flex:1 1 auto;min-width:0`（说明文字 ellipsis），
  只有 ≤760px 才折行 —— 靠 `flex-wrap:wrap` 自然换行会让「返回聊天」在 960 宽掉到第二行左侧。
- 同一批选择器被写进多处时**最后写入的赢** → 在文件末尾放明确归属的收口块并写注释。
- **列表类 UI 不要在定时刷新里无条件重建 DOM**：`workflows.js` 每 1.5s `refresh()`，`renderFlows()`
  原来每次 `textContent=''` 重建卡片 → 新 DOM 没有 `:hover`，「hover 才淡入」的删除按钮一秒闪一次。
  现在 `renderFlows(force)` / `renderRuns(force)` 先比数据签名（`flowsRenderKey`/`runsRenderKey`），
  没变就 return，`ResizeObserver` 用 `force` 穿透。删除按钮也改成常显 muted 色（hover 转危险色）。
- 危险色要压过 `.workflow-icon-action:hover:not(:disabled)`（0,3,1），属性选择器 + `:is()` 只有 0,2,1
  → 写 `.workflow-card-actions .workflow-icon-action[data-workflow-action=delete]:hover:not(:disabled)`。
- 末尾收口块会反过来压掉前面的 `@media`（同特异性）；隐藏类规则用 `#app` 前缀提特异性，别靠顺序。
- 图标尺寸真源是 style.css 的全局表（`button .icon svg` = 20px，特异性 0,2,1）；单独改要带前缀。
  viewBox 是 24 正方形，别写非方形宽高（会把圆压成椭圆）。
- 新增 `@media(max-width:900px)` 块会打碎 renderer-smoke 里 `lastIndexOf` 找最后一块的断言 → 改成遍历。
- 用文字字符当图标（`⌄` `↑` `+`）一律换 `data-icon` 图标库；`applyIcons(root)` **不含 root 自身**。
- 折叠箭头同理：`summary::before` 塞 ▸/▾ 会踩两个坑——缺字形渲染成「方框套三角」、老规则
  `.thinking-block.thinking-active summary::before`（0,2,1）权重更高把箭头换成转圈圆环。
  现在摘要行是 `span.timeline-summary-chevron`（icons.js 的 chevron，`[open]` 转 90°），
  `::before` 用 `#app` 前缀 `content:none` 压死；改这类伪元素先比权重再改样式。
- 伪元素画分割线**必须 absolute**：窄栏（≤900px）`.sidebar-footer` 是 display:flex，普通块级
  `::before` 会变成 flex 项、吃掉 80% 宽把内容挤走。做法 `position:absolute; left:10%; right:10%; top:0;
  height:1px; background:var(--divider)`。另注意主窗口 `minWidth: 980`（main.js）→ 桌面端 ≤900 的媒体查询
  根本进不去（web-bridge 端才会命中），验证窄栏用「临时把容器 display 设成 flex」等价模拟。
- 侧边栏底部「设置」行几何：`.sidebar-footer{padding:5px 0 0}` + `#sidebar .footer-button{height:26px;
  align-items:center;line-height:1}` + `.sidebar{padding-bottom:6px}` = 整块 37px；图标与文字靠 flex 压同一中线。
  分割线/空白三个坑：① `.sidebar` 有 `row-gap:10px`，footer 必须 `margin-top:-10px` 抵消，
  否则列表裁切线与分割线之间露出 10px 空白 + 半截字；② `height:1px` 在 150% 缩放下被取整成
  **2 个物理像素**，要配 `transform:scaleY(.5)` 才是头发丝；③ 列表底部用 footer `::after`
  14px `linear-gradient(to top, var(--sidebar), transparent)` 渐隐，**别用 mask 盖
  `.sidebar-scroll`**（整块文字进合成层，子像素抗锯齿全丢）；footer 底色取 `var(--sidebar)`
  不透明（同色不透明≠色块，但仍要同步 `[data-theme=light]` 那条 0,2,0 规则）。
- 流程 Ribbon（`workflow-ribbon.css`）：顶部条高度锁 69px + 隐藏 `#workflowNodeTypes` 横向滚动条
  （溢出时原生滚动条占 17px，会把条从 69 撑到 86、画布跟着下跳）；分组竖线用 `--divider`。
- 知识库面板「面板内按钮」（返回聊天 `#knowledgeClose`、添加资料/文件夹 `#knowledgeImport`/
  `#knowledgeImportFolder`）一律 `background:var(--panel-2)` + `border:1px solid var(--divider)` +
  显式 `color:var(--text)`；别用 `--panel`/`--border`（浅色档 `--panel=#fff`/`--border=#eee`
  会融成白底裸字近隐形，深色档 `--border=#303030` 画在同值 `--panel-2` 上也等于无边界）。
  详情网格左栏 `grid-template-columns` 用 `300px`（窄屏 `210px`），别低于 260px。
- 知识库左栏宽度可拖拽：`#knowledgeListResize`（8px 竖条，`left:calc(var(--knowledge-list-width,300px) - 4px)`）
  改写 CSS 变量驱动 grid 首列，拖拽夹 220~520、松手写 `localStorage['dsh-knowledge-list-width']`、
  双击回 300；rAF 节流照 panel.js `bindColResize`（那个 helper 是 IIFE 私有不导出，跨模块要自己抄小份）。
  测它用合成 MouseEvent 必须**拆三步**（down+move → sleep 等 rAF → up），同步连发读不到 flush 后宽度；
  真窗口探针等 `openLibrary` 出现后还要 `sleep(500)` 再点（监听器挂 init 后半段，立刻点= no-op，
  现象是停在聊天页、pane 宽 0）。

## 其他
- md-skills（65 个）在 `src/main/agent/md-skills/`，系统提示只放 id + 90 字简介。
- 自我验证工具：browser_launch/act/eval/browser_close、test_run、wait_ready、validate_ledger；
  用完必须关浏览器、停自起服务。
