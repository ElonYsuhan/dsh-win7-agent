# 轻量工作流与受限 Headless Agent（首版落地）

## 使用入口与闭环

工作流 → 使用步骤模板，载入“资料分析与报告编写”草稿。载入只预览，不保存、不执行；人工修改并保存后，点击执行，确认 Agent 工具白名单与限额。普通“新建流程”仍为空白创建；已有画布和旧实例继续兼容。

模板：开始 → 资料与任务表单 → Agent 资料分析 → 单次模型生成大纲 → 人工审阅/确认 → 单次模型生成正文 → 模型评估 → 结束交付。人工输入和模型结果为结构化数据，正文与评估共同写入最终实例产物。默认资料分析只允许 read_file，工作目录中的 input.txt 含输入与附件清单；用户可明确选择已启用的只读文档 MCP 解析 DOCX/XLSX 等。并不宣称 read_file 可以解析任意二进制文件。

## 职责和代码边界

- Cordis：装配、依赖、扩展启停和异步清理。
- contracts/workflows、workflow-schema、workflow-agent、workflow-templates：纯契约、受支持 Schema、执行限额和步骤模板。
- flow/workflow-policy：纯拓扑、依赖裁剪、字段映射和重试影响范围。
- state/workflow-state：事实驱动的合法状态迁移、尝试历史、人工待办。
- workflows/repository：版本定义、fsync JSONL 事实、附件、工作目录和产物。
- runtime/plugins/workflows：业务调度；workflow-nodes：统一节点注册；workflow-agent：受限执行适配。
- 原有 AgentPool → Agent.run → Cordis agentLoop：唯一 Agent 执行链，不引入第二个循环、容器或任务调度底座。

工作流 Agent 按需占用现有池名额；等待人工时没有悬挂 Agent、超时计时器或后台轮询。完成、拒绝或失败后 await 释放 worker。quiet 模式不向普通聊天广播内容，不创建项目或知识库会话。

## 节点与数据契约

新增版本2；旧版1不迁移改写历史。含 Agent、工具、Schema 或处理内容块的新定义按版本2保存。节点保留原 text/ports/edges，并增加：

```json
{
  "id": "analysis",
  "type": "agent",
  "title": "资料分析",
  "inputSchema": {
    "type": "object",
    "properties": { "sources": { "type": "string", "minLength": 1 } },
    "required": ["sources"],
    "additionalProperties": false
  },
  "bindings": { "sources": { "nodeId": "materials", "path": "sources" } },
  "outputSchema": {
    "type": "object",
    "properties": { "analysis": { "type": "string", "minLength": 1 } },
    "required": ["analysis"],
    "additionalProperties": false
  },
  "skills": [],
  "agent": {
    "permission": "readonly",
    "tools": ["read_file"],
    "maxSteps": 6,
    "maxRequests": 6,
    "maxToolCalls": 8,
    "timeoutMs": 120000,
    "tokenBudget": 150000,
    "outputBytes": 131072
  }
}
```

inputSchema 对人工节点定义提交表单，对自动节点定义映射后的输入。bindings 只能读取拓扑上游已完成节点的 data；path 支持最多5层对象字段，空路径表示完整结果。没有结构化结果的旧节点可使用 path: "text"。依赖引用不代替连线，不允许越过执行顺序读取未完成结果。

Schema 支持 object、array、string、number、integer、boolean，以及 properties、required、additionalProperties（布尔）、items、enum、min/maxLength、minimum/maximum、min/maxItems 和文案。最多4层、每对象24字段、数组最多100项、单份值最多64000字。未知关键字和远程 $ref 明确拒绝，不声称实现完整 JSON Schema。人工表单前端生成，服务端再次校验；AI/Agent 输出须通过同一校验，否则失败并保留原始结果。不进行无依据的自动修复或补值。

固定 tool 节点配置 `tool:{name,arguments,permission}`，arguments 是对象，字符串可引用 {{input}}/{{inputN}}。执行通过原 ToolRegistry，具有参数、权限、取消和插件禁用检查，不请求模型。REST 节点仍使用既有 HTTP 适配。业务插件可通过统一 `.plugin.pgk` 包在 Cordis effect 内注册 workflowNodes，自定义节点需声明稳定 type 和 version；不会提供新的节点安装器。

## Headless Agent 权限与结果

Agent 节点按配置获取确切工具列表，模型不能扩大白名单；实际执行时仍核对工具契约和权限。只读配置不能选择写入工具。首版不开放命令、浏览器及工作流创建/任务管理工具，以免产生嵌套调度；仍可明确授权工作目录内的文件修改及已启用 MCP/插件工具。

绑定的 Skill 是专业指令，不授予工具权限。技能正文按实例保存摘要和受限正文；请求提示仅暴露绑定的技能索引。显式允许 load_skill 时，仍只能加载已绑定的稳定技能 ID。

Agent 返回：

```json
{ "outcome": "completed", "result": { "analysis": "结构化结果" } }
```

或：

```json
{ "outcome": "needs_human", "reason": "需要补充的内容", "partial": "已有结论" }
```

节点内不展示审批弹窗。缺资料、工具越权或工具不可用时，由外层工作流创建待办；人工补充后开启独立新尝试，不恢复旧工具调用栈，不自动重放旧副作用。上下文来自上游事实和本实例独立目录，附件按引用复制；不把项目目录或知识库原件作为默认可写目录。

默认6轮/6次模型请求/8次工具调用/120秒；上限20轮、20次请求、32次工具、600秒。沿用现有无人值守预算和输出限制，无自动压缩/重试。预算为保守额度，不等同于供应商计费 Token。超时、取消和额度耗尽保留已收到的正文或工具摘要；未返回的远端结果仍可能不确定，不能声称已经撤销远端动作。可信工具必须响应 AbortSignal，进程内插件不等于 OS 沙箱，不能强制中断不合作代码。

## 执行、人工、暂停与重试

- 执行页继续左侧流程图、右侧节点工作台；支持查看历史节点，当前待办不随选择丢失。
- 开始记录输入，运行记录实际工具名及有限结果摘要，结束记录结构化结果、结论、错误和产物。不保存模型内部思维链。
- 记录尝试编号和 Agent 会话 ID，完整 Agent 事实位于现有 sessions 仓储。Agent ID 为稳定短标识，避免池内改写造成追踪不一致。
- 暂停请求是持久化事实，等待当前步骤结束后暂停，不启动下一节点。暂停不等于冻结正在进行的外部调用；立即停止使用取消。
- 版本2人工审批“不通过”后暂停，不能直接跳过确认继续。需重试对应人工节点并重新确认。旧版本1仍保留原有“结论传递”行为。
- 结构化评估 verdict 为 revise/fail 时进入人工待办；用户可核查后确认，或显式从上游步骤重试。模型结论不代替人工审批。
- 重试仅由显式操作发起，当前节点及执行计划中的下游结果失效，上游成功结果继续复用；历史尝试和事实不覆盖。最多每节点10次尝试，模型/Agent节点尝试合计20次。
- Agent、REST、固定工具重试需先确认已核查外部操作。重启将 pending/running 记为 interrupted，不自动重放；waiting 和 paused 持久恢复。尚无已开始步骤的中断，可新建实例重新执行。
- 重试沿用实例原定义。需要修改 Schema、指令或结构时保存新版本并创建新实例，不静默修改活动实例。

实例固定图修订、节点扩展版本、已启用扩展包摘要、所选工具契约和技能正文摘要。模型连接/参数保存不含密钥的指纹，变化时提示恢复原配置或创建新实例；凭据更新不写入流程事实。不自动下载依赖或切换到新版扩展。管理员若通过未托管的旧插件目录直接替换代码，仍需遵守节点 version 契约；离线托管包另外核对载荷摘要。

## 界面和首版范围

步骤模板默认左侧步骤列表、右侧属性；可调整步骤顺序、编辑指令、Schema/输入映射、绑定技能、工具白名单及限额，人工 Schema 有表单预览。复杂 Schema 当前通过折叠 JSON 编辑区修改，未提供完整表单设计器。保留原画布用于已有流程，不把含分支的图自动改写为顺序链。

会话中的 workflow_catalog 返回实际节点、能力和契约，AI 可创建包含 Schema 的草稿，之后由用户检查保存并执行。AI 创建工具没有运行、重试或批准人工待办的能力。人工节点打开辅助会话的既有路径继续保留，讨论结果由用户显式提交。

首版不包含条件路由引擎、自动循环、并行执行器、任意嵌套、多人身份审批或电子签名。模板中的评估返修是人工选择节点后的显式重试。没有新增生产依赖，没有新增 Python/PyTorch 或运行时下载。

## 验证

- `npm run check`：包含原工作流、Agent、任务和离线包回归，以及 workflow-v2-smoke。
- `npm run check:node16`：实际 Electron 内嵌 Node16.17.1 执行相同检查。
- `npm run check:workflows:v2:browser`：实际 Chromium108 验证步骤模板预览、编辑/保存/重开、表单预览与提交、真实 Agent 工具调用、人工确认、边界暂停/恢复、历史参照及最终报告。
- `node scripts/workflows-e2e-smoke.js`：旧画布、手工端口、AI会话建图、人工等待和画布资源回收继续回归。

模型和外部工具验证使用本机真实 HTTP/stdio 模拟服务，不声称已完成用户内网服务的联调。Electron22.3.27 / Node16.17.1 / Chromium108 保持锁定；尚未进行 Win7 真机验收。未来更换运行时仅替换平台适配，业务契约和事实无需依赖旧宿主。

独立节点包示例：`examples/extensions/workflow-node/`。使用 `node scripts/pack-extension.js examples/extensions/workflow-node /tmp/workflow-node.plugin.pgk` 打包；通过能力中心安装、启用后，节点目录新增“文本规范化”。回归验证实际离线安装、Cordis 注册、执行和停用后的目录清理。

## 实例交付产物（2026-10-19）

每个结束 / 兼容保存节点均发布交付文件，再记录节点成功事实。旧定义默认 TXT；
空文本交付生成包含已完成步骤和结论的执行报告，不生成空白占位文件。
报告模板默认交付 `分析报告.md`，正文来自经过评估的 `report` 字段。

此处的交付文件指正式结果；执行开始时的初始草稿与正式结果分开保存，规则见下文。

结束节点 `deliverable` 是可离线保存、供 AI 草稿工具读取的纯契约：

```json
{"format":"markdown","name":"分析报告","field":"report"}
```

`format` 支持 `text` / `markdown` / `json` / `files`。`field` 可选，最多五级，
从上游汇总 JSON 中提取正文；JSON 格式必须是有效 JSON。实际文件示例：

```json
{"format":"files","files":[
  {"nodeId":"generate","path":"output/report.pptx"},
  {"nodeId":"generate","path":"output/model.glb"},
  {"nodeId":"generate","path":"output/scenario.json"}
]}
```

文件来源必须是有依赖连线的上游 Agent、固定工具、人工附件或自定义扩展节点。
自动来源的相对路径以该节点本次尝试的独立工作目录为根；人工来源使用上传文件原名。
单次 AI / 评估 / REST 节点不具备本地文件生成能力，不能只凭模型返回的路径声称已经交付。
生成文件仍需相应白名单工具，Skill 不授予文件能力。首版不增加模型 / 场景专用生成器。
人工附件沿用现有三文件、总计 512KB 上限；实际自动交付每文件最多 64MB、每批最多
20 项、实例当前产物总计最多 256MB，不将大文件放入工作流 JSON 或事实日志。

仓储检查真实路径归属、普通文件、大小和存在性；拒绝跨目录或跨实例引用，复制、fsync、
SHA-256 后才由 `node-finished` 事实发布元数据。文件缺失、格式字段错误或归档失败，
结束节点和实例失败，不展示虚假交付。复制成功但事实未提交时允许不可见孤儿；重启不重放。
文件内容与来源工作目录分离，来源修改不改变已归档版本。重试使受影响节点的当前产物
失效，旧尝试元数据和磁盘文件保留作审计，不出现在当前交付列表；不会删除其他实例。
目前没有产物删除 / 自动清理接口，磁盘容量管理是后续独立任务。

实例列表增加产物数量和入口；实例右侧先显示当前待办，下方为工作流产物。
选中历史节点可展开输入、结论、结果和执行事实，不再常驻大块开始 / 运行 / 结束时间轴。
查看复用现有共享文件预览渲染器与 Office / 文本 / 图片解析器，预览窗口有独立状态，
关闭取消后续更新并释放 Blob URL。PPT 支持既有内容预览；模型、二进制场景等不承诺
专用三维预览，可下载原件交给相应软件。下载通过实例 ID + 产物 ID 分块读取，
不接收客户端提供的任意服务器路径，也不依赖远程客户端能够打开服务器本地路径。

验证：`workflow-artifacts-smoke.js` 覆盖真实 Cordis 调度、PPT / 场景 / 二进制逐字节
交付、分块、哈希、上传附件、路径 / 实例隔离、缺失失败、重试和重启恢复；浏览器回归
覆盖模板重开、报告预览、Escape 关闭回收以及待办 / 产物布局。仅使用内置 Node16 API，
没有新增生产依赖或下载；Electron Node16 / Chromium108 检查不等于 Win7 真机验证。

## 可组合的节点处理内容与初始草稿（2026-10-20）

解决人工步骤总是显示相同上传/结论表单的问题。人工节点可以声明处理内容块，
按顺序组合文字说明、上游/中间资料、Schema 表单、附件和结论：

```json
{"processing":{"version":1,"blocks":[
  {"type":"instructions","title":"处理说明","text":"阅读依据，登记核实后的发现。"},
  {"type":"reference","title":"上游依据","source":"input"},
  {"type":"form","title":"发现登记"}
]}}
```

`instructions`、`reference` 可重复，其余类型各最多一个，总计最多12块，文字纳入
既有整图128000字参数上限。`form`
与 `inputSchema` 一起配置；`reference.source` 为 `input` 或 `partial`；文字说明留空
时使用节点处理要求。`conclusion` 可省略或设 `required:false`，表单型、只读型步骤
不必另写一段结论。`upload` 方式必须含附件块，审批/已阅确认仍由 `humanModes`
决定并在服务端强制校验，不能通过隐藏内容块绕过。只展示纯文本和受支持的 Schema，
不接受任意 HTML、脚本或新能力权限。未配置时保持旧布局及必填结论语义。

右侧属性支持增删、排序和修改内容块标题；表单字段继续使用现有 Schema 编辑器。
会话中的 `workflow_catalog` 暴露相同契约，AI 可生成草稿供人工检查。执行页使用
服务端规范化的处理视图，不另存业务状态；切换历史节点、打开辅助会话时保留待办
未提交内容。“打开会话分析”采用明显的主题按钮，定位当前待办收进待办标题行图标。

每个实例在创建事实发布前初始化结束节点的交付项。TXT/Markdown 创建真实的0字节
草稿，JSON 创建有效的空对象 `{}`；它们是只读初始草稿，不随节点执行伪装为已生成
结果。PPT/模型等真实文件仅登记命名的“待生成”交付项，不制造无法打开的空二进制。
结束节点成功归档后，同一交付项显示正式文件；初始草稿独立保留，不覆盖正式产物。

草稿保存在 `workflows/drafts/<实例ID>/`，元数据进入版本化 `created` 事实；旧实例
首次查看时追加一次 `deliveries-initialized` 事实，不修改旧日志或重复外部操作。
`plannedArtifacts` 由纯契约校验，当前 `deliverables` 视图从计划和节点产物事实派生，
既有 `artifacts` 仍仅包含真实正式结果。仓储负责独占写入、fsync、摘要和实例路径归属，
服务继续由原 Cordis workflows 插件装配，没有第二个执行器或持久化容器。

验证：`workflow-processing-smoke.js` 覆盖表单/只读提交、强制校验、空白草稿和正式交付、
跨实例拒绝、重启与旧实例一次初始化；`workflow-v2-e2e-smoke.js` 使用 Chromium108
覆盖历史选择、定位按钮、草稿预览、表单提交和内容块编辑保存。实现仅用内置 Node16
文件能力及原生 DOM；替换未来宿主/预览适配时无需改变内容契约和执行事实。保持
Electron22.3.27/Node16.17.1/Chromium108，尚未进行 Win7 真机验收。

## 人工节点与画布交互（2026-10-21）

人工节点默认只有处理描述与交互类型：办理“完成并继续”、审阅“已审阅，继续”、
审批“通过并继续 / 驳回”。附件、填写项和补充意见按需展开。审阅也可驳回，
驳回只填原因并真实退回最近的上游人工办理环节，高级设置可明确指定目标。
退回保留原表单和可复用附件、历史尝试与产物版本；外部步骤逐节点确认后才会重放。
新报告模板使用这一交互契约；已有定义保留原有组合约束。

画布保留选择/移动、连线、框选、分割移动。空白拖动平移、鼠标滚轮以指针为中心缩放，
框选或 Shift 点选后可整体拖动。分割移动的左右/上下开关选择方向，拖动分隔线
同时调整两侧全部节点的间距，Esc 取消本次操作；原连接与保存的布局不会丢失。
“恢复100%”在右键菜单内，也支持 Shift+F10 打开菜单及 Esc 关闭并恢复焦点。
