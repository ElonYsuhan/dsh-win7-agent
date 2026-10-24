# 节点执行设计与数据流转协议

## 边界

`ExecutionDesign` 版本1是设计提案，只含声明式数据。AI 专用会话引用能力中心内置的
`01-app-builtin/workflow-node-designer` 技能，经原生 Cordis `workflowDesigner` 服务调用
当前模型；工具列表固定为空，没有通用 Agent 循环、文件工具、接口执行或业务批准权限。
每次请求最多60秒，支持取消，历史最多8条。用户点击应用后才修改编辑中的节点，整体
流程仍通过既有 `workflows.save` 保存，设计调用不会创建运行实例。

取消可以先结束界面等待；底层模型传输仍被追踪至完成关闭，计入最多2个请求的并发
上限。Cordis 卸载会中止活动请求并等待任务和底层传输一起收尾，避免取消后遗留请求。

新人工节点默认“处理说明 + 可选备注 + 审阅批复”。需要表单、上传或审批时按需设计。
旧节点的 `humanModes`、处理内容、输入输出 Schema 保持兼容；设计自动节点只允许调整
指令和数据契约，不能静默转为人工节点。

### 2026-10-24：简化设计交互

左栏保留设计会话、快捷需求和输入区，移除“更多设置”及其手工表单，不再搬移属性
面板 DOM。已有 Schema、附件要求与旧节点设置继续保留，可通过 AI 提案或协议预览
调整；移除入口不迁移、清空或降低既有业务校验。人工节点选中时不再构建隐藏的配置表单。

设计助手显示待输入、正在生成、预览已更新、失败、已停止及保存状态。生成期间显示
预览遮罩与 CSS 旋转图标，禁用重复提交和应用；停止按钮及 Esc 保持可用。取消或失败
移除遮罩并保留上一有效提案，过期响应通过请求代数守卫忽略。消息为有界的左右气泡，
只使用 textContent 展示模型文字；没有流式协议时不伪造百分比。保存期间禁止重复应用。
状态对屏幕阅读器可见，保留焦点限制、关闭恢复和输入法组字保护，减少动态效果时停转。

`scripts/workflow-node-design-e2e-smoke.js` 使用真实 Chromium108 和受限模型替身，覆盖
成功/失败/停止/关闭的遮罩恢复、晚到响应、Schema 预览、保存、主题和键盘操作。
协议与 Cordis 执行边界不变，不增加模型权限、生产依赖或 Agent 执行路径。

旧人工节点未声明 interaction 时，设计基线沿用既有 Processing.view 结果，保留必填
结论和附件要求；原 review 模式映射为 handle，read 映射为 review，approval 映射为
approve，避免仅打开设计器就增加审阅勾选或删除原有必填项。新节点显式采用 review
交互和可选备注。原 upload 模式在提案中补为附件 required:true，应用后继续生效。

## ExecutionDesign V1

```json
{
  "version": 1,
  "instruction": "核查资料与出处",
  "interaction": {"version": 1, "type": "review", "returnTo": "previous-human"},
  "inputSchema": null,
  "outputSchema": null,
  "processing": {"version": 1, "blocks": [
    {"type": "instructions", "title": "处理说明"},
    {"type": "conclusion", "title": "备注", "required": false}
  ]},
  "bindings": {}
}
```

人工交互仅允许 `handle`、`review`、`approve`，与现有办理、审阅、审批/驳回迁移一致。
自动节点的 `interaction`、`processing` 为 `null`。输入 Schema 的根类型必须是 object，
其余采用既有有界 JSON Schema 子集；不支持 HTML、脚本、远程引用、可执行表达式或
未知动作。字段名使用英文标识，中文名称用 title。表单字段最多24个，嵌套最多4层。

处理块只允许 instructions、reference、form、attachments、conclusion，最多12块，
form/attachments/conclusion 各最多一块。form 与人工 inputSchema 必须同时存在。
附件块支持 `required`；应用到节点时由适配器派生原有 humanModes 中的 upload 标志，
实际提交继续限制3个附件、合计512KB。备注的 required 默认 false。

契约入口为 `src/main/contracts/workflow-node-design.js`。设计应用仍映射到现有节点的
`text`、`interaction`、`inputSchema`、`outputSchema`、`processing`、`bindings`，没有第二份
可独立运行的节点状态。`validateDesign` 只返回规范化提案，不修改或保存节点。

## 业务数据与 NodeDataEnvelope V1

人工表单提交的 `values` 先按 inputSchema 校验，必要时再按 outputSchema 校验，
然后成为已完成节点的 `step.data`。自动节点返回的 JSON 按 outputSchema 校验后也存入
`step.data`。无结构化输出的旧节点继续通过 `step.output` 传递文本。

下游字段映射沿用 `bindings:{"字段":{"nodeId":"上游ID","path":"业务字段路径"}}`。
映射起点是上游 `step.data`（无结构化结果时为 `{text:step.output}`），不是 envelope；
所以 path 不需要 `output.data` 前缀。只有已成功完成的上游节点可成为实际执行输入。

详情和上下文另外派生标准审计外壳：

```json
{
  "version": 1,
  "nodeId": "review",
  "attempt": 1,
  "status": "succeeded",
  "input": {"text": "上游文本", "data": {}, "files": []},
  "output": {"text": "结果文本", "data": {}, "files": []},
  "review": {"note": "备注或批复", "decision": "confirm", "reviewed": true}
}
```

files 只传 name、size、ref 元数据，不把文件 Base64 塞进数据流。input.files 默认收集
已成功上游步骤的完整原文件引用，穿过文本中间节点并按 ref 去重，排除无依赖的旁支；
Agent 下一次尝试也保留本节点人工补充的文件。工作目录由仓储校验实例归属后完整复制
原文件，模型文本预览仍有界，读取二进制需相应工具。清单上限360份，覆盖100节点
每次3份与20次 Agent 执行尝试的补充额度，工作目录超限明确报错，不静默丢弃。
业务输入、输出与
审批结论继续来源于既有版本化事实；envelope 不另存一份可竞争的状态。waiting 状态的
output 可含已有中间结果，不能当作已批准结果使用。会话上下文中的长文本最多8000字，
与原有 context 截断语义保持一致；详情保留节点输出上限内的文本。

人工表单仅含一个字段且分组标题与字段名称相同时，预览和运行表单合并重复标题，
提交值仍保留原 Schema 的对象结构和字段路径。附件区直接上传原文件，无需另选传递方式。

## 无副作用自测

`simulate({workflow,samples?,outputs?,files?})` 返回 mode 固定为 simulation 的报告。
samples、outputs、files 按 nodeId 组织，分别提供人工表单业务值、自动节点输出样例和
模拟附件元数据。人工必填项缺少样例时返回 needs_input。自动节点没提供输出样例时，
仅按 outputSchema 合成标记清楚的模拟值，再验证图、Schema、字段映射和交付来源声明。
必传附件没有提供元数据时可生成 simulation:// 引用，并明确尚未读取或上传真实文件。

自动节点合成样例前先按 Schema 计算展开规模，每个节点最多512个值（含容器）和
32000个文本字符（含字段名）。嵌套数组及对象超过预算时直接返回节点错误，要求提供
精简输出样例，不先创建巨大数组或字符串。此限额只约束自动合成，不放宽既有真实数据
与请求大小校验；单个合规16000字符文本可用，但批量展开仍受总预算限制。

仿真不调用模型、工具、REST、Agent 执行器或真实文件操作，不写运行事实，不创建产物。
文件交付只验证来源声明，不证明文件实际存在；报告的 passed 只意味着样例数据及结构
检查通过，不代表业务执行、审批或文件生成成功。每步报告携带相同格式的 envelope，
便于查看样例如何从上游转给下游。

## 架构与兼容验证

纯设计契约在 contracts，纯仿真策略在 flow；模型、技能访问、取消和超时归属 Cordis
上层 workflow-designer 插件。workflows 服务仅委托这组设计方法，HTTP 与 IPC 共用
同一接口。没有新增容器、事件总线、持久层或生产依赖。

仍固定 Electron22.3.27 / Node16.17.1 / Chromium108，技能和实现均随包离线分发。
`scripts/workflow-node-design-smoke.js` 验证真实模型协议、专用 Skill、空工具列表、取消、
数据契约、旧字段兼容、派生 envelope 与无 IO 仿真；构建机 Node 与内嵌 Node16 均应通过。
这些验证不替代 Win7 SP1 x64 真机验收。未来宿主或模型适配器可替换，设计及数据契约不变。

仿真在拼接前限制每节点文本128000字符、结构化输入64000字符、累计文本1000000字符；模板展开与分叉汇合都在分配大字符串前检查，超限返回节点错误并阻断下游。
