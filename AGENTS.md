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

# Build and delivery rule

- **每个功能或任务完成后，必须打包当前开发环境对应的平台包，供用户测试验收。**
  日常验收沿用当前版本，覆盖同名压缩包和解压目录，不自动递增 `package.json` /
  lockfile 版本号，不创建带时间戳、额外后缀或临时版本号的发布目录。
  此规则替代此前“日常修改不打包，仅发版时打包”的要求。
- **用户明确要求“发版”时，才升级版本号，并打包全部支持的系统与架构：**
  `win-x64`、`mac-arm64`、`mac-x64`、`linux-x64`、`linux-arm64`，不得仅打当前平台。
- 用户单独要求打包但未要求发版时，默认按日常验收规则打当前开发环境的包；
  用户明确指定其他平台时按指定范围打包，不自行升级版本号。
- 打包必须包含最终源码，并在必要验证后交付；不得仅改源码后把旧应用当成验收包。
  未经用户要求，不自动启动应用。
- 默认交付解压后的 Mac 运行程序 `Agent.app`，不能只给 ZIP。
  根据本机架构选择 `mac-arm64` 或 `mac-x64`，保留最新版的解压目录，
  并在最终回复中提供 `Agent.app` 的绝对路径链接。无需自动启动应用。
- 打包后核对包内修改文件与最终源码一致；清理历史产物时，必须保留
  最新版压缩包、校验文件，以及默认 Mac 版的解压运行程序。
- 如果打包失败，修复后重试；无法完成时明确说明阻塞，不能宣称已交付新版。

- 每次成功打包后自动执行产物保留策略：每个平台只留最新压缩包，默认 Mac
  只留最新版解压程序，校验文件统一为 `SHA256SUMS.txt`。未完成打包时不清理；
  活动旧程序目录暂缓删除，下次打包或清理时重试。缓存和验证报告独立保留。

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
