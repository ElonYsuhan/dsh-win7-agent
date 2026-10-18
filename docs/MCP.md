# MCP 连接器（Model Context Protocol）

本项目在 Cordis 运行时上实现 MCP **客户端**，把外部 MCP 服务的工具发现并注册进现有
`ToolRegistry`。MCP 不是第二套 Agent 执行循环，也不能绕过权限、审批或状态迁移。

## 支持的传输

- `stdio`：由宿主启动本地 MCP 子进程，通过标准输入/输出交换按行分隔的 JSON-RPC 2.0。
- `http`：使用 Streamable HTTP `POST` 交换 JSON-RPC；兼容 `application/json` 与
  `text/event-stream` 响应，并保存 `mcp-session-id`。

当前只接入 MCP `tools` 能力（`initialize`、`tools/list`、`tools/call`）。
resources、prompts、sampling、roots 不属于本轮范围；未知服务器请求返回 JSON-RPC
`-32601`，不会被静默当作成功。

## 配置

配置保存在 `settings.json` 的 `mcpServers` 数组；桌面开发态和打包服务端共用同一套
纯契约 `src/main/contracts/mcp.js` 做规范化。

stdio 示例：

```json
{
  "mcpServers": [
    {
      "id": "local-tools",
      "name": "本地工具",
      "enabled": true,
      "transport": "stdio",
      "command": "node",
      "args": ["C:/agent/mcp/local-server.js"],
      "env": {},
      "cwd": "",
      "permission": "write",
      "timeoutMs": 30000
    }
  ]
}
```

HTTP 示例：

```json
{
  "mcpServers": [
    {
      "id": "intranet-tools",
      "name": "内网工具",
      "enabled": true,
      "transport": "http",
      "url": "http://10.0.0.20:3000/mcp",
      "headers": { "Authorization": "Bearer <token>" },
      "permission": "write",
      "timeoutMs": 30000
    }
  ]
}
```

`permission` 取 `read | write | edit | command`，默认 `write`。工具实际是否执行仍由
`ToolRegistry` 的权限模式、审批、禁用插件和无人值守白名单决定。模型看到的工具名是
`mcp__<server-id>__<tool-name>`，原始工具名只保存在宿主映射中。

## 分层

| 层 | 文件 | 职责 |
| --- | --- | --- |
| Contracts | `src/main/contracts/mcp.js` | 配置规范化、工具名映射、JSON Schema 子集、结果文本化 |
| Flow | `src/main/flow/mcp-policy.js` | 纯策略：服务是否暴露、工具过滤与命名 |
| IO adapters | `src/main/mcp/stdio-client.js`、`http-client.js` | 子进程、HTTP、SSE、超时与关闭 |
| Runtime | `src/main/mcp/manager.js`、`src/main/runtime/plugins/mcp.js` | 连接生命周期、工具注册/注销、Cordis 服务 |
| UI / transport | `src/renderer/app.js`、`server/mcp-api.js`、preload / web-bridge | 配置、测试、状态展示 |

`core/mcp` 是 profile 中的原生 Cordis 插件，`inject` `agentConfig/tools/prompts/contracts`。
连接和工具注册由 `ctx.effect()` 回收；设置变化时重新连接、注销旧工具并注册新工具。
工具执行走 `ToolRegistry.execute`，因此审批、取消和权限边界与内置工具完全一致。

## API

- `GET /api/mcp`：连接状态、工具清单（不执行工具）。
- `POST /api/mcp/test`：用一次性客户端连接并列出工具。
- `POST /api/mcp/reload`：重新读取 `mcpServers` 并重连。
- 开发态 Electron：`mcp:request` IPC，动作 `list | test | reload`。

## 安全与兼容边界

- MCP 服务是**用户显式配置的可信本地命令或内网地址**，不是沙箱。stdio 命令以当前用户
  权限运行；HTTP endpoint 可访问配置允许的网络。
- 不自动下载或安装 MCP 服务；Win7 目标机需要预装命令和依赖。
- 只使用 Node 16 内置 `child_process`、`http`、`https`、`readline`，无新增生产依赖。
- 无人值守任务目前只允许任务契约中的内置工具；MCP 工具不会自动进入任务白名单。
- 未在 Win7 真机验证。跨平台构建和本机 smoke 不等于目标机验证。

## 验证

```bash
npm run check:mcp
npm run check
```

`check:mcp` 启动真实假 MCP stdio 子进程与真实本地 HTTP 服务，验证初始化、工具发现、
工具调用、session header、关闭清理，以及通过 Cordis PluginHost 注册和执行
`mcp__echo__echo`；同时覆盖配置规范化和非法地址过滤。

## 内置文档 MCP（0.4.3 日常验收）

能力中心 → 连接器默认显示 **文档工具 / Document Tools**，无需填写命令、安装
Office/Python/Node 或下载依赖。可独立启停；内置服务不能编辑配置或删除。
`disabledBuiltinMcp: ["documents"]` 停用，默认空数组启用。`documents` 是保留的服务 ID，
同名外部配置由规范化逻辑加后缀，避免和内置工具冲突。

| MCP 工具 | 能力 |
| --- | --- |
| `mcp__documents__docx_read` | 分页读取正文/表格段落及索引、表格预览、源文件 SHA-256 |
| `mcp__documents__docx_create` | 新建段落、三级标题、文本表格 |
| `mcp__documents__docx_edit` | 按读取索引替换正文或表格单元格段落，校验源文件版本，另存副本 |
| `mcp__documents__xlsx_read` | 列出工作表、按 A1 范围读取值/公式/样式编号、源文件 SHA-256 |
| `mcp__documents__xlsx_create` | 多表、文本/数字/布尔、公式、加粗、数字/百分比/日期格式 |
| `mcp__documents__xlsx_edit` | 修改/新增单元格，保留已有样式编号，校验版本，另存副本 |

可以直接对 Agent 说：“创建项目周报 Word，包含进展和风险表格”，或“读取账目.xlsx，
将收入表 B3 改为 1200，另存为账目修订.xlsx”。返回的路径是工作区相对路径。
所有写入必须指定不存在的新输出文件；已有源文件和已有输出文件都不会被覆盖。
编辑需传入读取工具返回的 `revision`，源文件变化时拒绝旧版本编辑。

### 协议及架构

- 服务端为真正的标准 MCP stdio 服务：UTF-8、逐行 JSON-RPC 2.0、stdout 仅输出协议。
  支持 `2024-11-05` / `2025-06-18` 初始化协商；宿主现有客户端使用前者。
- 实现 `initialize` → `notifications/initialized`、`ping`、`tools/list`、`tools/call`，
  工具提供 JSON Schema 和只读/非破坏性 annotations。只声明 tools capability，
  不声称支持 resources/prompts/sampling/roots。固定六工具单页，无清单变更通知。
- 未知方法、未知工具、非法参数属于 JSON-RPC 错误；文件不存在、格式限制等执行失败
  返回 `CallToolResult.isError=true`，不会伪造成功。通知无响应，取消通知取消在途工作。
- 契约 `contracts/document-tools.js` 为纯数据；IO 位于 `mcp/documents/`。
  `core/mcp` 通过注入的 tools/prompts 服务装配，读取工具为 read、写入工具为 write；
  不依赖第三方 annotations 决定权限。仍走统一 ToolRegistry 和会话事实持久化。
- 仅在实际调用时用内嵌 Electron 的 Node 模式启动服务；每次调用固定独立工作区，
  经真实 initialize → tools/list → tools/call，校验发现的 Schema。没有共享会话 cwd。
  调用结束关闭进程；Cordis 卸载等待工具取消和资源释放。无新增生产依赖。
- 按宿主已选择的 workspaceRoot 限制文件访问，拒绝路径/符号链接逃逸；从磁盘读取大小
  有上限，ZIP 总展开最大 32 MiB、最多 2048 项，校验 CRC，拒绝加密/ZIP64/多卷。
  XML 不解析 DTD 或外部实体。输出同目录暂存，exclusive hard-link 发布，禁止覆盖；
  输出目录须已存在，文件系统不支持硬链接时明确失败，不退化成覆盖写。
- 支持第三方 MCP 客户端：用 Node 16+ 或随包 Electron（`ELECTRON_RUN_AS_NODE=1`）运行
  `src/main/mcp/documents/server.js --root <工作区绝对路径>`。根目录是启动配置，
  不能通过工具参数扩大。宿主权限/审批属于客户端职责；独立服务不提供 OS 沙箱。

### 明确的格式范围

支持基础 OOXML `.docx`、`.xlsx`，不支持 `.doc/.xls`、密码保护、PDF/PPT、宏执行、
Office 排版渲染、图片 OCR、公式计算。公式字符串与单元格文本分开，`=...` 文本
不会自动转成公式；写入公式后要求表格应用打开时重算，读取的缓存值可能陈旧。

Word 替换整个段落保留段落属性及首个 run 的格式，不保留段内多种字体分布；遇到域、
批注锚点、修订、书签、超链接、绘图等复杂段落会拒绝编辑。未修改的 ZIP 部件保留内容。
Excel 编辑保留原样式编号，新增格式目前仅新建工作簿支持；合并单元格交叉编辑、
共享/数组公式或计算链、含复杂单元格元数据的编辑均拒绝。签名或宏文档拒绝编辑。
这不是完整 Office 引擎；复杂生产模板应另存后用目标 Office/WPS 人工检查。

### 验证

`npm run check:documents` 覆盖协议错误语义、初始化、通知、真实 stdio、中文与表格、
Word/Excel 编辑、原件保护、版本冲突、ZIP/XML 校验、权限与工作区隔离、取消和停用。
`node scripts/document-mcp-e2e-smoke.js` 覆盖真实 Chromium 连接器启停、模型经主循环
生成 Word/Excel 文件、会话重开恢复。新增 smoke 已加入 check 和内嵌 Node 16 检查。
没有把本机测试、独立 ZIP/XML 校验当作 Win7 真机或 Office/WPS 渲染验收。

协议依据：[MCP 生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、
[MCP 工具](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)、
[MCP stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。

## 分组配置表单与环境引用

连接器卡片默认折叠工具明细；编辑器按“名称/类型”和传输配置分组，始终只显示当前
STDIO 或流式 HTTP 的字段。参数、环境变量和请求头使用逐行增删，参数中的空格原样保留，
不拼成 shell 命令。可选配置默认收起。原生单选 select 由共享 `select-control.js`
适配为页面统一 dropdown 外观；底层 select 值仍是唯一表单值，动态模型协议选择也复用。
支持方向键、Home/End、Enter、Escape、Tab；弹窗隔离背景并恢复焦点。

新增兼容字段（旧配置缺省时行为不变）：

- STDIO `env` 是显式键值；`envPass` 是宿主变量名列表。列表非空时只传选中的变量、
  平台运行必需的路径/临时目录等基础变量，再叠加显式 env；空列表沿用旧版继承宿主环境。
- HTTP `headers` 是显式请求头；`headerEnv` 映射“请求头名 → 宿主变量名”；
  `bearerTokenEnv` 是令牌变量名，连接时生成 Authorization Bearer。环境映射覆盖同名
  固定头（不区分大小写），Bearer 配置最后覆盖 Authorization。
- 环境变量在 Agent 服务机器上读取，不是在浏览器所在机器读取。找不到变量明确失败。
  配置/状态只保留变量名，不回写解析出的值。显式填写 env/headers 的值仍沿用原有明文
  settings 保存方式；不要误认为整个配置已接入密钥保险库。

自己实现 MCP 的分步练习见 [MCP-TUTORIAL.md](./MCP-TUTORIAL.md)。

## 2026-10-18 协议与可靠性复核

定位：实现 MCP 的工具客户端与内置文档工具服务，**不宣称覆盖整个 MCP 协议**。
协议依据为官方固定版本的 [生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle)、
[传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports) 和
[工具](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)。

本次修复：

- STDIO 保持请求 2024-11-05，可接受已实现的 2025-03-26 / 2025-06-18；
  Streamable HTTP 请求 2025-06-18，可协商降至 2025-03-26，后续头使用协商版本。
  不再把旧版 HTTP+SSE 与 Streamable HTTP 混用；旧版双端点 HTTP+SSE 不支持。
- HTTP 增量解码 UTF-8 SSE，收到对应结果立即完成，不依赖服务端关闭连接。
  校验响应版本、ID、result/error 互斥、Content-Type；响应最大 16 MiB。
  使用整个请求的截止时间，心跳不能无限延长；处理断流和响应错误。
- 取消/超时发送 cancelled 通知；退出取消在途请求，幂等关闭并有界删除会话。
  404 会话失效重新握手，但原调用仍失败，**不自动重放工具副作用**。
  只支持 POST 返回流，不打开可选的独立 GET 通知流，不实现 Last-Event-ID 恢复。
- 工具发现尊重 capabilities.tools，支持游标分页；循环游标、重复/映射冲突名称、
  无效 Schema 和超过 256 个工具明确失败，不悄悄遗漏或覆盖工具。
  Schema 保留 $defs/$ref、联合类型和约束，序列化后单个上限 256 Ki 字符；本地校验仍是
  ToolRegistry 的既有子集，完整校验依赖服务端。没有宣称完整 JSON Schema 校验器。
- STDIO 支持服务端 ping，捕获 stdin 错误，限制输入行 16 MiB；管理器显示实际进程状态。
  连接启动中也纳入关闭资源集合，避免关闭时遗漏尚未完成握手的客户端。

边界：没有声明 sampling/roots/elicitation 能力；resources/prompts、OAuth 发现与授权、
动态 list_changed 工具重新注册、后台自动重连仍未实现。界面定时刷新是读取状态，
不是健康 ping 或断线重连。外部服务权限仍是服务级宿主调用权限，不是操作系统沙箱。
认证引用从服务宿主环境解析；响应错误不回显 HTTP body，避免外部响应泄露凭证。

架构边界保持不变：契约纯定义，discovery 与传输是 IO 适配，Cordis core/mcp 管理
注册和资源释放，工具继续经过原有权限/执行/事实记录链路；没有第二套 Agent 执行器。
全部使用内置模块，不新增生产依赖；Electron 22.3.27 / Node 16.17.1 不变。
未来可替换传输客户端或升级运行时，不改变 ToolRegistry 和 Agent 状态契约。

验证：mcp-smoke 自动包含 mcp-reliability-smoke，覆盖真实 HTTP 服务的持久 SSE、
跨 chunk 中文、错 ID、截断响应、心跳超时、主动取消、会话恢复不重放、关闭中调用，
以及 Schema 保留、分页、循环游标、名称冲突、进程退出状态。随全量检查和内嵌
Node 16 检查运行；未在 Win7 真机、Office/WPS 或所有第三方 MCP 服务上验证。
