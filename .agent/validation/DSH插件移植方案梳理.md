# 验证账本：DSH插件移植方案梳理

- 建立时间：2026-11-10T01:52:55.839Z
- 需求原文：用户要求：在本工程中先不动代码，梳理一份"把 DSH token 计量/占用展示能力移植进来"的方案（对上一轮"不能原封不动照搬 DSH 插件"结论的落地方案）。

## 验收标准
- [ ] 方案基于本工作区真实代码（contracts/flow/state/runtime/renderer 分层、cordis vendor、session journal）定位每一层的落点，不引用不存在的路径
- [ ] 对 Node 16.17.1 上 structuredClone / findLast 等 API 的兼容性给出实证（用 Electron 内嵌 Node 跑 node -e / 探针脚本），不再停留在版本推断
- [ ] 列出每层可复用组件与需要新增的最小文件集，且符合 AGENTS.md 零新增生产依赖、纯策略无 IO、单一事实源的约束
- [ ] 明确 UI 落点（现有 contextUsage / composer 工具条 / .modal dialog token）与不引入 React 的实现方式
- [ ] 给出分阶段验收标准与对应验证命令（smoke / check:node16 定向）
- [ ] 未验证事项如实标注

## 验证手段
- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）

## 轮次记录

### 2026-11-10T01:57:21.015Z

轮次1（方案梳理，未改业务代码）：
1) 工作区确认：本工作区即目标工程 dsh-win7-agent（前一轮"找不到工程"的扫描结论与本工作区不符）。cordis vendor 实际存在：src/main/runtime/vendor/cordis/manifest.json = cordis 4.0.0-rc.11 / cosmokit 1.8.1 / target node16.17 / format cjs / sha256 固定。sessionProjections 全仓 0 命中（src 817 文件扫描）。
2) Node 16.17.1 实证（release\.electron-dist\unpacked\win32-x64\electron.exe + ELECTRON_RUN_AS_NODE=1，探针 .build-tools/probe-node16.js，exitCode=0）：
   - structuredClone: undefined → ReferenceError: structuredClone is not defined（确实不可用）
   - Array.prototype.findLast / findLastIndex: function，调用返回 3 / 2（**可用**，推翻"Node18+ 才有的会 ReferenceError"的推断）
   - Object.hasOwn: function(true)；??=/||=/&&= parse+run ok；String.replaceAll / at 均存在
   - Array.prototype.toSorted: undefined（不可用）
   - 自写 deepFreeze 在 strict 下正确抛错、值不变
3) 数据源现实：src/main/agent/llm.js 的 requestChat 只 resolve { content, toolCalls }，SSE 里 parsedLine.usage 完全未解析 → 当前工程**没有任何来自模型的 token 计量**。现有只有估算：context-compressor.js estimateTextTokens/estimateMessagesTokens（cjk*1 + ascii/4 + other/2，消息+4，基+3）；渲染层 ui-enhancements.js:22 另有一份重复 estimatedTokens（跳过 system、无基3）→ 已是双份事实源。
4) UI 现状：#contextUsage 在 composer toolbar-right（index.html:119），由 ui-enhancements.js:156-160 写 "≈ x.xk / Nk tokens"，title 明写"不是模型计费数据"。主渲染层是原生 JS DOM（IIFE），**不是 Vue**；vue/naive-ui 只存在于 generative-ui vendor 包（scripts/build-generative-ui.js AgentUIVendor）。
5) 持久化现实：SessionRepository.save() 写快照后把 events.jsonl 清空（session-repository.js:52-58，附平方增长/RSS 实测注释）→ journal 是短尾日志，**不能当累计 token 账本回放**，累计量必须进 last-session.json 快照。
结论：方案按 contracts(纯) → flow(纯策略) → state(账本 reducer) → runtime/agent(usage 采集与写回) → renderer(原生 SVG 环+弹层) 五层落地，零新增生产依赖。structuredClone 需替换，findLast 不需要。未验证：真实模型返回 usage 的字段形态（依赖用户所连服务）、Win7 真机。

### 2026-11-10T02:57:21.852Z

轮次2（交付可安装插件包，用户改需求：要一个能自己装的包，先验证再定方案）：

【产物】
- 源：examples/extensions/token-meter/{index.cjs, manifest.json}
- 安装包：dist/token-meter.plugin.pgk（zipBytes=6657，解压 17047 B，digest=3c17e4e35787d42491dc63732377097f92459cbbcfea6b7f3a85b4e5c00f53ac）
- 插件 id=dsh.token-meter，type=plugin，v1.0.0，entry=index.cjs，engines: extensionApi1/node16/electron22/chromium108，targets any
- 注册两个工具：token_meter_report（format=text|json|svg，recent 0-50）、token_meter_reset
- 挂 Cordis `llm:request` waterfall，包装 request.onDelta 统计 content/thinking，不改变转发语义

【验证：目标运行时 Electron 内嵌 Node 16.17.1（ELECTRON_RUN_AS_NODE=1 + release\.electron-dist\unpacked\win32-x64\electron.exe），命令 `node .build-tools\verify-token-meter.js`，exitCode=0，22/22 PASS】
A1 pack 产出包 / A2 inspect 通过（哈希+vm 编译+类型）/ A3 篡改包被拒 / A3b 载荷换内容被哈希拦下 / A4 后缀不符被拒
B1 安装前工具不可见 / B2 安装后 enabled=false 且工具仍不可见
C1 启用后 active 且两工具注册
E1 onDelta 包装后原样转发 ['thinking','content']，请求结果不变
D1 计量记录 prompt=200 completion=13 thinking=4 latency、tools=1、messages=4、model=test-model、source=estimate
D2 occupancyTenths == floor(prompt*1000/window) 钳 1000
F1 失败请求 failed=true、failedRequests=1、错误 LLM_HTTP_500 原样抛出未被吞
G1 99.7% → '99.7%' 不进位；1500/1000 钳 1000；窗口<=0 → null；formatPercent(null)='—'
G2 口径同构：estimatePrompt([{user:'hi'}],[])=8（基3+每条4+1）、空=3、中文4字=4、image_url=1000
H1 text 含「上下文占用」「估算，非计费数据」「最近 2 次」
H2 svg 含 stroke-dasharray / rotate(-90 7 7) / r="5.5"，无 script、无 javascript:
H3 无请求时显示「—」与「未设置窗口」（text 与 svg 双验）
I1 reset 后 requests=0 / I2 停用后工具消失 / I3 重启用后继续累加且 model=again
J1 宿主 dispose 重建后插件自动恢复 active 且工具可用 / J2 重启后 waterfall 计量仍生效（model=after-restart）

【过程中修掉的两个真问题】
1. summary() 原先读 ctx.agentConfig.settings.contextWindowTokens，与请求自身窗口形成双源 → 改为只取被观测请求的 contextWindow（单一事实源），并把 agentConfig 从 inject 移除（inject 只剩 tools）。改后重跑 22/22。
2. module.exports._internals 曾被前面的 module.exports 覆盖导致 undefined → 移到文件末尾。

【未验证 / 边界（如实）】
- 未接真实模型服务：completion/thinking 来自 onDelta 文本估算，非 provider usage。宿主 agent/llm.js 未解析 usage 帧，本包无法给出缓存命中率与实际计费，报表里已明文写「未解析到 provider usage」。
- 未做 Win7 真机验收（本轮在构建机 Electron 22 dist 上跑）。
- 包不能注入前端 UI（规范禁止前端加载包内 HTML/JS）：页脚常驻 SVG 环/明细弹层仍需宿主 renderer 改动，本包以工具返回 SVG 代替。
- 统计只在内存，宿主重启清零（J1 验的是插件恢复 active，不是累计值保留）。
- 清理：未启动常驻服务与浏览器窗口；.build-tools/ 下为一次性验证脚本与 report.svg，dist/token-meter.plugin.pgk 为交付物。
