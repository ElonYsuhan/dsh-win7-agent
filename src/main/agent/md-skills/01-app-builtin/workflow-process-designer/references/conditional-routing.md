# 排他条件分支与汇合

读取 workflow_catalog 的最新契约再创建。遵循 BPMN XOR 选一路语义，但使用本产品 JSON，不生成 BPMN XML/FEEL。

```json
{"id":"amount_gate","type":"condition","bindings":{"amount":{"nodeId":"apply","path":"amount"}},"branch":{"version":1,"cases":[{"id":"large","name":"大额审批","field":"amount","operator":"gte","value":5000}],"default":{"id":"small","name":"小额通过"}}}
```

- outputSlot 0 对应 cases[0]，依此类推，默认出口为 cases.length；每个出口恰好连一条边，最多8条条件。条件重叠时首条命中，顺序需说明清楚。
- 支持 eq/ne/gt/gte/lt/lte/in/not_in/contains/empty/not_empty，不执行任意代码。大小比较只接受数字，数据缺失或类型不符停止并报错，不能猜测默认。
- 表单 amount 使用 number Schema；来自AI的判断先产生经过Schema校验的结构化字段，再由确定性规则选路。
- 每条路径必须到达 end；复用后续步骤时使用 type:merge，来源连接不同 slot。merge 只允许一条有效输入，并透传该路径的数据；不是并行会签。
- 未选路径标记 skipped，不创建待办、不调用接口或工具、不计为交付产物。
- 驳回到 apply 后修改 amount 必须重新计算选路，保留旧审批/选路历史，不保留失效任务。
- 走查至少包含：小额、大额、恰好5000、条件重叠、默认、缺字段、错类型、驳回改金额、未选外部调用不发生。

完整可运行草稿：[金额分级示例](conditional-example.json)。
