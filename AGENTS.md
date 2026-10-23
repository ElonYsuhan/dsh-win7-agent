# 长期产品与技术原则

以下两条是今后所有功能开发、依赖选型、重构和版本升级的共同约束：

1. **运行技术锁定 Win7 兼容版本。** Windows 7 SP1 x64 是强制支持的最低平台，
   交付运行时固定为 Electron `22.3.27`、内嵌 Node `16.17.1`、Chromium `108`。
   库、工具、语法、系统 API、图形后端及原生二进制都必须满足这个边界；
   新选型必须固定明确版本并验证兼容性，不得通过自动升级或运行时下载突破边界。
   已有锁定版本不得擅自升级；构建机工具可使用较新版本，但产物及目标机执行路径
   必须保持 Win7 兼容，不能把构建机可运行当成目标机可运行的证据。
2. **架构思想与落地方法保持先进。** 为 Win7 做出的让步应限于实现版本和平台适配，
   不能成为降低架构质量的理由。坚持契约优先、纯策略与副作用分离、明确的状态迁移、
   事实持久化、可取消执行、可观测性、可替换能力和自动化验证。
   Cordis 始终作为运行时底座，上层插件承担 Agent 业务执行与持久化。
   优先使用简单、可验证且能持续演进的设计；先进不等于追逐最新依赖或堆砌复杂抽象。

- 遇到现代能力与 Win7 冲突时，先定义平台无关契约，再通过适配器、构建期转换、
  离线打包或显式能力降级实现。不得把平台判断散落到契约、纯流程或状态 reducer 中。
- 每项重要架构变更都应说明：解决的问题、模块边界、Win7 兼容实现、验证证据，
  以及未来替换旧运行时的路径。平台适配可以替换，核心业务契约不应被旧平台绑死。
- 兼容检查和真实目标环境验证必须如实区分；未在 Win7 真机验证时不得宣称已经验证。

# Agent architecture contract

This product uses **real Cordis as its runtime foundation**. Agent execution
and persistence are implemented by upper-layer plugins. This is the enduring
architecture for future Agent iterations, not an optional integration.

- Read `docs/ARCHITECTURE.md` before changing execution, plugins, sessions or startup.
- Follow the four-layer contract: `contracts/` defines interfaces and events;
  `flow/` contains pure policy; the pure state reducer owns transitions;
  upper runtime plugins execute policy and persist facts. Cordis manages assembly
  and lifetimes, not Agent business semantics.
- Contracts/flow must not import IO, platform or runtime implementations. The
  state reducer imports contracts only. Keep persistence in the separate repository.
- Change conversation state through versioned, validated, recorded transitions.
  Never mutate message arrays or maintain parallel progress/decision flags.
- Recovery may restore context but must never automatically repeat uncertain
  external tool side effects. Keep old snapshot/UI protocols compatible.
- Register new runtime capabilities as Cordis plugins/services in a profile.
  Declare required services with `inject`; let Cordis manage activation and teardown.
- Resolve model, context, session, tools and agent-loop capabilities through the
  runtime. Do not introduce a second service container, event bus, dependency
  scheduler, or a hardcoded execution path bypassing the selected services.
- `PluginHost` and `PluginContext` are compatibility adapters for existing tools.
  New core code uses native Cordis contexts; keep old user plugins compatible.
- Acquire resources with tracked effects; await asynchronous cleanup. Keep
  conversation-specific state on the Agent, never in a shared tool plugin.
- Cordis is pinned and bundled under `src/main/runtime/vendor/cordis`. Do not
  edit generated upstream code. Use the documented vendor regeneration workflow.
- Preserve Windows 7 SP1 x64 / Electron 22.3.27 / Node 16.17.1 and offline use.
  Do not add production dependencies or runtime downloads. See `docs/WIN7-COMPAT.md`.
- Run `npm run check` and meaningful runtime regression tests. Check the runtime
  with Electron's embedded Node 16.17.1 as well as the build machine's Node.

# Build and delivery rule（2026-10-24 更新）

本节替代原先以 ZIP＋解压目录为主要交付的规则。详细契约、现状差距与验收要求见
`docs/DESKTOP-DELIVERY.md`。以下为建设要求，未通过对应验收不得宣称已经实现。

- **统一交付：每个平台只交付一个供用户打开的分发文件，内含完整离线运行环境。**
  Windows 为离线 `.exe` 安装程序，macOS 为内含 `Agent.app` 的 `.dmg`，Linux 以
  `.AppImage` 为目标格式；实际依赖、执行权限与目标系统兼容性必须分别验证。
  “一个分发文件”不等于 Electron 只能有一个物理二进制，禁止为凑单文件而每次启动
  都全量解压运行时。Mac 的 `.app` 是标准应用包，不应伪装成裸 Mach-O 可执行文件。
- 支持范围仍为 `win-x64`、`mac-arm64`、`mac-x64`、`linux-x64`、`linux-arm64`。
  每个功能或任务完成后生成本机平台验收包；明确要求发版才升级版本并构建全部平台。
  日常验收不自动递增 package/lockfile 版本，未要求发版不得顺便升级运行时或依赖。
- 对外文件名按产品＋平台固定，成功验收后原子替换该平台旧包，不创建时间戳或临时
  版本发布目录。内部保留不可变 buildId、源码提交、载荷摘要和发布记录。正式更新
  使用签名的递增发布序号，不能只比较文件名、时间戳或同一个 semver。
- 用户安装位置、快捷方式与用户数据目录稳定。更新不得覆盖 AGENT_HOME、会话、
  知识库或离线能力包。运行后异步检查可信更新源，下载和验签完成后在空闲边界应用；
  有生成、任务、流程执行或未保存编辑时不强制退出。离线、检查失败不阻塞启动。
- 更新须经过签名清单、平台/架构匹配、大小与哈希校验、临时暂存、退出后替换、新版
  健康确认及失败回滚；不直接覆写运行中的文件，不先清空唯一可用旧安装。
  自动更新源未配置、签名未建立或未完成验证时必须如实说明，不以本地接管冒充在线更新。
- **发布包必须加强源码保护，但不承诺绝对不可反编译。** 自研代码须构建期裁剪、
  压缩与经验证的混淆；核心模块的编译/字节码保护必须锁定 Electron22/Node16/V8
  及各平台版本后验证。ASAR 仅是归档，不等于加密；内置解密密钥不能成为保密保证。
  不分发自研原始源码、源码映射、测试和开发配置，依法保留第三方许可与所需公开材料。
  不改写 Cordis 等固定 vendor；不引入未获授权的生产依赖或原生运行组件。
- 源码保护与性能共同验收：禁止运行时全量解密、全量哈希和全量解压阻塞首屏，禁止
  用重度控制流混淆拖慢热路径。启动、首屏可交互、模块冷/热切换、反复切换后的资源
  占用均须测量；性能目标、基准机与测试证据按交付契约记录，不能只声称“更快”。
- 包内必须包含最终源码对应的构建结果。未经要求不自动启动用户应用；隔离验证除外。
  运行 `npm run check`、`npm run check:node16` 及相关回归，核对运行时锁定版本、
  构建清单、载荷哈希、签名和实际平台行为。构建检查不能冒充 Win7 真机验收。
- 构建、校验失败时不替换有效旧包，不清理唯一可回滚安装；修复重试，无法完成明确
  报告阻塞。成功后每平台只保留最新分发包和统一 `SHA256SUMS.txt`；Mac 另保留
  最新解压 `Agent.app` 并在最终回复中提供绝对路径。缓存、审计记录、符号和验证报告
  独立保留，活动程序暂缓清理；客户端仅额外保留必要的上一个可回滚版本。
- **迁移期：** 新安装器/保护流水线尚未验收前，现有打包脚本可用于开发验收，仍覆盖
  同名当前版本包并保留 Mac `Agent.app`。交付时明确这是过渡包，不能将 ZIP 改后缀
  冒充单文件应用，也不能把未经保护的旧包说成已经加密。最终验收以新交付契约为准。

# 知识库 SQLite 的限定组件例外

用户于 2026-10-18 确认知识库落地方案并授权实施。为实现方案中的真实文件事务，
允许唯一新增随包组件：SQLite 3.54.0 + 本仓库自编译独立 bridge 进程。
源码、上游 SHA3、编译参数、五平台二进制与校验固定记录在 scripts/knowledge-native/
和 src/main/knowledge/vendor/sqlite/。该例外不允许 npm 生产依赖、Node native addon、
系统 SQLite/Python 依赖或目标机运行时下载。不得自动升级此版本；更新必须重新验证。
Win7 API/PE 静态检查、内嵌 Node 验证与 Win7 真机验证须分别报告，不能互相替代。

# 统一弹窗开发规范

- 应用内确认、提示、文本输入必须使用 `window.appDialogs.confirm/prompt/alert`，
  禁止直接调用浏览器 `window.confirm/prompt/alert`，避免系统弹窗、中英文和主题不一致。
  系统文件/目录选择器及无法展示应用窗口时的原生启动错误对话框除外。
- 表单弹窗沿用 `.modal`、`.task-dialog` 或 `.artifact-overlay` 外壳及共享 dialog CSS
  tokens，不单独定义遮罩颜色、圆角、阴影与按钮尺寸。弹窗默认24px内边距、14px圆角，
  操作区右对齐，取消在左、主要操作在右，界面文案使用中文；按内容确定宽度。
- 设置等复杂页面可保留专属布局，内联权限确认保留内联形态，但使用同一主题与按钮规则。
- 必须有可访问名称、明确初始焦点、Tab焦点限制、Esc取消及关闭后恢复焦点；危险操作
  默认聚焦取消，不默认执行；输入法组字中的Enter不能提交。不得把多个确认请求覆盖为一个。
- 新增或修改弹窗时验证深浅主题、键盘操作及与现有弹窗的一致性，并更新必要的回归用例。

# 离线能力包规范

- 新增 Skill、MCP、插件的离线分发统一使用 `docs/EXTENSION-PACKAGES.md` 的 formatVersion 1 清单（Skill `.skill.pgk`、MCP `.mcp.pgk`、插件 `.plugin.pgk`，兼容旧 `.agentpkg`），不自行增加另一套安装器或联网依赖安装流程。
- 清单负责身份、版本、平台、入口和文件摘要；包安装与启用分离，安装检查不执行代码。节点扩展后续沿用同一安装机制和 Cordis 生命周期。
- Skill 保留 SKILL.md，MCP 保留 MCP 协议，插件保留 Cordis/旧兼容 API；统一分发不合并三者的业务职责。
