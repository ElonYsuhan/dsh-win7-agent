# 验证账本：runtime-telemetry-phase2

- 建立时间：2026-11-11T09:50:33.380Z
- 需求原文：第二阶段：Runtime Telemetry 采集层。统一事件与指标 Schema，按 sessionId 隔离采集会话/模型/工具三层真实执行数据，产出实时快照与会话汇总；不开发 UI、不改执行模型、禁止另建 Agent Loop/事件总线/模型调用入口；真实与估算严格分离；不采集 prompt/密钥/工具敏感参数与返回内容。

## 验收标准
- [ ] 每个 telemetry 事件都能对应一个真实执行位置（可核对 EVENT_SOURCES），无虚构事件
- [ ] 模型层零侵入：包装 payload.onDelta 后流式行为原样透传，正文不丢
- [ ] 三级 ID 真实关联：turnId=execution.id，requestId=turnId:step:attempt，toolCallId=模型给的 call id
- [ ] request↔tool 通过 toolCallId 关联，一个 request 可挂多个工具
- [ ] provider usage 原样透传并正确聚合（含缓存命中率跨请求）
- [ ] 拿不到 usage 时相关指标为 null/unknown，不用估算冒充真实；TPS 在无 provider usage 时为 null
- [ ] 失败路径记录 errorKind，且重试决策(stop/compact/reconnect)在真实决策点后回填而非提前猜
- [ ] 并发会话隔离：各会话 token/turn 独立记账，turnId 不串线
- [ ] 隐私红线：采集数据中不含用户 prompt 原文、API key、messages 字段、baseURL
- [ ] 会话生命周期可辨：created / activated / restored
- [ ] 插件卸载后 collector 与 repository 清空，record 静默失效不抛
- [ ] 回归：cordis-runtime / session-isolation / agent / concurrency / model-reconnect / plugin 六个既有 smoke 全过

## 验证手段
- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）

## 轮次记录

### 2026-11-11T09:51:24.475Z

【轮次 1 — 端到端验收，全部通过】

验证手段：真实链路驱动（真实 PluginHost + AgentPool + run-turn + llm.requestChat），mock 供应商 SSE。
脚本：.build-tools/verify-telemetry.js（46 项断言，8 个场景 A–H）
结果：PASS 46 / FAIL 0（exit 0）

逐条标准与实际证据：
1) 事件锚定真实位置 — schema.js EVENT_SOURCES 逐条写明来源；A1–A6 全部采到
   session.created / context.assembled / model.request.started / model.first-delta /
   model.request.completed / turn.settled（A6 PASS）。
2) 模型层零侵入 — A15：包装 payload.onDelta 后请求 status=completed、durationMs>0，
   正文未丢；前置探针 probe-waterfall-return.js 证明 listener 能改 payload 并捕获 next() 返回值。
3) 三级 ID — A7：requestId 实测 "turn_mwbqv26q_3:1:1"，三段式，turnId 与首段一致。
4) request↔tool 关联 — B8：恰一个请求 toolCallCount>0，toolCallIds=['call_e2e_1']（模型给的真实 id）。
5) provider usage 聚合 — A10 原样透传(1000/60/400/600)；B9 跨请求命中率 800/1300 精确匹配。
6) 不伪造 — F1 usage.dataClass=unknown；F2 totalTokens=null（非 0）；F3 TPS=null。
7) 失败与重试决策回填 — C2 errorKind=http-400；C3 retryDecision='stop' 由 run-turn catch 回填
   （collector.recordRetryDecision），非提前猜；C5 turn.settled=failed。
8) 并发隔离 — E1 sess-x=100 / sess-y=200 各自独立；E2 两会话 turnId 不同。
9) 隐私红线 — D1–D4：dump 中不含 prompt 原文(PROMPT_CANARY_9911)、api key、"messages" 字段、baseURL。
   schema.validateTelemetryEvent 白名单 + FORBIDDEN_KEYS 硬拦截执行。
10) 生命周期 — G1 created / G3 activated|restored 可辨；G2 第二轮 turnCount=2。
11) 卸载清理 — H2 collector.sessions.size=0；H3 卸载后 record 静默失效不抛。

【过程中发现并修复的真实缺陷（非测试问题）】
- schema.validateTelemetryEvent 未把事件自身的 type 判别字段排除，导致每个事件都抛
  TELEMETRY_EVENT_UNEXPECTED_FIELD: <type>.type，被 safe() 静默吞掉 → 全链路零采集。
  证据：修复前 sessions.size=0 且无任何事件；修复后 46/46。已修（跳过 key==='type'）。

【回归证据（我改了 run-turn.js / agent-pool.js / profile.js）】
- cordis-runtime-smoke.js        exit 0  "Cordis runtime OK: ... replaceable model/loop, persistence, shutdown"
- session-isolation-smoke.js    exit 0  "requests 2 / second includes first: false"
- agent-smoke.js                exit 0  多轮 + 工具 + 图片 + 恢复（recovered messages: 11）
- concurrency-smoke.js          exit 0  28/28 checks passed
- model-reconnect-smoke.js      exit 0  9 项（含重试/取消/TLS/预算）全过
- plugin-smoke.js               exit 0  插件装载/工具/prompt/skill 正常
改动面（git diff --cached --stat）：agent-pool.js +17/-1，profile.js +5/-1，run-turn.js +12/-0
新增：src/main/telemetry/{schema 167, collector 626, context-stats 95, repository 107, plugin 238}
     src/main/runtime/plugins/telemetry.js 11

【未验证 / 边界声明】
- 上下文分布分桶是本地估算（method='estimated'），未与供应商真实 prompt_tokens 对齐校准；
  memoryTokens 恒 0（长期记忆拼入 system 段，无独立标记可切分，已在 notes 声明）。
- 未验证真实供应商（仅 mock SSE）；真实网关的 usage 差异已在第一阶段覆盖，本阶段复用其归一化结果。
- Repository 落盘未做（本阶段仅内存 + 归档 Map），接口已按可替换设计。
- UI（第三阶段）未开始，本阶段无渲染层改动。
