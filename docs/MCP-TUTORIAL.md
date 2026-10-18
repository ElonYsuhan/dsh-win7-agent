# 你来实现的第一个 MCP：项目统计工具

目标：自己写一个独立 MCP 服务，接入能力中心，然后在聊天中说“统计这个目录的文件”，
让 Agent 真实调用你的 `project_stats` 工具。先用标准 stdio，不需要 HTTP 或数据库。
本指南是练习步骤，不会替你创建或运行服务。

## 第一步：先实现普通函数

在你选定的练习目录创建 `server.js`。先写 `projectStats(root)`：

1. 使用 Node 内置 `fs`，`realpathSync(root)` 固定根目录。
2. `readdirSync(root, { withFileTypes: true })` 读取根目录第一层。
3. 返回 `{ files: 数量, directories: 数量 }`，符号链接不计入这两项。
4. 第一版不接收任意路径、不递归、不写文件。

先用 `console.error(projectStats(root))` 验证。不要用 console.log：stdio MCP 的 stdout
必须仅输出协议消息。后续可去掉调试输出。

## 第二步：描述你的工具

给 `project_stats` 定义 Schema：

```json
{
  "name": "project_stats",
  "description": "统计启动时指定目录第一层的文件和子目录数量，不递归、不修改文件。",
  "inputSchema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
  }
}
```

工具参数为空：目录由启动参数指定，模型不能自行扩大范围。

## 第三步：接上标准 MCP stdio

用 `readline.createInterface({ input: process.stdin })` 按行读取 UTF-8 JSON。
每个响应使用 `process.stdout.write(JSON.stringify(response) + '\n')`。
实现以下消息；收到通知时不要回复：

| 输入 | 你要实现的返回 |
| --- | --- |
| `initialize` | 协商支持的版本、`capabilities: { tools: {} }`、`serverInfo` |
| `notifications/initialized` | 记为可调用；不回复 |
| `ping` | `result: {}` |
| `tools/list` | `result: { tools: [上面的工具定义] }` |
| `tools/call`，name 为 `project_stats` | 校验空对象参数，调用你的函数，返回下面的工具结果 |
| 未知方法 | `error: { code: -32601, message: "Method not found" }` |
| 未知工具或非法参数 | `error: { code: -32602, message: "Invalid params" }` |
| 解析失败 | `id: null`、`error.code: -32700` |

请求响应都保留 `jsonrpc: "2.0"` 和原请求 `id`。工具执行结果示例：

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [{ "type": "text", "text": "{\"files\":5,\"directories\":2}" }],
    "isError": false
  }
}
```

函数执行失败时返回 `result.isError: true` 和错误文字；不要把业务失败包装成成功。
只实现自己声明的 tools 能力，不要声明 sampling/resources/prompts。
我们当前宿主请求版本为 `2024-11-05`，你第一版明确支持并返回此版本即可。
先处理初始化、再接受工具调用；输入流关闭后退出，不留下后台定时器。

## 第四步：在 Agent 里连接

进入“能力中心 → 连接器 → 添加 MCP 服务”：

- 名称：项目统计；类型：STDIO；权限：只读。
- 启动命令：你自己的 Node 16 兼容执行器，或 Agent 内嵌 Electron 可执行文件的绝对路径。
- 第一行参数：你的 `server.js` 绝对路径。
- 第二行参数：你选定的统计目录绝对路径；代码从 `process.argv[2]` 读取。
- 使用内嵌 Electron 时，环境变量添加 `ELECTRON_RUN_AS_NODE` → `1`。
- 工作目录可留空。参数中的空格原样保留，每行是一个参数，不需要再加引号。

Mac 包中执行器位于 `Agent.app/Contents/MacOS/Electron`；Windows 包中是 Agent 的 exe。
使用随包执行器不要求目标机额外安装 Node，不要采用运行时 `npx` 下载来满足离线要求。
如果使用“环境变量传递”白名单，仍需确保上述显式环境变量被配置。

先点“测试连接”，应发现一个工具；保存后让 Agent“调用项目统计工具，统计启动时指定目录”。
工具在模型端会带 `mcp__<服务id>__project_stats` 前缀，你的服务仍用原名 `project_stats`。

## 第五步：你自己验收

- 空目录返回两个 0；加入文件和子目录后数量正确。
- 输入未知工具、错误参数，返回标准错误，服务不崩溃。
- 日志只到 stderr，stdout 每行都是 JSON-RPC。
- 停止服务后 Agent 如实显示调用失败；不生成假的统计结果。
- 与资源相关的代码符合 Node 16，MCP 服务本身不需要知道 Cordis、会话或 Agent 主循环。

先完成第一、二步，把你的函数和 Schema 发来，我检查后再带你接第三步。

协议依据：
[MCP 生命周期](https://modelcontextprotocol.io/specification/2024-11-05/basic/lifecycle)、
[MCP 工具](https://modelcontextprotocol.io/specification/2024-11-05/server/tools)、
[MCP 传输](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports)。
