# 验证账本：runtime-telemetry-phase3-ui

- 建立时间：2026-11-11T10:11:16.061Z
- 需求原文：第三阶段：Runtime Telemetry UI。只消费第二阶段 Telemetry 数据，不修改 Agent 执行链路。状态栏三指标（Token 本轮输入/输出、TPS 生成速度、Context 上下文估算量）+ 浮动详情面板四区域（模型调用/性能指标/上下文分析/工具执行）。未获取数据展示 — 不显示 0；Context 标记估算；TPS 仅有效数据下展示。UI 经 Repository/只读查询接口取数，禁止直接操作 Collector，禁止新增 Agent Loop/事件总线/第二套会话状态；支持多 Session 切换不串线；流式期间实时更新；面板关闭/组件卸载不影响 Agent 执行；不展示 Prompt/API Key/消息正文/工具参数/敏感地址；内存数据不得包装成持久化历史统计。顺序：先状态栏三指标，再浮动详情面板，最后真实链路联调与回归。不扩范围到第四阶段（持久化/历史分析/报表）。

## 验收标准
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]
- [ ] [object Object]

## 验证手段
- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）

## 轮次记录
