# 统一离线扩展包（格式 1）

能力中心的三类包使用同一 ZIP32 容器与清单，分别采用：Skill `.skill.pgk`、MCP `.mcp.pgk`、插件 `.plugin.pgk`。后缀必须与清单 type 一致，安装检查和打包工具都会校验。旧 `.agentpkg`、`.zip` 包仍兼容。这是 Agent 的格式，不兼容 VS Code 的 VSIX 执行接口。不会扫描应用商店、联网安装 npm/pip 包、执行安装脚本或更新运行时。

## 使用

能力中心点击“安装离线扩展包”，或将一个包拖入能力中心。系统在隔离 worker 中检查后，展示类型、发布者、版本和能力信息；用户确认才安装。安装后默认停用，在对应栏目启用。已安装卡片提供停用和卸载。更新先停用旧版、安装同 ID 更高版本，再显式启用。拒绝同版本覆盖、降级和类型变更。

安装到当前连接的 Agent 服务主机的 `AGENT_HOME/extensions/`，浏览器上传文件内容，不传本机任意路径；开发态 Electron 使用 userData。远程连接时不会安装到浏览器所在主机。Skill 正文按需读取；本地 MCP 使用宿主的内嵌 Node；插件由原 Cordis 宿主加载。重启恢复已启用项，失败项保留错误供处理，不悄悄删除。

## 包结构与清单

根目录必须有 `manifest.json`，不能再包一层目录。示例：

```json
{
  "formatVersion": 1,
  "publisher": "example",
  "name": "report-guide",
  "displayName": "报告编写规范",
  "description": "资料分析与报告编写规范。",
  "version": "1.0.0",
  "type": "skill",
  "engines": { "extensionApi": 1, "node": "16", "electron": "22", "chromium": "108" },
  "targets": ["any"],
  "entry": "SKILL.md",
  "files": { "SKILL.md": "由打包工具生成的64位小写SHA256" }
}
```

- ID 为 `publisher.name`。两段都是小写字母开头，后接字母、数字或短横线，分别最多40字符。
- `version` 为不带前导零的 `x.y.z`。首版不接受预发布版本和版本范围。
- `targets` 为 `any`，或 `win32-x64`、`darwin-arm64`、`darwin-x64`、`linux-x64`、`linux-arm64` 的列表。`any` 是发布者对兼容性的声明，不等同于已经过所有平台验证。
- `files` 完整列出所有载荷文件及 SHA256，不包含 manifest 本身。不接受缺失、额外文件或大小写冲突文件。
- 文件名跨平台校验：禁止绝对路径、目录穿越、Windows 保留名、冒号、尾随点/空格及符号链接。

### Skill

`type: skill`，`entry` 指向 `SKILL.md`，保持现有 Markdown/frontmatter 习惯。可包含 references、scripts、assets；安装和加载技能不会自动运行脚本，执行仍经过现有工具授权。入口所在目录为 load_skill 的读取边界，附属资料应放在该目录内。稳定技能 ID：`extensions/<publisher.name>`，与内置技能隔离。

### MCP

`type: mcp`，声明 `mcp.permission` 为 read/write/edit/command。

本地服务使用 `mcp: {"transport":"stdio","permission":"read","args":[]}` 和 CommonJS `entry`。命令固定为随包内嵌 Node，工作目录为扩展目录，开启 ELECTRON_RUN_AS_NODE；不通过命令行 shell，不运行 npx/npm install。依赖需预先离线放入包中。此版不支持自带 EXE、Python 环境或 Node native addon。

内网服务使用 `mcp: {"transport":"http","permission":"read","url":"http://server/mcp","bearerTokenEnv":"MCP_TOKEN"}`。令牌引用服务主机环境变量，不把令牌写入包。HTTP 包是连接配置，不包含服务端模型/引擎；实际调用需要内网服务可用。

现有手工配置的 MCP 继续使用，包管理项由扩展服务管理，不能在普通 MCP 编辑器中复制修改为第二份配置。

### 插件

`type: plugin`，CommonJS 入口导出 `name: 'publisher.name'`；推荐 `cordis: true`，声明 inject 并通过 ctx.effect 注册和释放资源。既有 apply/setup + PluginContext 插件仍兼容。

插件代码受信任，与宿主拥有相同进程权限；包校验不是沙箱，也不是发布者签名。SHA256 用于内容完整性核对，不证明来源可信。前端不加载包内 HTML/JS，不接受安装钩子。首版不提供包依赖下载、跨扩展版本依赖求解、签名商店、任意自定义 UI 和原生二进制。

## 打包

```sh
node scripts/pack-extension.js examples/extensions/report-skill /tmp/report-guide.skill.pgk
node scripts/pack-extension.js examples/extensions/echo-plugin /tmp/echo.plugin.pgk
node scripts/pack-extension.js examples/extensions/local-mcp /tmp/local-echo.mcp.pgk
node scripts/pack-extension.js examples/extensions/http-mcp /tmp/intranet.mcp.pgk
```

工具自动遍历普通文件、计算 hashes、检查清单、生成包并回读验证。输出放到源目录外。源模板无需手写 files，安装成品必须有它。附属 JS 需要 CommonJS 且语法兼容 Node16；对入口进行语法检查不能证明所有 API 或目标机行为兼容。

## 存储、事务与资源

- `installed.json`：版本1登记，临时文件/fsync/rename 发布，指向不可变版本目录。
- `packages/<id>/<version>-<digest>/`：载荷；升级不覆盖旧目录，停用卸载按 ID 删除自身载荷，不触碰会话、知识库、工作流产物。
- `staging/<token>/`：仅验证通过的待确认内容；令牌10分钟有效，最多4个。取消清理，重启清理未提交 staging。
- PID 所有权锁防止两个进程修改同一安装仓库。中断在登记提交前至多留下未引用载荷，不自动执行它。
- 首版限制压缩8MB、解压32MB、ZIP32 2048项、安装100个包；检查在有15秒时限和128MB JS heap限制的 worker 内完成。未确认内容不常驻主进程大对象缓存。
- 停用通过现有 Cordis/MCP 清理路径取消并等待在途工具；可信扩展仍须正确实现取消。不是任意代码强制终止或 OS 沙箱。

## 验证和兼容

`npm run check:extensions` 验证包完整性、跨平台路径、停用安装、升级、卸载、Skill 运行时隔离、真实 Cordis 插件、真实 stdio MCP 和重启恢复。`npm run check:extensions:browser` 验证实际 Chromium 文件选择、拖放、确认/取消与界面管理。`npm run check` 与 `npm run check:node16` 包含运行时回归。

没有新增生产依赖、网络下载或运行时版本升级。Electron22.3.27 / Node16.17.1 / Chromium108 的实际运行检查与 Win7 真机验证分别报告。当前未做 Win7 真机验收。平台适配可替换，包清单、安装仓储与 Cordis 能力边界不绑定特定 UI 或 IPC。

清单 JSON Schema：`docs/schemas/extension-manifest.schema.json`，供编辑器和开发工具使用；运行时仍以纯契约校验为准，包括 JSON Schema 不足以表达的 Windows 路径、文件哈希和平台检查。

包级 MCP 启停增量对比连接配置，仅注销受影响包的工具和连接，保留既有手工 MCP、其他包及内置文档工具的注册和在途调用；显式修改全局 MCP 配置时仍沿用原有重新加载行为。卸载插件前等待工具清理，并释放包目录中的 CommonJS 缓存。
