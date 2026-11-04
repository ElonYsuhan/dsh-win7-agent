# dsh-win7-agent 长期记忆（产品名 Agent，0.4.4）

2026-11-04 二次精简（合并重复、只留结论）。更早的叙事在 `MEMORY-2026-10-07.md.bak` 与
`.workbuddy/memory/*.md`；2026-10-28 被 `git reset` 冲掉的本地提交在 tag `backup/local-03b6c12-20261028`。

## 硬约束
- Win7 SP1 x64：Electron 22.3.27 / Node 16.17.1 / Chromium 108；禁原生模块、无生产依赖、不联网
  （以 `scripts/check-win7-compat.js` 为准）。
- 底座 Cordis（`src/main/runtime/vendor/cordis`）；改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- 只维护 8080 常驻实例；测试一律随机端口 + 临时 AGENT_HOME。
- 交付见 `AGENTS.md`：改完打包**当前平台**（win-x64）、覆盖同名产物、不手动涨版本；「发版」才升版本打全平台；
  未经要求不自动启动应用。git origin=github.com/ElonYsuhan/dsh-win7-agent(main)。

## 打包与交付
- 本机跑脚本 `"/d/Program Files/nvm/v16.20.2/node.exe" scripts/x.js`；装依赖用 PATH 上 node 22。
- 打包：node ≥20，`node scripts/build-desktop.js win-x64`，须放开沙箱 + 前台 +
  `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`；日志要有 `exe branding applied: Agent.exe`。
- 单入口：`release/desktop/Agent-<target>/` 只有 Agent.exe；中间目录 `release/.desktop-build/`；镜像
  `installers/Agent-<target>/` 同步 `SHA256SUMS.txt` + `build-info.json`（uiBuild / packageBuildId 取包内
  `desktop-build.json`）。核对包内文件前缀是 `Agent-<target>/resources/app`（少这层 = 空串假绿）。
- 包内没有 `server/`：服务端打成 `service/`，`server/index.js` 在 source-protection 里记作 `service/index.js`。
- **混淆载荷不能 cmp**（app/knowledge/workflows/icons/markdown.js、service/*、main.js…）：源码 vs 包内必然
  DIFF。核对走 `source-protection.json` 的 `records[].sourceSha256`（混淆前哈希，按 path 精确匹配）；变量名会
  重命名，包内 grep 标记为 0 不等于没打进去。纯文本（style.css/index.html）直接 cmp。
- publish 的 rename 会被路径垫片打回（`EBUSY ... previous-delivery`）→ 手动 `cp delivery/Agent.exe` +
  `desktop-distribution.checksums('release/desktop')`，再跑 desktop-distribution-smoke 兜底。
- NSIS（`scripts/desktop/installer.nsh`）：嵌套 `!include` 只认反斜杠绝对路径、不能含非 ASCII；customInstall
  要显式建桌面快捷方式（isUpdated 分支不重建），末尾 `SHChangeNotify` + `ie4uinit -ClearIconCache`。
- 图标整链：make-logo.py → icon.ico branding → 打进安装器 → 刷缓存；「图标还是小」先怀疑 shell 缓存，再量
  源码 ico 七帧 alpha bbox 与安装目录 `resources/app/assets/icons` 是否一致。

## 本机环境与调试
- 全仓 CRLF：跨行 indexOf/slice 断言先归一 `\r\n`→`\n`。renderer-smoke 用例在模板字符串里（`\d` 被吃 →
  `[0-9]`、`(` → `[(]`、注释禁反引号）；`app.js` 中英混排用 python 按行替换更稳。
- 真机窗口脚本（theme/drag/ui/knowledge-panel…）**用普通 node 跑**（自己 spawn Electron）+
  `SMOKE_NO_SANDBOX=1`；拿 Electron 当解释器会静默 skip（exit=0）。
- `driver.launch` 必须带 noSandbox；`launch(url)` 起裸 Electron（无 preload），验 preload/IPC 要 `launch('.')`。
- 本机 Electron 窗口宽被压到 960：量 1920/2560 用 `driver.cdp.send('Emulation.setDeviceMetricsOverride',…)`。
- 从宿主起 Agent.exe：清 `ELECTRON_RUN_AS_NODE` / `NODE_OPTIONS`；父进程在宿主树里会 GPU 崩 →
  `Start-Process explorer.exe -ArgumentList '"<exe>"'`。Bash 吃反斜杠。
- 真实用户数据在 `%APPDATA%\Agent\agent-home`（settings.json / ui-store.json / sessions）。测真实数据量时
  复制一份当 AGENT_HOME，别直接改。
- `driver.evaluate` **不 await 页内 Promise**（返回 `{}`）：异步测量要么页内写 `window.__probe` 再轮询，
  要么全程用 CDP（`Profiler.start/stop`、`Performance.getMetrics`）。

## 已知既有红（复现过，别重复查）
- `check:drag` 675/677；`workflow-canvas-e2e-smoke` 必红（wrap/serpentine，HEAD 同红）。
- `knowledge-e2e-smoke`：`内存验收` 循环 `.knowledge-project-folder summary` click null；`update-takeover`
  （macOS 探针）；`theme-smoke` 74/75（unsafe-eval，CSP 只有 script-src 'self'）；`extensions-e2e` 需先
  `mkdir -p /e/tmp`；`ui-e2e` 38/41（资料库两行 rows=3、定时任务可滚、滚得动）；必红夹具 installer-smoke、
  shell-menu-smoke（夹具问题，补丁在 backups）。
- 会话存储服务端优先（`/api/ui-store`），造种子必须写服务端。
- 知识库文档行**不显示解析提示**：parser notice 被 service 写进 jobs.error（成功也写），渲染层只对
  `phase!=='ready'` 画 error；改文案去 `parser-worker.js`。

## 性能纪律（都实测过）
- **切会话窗口化**：首屏只画最近 24 条（`HISTORY_WINDOW`），更早的在顶部 `.history-more`
  （滚到顶也自动补）按 8ms/帧分片回填（`fillEarlier`/`historyToken`）；两段都写离屏 `renderTarget`
  fragment、一次挂载（`renderHost()`），因为 `addBubble` 末尾的 `scrollToBottom()` 每条都要一次强制布局。
  实测 219–269ms 长任务 → 首屏 16–24ms、零长任务；`renderOneMessage(ctx,index)` 是唯一渲染入口。
- **ui-store 别每次全量推**：`buildUiStorePayload({light:true})` 不带 sessions（服务端 `save()` 是
  `Object.assign` 浅合并），切会话只发 currentSessionId+prefs；整份 5MB stringify+跨进程克隆 =
  50–70ms，曾整段卡在点击的同步路径里。`uiStorePush.full` 记账，中间有一次全量就按全量发。
- **`saveSettings`+`refreshState` 别挡在渲染前**（`switchProjectContext` 放渲染之后 fire-and-forget）。
- `content-visibility` 在这类场景没用（成本在建 DOM/HTML 解析，不在布局），A/B 过，别重复试。
- **点一次只动被点的那个节点**。侧边栏项目展开/收起曾走 `renderWorkspaceList()` 整列重建（1080 行
  59–81ms），现 `setProjectExpanded` / `syncProjectNode` 只替换目标节点的会话列表（3ms），整列用
  `DocumentFragment` 一次挂上，节点带 `dataset.projectId`。复用节点的闭包 `expanded` 是旧值，点击时必须从
  `state.expandedProjects[id] === false` 读当前值。
- **收起不销毁**：`.project-session-list` 加 `.is-collapsed`（display:none，写在文件末尾才能压过
  `.sidebar .project-session-list{display:flex}`），展开时比 `dataset.sessionsKey`（id:title:pinned）决定复用
  还是重建；`createProjectSessionList` 必须同时写 key。
- **图标走克隆**：`window.iconNode(name)`（icons.js 缓存模板 + `cloneNode`），侧边栏统一 `setIcon()`，别再
  `innerHTML = renderIcon()`。
- **定时刷新只换变了的**：`syncRunningState` 500ms 一轮 → `syncSessionBadges()` 只换 `.session-state`，且先比
  className + textContent 再 replaceChild。`workflows.js` 1.5s `refresh()` → `renderFlows(force)`/`renderRuns`
  比签名（`flowsRenderKey`/`runsRenderKey`）没变就 return，`ResizeObserver` 用 `force` 穿透。无条件重建会让
  「hover 才淡入」的按钮一秒闪一次（新 DOM 不是 `:hover`）。
- **点项目行 ≠ 切项目**：原来收起态点行走 `selectProject`（saveSettings + refreshState + 切该项目最近会话 +
  重画历史），真机 197ms，其中 186ms 是单条长任务（294 条消息的 Markdown）。现在点行只
  `setProjectExpanded`；切项目靠点会话（`selectSession` 会连带切）或「+」新建。
- **`POST /api/settings` 别无条件重配插件**：`pluginHost.configure()` 会 dispose/重载插件并 settle 整棵 fiber
  树，一次 ~200ms，而它只关心 `disabledPlugins`；`settle()` 在无变化时也是纯等待（改成 `if (changed)`）。
  `pool.setWorkspace()` 内部还会再 `settings.update()` 写一次盘，只在真传了 workspacePath 时调。
  改完 237ms → 3ms；`scripts/settings-api-smoke.js` 守住（含插件启停/工作区/MCP 仍生效）。
- 依赖链长时先分段计时（`getState` / `saveSettings` / `refreshState` / 各 render）再动手，别猜。

## 渲染层
- 思考过程 = 步骤时间线：一轮一个 `details.thinking-block.process-timeline`，每步
  `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`，**状态存 class 不存 data-**。
- 摘要行的 chevron/标题/转圈/耗时是同一批节点复用（`ensureTimelineSummary`）——`updateRunStatus` 每 500ms 刷，
  重建会让转圈归零像一根斜线。运行中耗时一直显示，<1s 才留空。
- 正文流式就按 markdown 渲染：delta 只累加 `body.dataset.raw`，`scheduleStreamPaint` 节流（90ms / 长文 280ms，
  首帧同步）；收尾不带正文时 `endAssistant` 用 raw 兜底（否则停在 `## ` 源码）。markdown.js 支持 `> 引用`
  （先转义再分行匹配 `&gt;`）与 `---`（必须排在列表判断前），CSS 一律 `--divider`。
- `#runStatus` 放在 `#messagesInner` 外（否则被 clearMessages 清）；`state.runs` 按会话记账、事件带 sessionId，
  非当前会话只记账不碰 DOM。`isSessionRunning` 判的是 `state.runs[id] === true`（不是对象）。
- 存储：AGENT_HOME 下 settings.json + sessions + ui-store.json；桥 = preload IPC 与 web-bridge HTTP；
  `save()` 返回 ≠ 已落盘，断言磁盘前先 `await store.flush()`。
- 剪贴板真源：主进程 `clipboard:write` → preload `dsh.copyText` → `window.copyToClipboard()`；浏览器
  `navigator.clipboard` 要求文档有焦点，`execCommand` 在 await 之后丢手势。
- 输入框（contenteditable）：Enter 发送，Ctrl/⌘/Shift+Enter 走 `insertPlainLineBreak()`（光标处把顶层块一分
  为二，光标后内容压成纯文本）。
- `openMcpDetail(server, trigger)` / `closeMcpDetail`：连接器卡（`--cap-card-height:78px; height:auto`）整张
  可点（`tabIndex=0` + `role=button` + `aria-haspopup=dialog`），内部控件靠
  `event.target.closest('button,a,input,select,textarea')` 守卫；**trigger 必须传**，否则焦点回不去。内置服务也
  有入口 → 不能用「有没有 `.mcp-icon-action`」判断能否编辑删除，要用 `.danger`。

## 样式纪律
- 三个内容页（知识库/能力中心/工作流）共用末尾「统一版心」块的变量：`--page-gutter` clamp(20,4vw,56) /
  `--page-max: none`（铺满，别封 1200）/ `--card-bg` / `--card-border` / `--card-radius` 10 / `--card-pad` 14 16。
  浅色卡必须 `[data-theme=light] …{--card-bg:#f5f5f4;--card-border:#e1e1df}`；工作流卡要
  `#workflowPage .workflow-card` 才压得过浅色覆盖。直接子块加 `width:100%`，行内小按钮复位 `width:auto`；
  **页头 `margin:0 0 16px` 会冲掉版心的 `margin:auto`** → 宽度靠铺满，别居中封顶。
- 能力中心页头无副标题，「安装离线扩展包」跟在 h1 后：`flex-wrap:nowrap` + h1 `flex:0 0 auto` + 安装条
  `flex:1 1 auto;min-width:0`（说明文字 ellipsis），≤760px 才折行 —— 用 `wrap` 会让「返回聊天」掉到第二行。
- 同批选择器写多处时**后写赢** → 末尾放收口块并写注释；收口块会压掉前面的 `@media`，隐藏类用 `#app` 提特异性。
  改样式前先比特异性：多 ID 规则（`#capabilityCenter #mcpList > .x` = 2,1,0）压死 `:has()` 补丁；通用
  `.modal-card{max-height:calc(100vh-48px);overflow:auto}`（0,1,0，末尾）要带 ID 才能改尺寸，且整卡滚会把标题
  和底部按钮滚走（正解：卡 `overflow:hidden` + 内容区自己 `overflow-y:auto`）；危险色要压过
  `.workflow-icon-action:hover:not(:disabled)`（0,3,1）。
- 伪元素箭头：`summary::before` 缺字形会变「方框套三角」且被 `.thinking-active` 覆盖 → 用
  `span.timeline-summary-chevron`，`::before` 用 `#app` 前缀 `content:none` 压死。
- 伪元素画分割线**必须 absolute**（窄栏 `.sidebar-footer` 是 flex，块级 `::before` 会吃掉 80% 宽）。侧边栏
  设置行：`.sidebar` 的 `row-gap:10px` 要 footer `margin-top:-10px` 抵消；1px 在 150% 缩放占 2 物理像素，配
  `transform:scaleY(.5)`；底部渐隐用 footer `::after` 的 linear-gradient，**别用 mask 盖 `.sidebar-scroll`**
  （文字进合成层，子像素抗锯齿全丢）。
- 面板内按钮：`background:var(--panel-2)` + `border:1px solid var(--divider)` + 显式 `color:var(--text)`。
- 知识库左栏 300px（窄屏 210px）；`#knowledgeListResize` 改 CSS 变量驱动 grid 首列，夹 220~520、松手写
  localStorage、双击回 300。测按压合成事件拆三步（down+move → 等 rAF → up），探针等 `openLibrary` 出现后
  `sleep(500)` 再点。
- 图标尺寸真源是 style.css 全局表（`button .icon svg` 20px，0,2,1）；viewBox 24 正方形；文字字符当图标
  （`⌄ ↑ +`）一律换 `data-icon`；`applyIcons(root)` 不含 root 自身。

## 窗口 / 主题 / 排版
- 外观真源 `shell/window-chrome.js`：frame:false + preload 注入自绘 `.window-controls`（不依赖
  titleBarOverlay → Win7 可用）；`TITLEBAR_HEIGHT=44`，改它要同步两份 CSS + 4 个 smoke。主窗口 `minWidth:980`
  → 桌面端 ≤900 媒体查询进不去（只有 web-bridge 命中）。☰ 应用菜单是渲染层自绘（`app-menu.js`），不是 popup。
- 两套主题（#212121 / #ffffff），只用现有变量；**分割线一律 `--divider`**（深 #4c4c4c / 浅 #c9c9c9），别用
  `--border`（深 #303030 = panel-2、浅 #eee 画在 #f5f5f5 上看不见）。
- 排版：`typography.css` 必须排在 style.css 之前；6 个 woff2 在 fonts/（OFL）；字号只 12/13/14/16/20/24，字重
  400/500/600；新界面禁写字面量；`server/index.js` MIME 要 `.woff2`。验收 `typography-smoke` +
  `npm run check:typography:browser`。

## 工作流与画布
- 人工节点主入口 `interaction:{version:1,type:'handle'|'review'|'approve',returnTo}`；旧 humanKind/humanModes
  仅在没有 interaction 时生效。**驳回是流程动作**：`submit(decision:'reject')`→node-returned，重置目标与下游；
  external-checkpoint 重放前须 `resume({confirmExternal:true})`。事件 `state/workflow-state.js`，退回策略
  `flow/workflow-policy.js`，契约 `contracts/workflow-interaction.js`。
- 画布多选整体移动是 LiteGraph 原生行为，只覆写 processNodeSelected；测它：CDP 两次按下 <300ms 判双击、合成
  拖拽先发一次 hover move。折叠 details 里 focus() 静默失效，聚焦前先展开祖先 details。
- `src/renderer/workflow-auto-layout.js`（纯 UMD，别塞回 workflows.js）：分层→重心法降交叉→
  horizontal/vertical/layered，`fit` 按 `fitScale*4-|ln(长宽比/视口比)|` 挑。入口 Ribbon `#workflowArrange`，
  默认 layoutMode=fit；横/纵/分层仍 `readableGraph()`（别改成自动 fit）。
- 正交布线：`route()` 的 startLane/endLane + `elbow()`；穿越检查拆两段判（hits() 对斜线一律 true）；分组键
  `(source,origin_slot)`，间距 12px。Ribbon 顶部锁 69px + 隐藏 `#workflowNodeTypes` 横向滚动条（原生滚动条占
  17px 会撑到 86、画布下跳）。
- 改单行压缩风格函数后 `node --check` + 括号平衡扫描（少一个 `}` 会让后续函数掉出 IIFE，报 xxx is not defined）。

## 其他
- md-skills（65 个）在 `src/main/agent/md-skills/`，系统提示只放 id + 90 字简介。自我验证工具用完必须关浏览器、
  停自起服务。
