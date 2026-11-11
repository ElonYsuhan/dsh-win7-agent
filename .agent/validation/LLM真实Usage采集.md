# 验证账本：LLM真实Usage采集

- 建立时间：2026-11-11T02:14:18.778Z
- 需求原文：第一阶段：修复 llm.js 的真实 Usage 采集。修复 choices 为空数组时提前 return，确保能解析 usage 尾帧；对支持的 OpenAI 兼容流式接口启用 stream_options.include_usage 且不破坏其他供应商兼容；将 prompt_tokens/completion_tokens/total_tokens 及可识别缓存 Token 统一返回；不支持字段明确返回 unknown，不允许估算值冒充真实值；保持 content/thinking/toolCalls 流式解析行为不变；增加 SSE 尾帧、无 usage、工具调用、异常响应等测试。本阶段只改 LLM Usage 相关代码和必要测试，不开发 UI、不重构 Runtime、不修改工具执行模型。

## 验收标准
- [ ] choices 为空数组的 usage 尾帧能被解析（不再被提前 return 丢弃）
- [ ] 请求 payload 包含 stream_options.include_usage=true
- [ ] 供应商拒绝 stream_options 时自动降级重试且记住 baseURL，不破坏兼容
- [ ] prompt/completion/total 及缓存 token 归一化返回
- [ ] 拿不到的字段为 null 且列入 unknownFields，不出现估算值或 NaN
- [ ] content/thinking/toolCalls 流式解析行为与改动前一致
- [ ] HTTP 500 与截断流仍按原有错误语义抛出
- [ ] Ollama 分支 prompt_eval_count/eval_count 也能归一化
- [ ] 测试在 node v20 与目标运行时 node 16.17.1 下全部通过
- [ ] 宿主契约 assertModelResult 接受新增 usage 字段
- [ ] 宿主既有 runtime-audit-smoke 通过

## 验证手段
- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）

## 轮次记录

### 2026-11-11T02:14:45.369Z

轮次1（node v20.20.2）：node .build-tools\verify-llm-usage.js → exitCode=0，43/43 PASS。逐条对应验收标准：
- S1 usage 尾帧（choices:[]）被解析：promptTokens=1234/completionTokens=567/totalTokens=1801 ✅
- S1 请求 payload 实测含 "stream_options":{"include_usage":true}（服务端捕获 JSON 取证，见 usage-evidence.json openai.payload）✅
- S4 供应商回 400 "Unsupported parameter: 'stream_options'" → 自动降级重试，服务端收到 2 次请求，第 2 次无 stream_options，content='fallback-ok' ✅
- S1/S5 缓存归一：prompt_tokens_details.cached_tokens→cacheReadTokens=900；completion_tokens_details.reasoning_tokens→reasoningTokens=200；Anthropic cache_read_input_tokens=800/cache_creation_input_tokens=50 且 promptSemantics='exclusive'，总输入 100+800+50=950 ✅
- S2 无 usage → source='none'，8 个字段全 null，unknownFields.length=8（无估算值）；U3 非数字 'abc' → null 不产生 NaN ✅
- S1 content='Hello'、thinking delta 原样、S3 toolCalls 分片拼接 '{"format":"svg"}' 与改动前一致 ✅
- S7 HTTP500 → LLM_HTTP_500 未被吞；S8 截断流 → LLM_STREAM_INCOMPLETE 行为不变 ✅
- S12/S13 Ollama：prompt_eval_count=321/eval_count=65 → promptTokens/completionTokens，total 合成 386；无 usage 时 source='none'；且断言 Ollama 请求不带 stream_options ✅
轮次2（目标运行时 node 16.17.1，ELECTRON_RUN_AS_NODE=1 + release\.electron-dist\unpacked\win32-x64\electron.exe）：同一测试 43/43 PASS，exitCode=0 ✅
轮次3（宿主契约）：node -e assertModelResult({content,toolCalls,usage:{...}}) → 'assertModelResult ACCEPTS usage field: OK'，新增 usage 字段不撞 contracts/index.js:84 校验 ✅
轮次4（宿主既有 smoke）：node scripts\runtime-audit-smoke.js → exitCode=0，Skill inventory 68 / Process lifecycle 12 / Recovery 15746664 bytes / MCP lifecycle / SSE backpressure 全通过，无回归 ✅
改动范围：git diff --stat 仅 src/main/agent/llm.js（+298/-111），其中 usage 相关新增行 29 行；未新建 Agent Loop/事件总线/模型调用入口，未改 UI，未改工具执行模型（run-turn.js 未触碰）。
