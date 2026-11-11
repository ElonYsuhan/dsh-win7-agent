# Host Integration Protocol：v1 开发现状与协商草案

状态：2026-11-09，Agent Service 工程提出；**未获 HESYN 确认，不是双方正式协议，也不具备生产安全验收**。本文以当前工作树实现为依据，区分实际行为和待协商内容；不更改线上的字段或承诺不兼容升级。线上的版本字段是整数 `1`，与 HESYN 工程本地 `1.0.0` 常量没有已确认的兼容关系。正式版本、兼容和迁移规则须双方确认。MCP 是独立协议；本文传输不是 MCP，也不实现 WSS。

## 一、连接和身份：当前实现

Host 主动连接 Service，生产网络要求 HTTPS；开发 HTTP 仅限 Service 监听与 publicOrigin 都为回环、且标准测试 Connector 显式启用回环 HTTP。Service 当前直接加载 TLS key/cert，不提供已验证的反向代理 TLS 终止方案。Host 和用户分别使用管理员预配置的独立 `Authorization: Bearer <token>`；token 为 32–256 个字母、数字、`_` 或 `-`，配置保存 SHA-256 小写十六进制摘要，随机熵和凭证分发由运维负责。用户和 Host 双向白名单必须同时匹配。配置启动时加载，尚无在线吊销或轮换协议。不要在协作记录中放令牌。

本机开发的固定版本面板入口为 `http://127.0.0.1:18090/panel/1.0.8/`，组件文件位于该路径下；配置和部署条件见 [AGENT-SERVICE.md](AGENT-SERVICE.md)。配置 `publicOrigin` 是不带路径的 origin（本机示例为 `http://127.0.0.1:18090`），返回的 URL 不由请求 Host 头生成。Service 与桌面必须使用不同数据目录；当前单进程、单写者，不支持高可用。当前权限机制不构成同进程插件沙箱；未完成完整多租户安全审计。

## 二、Host 注册与下行流：当前实现

所有路径前缀为 `/api/v1`，示例中的令牌和标识仅为占位符。

### 注册

`POST /hosts/register`，Host Bearer，JSON：

```json
{"protocolVersion":1,"tools":[{"name":"lookup","description":"读取业务信息","permission":"read","parameters":{"type":"object","properties":{}}}]}
```

成功 `200 {"hostId":"host","protocolVersion":1}`。管理员预设 Host 工具白名单的名称与权限须逐项完全一致。工具最多 64 项；名称为 1–24 个字符，字母开头，仅字母、数字、`_`、`-`，禁止 `__`；权限为 `read`、`write` 或 `command`；parameters 顶层须是 object schema，其 JSON 字符串不超过 16000 字符；description 截取前 2000 字符。现有参数验证仅支持项目实现的 JSON Schema 子集，不能假定所有 JSON Schema 约束都执行。Service 将工具注册为 `host__<hostId>__<name>`，创建会话时固定工具集合及定义指纹。定义变更不得视为对已有会话自动授权。

### SSE

`GET /hosts/self/stream`，Host Bearer，注册后返回 `text/event-stream`；未注册为 `409 HOST_NOT_REGISTERED`。单个 Host 新连接替换旧连接；服务每 15 秒发送注释心跳。业务帧格式为 `data: <JSON>\n\n`，没有事件 ID、Last-Event-ID 或离线补发。

```json
{"protocolVersion":1,"method":"context.get","id":"00000000-0000-4000-8000-000000000001","sessionId":"00000000-0000-4000-8000-000000000002","userId":"user"}
```

Host 返回任意 JSON 上下文；当前没有项目、场景、选中实体的正式 schema，也没有快照一致性承诺。Service 每轮取上下文，将其作为带“不可信参考”说明的用户消息内容，而非直接设置为系统消息；**这并不能证明提示注入和记忆污染已得到防护**。

```json
{"protocolVersion":1,"method":"tools.call","id":"00000000-0000-4000-8000-000000000003","sessionId":"00000000-0000-4000-8000-000000000002","userId":"user","tool":"lookup","args":{},"deadline":1794204000000}
```

`id` 是本次传输调用 UUID，`deadline` 是 Unix 毫秒时间戳，默认从派发时起约 30 秒。标准测试 Connector 执行前检查 deadline，但不保证 deadline 到期后中断正在运行的业务操作。`id` 在测试 Connector 中作为 `idempotencyKey` 传给工具；**它不是稳定的业务 operationId**，Agent 再次规划会生成新的 id。目前没有基于业务 operationId 的状态查询接口或安全重试协议；结果 POST 和摘要补交不等于业务状态查询。

```json
{"protocolVersion":1,"method":"event","event":{"sessionId":"00000000-0000-4000-8000-000000000002","type":"tool:result","name":"host__host__lookup","outcome":""}}
```

仅转发 `tool:start`、`tool:result`、`finished` 的简化在线通知；没有操作 ID、正文、业务 revision、渲染状态或补发保证，`finished` 不能假定恰好一次。

### 结果和心跳

`POST /hosts/self/results`，Host Bearer：

```json
{"protocolVersion":1,"id":"00000000-0000-4000-8000-000000000001","status":"succeeded","result":{"example":"data"}}
```

`status` 为 `succeeded`、`failed`、`uncertain`。Service 根据认证 Host 和持久化 callId 接受当前或迟到结果，一致的重复终态可幂等确认，冲突拒绝。已完成结果的摘要补交示例为 `{"protocolVersion":1,"id":"00000000-0000-4000-8000-000000000001","status":"succeeded","resultHash":"<64位小写十六进制摘要>"}`；这无法重建丢失的结果正文，状态对账不自动恢复旧执行。失败和不确定状态目前不提供稳定的结构化业务错误；无效结果仍可能返回 `500 {"error":"SERVICE_ERROR"}`，不得据此盲目重试副作用。心跳请求为 `{"protocolVersion":1,"method":"heartbeat"}`，返回相同成功响应。

Service 所有 `tools.call` 均先记录调用，断线、取消、超时或重启时未知结果标记 uncertain，不自动重放；包括只读工具也采取此保守处理。标准测试 Connector 每次连接前重新注册，持久账本只保存调用状态和摘要；结果正文仅暂留内存供补交，重启后只能补交状态与摘要。旧 Host 账本若含完整结果会拒绝启动并要求显式迁移，不自动删除旧数据。Host SSE 通知没有离线补发。取消仅中断 Service 等待，不保证停止 Host 操作或撤销业务副作用。调用账本不是业务事务，不提供通用 exactly-once。

## 三、用户和会话：当前实现

- `POST /sessions` 使用用户 Bearer 和 `{"hostId":"host","requestId":"request_123"}`；Host 必须在线且双向授权。`requestId` 为 8–100 个字母、数字、`_`、`-`。成功 201：

```json
{"sessionId":"00000000-0000-4000-8000-000000000002","sessionUrl":"https://service.example/sessions/00000000-0000-4000-8000-000000000002","launchCredential":"单次短期凭证","expiresAt":1794204000000}
```

  `expiresAt` 为 Unix 毫秒，凭证当前 60 秒有效。同用户同 requestId、相同 Host 重试返回 409 `LAUNCH_CREDENTIAL_ALREADY_ISSUED`，异参为 409 `REQUEST_CONFLICT`；首个响应丢失后不能通过重试重新获取凭证。
- HESYN 可将凭证作为 `#launch=<credential>` 附到返回的 Session URL 并安全打开；URL 本身不包含凭证。页面先清除 fragment，再以同源 Origin 向 `POST /sessions/:id/launch` 提交 `{"credential":"..."}`。单次兑换返回 `{ "ok": true }` 和仅该会话 API 路径有效的 HttpOnly、SameSite=Strict cookie；HTTPS 时带 Secure，最长一小时。不要把凭证放 query、日志或共享文件。HESYN 的允许源校验和安全打开尚未联调验证。
- `POST /sessions/:id/launch` 的凭证兑换 browser cookie；`POST /sessions/:id/tickets` 由宿主后端以用户 Bearer 续发 60 秒一次性票据；`POST /sessions/:id/panel-token` 由已登记 `panelOrigins` 用票据兑换 1 小时会话级 Bearer 令牌。面板令牌只存 Service 内存，服务重启即失效，不能自行续发票据；跨源写请求必须来自登记 Origin。固定版本组件入口为 `http://127.0.0.1:18090/panel/1.0.8/`，包含 `agent-panel.js`、`host-storage.js` 与 SHA-256 摘要清单 `manifest.json`；宿主 Origin 必须在 `panelOrigins` 中。详见 [AGENT-PANEL.md](AGENT-PANEL.md)。
- 以下会话 API 使用用户 Bearer、面板令牌或该会话 cookie；cookie 的非 GET 请求校验 Origin。资源不属于用户时返回 404。
- `GET /sessions/:id` 返回 `{sessionId,userId,hostId,epoch,running,execution,messageBodyMaxBytes}`，不返回服务端持久化历史。
- `POST /sessions/:id/messages` 接收 `{"text":"...","requestId":"message_123","history":[],"memory":null}`，文本非空，history 为浏览器历史，拒绝 system 角色；不另设文本字符数和历史条数上限，按 JSON UTF-8 总字节数统一保护。默认消息体上限 64 MiB，Service 配置 `messageBodyMaxBytes` 可在 128 KiB–256 MiB 内调整，快照返回实际值供面板预检。此上限不等于模型上下文窗口，不静默裁剪浏览器历史。浏览器提交的 memory 当前不用于模型上下文。新请求返回 202 `{requestId,status:"running"}`；同会话同 requestId 同文本与历史返回 200 及原状态，异参 409 `REQUEST_CONFLICT`；会话忙时 409 `SESSION_BUSY`。
- `POST /sessions/:id/cancel` 返回 200 `{ok:true}`，仅表示已请求取消，不能表示业务副作用已撤销。
- `GET /sessions/:id/events?after=0&epoch=<epoch>` 返回 `{events:[{sequence,event}],cursor,epoch,gap}`，最多 500 条；这是 JSON 轮询，不是 Host SSE。事件仅存有界进程内存，代次变化或超出保留窗口时 `gap:true`。`POST /sessions/:id/events/ack` 接收 `{epoch,cursor}`，浏览器只在 IndexedDB 事务完成后确认；当前确认不主动清理缓冲。
- `GET /sessions/:id/approvals` 返回 `{approvals:[{id,request,expiresAt}]}`；`POST /sessions/:id/approvals/:approvalId` 接收 `{"approved":true}`。审批当前保存在内存，5 分钟到期；write/command 工具需人工审批，审批后再次检查工具策略。

一般错误响应为 `{"error":"CODE"}`，常见状态包含 400（输入无效）、401（认证失败）、403（授权或 Origin 拒绝）、404（资源不存在/不可见）、409（冲突或 Host 离线）、500（内部错误）。当前未建立完整稳定错误表，尤其 Host 结果处理的普通异常会归一为 `SERVICE_ERROR`。消息请求默认上限 64 MiB，其余 JSON 接口仍为 131072 字节；超限会返回带正常 CORS 响应头的 `413 {"error":"BODY_TOO_LARGE"}`，不再直接销毁请求连接。

## 四、客户端会话历史（开发中）

远程 Session 页面使用稳定 Origin 下的 IndexedDB，按 Service 确认的用户、Host、会话分区保存消息、工具事件、审批、发送回执和游标；持久化事务完成后才确认游标。Service 模式通过 Cordis 注入内存型 sessions，不再将新聊天快照或页面事件写入 Service 磁盘；Service 仍保存身份绑定、授权、调用状态、摘要和必要审计。桌面原会话存储不变。旧 Service 磁盘历史不会自动删除、迁移或通过新 API 暴露；部署者需单独处理。浏览器清理数据、换 Origin、换设备或未完成的浏览器事务均可能丢失历史。

运行事件在内存中每会话最多 500 条或 4 MiB；浏览器提交前 Service 崩溃、内存溢出或页面关闭期间的结果不能保证恢复。服务重启后，若本地没有待确认请求且没有已知缺口，可保留已存历史并进入新代次；否则阻断并要求核对，不能自动重放未知外部操作。已保存压缩记忆暂不回传模型：旧压缩机制会将其放入系统提示，安全适配尚未完成。测试宿主和确定性模型替身曾覆盖真实 Chromium 中的 IndexedDB、页面刷新及 Service 重启后重新注入票据；这不证明关闭页面期间无损恢复，也不代表真实 HESYN 验收。当前恢复协议为本工程开发中变更，尚未与 HESYN 确认兼容。

## 五、待双方协商，当前并未实现或验收

1. 版本兼容：版本协商、能力发现与扩展字段策略、非兼容升级、弃用窗口，以及 HESYN 本地版本与线上整数版本的对应关系。
2. 业务上下文：projectId、sceneId、sceneEpoch、选中实体、权限及快照时效；场景切换或审批期间 revision 变化时的拒绝/刷新规则。
3. 业务写入：稳定业务 operationId、不同于传输 id 的生命周期、持久 revision/CAS、原子操作收据、相同 operationId 异参冲突、查询与安全重试；写操作必须经过 HESYN 原有业务服务。
4. 明确结构化业务错误、可重试条件、调用取消及截止时间、结果大小和敏感信息处理；不能将 transport `succeeded` 自动等同业务提交成功。
5. 业务提交与渲染观测分别建模；确定如何关联 operationId、场景/revision、渲染 pending/completed/failed、截图及证据，不能用一般帧回调证明操作级渲染完成。
6. SSE 断线、命令/通知恢复、去重、游标有效期、结果丢失对账与 uncertain 的人工或业务查询处理；禁止自动重放结果未知的副作用。
7. 凭证发放/撤销/轮换、用户映射、Host 安全身份、真实 HTTPS、Session URL 安全打开和过期重启体验。

## 六、已知验证边界与优先阻塞

Node 16.17.1 下定向测试覆盖测试 Host、真实 Cordis/AgentPool、worker 淘汰重新绑定、Service 重启后 Host 重连及历史由调用方重传；不是真实 HESYN、真实授权模型或真实业务验收。Service 模式禁用共享长期记忆插件，历史和 Host 上下文仍属不可信输入；客户端提交的压缩记忆不进入系统提示。测试宿主的 Chromium 检查覆盖了 IndexedDB、页面刷新和 Service 重启后的有限恢复；关闭页面期间无损恢复、Host SSE 断线补发与业务状态查询并未实现或验收，全面多用户安全、生产 TLS 和 Win7 真机仍未验收。该草案不能作为生产部署许可。
