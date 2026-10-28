# dsh-win7-agent 长期记忆（产品名 Agent，当前 0.4.3）

2026-10-17 重写：0.1.x 时代的细节（14 段链、329 条 renderer、单 agent、DSH 命名）已随
0.1.3–0.3.4 的重构失效，历史叙事留在 `MEMORY-2026-10-07.md.bak` 与 daily logs（2026-09-18/19/20/23）。

## 硬约束（别碰）
- **Win7 SP1 x64 可跑**：Electron 22.3.27 / Node 16.17.1 / Chromium 108。禁原生模块、无生产依赖、
  不联网。禁用清单以 `scripts/check-win7-compat.js` 为准。
- **架构底座是 Cordis**（`src/main/runtime/vendor/cordis`），执行与持久化在插件里。
  改执行/插件/会话/启动前先读 `docs/ARCHITECTURE.md`。
- **只维护 8080**（用户常驻实例）。打包/测试不要动它，测试一律随机端口 + 临时 AGENT_HOME。
- **交付规则见 `AGENTS.md`**：改完必须重新打包，至少 Mac 版，默认交 `Agent.app` 绝对路径。
- 本仓库已有 git（首提交 2026-10-07），main 分支；用 `git worktree add /tmp/dsh-head HEAD`
  （symlink node_modules）可以在旧版本上跑同一份脚本，分清「这轮引入的」与「本来就红的」。

## 怎么跑验收
- 本机**没有** `/tmp/node-v16.17.1`。用 Electron 内置 Node 16.17.1 跑脚本：
  `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/x.js`
- 默认链 **38 段**（`npm run check`，完整清单看 package.json）：runtime-architecture / cordis / layered-agent /
  syntax / win7 / settings-migration / renderer / dialogs / web-bridge / platform / ui-store / self-validate /
  service-manager / installer / update-takeover / shell-menu / shell-chrome / window-controls / plugin / mcp /
  knowledge×3 / workflows / document-mcp / agent / llm-stream / concurrency / server-concurrency / release-retention /
  agent-ux / tasks×2 / extensions / workflow-v2 / workflow-artifacts / workflow-processing / workflow-interaction。
- **真机窗口脚本要「用普通 node 跑」**（它们自己 spawn Electron）+ `SMOKE_NO_SANDBOX=1`：
  `check:theme` `check:drag` `check:shellpage` `check:browser` `check:first-chat` `check:ui`。
  直接拿 Electron 当解释器跑 `shell-drag-smoke.js` 会**静默 skip**（exit=0，别被骗）。
- 打包：`/Users/.../versions/22.22.2-6/bin/node scripts/build-desktop.js mac-arm64`，
  **必须放开沙箱 + 前台**（后台任务拿不到授权），带 `CODEBUDDY_SAFE_DELETE_BULK_THRESHOLD=200000`。
- 打包后必做：包内与 zip 内改动文件哈希对源码逐字节一致（mac 前缀
  `Agent-mac-arm64-<v>/Agent.app/Contents/Resources/app`，win/linux 是 `Agent-<target>/resources/app`；
  少这层前缀 → 取到空串 `e3b0c44298fc1c14`，看着像「包坏了」）。

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
- 默认链现在 **38 段**（加了 `workflow-interaction-smoke`）。浏览器版 `check:workflows:interaction:browser`、
  `check:workflows:v2:browser` 和 `check:workflows:browser`（scripts/workflows-e2e-smoke.js）都在跑；
  后者靠 `delete n.properties.interaction` 固定测旧表单。
- 画布多选整体移动是 LiteGraph 原生行为，我们只覆写 `processNodeSelected`（已选中+多选+无修饰键时提前返回）。
  测它的两个坑：CDP 两次按下间隔 <300ms 会被判双击（塌缩选择并 `bringToFront` 重排 `_nodes`，断言要按 node id）；
  `last_mouse` 只在 mousemove 里更新，合成拖拽要先发一次 hover move。
- **折叠 details 里的 focus() 静默失效**：子元素 `display:none` 时 focus 无效，activeElement 停在 body。
  重绘后要聚焦必须先展开祖先 details（`renderStructured` 的 `redraw` 已内联）。
- 改这种压缩风格的单行函数后务必 `node --check` + 括号平衡扫描：少一个 `}` 会让后续函数掉出 IIFE 作用域，
  症状是莫名的 `xxx is not defined`。

## 渲染层架构（改之前先懂这几条）
- **思考过程 = 步骤时间线**（2026-10-17 P0）：一轮一个 `details.thinking-block.process-timeline`，
  每步 `div.tl-step.tl-think|tl-tool` + `tl-running|tl-ok|tl-err`；头部
  `tl-icon`/`tl-title`/`tl-dur`；正文 `.tl-body`（工具输出在 `details.tl-detail`）。
  标题由 `toolStepTitle()` 翻人话（读取 package.json / 执行 npm run dev），未登记工具如实显示工具名。
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

## 主题 / 视觉
- 两套主题：灰黑（`--bg #212121`）与白（`--bg #ffffff`），去蓝青、去渐变、去普通阴影，
  语义色只留给错误/警告/成功与代码高亮。新增样式一律用现有 CSS 变量。
- 验收门 `check:theme`（真 Electron，双主题、对比度、hover、focus、截图写 `release/validation/`）。
- **改面板结构后要顺手查检查脚本里的选择器**：`.panel-head` 在 0.1.3 重构后已无人创建，
  theme-smoke 探它会假红（2026-10-17 已改成 `.panel-tabbar`）。

## 样式改动的两条纪律（都踩过）
- **量间距用脚本，别用眼睛**：`/tmp/sb-measure.js` 那套（真窗口读盒模型 + 段间距）能直接指出
  「哪段是 0px、哪段多到 24px」。2026-10-17 侧边栏就是靠它发现品牌行下留了 24px、
  分组标题和第一行贴死 0px。
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