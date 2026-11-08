# 生成式界面协议与开发进度

## 范围与当前状态

这是受 A2UI 思想启发的**项目内部声明式协议**，不是完整 A2UI 标准实现。P0–P4 源码已接通有界 Surface/Component/State/Action 协议、混合消息、版本化会话事实、Vue/Naive UI/ECharts 渲染、交互参数持久化、统一确认、Agent 回传、流式修订、取消与恢复。普通应用现在按客户端实际渲染能力协商：资源加载成功后声明支持的版本和组件，模型只收到对应工具与规范；没有渲染能力时保持纯文本，不暴露 `render_ui` / `update_ui`。工具返回的 `rendered: false` 只表示服务器不能证明客户端已显示，不等于显示回执。

协议 v1 保留 column/row/form/input/checkbox/text/slider/chart/button；v2 增加 filter/table/progress/flow/map/visual。`visual` 是受限的静态页面：模型提供 HTML/SVG/CSS，聊天在无脚本、无表单、无网络、无外链的沙箱 iframe 中直接显示，而不是打开内部浏览器截图。旧 v1 消息继续读取和执行；未知未来版本仍作为不透明数据保留，不执行、不绕回。地图使用固定 `cesium@1.104.0` 离线椭球与点标记，不含影像、地形、Ion、token 或在线资源；图形不可用时明确降级为经纬度示意图。真实 Win7、Android WebView、操作系统输入法和屏幕阅读器尚未验收。

项目默认禁止新增生产依赖。经用户具名授权，构建机安装了固定版本 `vue@3.5.22`、`naive-ui@2.39.0`、`echarts@5.5.1`、`vite@5.4.21`、`@vitejs/plugin-vue@5.2.4`、`typescript@5.9.3` 和 `cesium@1.104.0`，均登记为开发依赖并禁用安装脚本；`cesium` 传递使用固定 `@cesium/engine@2.2.0`。Vue、Naive UI、ECharts 和 Cesium 的实际浏览器运行代码随应用离线分发，保留第三方许可，不能因开发依赖分类忽略其体积和兼容性。

安装期间 npm 曾把根 `@types/node` 从 `16.18.126` 改为 `26.6.6`；用户已明确授权恢复，现锁定回 `16.18.126`，不再构成阻塞。Vite 5 要求较新的构建机 Node，但只用于构建期；目标运行路径仍固定 Electron 22.3.27 / Node 16.17.1 / Chromium 108。当前滑块使用 Chromium 原生 range，Naive UI 用于其他组件；缺少可核实完整许可文本的 `vdirs@0.1.8` 没有进入实际浏览器产物。资源构建通过实际所含第三方代码的许可检查；若重新引入未核实许可的代码，构建仍会失败。构建机测试不等于 Win7 真机验收。
## v1 数据

assistant 消息 `content` 可以同时包含普通 text 块和 `{ "type": "ui", "toolCallId": "…", "surface": { … } }` 块。其他旧消息形态不变。一个 surface 的 v1 示例：

```json
{
  "version": 1,
  "id": "sales",
  "revision": 1,
  "title": "季度收入",
  "root": "layout",
  "state": { "factor": 1 },
  "components": [
    { "id": "layout", "type": "column", "children": ["chart", "scale", "send"] },
    { "id": "chart", "type": "chart", "chartType": "line", "title": "收入", "labels": ["第一季", "第二季"], "series": [{ "id": "revenue", "name": "收入", "values": [2, 4] }], "multiplierKey": "factor" },
    { "id": "scale", "type": "slider", "label": "倍数", "stateKey": "factor", "min": 0, "max": 5, "step": 0.5 },
    { "id": "send", "type": "button", "label": "分析", "actionId": "analyze" }
  ],
  "actions": [{ "id": "analyze", "type": "ask_agent", "message": "分析当前数据", "stateKeys": ["factor"] }]
}
```

- surface 的所有顶层字段必填；每个组件、action 和序列只允许其明确定义的字段。标识符以 ASCII 字母开头，后续由 ASCII 字母、数字、下划线、连字符构成，不超过 64 个字符；拒绝原型相关保留键。
- `column` / `row` 有 `children`；`form` 是有名称和子组件的分组，不具备原生提交或网络 action；`input` 是带 `label`、`stateKey`、`maxLength` 的单行文本输入；`maxLength` 为 1–2000 的整数，按 UTF-16 代码单元计长，允许空值但不允许换行；`checkbox` 绑定布尔 state。`text` 有纯文本 `text`；`slider` 引用数字 state，定义 `label`、`min`、`max`、`step`；`button` 引用 action；`chart` 仅支持 `line` / `bar`，每个 series 的 `values` 与 labels 等长，可用 `multiplierKey` 引用数字 state。没有可执行表达式、任意 HTML 属性或原始图表配置。
- action 仅支持 `ask_agent`，引用存在的 state 键。P2 经应用确认后把服务端已保存的选定参数提交给当前 Cordis Agent；不支持直接指定或调用业务工具。后续模型提出的业务工具仍经原 ToolRegistry、权限与审批链，Schema 本身不是授权。
- 单个 surface 最多 48,000 个 JSON 字符、64 个组件、32 个状态键、16 个 action；组件树最多 8 层，图表最多 8 个序列和 120 个标签；滑块最多 10,000 个步长。数字必须有限且绝对值不大于 10¹²。完整约束以 `contracts/generative-ui.js` 为准。
- 字符串都是不可信的普通文本。未来渲染器必须使用安全的文本节点/转义，不能使用 `eval`、模型提供的脚本、HTML、URL、函数或任意图表 option。校验不替代渲染器的安全设计。

下例是基础表单的完整 surface；未连接可信交互宿主时按钮禁用；连接 P2 宿主后必须先恢复服务端定义和已保存参数：

```json
{
  "version": 1,
  "id": "query",
  "revision": 1,
  "title": "查询条件",
  "root": "form",
  "state": { "keyword": "", "includeArchived": false },
  "components": [
    { "id": "form", "type": "form", "label": "筛选参数", "children": ["keyword", "archived", "send"] },
    { "id": "keyword", "type": "input", "label": "关键词", "stateKey": "keyword", "maxLength": 100 },
    { "id": "archived", "type": "checkbox", "label": "包含归档", "stateKey": "includeArchived" },
    { "id": "send", "type": "button", "label": "查询", "actionId": "ask" }
  ],
  "actions": [{ "id": "ask", "type": "ask_agent", "message": "按条件查询", "stateKeys": ["keyword", "includeArchived"] }]
}
```

基础表单是尚未发布的 v1 能力扩展：旧源码能够读取旧内容，但不认识新组件的旧客户端会拒绝新 surface；不要将它当作跨版本前向兼容，正式开放前须定义版本/能力协商并验证升级与回退。

## 生成、更新与持久化

实验配置下，`render_ui` 接受 `{operation: "create" | "update", expectedRevision, surface}`；`update_ui` 接受 `{expectedRevision, surface}`，始终表示更新。创建使用 `expectedRevision: 0`、`surface.revision: 1`；更新提交完整替换内容，要求 `surface.revision === expectedRevision + 1` 且与当前会话该 surface 的最新修订一致。单会话最多创建 128 个不同的 surface；一个 surface 的最大修订号为 10,000。每次调用最多发布一次。

工具仍通过 `ToolRegistry`、许可检查、现有权限策略及 Cordis 生命周期。插件本身不持有会话状态。reducer 验证当前活跃工具调用及修订，将新 UI 块不可变地附加到对应 assistant 消息；`Agent.record` 先持久化版本化 `ui.surface.published` 事件，再发送非权威通知。不同会话即使使用同一 surface ID 也互不共享状态。后续渲染器应按**会话内** surface ID 和最高已验证修订解析更新，不得把过期通知当成新事实。P0 的模型 state 是发布时数据，不是用户交互状态。

快照和日志重放恢复已提交的 UI 块，不自动重跑未确定结果的工具调用。原有 v1/v2 会话快照可继续读取。未知未来 surface 版本在有大小和嵌套限制的前提下作为不透明块保存，不被解释或渲染；针对同一 ID 的旧版本更新被拒绝。未知未来**事件**或不受支持的快照版本没有向前兼容保证。发往 OpenAI 兼容及 Ollama 的消息会把 UI 块转换成简短的纯文本摘要，不会发送自定义 `ui` 内容类型；原始历史不因此被修改。

## P1 聊天适配与资源暂存

`ui/generative-ui/src/` 包含 TypeScript 视图数据、安全注册表、混合消息投影和 Vue 单文件组件。桌面构建在构建机将其编译为离线浏览器资源，不复制原始 TypeScript 或 Vue 源码；第三方库及许可与自研代码分开暂存，自研浏览器代码进入 `agent-source-v1`。资源清单的摘要明确属于保护前，并记录实际纳入模块的输入摘要及锁文件中的包完整性；保护报告绑定该清单并另记变换后摘要。暂存及合成签名回归通过；完整安装包仍由独立的构建、载荷验证和发布流程处理。当前资源清单包含 22 个实际运行库。类型辅助不能替代运行时校验；代码复用 P0 唯一 Schema。

- 视图状态绑定具体会话和 surface，记录发布时的 revision；替换时拒绝其他会话或其他 surface，忽略重复/过期修订。有效的新修订使用新发布的默认 state，不假装恢复用户先前操作；P2 只恢复同一修订的已记录交互；完整的新修订显式采用新默认值，不跨修订猜测合并。
- 滑块、单行文本和勾选框仅修改自己绑定的键，复用 P0 约束校验原始 surface 和本地 state；多个控件共享一个状态键时必须同时满足各自的范围、步长或长度。文本控件等待组字提交后再同步，其 Enter 不提交外层聊天表单；当前只做过 DOM 组字事件模拟，未验收操作系统输入法。原始 surface 与本地 state 分别受大小限制，避免已接近 48,000 字符上限的界面仅因数值位数变化而无法操作；这不放宽发布 surface 的大小上限。无可信宿主时状态仅在视图内存中，不是会话事实或授权凭据；接入 P2 后参数通过下面的交互协议持久化，同一修订的任务结束重画、切会话和页面重载会恢复已记录参数。
- 图表数据派生出序列、标签和表格行，支持 line/bar 与数值倍乘；可信代码生成限定配置，不接受模型提供的 ECharts option、事件处理器、脚本或 HTML。图表草稿使用 Canvas richText 提示、非颜色标记和数据表；深浅配色在应用表面色上通过分类调色板检查，但部分颜色对比度低于 3:1，必须结合表格及标记，真实 UI 可访问性尚未验收。纯显示树默认禁用按钮；P2 仅在可信宿主成功绑定服务端定义、保存参数且会话空闲后开放确认回传。所有文本仍是不可信数据，实际渲染必须采用框架转义及安全 tooltip。
- 注册表仅由可信宿主代码组装，允许在封存前按白名单注册/替换组件，挂载后不能再改；每次挂载可使用独立注册表，不从模型数据加载组件、路径或脚本。引入新组件类型仍须先扩展协议和校验器，渲染器必须遵守转义、离线和权限边界，注册本身不授予动作权限。混合消息投影从会话事实重新计算，按会话和 surface 筛除旧修订；已知 ID 的未知未来版本或无效新块会阻断旧界面回退。未知块缺少可关联 ID 时只能单独标记不可用。
- 聊天适配从整段权威会话消息投影当前最高修订，保留已有 Markdown 与 UI 块顺序；历史分页可在离屏 fragment 中挂载，取消回填、清屏或切会话时释放实例。实时通知必须带准确会话 ID，只作为有界临时预览；结束时以服务端权威消息重新对账，超过临时通知上限时隐藏可能过期的 UI，等待最终结果。新一轮追加消息不会清掉其他 surface 的本地视图。混合 UI 消息暂不提供原有消息操作按钮，避免按纯文本错误定位或删除消息。
- 资源按需从固定本地路径加载，不取模型提供的 URL；加载失败时保留正文并显示中文不可用提示。图表生命周期控制器等待节点连接且具有尺寸后初始化，在销毁时取消帧和释放实例。隔离 Electron 中已覆盖真实 Vue/ECharts、分页、合成流通知及主题；完整受保护安装包、可访问性和目标平台仍须验收。

### 可信宿主挂载示例

资源由宿主从固定本地路径加载；下面的 `TrustedTextRenderer` 代表已经随应用构建的可信 Vue 组件，绝不能来自模型或远程脚本。可省略第三个参数使用默认注册表；`update` 和 `dispose` 都由宿主负责调用。

```js
const builder = window.AgentGenerativeUI.createRendererRegistryBuilder()
builder.replace('text', TrustedTextRenderer)
const registry = builder.build() // 封存；此后 builder 不能再修改
const view = window.AgentGenerativeUI.mountSurface(hostElement, {
  sessionId, surface, theme: 'light'
}, registry)
view.update({ sessionId, surface: nextSurface, theme: 'dark' })
view.dispose()
```

`mountMessage` 同样可接收第三个注册表参数，消息必须来自同一会话的 `projectMessages()` 投影。替换实现应继续显示组件数据、遵守绑定与可访问性规则，不得自行派发绕过权限链的动作；重放不能自动执行未确定副作用。

## P2 交互事实与执行边界（2026-11-08）

`contracts/generative-ui-interaction.js` 定义独立 v1 交互请求与快照；`flow/generative-ui-policy.js` 只生成带数据边界说明的用户请求；纯 session reducer 拥有状态和操作回执迁移。原生 `core/generative-ui` 提供 `generativeUi` 服务，注入 sessions、licensing、agentLoop 等原服务，负责加载仓库、记录事实和调用现有 AgentPool；共享插件不保存会话状态。HTTP 和开发 IPC 只是同一服务的适配器，没有第二个 Agent/工具执行器。平台实现只使用 Node16/Chromium108 内置能力，未来可替换传输/渲染而保留协议和事实。

### 参数与版本

- 已发布消息中的 `surface.state` 是该修订的默认值；同一会话快照中的 `ui.surfaces` 是从发布/交互事实归约出的当前定义、参数和 `stateVersion`。客户端消息不能重定义此记录；传入的历史若与当前定义不同，只能预览，不能据此发起动作。
- `ui.state.changed` 每次只允许已存在的 slider/input/checkbox/filter/table/flow/map 修改自己的绑定键，重验全部共享约束；table/flow/map 使用组件的 `selectionKey`，空字符串表示未选择。没有选择绑定的表格只读。请求必须精确包含 `version, sessionId, surfaceId, revision, expectedStateVersion, requestId, componentId, value`；会话为 1–48 位 ASCII 字母/数字/下划线/连字符，不使用缺省会话回退，原型保留名被拒绝；请求 ID 为 1–96 位字母/数字/下划线/连字符。
- 例如：`{version:1,sessionId:"session_abc",surfaceId:"sales",revision:1,expectedStateVersion:0,requestId:"edit_1",componentId:"scale",value:1.5}`。相同最后一次编辑可确认重试；旧游标或修订拒绝，不把网络失败当成功。每修订最多 1,000,000 次状态迁移。
- UI 立即更新；控制器串行提交，只合并尚未发送的连续同控件调整。状态冲突会重新读取并提示核对，不自动覆盖另一窗口。保存失败禁止动作；“重新读取”会先等待在途保存，再重新读取记录，并丢弃未保存的本地调整。已经排队的纯参数编辑可在卸载时排空；卸载不会提交新的 Agent 动作。
- `generativeUiRead({version:1,sessionId,surfaceId})` 返回当前状态、回执和该 surface 的权威定义。渲染器必须验证定义与所显示的 surface 完全相同，才能启用交互回传；没有定义的导入/合成历史仍为本地预览。没有 `surfaceId` 的读取只返回会话状态，不重复传输全部组件定义。

### 操作回执与权限

- `ui.action.accepted` 请求使用同一身份和游标字段，把 `value` 换为 `actionId`。后端从自己的组件/动作定义和已保存参数中提取 `message`、`stateKeys`；客户端不能提供 prompt、工具名、任意参数集或扩大权限。
- 用户点击后使用 `window.appDialogs.confirm`，默认焦点在取消；取消不调用模型，重复点击不再排队确认。接受事实先写日志，再经原 AgentPool 和选中的 Cordis agentLoop 执行；参数作为用户消息中的有界 JSON，而不是系统指令。业务工具只能由这条现有路径执行，原许可、禁用策略、权限、人工审批、预算和 AbortSignal 继续有效。
- 回执由 `accepted → running → completed/cancelled/failed/blocked/exhausted/timed_out/interrupted` 迁移；`turn.started` 和已有终态事实关联操作 ID 与 turn ID，不维护另一套进度标志。UI 显示保存/提交/执行/异常状态，运行中不可重复提交；停止仍使用原会话停止入口。
- 同一会话保留最多 1,024 个操作回执，不淘汰回执来偷偷允许旧请求重放；达到上限拒绝新动作。重复操作请求只返回原回执，复用 ID 修改请求会被拒绝。accepted 但未启动、或运行中崩溃的操作恢复为 interrupted，绝不自动执行；若结果不确定，应先核对外部结果，再由用户明确发起新请求。这不是跨机器、断电或供应商副作用的 exactly-once 保证。

### 流式更新与恢复

- 流式通知只显示完整、已验证且已记录的 surface 修订，不解析半截 JSON，更不执行前端代码。`ui:interaction` 和 `finished.ui` 只是已记录状态的投影；过期、错会话、未知版本和结构错误失败关闭。
- 完成时重新对账保留同修订已保存参数；新的完整修订采用新发布默认值。原 v1/v2 服务端快照缺少 `ui` 时可从已有 UI 消息迁移默认参数，不能虚构旧用户交互；未知新事件/新快照版本仍无向前兼容保证。操作状态和参数都沿用现有快照＋日志仓库。
- `mountSurface` / `mountMessage` 可传入可信 `interactionHost`：提供 `read/change/dispatch` Promise 适配器、`confirm`、`requestId` 及可选 `onRun`。当前聊天将其分别连接到 dsh 的三个接口、统一确认框、浏览器 UUID 和原运行状态显示；不传时维持 P1 本地预览和禁用动作。
- 当前回归覆盖页面重载、会话切换、worker 释放后重读及进程内模拟崩溃日志恢复。全新设备迁移、离线导入的动作重新授权、真实 OS 输入法、Android WebView 以及安装包内端到端 Agent 交互仍未验收；事件流完全断开期间的新消息/新修订自动补齐仍沿用现有聊天恢复边界，不能声称任意 SSE 丢失均已续传。

`npm run check:generative-ui:interaction` 运行 P2 真实 Cordis/仓库回归和控制器回归，包含精确会话、乐观并发、失败提交不通知/不执行、重复请求、业务工具只读拒绝及人工审批、修订更新和不确定操作不重放；两者均纳入全量及内嵌 Node16 检查。`generative-ui-business-smoke.js` 另覆盖 v2 业务 Schema、真实 Cordis 发布、四类选择持久化、回传和未来版本恢复。

## P3 业务组件与离线地图（2026-11-08）

v2 业务组件仍遵守同一严格键、原型保留名、有界数值和引用校验：

- `filter`：`{id,type,label,stateKey,options:[{value,label}]}`，1–64 个唯一值，当前 state 必须是声明值之一。
- `table`：`{id,type,title,columns,rows,selectionKey?,filterKey?,filterColumn?}`，1–12 列、0–120 行，单元格仅限有界 primitive；筛选键与列必须成对出现，行选择写入声明的 state。
- `progress`：`{id,type,label,valueKey,max,status}`，值在 `[0,max]`，status 为 bounded enum。该进度由 Agent 提供，**不是系统任务实际执行状态或完成凭据**。
- `flow`：`{id,type,title,nodes,edges,selectionKey}`，1–32 节点、0–64 边，拒绝缺失端点、自环和重复边；一般环可显示。选择节点只保存选择，不启动系统流程。
- `map`：`{id,type,title,points,selectionKey}`，1–120 点，经度 `[-180,180]`、纬度 `[-90,90]`；不接受 URL、provider、token、高度或脚本字段。
- `visual`：`{id,type,title,html,height?}`，`html` 最长 30,000 字符，`height` 为 200–800。聊天用 `sandbox` iframe + 文档 CSP 渲染；脚本、表单、链接、外链资源、网络和同源访问均被阻止，保留静态 SVG/CSS。旧的 v2 客户端不会声明该能力，历史中的未知组件会失败关闭。

Vue 组件使用原生可访问控件并转义所有不可信文本，表格、流程和地图提供不依赖颜色的键盘可操作选择；窄屏只产生组件内部滚动，不让页面横向溢出。流程图复用现有自动布局和连线避障，无法路由的边保留在详情列表，不绘制穿节点的假线。地图组件独立懒加载约 1.6 MB 的 Cesium IIFE，普通图表/表单不加载；随包固定 28 份 IAU2006_XYS 数据（不是底图或地形）并校验摘要、编号范围和路径穿越。静态可视化先生成 Blob URL，再交给空 `sandbox` iframe；渲染前用 DOMParser 移除脚本、嵌套框架、表单、链接、事件属性和非 data: 资源，文档自身 CSP 再阻断网络。它不是任意前端代码执行环境，脚本动画不可用。

## P4 产品能力协商（2026-11-08）

`render_ui` / `update_ui` 在普通 profile 注册，但 `available(context)` 取决于当前轮 Agent 的 `rendererCapabilities`：没有声明、未来版本无交集、unattended 或插件被禁用时不向模型提供工具，直接猜调用返回 `DENIED` 且不产生 UI 事实。客户端在本地 UI 资源加载成功后，经既有 send/action 传输附带 `{versions,components}`；服务器只把它当渲染元数据，不写入请求事实、不参与动作幂等比较，也不构成工具授权。`Agent.rendererCapabilities` 仅在当前轮存在并在 finally 清空，不存放会话业务事实，也不进入共享插件 Map。

发布前再次执行 `UI.assertRenderable`，因此模型不能借工具描述猜出未声明组件；既有许可、权限、审批、禁用、取消、预算和选定的 Cordis `agentLoop` 仍是唯一执行路径。提示要求：用户要在聊天里“画/设计/展示”自定义视觉或页面时，应发布 `visual` 静态页面；不得用 `browser_launch` / `browser_act` / `browser_eval` 或截图代替聊天渲染，浏览器工具只用于验证真实网页或文件；验证窗口默认隐藏，只有用户明确要求时才显示。正常产品没有环境变量或设置绕过；只有测试fixture可通过既有 `enableGenerativeUiProtocolForTests` 在未提供能力时模拟完整渲染器。实际动作仍从权威定义和已保存参数提取 message/stateKeys，客户端不能提供 prompt、工具名或任意参数。

## 验证与后续阶段

`node scripts/generative-ui-smoke.js` 验证纯契约与恶意数据拒绝、不可变迁移、旧快照和未知版本、真实 Cordis 工具、会话并发隔离、修订冲突、先持久化后通知、权限拒绝、崩溃恢复，以及本地 HTTP 模拟的 OpenAI 兼容和 Ollama 请求。该测试纳入 `npm run check` 和 `npm run check:node16`。

`node scripts/generative-ui-view-smoke.js` 在临时目录编译并验证 P1/P3 视图数据、受限滑块及表单绑定、业务表格/筛选/进度/流程/地图选择、流程图几何、会话隔离、乱序修订、混合消息投影、显示树、图表配置与生命周期及可信注册表；也检查组件草稿的脚本语法、标签结构，并使用实际安装的库类型检查脚本（Vue 组件模块和宏仍用测试声明）。同时覆盖 P2 控制器的即时视图、串行保存/合并、并发冲突、响应丢失、重复点击、卸载排空和服务端定义绑定。该测试纳入 `npm run check` 和 `npm run check:node16`；它不编译 Vue 模板，真实浏览器行为由隔离 Electron 覆盖。

`npm run check:generative-ui:build` 在临时目录验证固定版本、资源清单、22 个实际渲染依赖的许可证、输入与产物摘要、Cesium 资产及无源码映射；构建期仅对固定版本和源文件摘要完全匹配的 lodash 全局对象回退做 CSP 安全转换，转换及摘要记入构建记录。`npm run check:generative-ui:browser` 在隔离的 Electron 22/Chromium 108 进程中使用真实 Vue/Naive UI/ECharts/Cesium 和经实际浏览器源码保护变换的自研代码，验证 CSP、原生滑块和表单键盘输入、模拟组字、可信渲染器注册、图表/表格联动、业务筛选/选择、真实离线地图片段、WebGL 丢失/不可用降级、窄屏触控、深浅主题与禁用按钮对比度、挂载与释放及历史修订隔离；不等于正式聊天或完整签名包验收。

`node scripts/generative-ui-chat-smoke.js` 纳入 `check` 与内嵌 Node 16 回归，检查适配器会话隔离、能力查询、不可变消息追加、主题、离屏取消和通知上限。`npm run check:generative-ui:stage` 在临时合成应用中验证资源暂存、第三方代码边界、临时签名和篡改拒绝；`npm run check:generative-ui:chat` 使用隔离服务和真实聊天渲染器，覆盖合成通知及真实普通 profile Cordis 工具 → Agent → 会话持久化 → 事件流 → 聊天链路，以及 v2 业务选择、真实离线地图、参数真实落盘、会话/页面恢复、统一确认与 Esc 取消、选定参数回传、`update_ui` 流式修订、现有停止入口和取消后的不重放，并使用保护变换后的浏览器资源验证历史分页、首条会话消息、表单、旧运行状态轮询下的实时路由、交互、主题、修订和释放。该聊天测试仍会观察到原有 LiteGraph 在启动时尝试 `Function()` 并被未放宽的 CSP 拦截；这不属于 Generative UI，测试也未验收工作流功能。

`generative-ui-product-smoke.js` 在**不带测试开关**的普通 PluginHost/AgentPool 上验证无能力、v1 子集、v2（含 `visual` 能力）、未来/畸形协商、逐轮/逐会话隔离、动作幂等、unattended/禁用拒绝和直接调用不可绕过。本次已对真实保护载荷运行加密源码下的 Node16 协议/业务/生产能力回归，并在编译后的 Mac 应用内验证受保护 v2 渲染和离线 Cesium；30 组交替启动测量的受保护包启动 P95 为 940ms（相对基线 0.994），首/重复模块切换为 0.987/0.981 倍，均通过既定阈值，详见 `release/validation/source-protection-perf.json`。安装包内端到端 Agent 对话、Win7 真机、Android WebView、操作系统输入法和屏幕阅读器仍需在对应环境验收。
