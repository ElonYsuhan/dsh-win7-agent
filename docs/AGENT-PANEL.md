# AgentPanel：可远程嵌入的 Agent 聊天组件

状态：`1.0.15`，2026-11-10。启动时存在未确认操作的面板保留在页面，供人工核对并使用恢复按钮；不会自动重新提交。此前的基础浏览器测试使用测试 Host 与模型替身，真实授权模型和 Win7 真机验收仍未完成。

## 1. 入口与版本

Service 以固定版本路径提供组件，本机开发入口为 `http://127.0.0.1:18090/panel/1.0.15/`：

```text
http://127.0.0.1:18090/panel/1.0.15/agent-panel.js
http://127.0.0.1:18090/panel/1.0.15/host-storage.js
http://127.0.0.1:18090/panel/1.0.15/manifest.json
```

- `agent-panel.js`：ESM 自定义元素，导出 `AgentPanel`、`AgentPanelElement`、`defineAgentPanel`、`version`。
- `host-storage.js`：参考宿主 Storage Adapter；由宿主导入并在宿主 Origin 打开 IndexedDB，组件不导入它。
- `manifest.json`：版本、入口、空依赖清单、运行时边界及每个文件的 SHA-256。

`manifest.json` 是版本与摘要的事实源；路径固定后内容不可原地变更，升级必须发布新版本目录。上述 HTTP 地址仅用于显式配置的回环测试；远程部署须改用实际 HTTPS Service origin。

## 2. 最小集成

宿主页面需要允许组件 Origin 的脚本与连接：

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'self';
               script-src 'self' http://127.0.0.1:18090;
               connect-src 'self' http://127.0.0.1:18090;
               style-src 'self' 'unsafe-inline';
               img-src 'self' data:">
<div id="agent"></div>
<script type="module">
  import AgentPanel from 'http://127.0.0.1:18090/panel/1.0.15/agent-panel.js'
  import { createHostStorage } from 'http://127.0.0.1:18090/panel/1.0.15/host-storage.js'

  const panel = await AgentPanel.mount(document.getElementById('agent'), {
    endpoint: 'http://127.0.0.1:18090',
    auth: { ticket: async () => hostBackend.issueTicket() },
    storage: createHostStorage({ databaseName: 'hesyn-agent-sessions' })
  })
</script>
```

参考宿主代码见 `examples/agent-panel/`；它依赖宿主自行实现 `/agent-session-ticket` 后端，不是独立可运行的 HESYN 集成。宿主后端负责创建会话、换取短期票据；浏览器不保存用户长期 Bearer。

## 3. 生命周期

| API | 行为 |
| --- | --- |
| `AgentPanel.mount(container, options)` | 创建元素、挂载并连接；失败时移除元素并抛出错误。 |
| `AgentPanel.unmount(element)` | 停止轮询与请求、调用 Host Connector `detach`、移除元素；宿主存储保留。 |
| `element.connect(options)` | 连接或按新配置重连；成功后解析为元素。 |
| `element.disconnect()` | 停止传输、清除内存令牌；不删除宿主历史。 |
| `element.destroy()` | 断开、解绑监听、移除元素；之后 `connect` 被拒绝。 |
| `element.setTheme(theme)` | 内置主题 `auto`/`light`/`dark`，或自定义主题 `{ mode, variables }`；切换时自动清除上一次的自定义变量。 |
| `element.setTitle(text)` | 更新面板的可访问名称（`aria-label`）；面板本身不渲染标题行，会话标题由宿主展示。 |

元素从 DOM 移除时自动暂停（`suspend`），重新插入时自动恢复（`resume`），无需调用 `disconnect`。`running`、`connected`、`blocked`、`version`、`sessionId` 为只读状态属性。

## 4. 宿主注入接口

`connect(options)` / `mount` 的选项：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `endpoint` | 是 | Agent Service 纯 origin，如 `http://127.0.0.1:18090`。 |
| `sessionId` | 条件 | 已知会话标识；使用 `auth.ticket` 时可省略。 |
| `auth.ticket` | 二选一 | `async ({ sessionId }) => ({ sessionId, credential })`；组件用一次性 `credential` 兑换短期面板令牌。组件内置“历史/新建”会把目标 `sessionId`（新建时为空字符串）传进来，宿主后端必须优先采用它并返回实际会话标识；省略该参数时组件无法切换或新建会话。 |
| `auth.token` | 二选一 | `string` 或 `async () => string`；宿主已兑换的会话级 Bearer。 |
| `auth.cookie` | 专用 | 仅同源独立会话页使用：`{ cookie: true, launch: () => credential }`。跨源宿主不得使用。 |
| `storage` | 是 | `{ open(identity) }`，返回 Storage Adapter。缺失时拒绝发送。 |
| `hostConnector` | 否 | `{ attach({ sessionId, emit }), detach() }`；宿主侧生命周期/通知适配器。 |
| `theme` | 否 | `auto`、`light`、`dark`，或自定义主题 `{ mode, variables }`（见下文“自定义主题”）。 |
| `title` | 否 | 面板可访问名称（最多 80 字符），默认 `Agent`；不渲染为标题行，宿主自行展示会话名称。 |
| `autoFocus` | 否 | 默认 `true`，连接成功后自动聚焦输入框；传 `false` 关闭。 |
| `onNewSession` | 否 | 点击左上角“新建会话”时调用；提供后由宿主接管（组件不再内置新建）。不提供时组件内置新建会话：清空当前视图并让 `auth.ticket` 以空 `sessionId` 创建新会话。 |
| `onHistory` | 否 | 点击左上角“历史会话”时调用；提供后由宿主接管历史界面。不提供时组件显示内置历史下拉（需 Storage Adapter 支持 `listSessions` 等可选方法）。 |
| `onEvent` | 否 | 接收 `ready`、`status`、`tool`、`approval-request`、`approval`、`model`、`finished`、`error`、`blocked`、`suspend`、`resume`、`history`、`new-session`、`session-change`、`session-rename`、`session-delete`、`disconnect`、`destroy`。 |

### 认证流程

1. 宿主后端以用户 Bearer 调用 `POST /api/v1/sessions`，取得 `sessionId` 与会话 URL。
2. 需要重新注入时调用 `POST /api/v1/sessions/:id/tickets`（用户 Bearer），取得 60 秒一次性 `credential`。
3. 浏览器把 `credential` 交给组件；组件从已登记的面板 Origin 调用 `POST /api/v1/sessions/:id/panel-token`。
4. Service 返回 1 小时、仅限该会话的面板令牌。令牌只保存在组件内存；页面刷新或 Service 重启后重新走第 2–3 步。
5. 不要把长期用户 Bearer、Host 令牌或固定密钥放进 URL、HTML 或宿主存储。

Service 配置 `panelOrigins` 必须列出宿主页面 Origin，例如：

```json
{
  "publicOrigin": "http://127.0.0.1:18090",
  "panelOrigins": ["https://hesyn.example"],
  "allowPanelSettings": true,
  "users": [{ "id": "user", "tokenHash": "…", "hosts": ["host"] }],
  "hosts": [{ "id": "host", "tokenHash": "…", "users": ["user"], "tools": {} }]
}
```

非回环地址的 `panelOrigins` 必须是 HTTPS；回环 HTTP 仅用于本机开发。面板令牌不落盘，服务重启即失效；跨源写请求必须来自登记的 Origin。HESYN 本机联调需同时放行其前端与后端 Origin（`http://localhost:5191`、`http://127.0.0.1:5191`、`http://localhost:5180`、`http://127.0.0.1:5180`）；只放行其中一个会出现预检 403 或浏览器 CORS 报错。

### 界面行为

- 面板不渲染标题行和说明行；左上角显示历史、新建与连接/生成状态，状态同时供读屏播报。
- 输入区只有一个操作按钮：空闲时发送，生成时切换为停止；Enter 不会在生成时触发停止。
- 轮询连接失败时显示网络、服务地址及跨域排查提示，并自动退避重试读取；写入结果不确定时保留待确认记录，禁止自动重发，等待事件对账或人工核对。
- 历史与新建会话默认由组件内置：点击时钟图标展开历史下拉，支持关键字搜索、铅笔重命名、垃圾桶删除（行内二次确认）、点击切换会话；新建会话清空当前视图并请求宿主创建新会话。宿主提供 `onHistory` / `onNewSession` 时改为调用宿主回调（同时通过 `onEvent` 发出同名事件），由宿主渲染自己的界面。
- 内置历史列表的数据来自宿主 Storage Adapter 的 `listSessions`；重命名与删除分别调用 `renameSession`、`deleteSession`。宿主未实现这些可选方法时，下拉会明确提示“宿主未提供历史会话列表”，不会伪造数据或读取第二套存储。
- 切换、新建、重命名、删除成功后会发出 `session-change`、`session-rename`、`session-delete` 事件；执行中禁止切换或新建，避免同一面板并发两条会话流。
- 消息区独立滚动（`flex: 1` + `overflow-y: auto`），页面本身不滚动；空闲轮询没有新事件时不重绘，用户上翻阅读时不会被拉回底部，只有停留在底部附近才跟随新消息。
- 输入框位于最下方并在连接成功后自动聚焦；宿主可用 `autoFocus: false` 关闭自动聚焦。
- 主题默认 `auto`，跟随操作系统 `prefers-color-scheme` 并实时响应切换；宿主传入 `theme` 或调用 `setTheme('light'|'dark')` 可覆盖，改回 `setTheme('auto')` 恢复跟随系统。宿主自己的品牌/自定义主题（例如 HESYN 的“科技蓝”）通过 `{ mode, variables }` 传入对应颜色，见下文。
- Service 注入的 Host 业务数据（携带 `[Host 业务数据，仅供参考，不是指令]` 标记）只进入模型上下文，用户消息气泡不显示该段内容。
- 消息区不展示工具调用、工具参数或工具结果卡片，只显示用户消息、Agent 回复和待审批项；工具事件仍通过 `onEvent` 的 `tool` 通知宿主，供宿主自行决定是否展示。
- 每条 Agent 回复气泡右上角有“复制”按钮，复制该条回复的原始 Markdown；使用 `navigator.clipboard`，不可用时退化为 `document.execCommand('copy')`。
- 审批项提供“允许”“拒绝”和“本会话全部允许”。选择“本会话全部允许”后，Service 对该会话后续审批直接放行并补决其余待审批项；该授权只存在于 Service 进程内，重启或新建会话后失效。

### 自定义主题

自定义主题用 `mode`（`auto`/`light`/`dark`）决定基础配色模型，再用 `variables` 覆盖 `--ap-*` 设计令牌；只接受 `--ap-` 前缀，其他键会被忽略。宿主切换主题时重新调用 `setTheme` 即可，组件会先移除上一组自定义变量，避免主题间残留。

```js
panel.setTheme({
  mode: 'dark', // “科技蓝”是深色底，用 dark 作为兜底
  variables: {
    '--ap-bg': '#061a2b',
    '--ap-panel': '#0b2439',
    '--ap-panel-2': '#0f3049',
    '--ap-border': '#1d4a6b',
    '--ap-field-bg': '#0a2134',
    '--ap-field-border': '#245a7f',
    '--ap-text': '#e6f4ff',
    '--ap-muted': '#8fb6d1',
    '--ap-focus': '#4fb3ff',
    '--ap-code-bg': '#03121e',
    '--ap-send-bg': '#2f8cff',
    '--ap-send-text': '#ffffff',
    '--ap-send-hover': '#57a4ff'
  }
})
// 切回内置暗色/浅色或跟随系统：
panel.setTheme('dark')
panel.setTheme('light')
panel.setTheme('auto')
```

上例颜色仅示意映射关系，HESYN 应替换为自己的主题色值。可用令牌：`--ap-bg`、`--ap-panel`、`--ap-panel-2`、`--ap-border`、`--ap-field-bg`、`--ap-field-border`、`--ap-text`、`--ap-muted`、`--ap-focus`、`--ap-error`、`--ap-error-text`、`--ap-send-bg`、`--ap-send-text`、`--ap-send-hover`、`--ap-code-bg`、`--ap-shadow`、`--ap-font`、`--ap-mono`。宿主也可以在 `agent-panel` 元素上直接设置这些 CSS 变量，效果等同，但仍建议通过 `setTheme` 统一管理切换。

### 模型配置

`allowPanelSettings: true` 时，组件提供与桌面端同结构的模型配置：输入框右下角显示当前模型，下拉可切换，菜单内「模型设置…」打开多模型表单（显示名称、API 地址、模型、API 密钥、最大轮次，可增删并指定当前模型）。配置属 **Service 级**，不是单个会话级；不开启该项时接口返回 `403 SETTINGS_DISABLED`，组件保留纯聊天展示。

| 接口 | 说明 |
| --- | --- |
| `GET /api/v1/settings/models` | 返回 `models`、`currentModelId`、`maxIterations`、`contextWindowTokens`；**不返回 API 密钥**，只给 `hasApiKey`。 |
| `PUT /api/v1/settings/models` | 接受 `models`、`currentModelId`、`maxIterations`；某模型 `apiKey` 省略时保留原值，留空表示不修改。 |

两个接口都要求用户 Bearer、面板令牌或会话 Cookie；写请求必须是 Service 同源或 `panelOrigins` 中的 Origin。密钥保存在 Service 的 `settings.json`，不进入浏览器存储、URL 或组件产物。宿主若不希望最终用户修改模型，应保持 `allowPanelSettings` 关闭，由运维配置模型。

## 5. Session Storage Adapter 契约

会话历史、消息、工具事件、审批和游标的唯一持久化真值是**宿主 Origin 的 IndexedDB**。组件不创建、不迁移、不导出任何浏览器数据库；Adapter 缺失或事务失败时组件停止发送。

`storage.open(identity)` 接收 `{ sessionId, userId, hostId, epoch }`，返回对象：

| 方法 | 契约 |
| --- | --- |
| `read()` | 返回当前状态。 |
| `reserve(text, requestId, expectedCursor)` | 单个读写事务内校验游标与代次，持久化待确认消息及请求 ID，返回 `pending`。 |
| `apply(expectedCursor, epoch, entries)` | 单事务内校验连续序号，应用事件；`finished` 必须含完整 `messages` 与 `memory`，并与待确认 `requestId` 匹配。 |
| `saveApprovals(approvals)` | 保存当前待审批列表。 |
| `approvalDecision(id, approved, status)` | 记录审批决定（`pending`/`confirmed`/`failed`）。 |
| `markGap()` | 标记不可恢复的事件缺口。 |
| `rebase(epoch, force?)` | 无 `gap` 时切换服务代次并清零游标。存在 `pending` 且未传 `force` 时拒绝；`force: true` 仅在用户人工核对后通过“我已核对，重新同步”调用，清除本地待确认标记；`gap` 仍阻断。 |
| `listSessions()` | 可选；返回同一 `userId` + `hostId` 下的 `[{ sessionId, name, preview, updatedAt }]`，供内置历史列表使用。不实现时组件不显示历史条目。 |
| `renameSession(sessionId, name)` | 可选；保存会话名称（最多 40 字符），供内置历史重命名使用。 |
| `deleteSession(sessionId)` | 可选；删除该会话的宿主存储条目；删除当前会话后组件会新建空会话。 |

状态形状：

```js
{ epoch: '', cursor: 0, messages: [], memory: null, pending: null, events: [], approvals: [], gap: false, name: '', updatedAt: 0 }
```

`name` 与 `updatedAt` 供历史列表排序和展示，不是消息事实；`updatedAt` 在预留消息和应用事件时更新。列表接口只读本用户与本 Host 的分区，不返回其他会话或其他宿主的条目。

所有写入必须在 IndexedDB 事务 `oncomplete` 后才算持久；Adapter 应按 `[userId, hostId, sessionId]` 分区，并由宿主负责多标签页的单写者约束。参考实现见 `host-storage.js`，宿主可替换，但必须保留上述语义。

## 6. 恢复与安全边界

- Service 仅保留运行期事件与运行元数据，不持久化聊天历史、Prompt 或完整工具上下文。
- 事件每会话最多 500 条，字节缓冲上限为 `2 * messageBodyMaxBytes + 4 MiB`；它仍是有限的运行期缓冲，不保证断线恢复。浏览器未在 Service 崩溃/重启前保存的事件无法重建；组件报告 `gap` 并停止发送，不猜测历史。
- Service 重启后须由宿主重新注入票据；若无未确认请求、无已知缺口且无运行中执行，组件切换新代次并保留已存历史。这不保证恢复未保存事件。存在 `pending` 或缺口时阻断，等待人工核对，**不自动重放结果不确定的外部操作**。
- 消息回执不能证明业务副作用的最终状态；不得根据回执自动重发未确认操作。
- Host 传输 ID 不是稳定业务 operationId，业务操作状态查询和 Host SSE 断线期间命令、通知的无损恢复尚未实现。测试 Connector 的重新注册与结果或摘要补交不等于业务对账或无损恢复。
- 客户端提交的压缩记忆当前不注入模型系统提示；续聊上下文由浏览器 `history` 重新提交。消息请求体默认上限 64 MiB，可通过 Service `messageBodyMaxBytes` 配置为 128 KiB 至 256 MiB；不再另设历史条数或单条文本字符上限。组件按会话快照中的实际字节上限在预留前检查 UTF-8 JSON；超限不会截断或删除历史。模型上下文窗口与此 HTTP 上限独立，仍可能更小。
- Host 上下文、工具输出和用户历史均为不可信业务数据，不提升为系统指令，也不授予工具权限。
- 组件没有工具执行能力；工具调用、审批后复检和取消语义仍由 Service 的 Cordis Agent、ToolRegistry 和 Host Integration Protocol 执行。
- 组件不使用 iframe，不读取 Electron/桌面能力，不引入第二套聊天系统或状态容器。

## 7. Host Connector 注入说明

`hostConnector` 是**宿主浏览器侧的生命周期与通知适配器**，用于宿主同步界面状态、场景提示或遥测。真正的 Host 上下文、工具执行与结果回传仍由 HESYN 后端通过 Host Integration Protocol（HTTPS + SSE + POST）完成；浏览器组件不接收、不转发 Host 令牌，也不能替代服务端 Connector。跨源嵌入首期不开放浏览器直接注册 Host。

## 8. 验证证据（2026-11-09）

- `node scripts/build-agent-panel.js --check`：产物与 SHA-256 清单一致。
- `node scripts/agent-panel-smoke.js`：跨源入口、CORS 预检（含 PUT）、票据单次使用、面板令牌、重启失效与续签、模型设置读写与密钥不回显、组件包不含 `indexedDB`/`iframe` 引用。
- `node scripts/agent-panel-browser-smoke.js`：真实 Chromium 108 中跨源加载、挂载、发送、流式回复、工具与审批、模型下拉与设置弹窗、空闲轮询不重绘消息区（上翻阅读位置保持）、卸载/重挂载、页面刷新、Service 重启后重新注入票据、销毁；宿主不接管时内置历史列表可搜索、重命名、删除并自动新建会话；历史来自宿主 IndexedDB；HTTPS 固定版本入口以自签名证书在本机验证。
- `npm run check:node16 -- agent-panel-smoke agent-service-smoke host-connector-smoke host-integration-smoke`：在 Electron 22.3.27 内嵌 Node 16.17.1 下通过，4 项共约 5.2 秒。
- 当前 `1.0.15` 的摘要以其 manifest 为准；版本化路径发布后不得原地改动。
- `1.0.12` 的“我已核对，重新同步”与 `rebase(epoch, force)` 由 `node scripts/agent-panel-smoke.js`（产物与清单）及 HESYN `tests/unit/scene-data.test.ts`（强制 rebase 清 `pending`、`gap` 仍阻断、按项目隔离会话标识）覆盖。
- `1.0.14` 的阻断状态挂载与人工恢复沿用；不使用 `1.0.13` 的自动重发方案。
- `1.0.15` 新增的浏览器回归覆盖生成状态、单按钮停止、401 续签、轮询失败恢复、UTF-8 大小预检和不确定写入禁止自动重发；本次执行因测试浏览器 `CDP_DISCONNECTED` 中断，尚未通过。以上 2026-11-09 浏览器结果为此前版本证据，不能作为本版通过证明。
- 使用测试 Host 与确定性模型替身，不是 HESYN 或授权模型验收；未在 Win7 真机验证，自签名证书不代表生产证书。

## 9. 已知限制

- 生产 HTTPS、证书信任、反向代理与 HESYN CSP 尚未联调。
- 面板令牌 1 小时有效，无在线吊销与轮换协议；依赖 Service 重启或票据重新签发。
- 多标签页写入由宿主 Adapter 决定，组件未实现租约/围栏。
- 审批请求本身保存在 Service 内存，Service 重启后不会恢复待审批授权。
- 组件只覆盖聊天、工具状态、审批、取消和运行状态，不包含桌面设置、终端、插件管理或全局文件浏览。
