# dsh-win7-agent 长期记忆（产品名 Agent）

非 git 仓库。硬约束：**Win7 SP1 x64 可跑**（验收 `npm run check`）、全内网禁联网、不做 TTS（用户已否决）、**端口只维护 8080**（用户常驻实例，改 renderer 不用重启；动它前确认不是用户在跑的）。全量叙事细节见 `README.md` / `docs/WIN7-COMPAT.md` / `docs/SELF-VALIDATION-PLAN.md` / daily logs（2026-09-18/19/20/23.md 覆盖 R17–R27）。

## 运行时 / 验收
- Electron 22.3.27 / Node 16.17.1 / Chromium 108；Win7 服务端靠 `ELECTRON_RUN_AS_NODE=1`。禁原生模块、dependencies 空；禁用清单以 `scripts/check-win7-compat.js` 为准；Windows 侧注意 GBK 输出、`shell:true`、PowerShell 降级。
- **验收链 14 段**（**必须 Node 16.17.1**：`/tmp/node-v16.17.1-darwin-arm64/bin/node`；**该目录下 npm 已被清掉** `Cannot find module ../lib/cli.js` → `npm run check` 起不来，改为逐个 `node scripts/<x>.js`）= syntax(**86** 文件)+win7(69 node-side/11 renderer/2 css)+settings-migration+renderer(**329**)+ui-store(17)+**self-validate(28)**+service(21)+installer(57)+menu(55)+chrome(136)+plugin+agent+concurrency(25)+server-concurrency(22)。全绿才算过。
- 需 Electron、**不进**默认链：`check:shellpage`(61；activate 重建窗口后必须 loadURL 进界面) / `check:drag`(**173**：拖拽带+页面操作组+折叠+文件面板+终端+编辑器+Win/Linux 基线+真机 IPC) / `check:browser`(**16**：自验证 CDP 链) / **`check:ui`(13：真实界面 E2E —— 模型切换标签 / 多发一轮不清思考过程 / browser_close 真关窗口)**。**本机 seatbelt 起不来 → 真机测试加 `SMOKE_NO_SANDBOX=1`**（shellpage 漏了会 GPU FATAL "Goodbye"）。`check:ui` 自起独立服务（随机 PORT + 临时 AGENT_HOME，不碰 8080）。新增 `shell/*.js` 登记进 check-win7-compat 的 NODE_FILES/RENDERER_FILES；`vendor/`、`md-skills/` 在扫描 SKIP_DIRS；**测试页/模板字符串里写 `fetch(` 会被 win7 守卫拦**（它扫 scripts/*.js 源码分不清是不是页面代码）→ 用 XMLHttpRequest。
- **打包（Node ≥20，`scripts/build-desktop.js all` → 四平台 zip：win-x64 / mac-arm64 / linux-x64 / linux-arm64 银河麒麟；Win7/10/11 共用 win-x64）**：① Node 用 `/Users/ysuhan/.workbuddy/binaries/node/versions/22.22.2-3/bin/node`（resedit ESM），日志须有 `exe branding applied: Agent.exe`（Node 16 下静默退化图标/版本，只有一行 WARN 易漏）② **必须在放开沙箱下前台跑**：沙箱拦「写任何 `.asar`」和「把 md-skills 某些文件当 copyFileSync 源」（`dangerouslyDisableSandbox` 丢后台不生效，拦截来自 NODE_OPTIONS 的 `node-language-shim.cjs`，与 shell 沙箱无关）；清残骸带 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000` ③ `server/` 新文件必须登记 `SERVICE_FILES`（漏了构建对账失败），`default_app.asar` 在 `ELECTRON_SKIP_NAMES` 里不复制。
- **包内对账**：zip 内层有一层顶级目录 —— win/linux 前缀 `Agent-<target>/resources/app`、mac 是 `Agent-mac-arm64/Agent.app/Contents/Resources/app`（少这层 `unzip -p` 取空 → 哈希退化成空串 `e3b0c44298fc1c14`，极易误判「包坏了」）。用 `unzip -p <zip> <前缀>/<相对路径> | shasum -a 256` 直接对源码哈希（四包同哈希）。包内服务端路径是 `resources/app/service/`（源码叫 server/）、mac 首字母大写 `Resources`（grep 带 `-i`）。
- 打包前查实例：沙箱禁 ps → `pgrep -fl` + `lsof -nP -iTCP:8080 -sTCP:LISTEN` + `curl /api/health`。release/ 只留最新版（用户已授权）；`.electron-dist` 缓存别删。批量删除保护是 Node shim（>50 拦截），跑干净用 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`。
- **8080 上若有 smoke 残留实例，一定要清**：它 health 报同一个 app id → 用户自己的实例会把它当「自家」复用，界面读到的是它的空设置/临时工作区（表现为「会话列表空了」）。判别特征：`lsof -p <pid> | grep cwd` 指向 `/private/var/folders/.../T/dsh-browser-test-*`、`txt` 指向 `~/.Trash/.../Agent.app`。浏览器临时 profile 目录也归 `dsh-browser-test-*`。

## 数据存储（R24 已解耦端口，2026-09-20）
- **服务端（磁盘，与端口无关）**：打包版 `userData/agent-home/`（AGENT_HOME env；dev=项目根 data/）：settings.json + sessions/<id>/ + assets/workspace/plugins + **ui-store.json（R24 新）**。
- **渲染层原本 localStorage 按 origin（含端口）隔离**——8080 被别的程序占、服务跳端口时列表「看起来空」（没删，回原端口在；两边聊过分叉）。缓解：`shell/service-manager.js` probePort 认 health.app===SERVICE_ID 优先复用自家实例 + `config.lastPort` 优先试；只有被**别的程序**占才跳端口。BrowserWindow 无 partition。
- **R24 双写解耦**：GET/PUT `/api/ui-store` → `AGENT_HOME/ui-store.json`（`server/ui-store.js`，已登记 SERVICE_FILES；**只认 loopback**，PUT body 上限 40MB / store 32MB）。渲染层：`loadSessionStore` **服务端优先**，服务端空才用 local 且保存时**自动迁移上去**；所有 save*（会话列表/当前会话 id/分组折叠/侧边栏/消息宽/输入历史）= localStorage 照旧 + **in-flight 合并 PUT**（至多一个在途请求，写盘中来新数据记 pending）；`beforeunload` flush。桥两条腿：`src/main/preload.js`（IPC，开发态）+ `web-bridge.js`（HTTP，打包壳/浏览器共用——**打包壳的 window.dsh 是 web-bridge 注入的，shell/preload.js 只有 window.shell**）。老宿主没方法 → `uiStoreApi()` null → 纯 localStorage 不炸。
- **UiStore 关键语义**：`save()` 返回 ≠ 已落盘——断言磁盘必须先 `await store.flush()`（冒烟第一版 3 条假红就栽这）；坏文件回落空 store 且**不覆盖坏文件**（可自愈）；temp+rename 原子写 + Windows EBUSY/EPERM/EACCES 降级直写（与 file-api 同款）。renderer-smoke 的 ui-store 动态块会污染后续用例——开头备份结尾恢复 sessionStore/偏好。

## AgentPool 并发（R20，取代单 agent）
- `src/main/agent/agent-pool.js`：每会话常驻 worker；`maxConcurrentRuns`（1–16，**默认 3**）条会话同时跑；`maxWorkers` 常驻上限（默认 24，LRU 淘汰**绝不淘汰在跑的**）。server/main 都用它。worker 各自 `sessionRoot/<sessionId>` 子目录（safeSegment 防穿越）；所有事件/审批盖 sessionId（`tag()`）。
- 错误码：同会话重入 **409 SESSION_BUSY**（渲染层排队）；池满 **503 POOL_BUSY**（报错不排队）；成功 202 `{ok,sessionId}`。abort 不传 sessionId=全停；reset 只停该会话并补**带 sessionId 的 finished**；setWorkspace 广播 pluginHost+所有 worker。老客户端不带 sessionId 落 default worker（行为不变）。
- 渲染层：`state.runs` map + runLimit（无 activeRunSessionId/state.running）；`handleEvent` 非当前会话只记账+落盘**不碰 DOM**；`applyRunState()` 本会话在跑藏发送、别的在跑提示条；preload/web-bridge 的 send/stop/resetChat/clearChat 全透传 sessionId。向后兼容：宿主只给 running → applyRuns 标当前会话在跑。
- 测试：concurrency-smoke(22)+server-concurrency(21) 在默认链；renderer-smoke concurrencyStatic 守卫 + DOM stub addEventListener 真存真触发。

## 收发状态 / 提示条（R18/19/23）
- **`#composerRunHint` 只在并发池满**出现：`runLimit>0 && runningTotal()>=runLimit && !currentRunning()`，文案「并发已满（N/M），再发会被拒…」。别的会话在跑但池没满=正常并发**不提示**；本会话自己在跑不说；runLimit 未知**不猜**；池满也**不禁用**发送按钮。`otherRunningCount()` 已删，守卫 hintLogic 断言不许回来。
- **运行记忆不可信四道防线（别拆）**：`syncRunningState()` 回传 runningSessions；`selectSession()` 对表+清思考残留+重排队列；`sendMessage()` 排队前对表；init 常驻 5s `startRunPoll()`（句柄 unref）。`flushPendingMessage` 冲完还剩要重新 `scheduleQueueFlush`。
- 只发图片合法：`/api/chat` 没字**也没图**才算空；agent 与 buildUserContent 无字都**不许塞 `{type:'text',text:''}` 段**。
- renderer-smoke 宿主钩子：`__dshRunning`/`__sendCalls`/location shim（origin/`__reloads`）/`__clipboard`。

## 思考过程 / 授权（R21）
- 并发化曾丢后台会话思考过程 → **过程记录与 DOM 解耦**：`processRecord(sessionId)` 游离节点（首建用 session.processHtml 回填）；appendProcess* 元素级原子（当前活块与后台游离节点同套）；`recordBackgroundProcess`→`commitProcessRecord` 落 processHtml；settleRun 收尾 drop。切回在跑会话要 `resumeThinking(seedHtml)` 续上，**不另起空「正在思考」**。
- 授权弹窗单槽会互踩 → `requestApproval(request, sessionLabel, requestId)` + approvalQueue/approvalBusy 排队；**必须配 `expireApproval`**（服务端 300s 超时广播 expired；不收掉 → approvalBusy 永真 → 之后所有授权静默失效，比原来更糟）。`state.approvalCurrentId` 记当前弹窗替谁等。
- renderer-smoke 的 innerHTML getter 必须序列化子节点、remove() 真摘节点；shell-drag-smoke 的 `app:get-state` 必须返回像样 settings（null → fillSettingsForm 抛 → init 死在 onEvent 注册前）。
- **思考过程必须逐轮累积，别覆盖（R28/R29）**：两条防线，缺一条都白搭 —— ① `endThinking` 会把 `state.currentThinking` 置空 → 下一轮 `beginThinking` **另起一块**，所以写回不能是 `= content.innerHTML`（只写本轮 = 上一轮在重载后整段消失）；现为 `mergeProcessHtml(state.thinkingBase, 本轮)`（`beginThinking` 另起时 base = 此前的 `processHtml`；`resumeThinking` 续接时 base = **空串**，否则自己叠自己）+ `MAX_PROCESS_HTML=262144` 按整轮裁剪（切半句会把标签切坏）。② **`sendMessage` 里绝不能清 `session.processHtml`** —— 以前那儿有 `session.processHtml = ''`，每发一条新消息就把整条会话的过程全清（R29 找到的真主因，用户复报「还是会丢失」）；现在是 `endThinking()` 收尾上一块、过程留着。轮间用 `THINKING_TURN_SEP`。

## 模型选择（R28）
- 界面里显示当前模型的**只有** `#composerModelLabel`（composer 里那个下拉触发器）。凡改动选择的函数，两个分支都必须走 `renderModelSelect()` —— `selectProviderModel` 的早返回分支（`name === model.model`，**单模型供应商几乎必然命中**，不是罕见路径）以前只刷 provider 列表，标签原地不动 = 用户看到的「切了没生效」。
- `POST /api/settings`（server/index.js）返回**完整 settings**，不是 `{ok:true}`，所以 `state.settings = await saveSettings(patch)` 这条链没问题。

## 文件面板 / 编辑器 / 终端
- 三列 grid `#app=260px 1fr var(--panel-width)`，**`grid-template-rows:minmax(0,1fr)` 必钉**；宽只写 CSS 变量，媒体查询只准改前两列（有守卫）；chat-hidden 模式 `0 0 1fr`；拖拽 onMove 只记事件、rAF apply、mouseup flush（一帧多次 setProperty=整列白排）；真机冒烟喂数据走 `ipcMain.handle('fs:*')` 假 handler（contextBridge 只读，`window.dsh={}` 静默失败=假绿）。默认面板宽 `clamp(460,vw*0.38,720)`；GBK 解码在渲染层；代码高亮零依赖。三期终端共享模块 server/terminal-api.js（HTTP+IPC 同源；**server/ 新文件必须登记 SERVICE_FILES**）。
- 四期编辑：写盘口子只有 `dsh().fsWrite` → fs:write / POST /api/fs/write → file-api writeWorkspaceFile（复用 resolveInWorkspace 两闸；只写已存在文件；原子写 16MB）。停手 700ms 自动写盘 + Ctrl/Cmd+S/失焦/切标签/刷新/beforeunload flush。**编码/换行渲染层还原**：GBK 懒建反查表，存不下抛 GBK_UNENCODABLE 宁不存不写 '?'；`textarea.value` 恒 `\n` → detectEol/applyEol 补回 `\r\n`。冲突：expectedMtime 对不上 409 MTIME_CONFLICT **不静默覆盖**、露「强制保存」；**判错用 `indexOf(...) !== -1` 不能 `===0`**（HTTP message 带路径前缀、IPC 包一层）。编辑态正文以 `panel.editor.text` 为准不从磁盘重读。
- **输入框高度**：composer max-height 与 autoResizeComposer 都钉 180px（别用 40vh，两套打架后者赢长到半屏）；**空内容撤内联高度回 52px**（守卫 composerEmptyReset）。setupComposer 绑定在 init 开头任何 await 之前 + MutationObserver 自愈。
- 终端 = xterm.js 5.5.0（vendor 内置，script 在 panel.js 前；**allowProposedApi:true**）。多标签：`panel.terminal` 指当前标签，视图开关独立 `panel.terminalView`（共用字段会反转开关）；命令结束靠服务端哨兵 `__DSH_CMD_READY__`；fit 列数≤20 rAF 重试≤7 + `#terminalOut` ResizeObserver；空实例强制 replay（terminalHasContent）；termState 必须带 sid（空 sid 服务端返回列表会被误判会话死→偷重启丢历史）。目录切换=编号列表，去重走 pathKey。行编辑在渲染层。探针读 buffer API 不读 textContent，判断前 `replace(/\s+/g,'')`；spawn PATH 补 nvm/homebrew。
- 标签关闭 ×：悬停才露；**padding:0**（通用 button 的 8px 12px 会把 border-box 挤 0 宽、× 隐形）；选择器用 `.panel-tab-close svg`；横向滚 overflow-x:auto + wheel→scrollLeft。
- 顶栏页面操作 `#pageActions`（R19，刷新/转发）：位置跟 `.sidebar-toggle` 绑定（展开 left:140/折叠 54；.shell-mac top:9+no-drag+折叠 118，别撞红黄绿 16..68）；z-index:31；chat-hidden 退场。刷新=`location.reload()`（同源 will-navigate 不挡，跑任务时刷安全——init 对表接回）；转发=复制 origin+甩默认浏览器（appLink 只在 http/https 给值）。
- 品牌徽章 `#brandBadge`：applyPlatformBadge() 从 userAgent 认系统（NT 6.1→Win7），断言在 check:drag。

## macOS 窗口外观
`titleBarStyle:'hidden'` 只对 darwin；主进程+preload 打 `.shell-mac`+CSS 留白三处缺一不可。拖拽带 `#titlebarDrag` 40px/z-index:30；带内按钮 no-drag+z≥31。红黄绿灯心 y=24、按钮 top:9，断言不带容差。折叠按钮 #app 直接子元素、展开 left:214。**隐藏窗口 Chromium 停 rAF/CSS 过渡**：探针先注入 `*{transition:none!important}`。

## md-skills（R17）
`src/main/agent/md-skills/`（65 唯一 skill，8.7MB 随包）+ md-skills.js + 内置插件 skill-tools（load_skill/search_skills，permission read）。渐进式披露：系统提示只放 id+90 字简介，正文按需 load；技能目录在工作区外 read_file 够不到；SKILL_PATH_ESCAPE 护栏。与代码级 skills.js 互不影响。导出源 exports/workbuddy-skills-2026-09-19/。

## 自我验证（R26/R27 P0，方案见 docs/SELF-VALIDATION-PLAN.md）
- 完成判定 = **验收标准被真实运行的证据满足**，不是「代码改完了」；只认工具真实返回；改完重跑同一验证 + 收尾跑既有用例防回归；验不了明写「未验证」。**轮次不是指标**——按失败性质分档（断言过严/服务未就绪/用例写错不计轮，代码类 1 轮，**连续 2 轮同断言同样失败立即停**），默认 3 轮自动修复 + 1 次换策略。
- `src/main/agent/process-manager.js`：每会话进程表挂 `agent._processManager`（用 `toolCtx.agent`）；后台 spawn（`shell:true`+`windowsHide`，POSIX `detached` 建进程组）；名字白名单 `[A-Za-z0-9._-]{1,32}`；cwd 走 path-guard（抛 `PATH_ESCAPE`）；同名在跑 `PROCESS_EXISTS`；上限 8；日志 256KB 环形缓冲；`taskkill /PID x /T /F` / `process.kill(-pid)`，SIGTERM→3s→SIGKILL；`waitReady` url 走 HTTP（**任意响应即 ready，状态码带回**——区分「没起来」和「起来了但 500」），port 走 TCP。
- `src/main/agent/validation-ledger.js`：`.agent/validation/<task-slug>.md`，init **必须有可判定验收标准**否则 `LEDGER_NO_CRITERIA`、幂等不覆盖，append-only。
- `src/main/plugins/builtins/self-validate/`：6 工具（start_process/stop_process/list_processes/process_logs/wait_ready/validate_ledger）+ 证据优先系统提示；已登记 plugin-host builtins。
- 冒烟 `scripts/self-validate-smoke.js` 28 条在默认链。**教训**：`sleep()` 里 `timer.unref()` 会让 `stop()` 卡死（杀完子进程无活跃句柄 → Node exit(0)，await 后代码永不执行）——**进程管理器的 sleep 绝不能 unref**；TokenRegistry 没有 `has()` 用 `list()`。
- **浏览器收尾（R29）**：验证完**必须关掉自己起的窗口**。`browser_close` 工具（tools.js + browser-tools 插件 filter **和显式分支** —— 漏分支会掉进 `runTestCases` 兜底）、`browser_launch` description 末尾要求关、`VERIFICATION_PROMPT` 第 8 条「每轮收尾关浏览器/停服务」、`browser-driver.js` 的 `liveDrivers` + `process.on('exit')` 兜底 SIGKILL。会话 reset/clear 走 `agent.dispose()` → `close()`。`browser_act action=close` 与 `test_run.closeAfter` 是老口子，保留。

## 易复发坑（教训浓缩）
- **全局 `textarea` 规则会漏到别处**（220px 那条已删+守卫 editorFillsHeight）；量高度用**比例阈值**（如 >previewH*0.8）不用绝对值——220/589 都能过「>100」。
- **CSS 守卫匹配前先扒注释**：`cssSrc.replace(/\/\*[\s\S]*?\*\//g,'')`——`/[^}]*/` 会被注释里的 `}` 截断假红。
- **断言太松=假绿**；**本机 BSD grep 不认 `\|` 交替**→ 一律 `grep -E` 或 Grep 工具（曾据此误判「修复没进包」）。
- **同一文件多条 Edit 会互相覆盖**（都报成功但部分落盘）——逐条串行+改完 grep 验证。Bash 每次调用 cwd 重置——跨目录在同一条命令里 cd 或用绝对路径。
- 探针是模板字符串里的代码：`\n` 要写 `\\n`，否则求值语法错误 "Script failed to execute"。
- Edit 菜单不能省（剪贴板/撤销靠菜单 role），模板在 shell/menu.js。
- 更新接管：install.json 记生效版本；resolveUpdate 在单实例锁前；relaunch 清 ELECTRON_RUN_AS_NODE。
- **zsh 两个静默坑**（每次都栽）：① glob **无匹配直接报错并中断整条命令**（`rm -rf x/*` 无残骸时 `(eval):1: no matches found`，`&&` 后半段全不执行）→ 命令前加 `setopt +o nomatch;` ② **不对无引号变量做分词**（`FILES="a b"; for f in $FILES` 只跑一轮）→ 用 `for f in ${=FILES}`。
- **包内哈希校验别被空串骗**：`unzip -p` 模式写错的返回是空内容，sha256 = `e3b0c44298fc1c14`——看到这个哈希先怀疑前缀写错，不是包被污染。
- **renderer-smoke 的用例写在模板字符串里**（三重坑）：① 注释里出现反引号会把模板截断（`SyntaxError: Unexpected identifier`）② 注释里出现块注释起始符会把外层注释提前闭合（`Invalid or unexpected token`）③ 正则里的 `\/\*` 会被模板求值吃掉反斜杠、变成真的注释符。→ 要扒注释就用字符扫描（`indexOf` + slice），别用正则字面量。
- **「改好了但用户说还是没变」先想两件事**：① renderer 改动要**刷新页面**才生效（对着旧窗口测必然「没修」）② 单元级断言不等于真机 —— 用 `check:ui`（真 Electron + CDP，13 条）拿界面级证据。用户报的 bug **必须先在用例里跑出 FAIL 再改代码**。
- P1/P2 遗留见 docs/WIN7-COMPAT.md §9。
