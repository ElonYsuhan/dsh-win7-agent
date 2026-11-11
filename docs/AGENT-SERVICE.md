# Agent Service 与 Host Integration Protocol（建设中）

## HESYN 本机联调（开发用途，含写入）

`service/hesyn-development.js` 在回环地址启动独立 Service 和 HESYN 桥接，默认端口分别为 18090、18100；`HESYN_ORIGIN` 默认 `http://127.0.0.1:5180`。桥接通过既有 HostConnector 注册只读工具 `get_context`、`list_equipment`、`get_selected_entity`、`entity_list`、`hesyn_capabilities`，写入工具 `entity_create`、`entity_update`、`entity_delete`，以及通用能力入口 `hesyn_call`（`command`）。写工具在服务会话中强制人工审批；执行经 HESYN Capability Registry 落到其业务服务，桥接本身不复制业务校验或持久化。能力发现与执行走 SSE 下行 + `/tool-result` HTTP 上行，HESYN 侧通过内部 Host Adapter 模块调用正式协议，不使用页面全局对象作为接口。结果回传区分业务提交（`committed`、`entityId`、`entityRevision`、`receipt`）与渲染观察（`renderStatus`），写入以 Host 命令 ID 作为稳定 operationId 实现重试幂等。一次只允许一个活跃工作台；面板会话与该工作台绑定，关闭、过期或被其他工作台接管后，旧会话不能读取或操作新工作台。面板不接触 Host 或用户长期令牌。令牌每次启动随机生成、只存在进程内；Service 和 Host 各自使用 `HESYN_AGENT_HOME` 下独立目录。

Host 重新注册工具时，Service 会同步刷新该 Host 下所有已存在会话的工具表；下一条消息即可看到新工具，无需新建会话。若面板仍显示旧状态，刷新页面或重新打开面板即可。

面板审批卡提供「本会话全部允许」：批准当前请求并为该会话建立内存级全量授权，后续同一会话的工具调用不再逐个弹审批。授权在 Service 重启或会话结束后失效，审计记录 `approval.granted`。服务会话中的非只读工具仍受此审批闸口约束；该选项不改变工具白名单。

消息按宿主生成的 `requestId` 去重，回执不能替代业务操作状态查询。存在未确认操作时必须先人工核对，不自动重发。

2026-11-10 长会话请求修复：原 128 KiB 消息体限制会在超限时直接断连接，导致 `ERR_EMPTY_RESPONSE` / `Failed to fetch`。消息接口默认改为 64 MiB，`messageBodyMaxBytes` 可配置 128 KiB–256 MiB，实际值随会话快照返回；去掉独立的历史条数和文本字符数限制，不静默裁剪历史。其余接口仍保持 128 KiB；超限正常返回 JSON 413 与 CORS 响应头。已有事件缓冲字节预算同步为消息限额的两倍加 4 MiB，仍保留 500 事件的运行期边界。模型上下文窗口限制独立存在。

HESYN 编辑流程通过 Service 自有系统提示注入现有 Agent：先列实体/参数及动画/参数计划并等待明确确认；确认后依次完成实体部署与参数修改、动画编辑与参数修改及回读。保持现有工具审批，不新增 Agent Loop、业务 Store 或自动重放。该流程是模型行为策略，不是额外的事务执行器；系统提示范围和内容已有测试，真实授权模型完整遵循仍需验收。

项目隔离：本机桥接将会话与 `sceneId` 持久绑定到 Host 数据目录的 `session-scenes.json`（仅路由元数据，不含聊天）。取票支持 `projectId` 并与当前上下文核对，工具执行也再次核对会话项目；切换项目时中止旧项目待回传调用。无法确定归属的旧会话不自动迁入当前项目。`scripts/hesyn-bridge-smoke.js` 覆盖同一浏览器从 A 切至 B 后旧凭证读取被拒、跨项目续票被拒，以及返回 A 后正常使用。

2026-11-10 修复 Service 发送前误访问桌面知识库：`AgentPool.run` 对 `serviceBinding` 会话不调用桌面 `knowledge.sessionContext`，保持其显式工作区和 Host 权限边界；桌面会话仍按原逻辑查询知识库。故障注入让该方法固定抛出 `KNOWLEDGE_DB: attempt to write a readonly database`，Service smoke 在 Node 24/16 下均通过且断言访问次数为 0，面板浏览器测试也通过。预览沿用原数据目录重启，未删除数据库或改写其权限；真实授权模型回复仍未作为此次测试证据。

2026-11-10 修复异常终止事件：Host 上下文失败或 Agent 执行抛错时，`finished` 同样包含 `messages` 和 `memory`。Agent 已存在时在清理前保留其内存历史；尚未创建 Agent 时保留客户端历史及本次用户消息，并追加明确的失败说明。该事件只说明本轮执行停止，不声称业务写入已回滚或成功。服务回归和真实面板浏览器故障注入均通过（测试 Host、确定性模型，非授权模型验收）。

先执行 `node scripts/build-agent-panel.js`，指定一个**独立测试数据目录**并启动：

```powershell
$env:HESYN_AGENT_HOME = 'C:\agent-hesyn-test-data'
node service/hesyn-development.js
```

HESYN 侧以相同 Origin 启动开发服务器。端口被占用时，在启动服务前设置 `HESYN_SERVICE_PORT`、`HESYN_BRIDGE_PORT`，并分别在 HESYN 启动前设置 `VITE_AGENT_SERVICE_ORIGIN`、`HESYN_AGENT_BRIDGE_ORIGIN`。模型须在隔离 Service 中自行配置；此启动器不内置模型或密钥。

这是本机 Web 开发桥，不是生产部署或桌面交付：工作台状态（场景、装备、选中对象）变化时才推送新快照，不按固定周期轮询；读取上下文时刷新 `observedAt`。SSE 长连接断开时立即清空快照、解除会话绑定并让未回传的能力调用失败，后续读取直接失败，不会继续使用旧数据。场景切换与快照送达之间仍有延迟。装备只包含标识、名称、类别、显隐和版本，不传自定义属性。源校验与本机隔离不能阻止本机其他进程伪造请求；不得用于敏感数据或多用户生产环境。无离线事件补发，Service 重启后须重新取得票据。仅使用显式授权的测试数据。`node scripts/hesyn-bridge-smoke.js` 和 `scripts/hesyn-integration-fixture.js` 分别用于边界与浏览器联调；后者默认使用确定性模型，可显式使用已有模型配置在隔离测试项目中验证真实调用。

2026-11-09 验证：现代 Windows 的真实 HESYN 测试项目、Agent Service 与确定性模型替身完成两个只读工具调用和一次 `entity_create` 写入闭环（审批 → 创建 → 装备列表回读 → 结果回传），浏览器 E2E 分别 11.7 s 和 5.0 s 通过；桥接定向测试在 Electron 内嵌 Node 16.17.1 通过。真实授权模型驱动的写入联调、桌面联调、生产安全、Win7 实机和完整 `npm run check` 仍未验证。

本文描述首期目标契约，不代表功能已经实现或验收通过。Agent Service 属于本项目，复用现有 Cordis Runtime、AgentPool、agentLoop、Session Repository、ToolRegistry、权限和消息展示能力。HESYN 是独立的 Host 实现，不承载 Agent 会话状态或执行循环。

字段级现状、请求响应样例与待双方确认事项见 [Host Integration Protocol v1 开发草案](HOST-INTEGRATION-PROTOCOL.md)。独立 Service 的会话历史迁移至浏览器 IndexedDB；当前实现和未验证的恢复边界见该草案中的“客户端会话历史”章节。可嵌入宿主页面的聊天组件见 [AgentPanel](AGENT-PANEL.md)，本机开发入口为 `http://127.0.0.1:18090/panel/1.0.14/`。该地址仅用于显式启用的回环 HTTP 测试；远程部署需要 HTTPS。

## 协议边界

Host Integration Protocol v1 是 Service 与 Host 之间的业务协议，首期使用 Host 主动发起的 HTTPS、SSE 和 POST：Host 注册并保持 SSE 接收指令，使用 POST 回传上下文、工具执行结果和心跳；Host 不开放本地业务监听端口。Host 工具的上下文、输入和结果是不可信业务数据，不得提升为系统指令。MCP 是独立的标准工具接入协议，不能把此传输称为 MCP。WSS 不属于首期实现，后续另行评估。

## 首期接口目标

统一前缀为 `/api/v1`；具体字段以实现和自动化回归为准，部署前必须核验。所有接口必须先鉴权和检查资源归属，不允许将现有未隔离的 `/api` 管理接口暴露给远程用户。

- `POST /hosts/register`：Host 用独立凭证注册协议版本和工具定义。
- `GET /hosts/self/stream`：已认证 Host 接收 SSE 指令（`context.get`、`tools.call`）及工具开始、结果和结束事件；事件通知当前是在线尽力投递，不保证断线期间补发。
- `POST /hosts/self/results`：同一 Host 返回上下文、工具结果、状态或心跳。
- `POST /sessions`：使用 `{hostId, requestId}` 创建用户、Host、权限和工具集合绑定，返回 `{sessionId, sessionUrl, launchCredential, expiresAt}`；同一创建请求重复提交返回冲突，不重新发放已交付的一次性凭证。
- `POST /sessions/:id/launch`：兑换仅限该会话的浏览器授权。
- `POST /sessions/:id/tickets`：宿主后端以用户 Bearer 续发 60 秒一次性面板票据。
- `POST /sessions/:id/panel-token`：已登记面板 Origin 用一次性票据兑换 1 小时会话级面板令牌。
- `GET /panel/:version/agent-panel.js`、`/panel/:version/host-storage.js`、`/panel/:version/manifest.json`：固定版本嵌入组件、宿主存储参考实现与摘要清单。
- `GET|PUT /settings/models`：仅在配置 `allowPanelSettings: true` 时开放；读取/更新 Service 级模型列表、当前模型与最大轮次，密钥永不回显。写请求必须来自 Service 同源或 `panelOrigins`。关闭时返回 `403 SETTINGS_DISABLED`。
- `GET /sessions/:id`：返回经授权的会话身份、运行状态及事件代次，不返回聊天历史。
- `POST /sessions/:id/messages`、`POST /sessions/:id/cancel`：发送消息和取消当前执行。
- `GET /sessions/:id/events`：按游标读取该会话事件。
- `GET /sessions/:id/approvals`、`POST /sessions/:id/approvals/:approvalId`：查看和处理该会话的待审批请求。

Tools 的可见性和执行均须受同一会话策略限制；审批后重新检查授权。调用前记录持久事实，断线或重启后的不确定副作用不得自动重放。当前传输调用 ID 不是稳定业务 operationId，业务操作状态查询和安全重试尚未实现；标准测试 Connector 可以重连和补交保留的结果或摘要，但 Host SSE 没有离线补发，不能保证断线无损恢复。取消不能保证撤销已产生的外部副作用，不声称通用 exactly-once。任务、工作流和产物完整 API 不属于本次最小闭环。

## 开发态启动与配置

独立入口为 `service/index.js`，通过 `AGENT_SERVICE_CONFIG` 指定配置文件、`AGENT_HOME` 指定独立数据目录；不加载旧桌面 HTTP 管理路由。配置须由运维预置用户和 Host 的 SHA-256 凭证摘要、双向授权关系以及各 Host 的工具名和权限白名单，例如：

```json
{
  "publicOrigin": "http://127.0.0.1:18090",
  "host": "127.0.0.1",
  "port": 18090,
  "panelOrigins": ["http://127.0.0.1:5190"],
  "allowPanelSettings": true,
  "users": [{ "id": "user", "tokenHash": "用户令牌的64位十六进制SHA256", "hosts": ["host"] }],
  "hosts": [{ "id": "host", "tokenHash": "Host令牌的64位十六进制SHA256", "users": ["user"], "tools": { "lookup": "write" } }]
}
```

`panelOrigins` 是允许跨源加载 AgentPanel 并调用会话 API 的宿主 Origin；非回环地址必须为 HTTPS。未列出的 Origin 会被拒绝。

令牌必须是至少 32 位随机字符；示例中的文字不是有效摘要。远程连接必须使用 HTTPS 和配置 `tls.key`、`tls.cert` 文件；明文 HTTP 仅限服务端和客户端均显式配置的回环测试。模型配置复用现有 SettingsStore，不内置或猜测真实模型接口。Host 可调用 `src/main/host-connector/client.js` 暴露的 `HostConnector`，提供本地上下文和工具实现；该类不是 HESYN 实现。

开发验证入口：

```bash
node scripts/agent-service-smoke.js
```

```bash
node scripts/host-connector-smoke.js
```

```bash
node scripts/host-integration-smoke.js
```

```bash
node scripts/agent-panel-smoke.js
```

```bash
node scripts/build-agent-panel.js --check
```

```bash
node scripts/agent-panel-browser-smoke.js
```

这些检查使用确定性模型替身或测试 Host，不是 HESYN 或真实模型验收。组件浏览器检查需要 Electron 22 运行时，并会启动临时 Chromium 窗口。桌面和 Service 不得共享同一数据目录；首期不支持多进程共享和高可用。认证与权限不构成对同进程插件的沙箱。当前实现仍需完善连接恢复、审计覆盖和安全验证，不应作为生产服务暴露。

## 当前状态与验收门禁

已具备测试 Host 与真实 Cordis Agent 的最小开发链路及远程页面，但尚未完成生产安全和目标环境验证，不能用于生产部署。2026-11-09 在 Node 24 构建机执行 `npm run check:host-integration` 通过，覆盖测试 Host 注册、会话、上下文、Agent 工具调用、人工审批、结果和隔离；隔离浏览器使用测试 Host 与确定性模型替身完成发送、审批、结果展示和主题切换。桌面 renderer、web bridge、Agent、Cordis 和并发定向检查通过。

固定版本 AgentPanel 组件已在真实 Chromium 108 中验证跨源加载、挂载、流式回复、工具与审批、卸载/重挂载、页面刷新、Service 重启后的票据重新注入、销毁，以及宿主 IndexedDB 历史恢复；HTTPS 入口使用自签名证书在本机验证。它们仍使用测试 Host 与确定性模型替身，不代表真实 HESYN、授权模型或生产证书验收。

`npm run check` 在 Cordis vendor 摘要检查失败：工作树文件为 CRLF，其 SHA-256 与 LF 清单不同；只读核对 LF 规范化后的摘要与清单一致，未修改 vendor。内嵌 Node16 定向检查的默认探测未找到 Electron；显式指定上级工程目录中的 Electron 22 后，三项 Host/Service 定向 smoke 在 Node 16.17.1 通过；真实 HTTPS/TLS 部署、断线故障注入、恶意输入全面安全审计和真实 Win7 均未完成。确定性模型替身和示例 Host 仅用于协议开发及自动化测试。真实授权模型调用、真实 HESYN 上下文和工具执行与结果回传，以及 Win7 真机验证均待独立验收；任何模拟测试均不能替代。未要求打包、提交、推送或合并。
