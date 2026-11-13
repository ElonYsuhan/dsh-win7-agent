# 验证账本：runtime-telemetry-ui-phase3

- 建立时间：2026-11-13T12:01:47.706Z
- 需求原文：(未记录)

## 验收标准
- [ ] 状态栏三指标挂载在 composer toolbar-right，无数据时显示 — 而非 0
- [ ] Token 显示本轮真实输入/输出并带千分位；TPS 仅 provider 口径有效时展示
- [ ] Context 带「估算」标记且 title 声明非供应商计费口径，环形进度按 contextWindow 比例填充
- [ ] 点击指标打开浮动面板，四区域齐全，同一时间仅一个面板，可关闭
- [ ] 工具执行区显示调用次数/成功失败/耗时/结果体积，不含参数与返回内容
- [ ] 多会话切换不串线，切到无数据会话回到 —
- [ ] 流式期间经推送实时更新，非轮询
- [ ] 失败/重试/取消状态可见
- [ ] UI 只调用白名单只读动作，无 Collector 写调用、无自建事件总线、无模型调用入口
- [ ] UI 渲染文本与采集数据均不含提示词原文/API Key/baseURL/工作区路径/工具参数
- [ ] 面板关闭与 UI 卸载后 Agent 正常执行且采集不受影响
- [ ] 既有回归全绿：check-syntax / renderer-smoke / check-win7-compat / 第二阶段采集验收

## 验证手段
- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）

## 轮次记录

### 2026-11-13T12:02:26.223Z

轮次 1（端到端全绿，12/12 标准有证据）

【改动文件】
- 新增 src/main/telemetry/query-api.js：只读门面 createTelemetryQuery（仅 read/actions，白名单 get/list/panel/snapshot）、summarize、createThrottledPush（rAF 节流 + 终态补推）
- 新增 src/renderer/telemetry-ui.js：状态栏三指标 + 浮动面板四区域（vanilla JS，IIFE，window.telemetryUI）
- 新增 src/renderer/telemetry.css：深/浅主题、千分位、环形进度、面板定位
- 接线：src/renderer/index.html（stylesheet + script）、src/renderer/app.js（renderModelInfo→refresh / selectSession→setSession / DOMContentLoaded→mount）、src/main/preload.js（telemetryRequest/onTelemetry）、src/main/main.js（licensedHandle 注册只读 IPC + 推送）
- 修 src/main/telemetry/query-api.js 两处真实缺陷：① buildPanel 中 model.requests 计数被明细覆盖 → 明细改名 items；② usageView 只认 dataClass，漏 turn 级 source 字段 → 加 usageClass 兼容；③ 推送器只推 running 会话，run 结束后终态（provider usage 常收尾才到）永远推不到 UI → 加「刚由 running 转空闲」补推一次

【证据（工具实测）】
1) 单元级 UI 验证 .build-tools/verify-telemetry-ui.js → 58/58 passed（node v20.20.2）
   A1-A3 挂载/三指标/无数据显示 —；B1-B5 Token=12,345 / 2,000、TPS 有值、Context ≈ + title 含「估算」「非供应商计费数据」、环形 offset 36.90 < 40.84；C1-C8 四区域齐全、仅一个面板、含 TTFT/请求耗时/未持久化提示；D1-D4 工具 calls=2 ok=1 bad=1、resultBytes=4096、明细 keys 无 args/arguments；E1-E4 切换不串线；F1-F3 流式中 —、完成后 5,000/600、二轮 11,000/1,000；G1-G5 失败/重试(reconnect+stop)/取消；H1-H5 无 usage 全 null 显示 —；I1-I8 关闭/卸载不影响采集与查询；J1-J5 只读约束（actions=["get","panel"]、无 Collector 写、无 EventTarget、record 被拒 TELEMETRY_ACTION_NOT_ALLOWED）；K1-K6 隐私 canary 全不命中
2) 端到端 .build-tools/verify-telemetry-ui-e2e.js → PASS 39 FAIL 0
   真实 PluginHost + 真实 telemetry 插件(Cordis waterfall) + 真实 AgentPool + mock 供应商 SSE + 真实 query-api + 真实 telemetry-ui.js
   A3 Token=1,234/60 来自真实 provider；A5 UI 显示值 == 采集 measureContext 值（非 UI 另算）；B5 缓存命中率 (300+700)/(700+900) 精确匹配；C3/C4 run promise 未 resolve 时已有推送且 running=true（证推送驱动非轮询）；D1-D4 并发两会话不串线；E1-E5 UI 渲染文本与采集快照均不含提示词/API Key/127.0.0.1/工作区路径；F2/F4 关面板与卸 UI 后 Agent 正常完成且继续采集；G1-G5 只读约束在真实 host 上成立
3) 回归：
   - node scripts/check-syntax.js → syntax OK: 381 files
   - node scripts/renderer-smoke.js → 457/457 checks passed
   - node scripts/check-win7-compat.js → scanned 332 node-side js / 39 renderer js / 11 css，no blocked api usage found
   - 第二阶段采集层 .build-tools/verify-telemetry.js → PASS 46 FAIL 0（进程不自动退出属既有脚本行为，已 stop_process）

【未验证 / 限制】
- 未在真实 Electron/Win7 桌面窗口做视觉验收（本机沙箱无头渲染会被 SIGTERM 137 杀掉），CSS 视觉细节（主题配色观感、面板不遮挡输入区的实际像素）未经人眼确认；布局逻辑与定位计算已由 DOM shim 覆盖
- .plugin.pgk 打包形态未做（本阶段按 vanilla JS 内置渲染层接线，非独立插件包分发）
- 面板「上下文分析」的分桶占比条只验证数据存在与总量一致，未逐项核对每个桶的百分比渲染
- 清理：已 stop_process stage2；未启动浏览器验证窗口；临时 patch 脚本已删除，保留 verify-*.js / dom-shim.js 作为可重复回归资产
