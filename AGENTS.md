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
- Use change-scoped checks during development; run `npm run check` once for an
  agreed feature batch or delivery. Validate affected runtime boundaries with
  Electron's embedded Node 16.17.1; full delivery checks remain mandatory.
  Follow the development-efficiency section below for scope and timing.

# Build and delivery rule（2026-10-24 更新）

本节替代原先以 ZIP＋解压目录为主要交付的规则。详细契约、现状差距与验收要求见
`docs/DESKTOP-DELIVERY.md`。以下为建设要求，未通过对应验收不得宣称已经实现。

- **统一交付：每个平台文件夹里只放一个可打开的程序，内含完整离线运行环境。**
  固定为 `release/desktop/Agent-<平台>/`：Windows 内只有 `Agent.exe` 离线安装运行入口，
  macOS 内只有 `Agent.app`，Linux 内只有 `Agent.AppImage`。不得将散列 Electron
  依赖目录或其 ZIP 当作默认交付；构建中间目录移到 `release/.desktop-build/`。
  实际依赖、执行权限与目标系统兼容性必须分别验证。
  “一个分发文件”不等于 Electron 只能有一个物理二进制，禁止为凑单文件而每次启动
  都全量解压运行时。Mac 的 `.app` 是标准应用包，不应伪装成裸 Mach-O 可执行文件。
- 支持范围仍为 `win-x64`、`mac-arm64`、`mac-x64`、`linux-x64`、`linux-arm64`。
  仅在用户明确要求打包、交付或发版时生成安装包；小功能完成不自动打包。
  明确要求发版才升级版本并构建全部平台。
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
  最新解压 `Agent.app` 并在最终回复中提供绝对路径。交付完成后的最终回复必须提供
  安装包所在文件夹的可点击 Markdown 链接，使用绝对目录路径，方便用户点击打开文件夹；
  不得仅提供安装程序文件链接或不可点击的纯文本路径。需要时可另外提供安装程序链接。
  缓存、审计记录、符号和验证报告
  独立保留，活动程序暂缓清理；客户端仅额外保留必要的上一个可回滚版本。
- 默认 `build:desktop` 已改走平台封装，旧 ZIP 仅可通过 `--legacy-zip` 显式生成供内部排查。
  成功验证新包后才清理同平台旧散文件和 ZIP；活动旧程序暂缓删除。Mac 两个架构均
  保留 `Agent.app`，总目录统一生成 `SHA256SUMS.txt`。源码保护与在线更新仍单独验收，
  不能把平台封装说成源码加密或自动更新完成。最终验收以新交付契约为准。

# 默认源码保护流水线（2026-10-24）

- 默认平台封装必须先执行 `agent-source-v1`：构建期固定 Terser 5.31.0 与
  javascript-obfuscator 4.1.1，仅devDependencies；Node16内置crypto加载逐模块AES-GCM
  载荷。自研CommonJS加密，页面与沙箱preload压缩混淆；不降低sandbox或开放Node。
- 必须生成并验证source-protection.json、覆盖率和载荷摘要；失败停止交付，不回退明文。
  vendor、Skill资源、许可及可编辑示例按资源契约保留。加载器不得引入Agent业务状态。
- 内置密钥不能保证绝对保密，也不是授权签名密钥。禁止将ASAR或混淆说成不可反编译。
  V8字节码仍需按固定运行时/平台独立验证，不能因本层保护而宣称已实现。
- `--stage-only`保留保护/封装/验签，只暂存供真实包回归。性能基线及legacy原始目录
  仅供内部排查，不作为对外交付。保护包要验证离线直接启动、真实Cordis/工作流和性能。
- 软件授权采用设备绑定、离线签名、人工迁移方向，方案见docs/SOFTWARE-LICENSING.md。
  私钥不得进入客户端或签发工具包。用户已明确启用发布包强制授权蒙版与一次10分钟试用；
  公钥缺失必须构建失败。开发模式与生产策略分开，不提供客户端环境变量绕过。

# 知识库 SQLite 的限定组件例外

用户于 2026-10-18 确认知识库落地方案并授权实施。为实现方案中的真实文件事务，
允许唯一新增随包组件：SQLite 3.54.0 + 本仓库自编译独立 bridge 进程。
源码、上游 SHA3、编译参数、五平台二进制与校验固定记录在 scripts/knowledge-native/
和 src/main/knowledge/vendor/sqlite/。该例外不允许 npm 生产依赖、Node native addon、
系统 SQLite/Python 依赖或目标机运行时下载。不得自动升级此版本；更新必须重新验证。
Win7 API/PE 静态检查、内嵌 Node 验证与 Win7 真机验证须分别报告，不能互相替代。

# 流程命名与卡片规范

- 新建或重命名流程时，名称不得超过15个字（按 Unicode 字符计数），简洁表达用途；
  详细说明、节点安排与执行策略写入流程描述，不堆进名称。AI 创建流程遵守同一规则。
  已有长名称保留读取和执行兼容，未重命名时不阻止保存其他修改，不自动截断持久化名称。
- 流程卡片仅展示名称、版本和操作，不展示节点预览、节点数、运行时间或执行状态标签。
  “实例”按钮使用图标加文字；任一实例处于待执行、执行中、待人工处理或暂停状态时高亮，
  全部实例结束后恢复普通样式。高亮由实际实例状态推导，不另存进度标志。

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

# 文档语言与 Git 提交规范

- 根目录 `README.md` 使用简体中文，`README.en.md` 提供对应英文版，两者顶部互链。涉及功能、安装、构建、验证、交付和限制的更新必须同步维护两种语言，确保事实与命令一致。
- 今后所有新建 Git 提交的标题与正文统一使用中文，明确说明实际变更及原因。代码标识符、文件路径、命令、协议名称及必要的 `feat`、`fix` 等提交类型前缀可保留原文，但描述不得整段使用英文。
- 历史提交不因本规则自动改写；修改已推送提交说明属于重写历史，必须获得用户针对该操作的明确授权。

# 快速功能落地与开发效率规范（2026-11-09）

本节替代原“开发效率与验证节奏（2026-11-08）”，适用于当前工程后续开发。开发与交付的执行时机按本节区分；上文的 Win7、架构、安全、源码保护、授权、数据可靠性及交付回滚契约保持有效，不因提速而减免。

## 一、核心目标

以功能交付为中心，减少无效分析、过度设计、重复测试和不必要的构建。先实现功能，再考虑非必要优化；先完成端到端闭环，再逐步完善。优先复用现有架构、组件、服务和工具，只修改必要范围，不扩大任务边界。采用最小充分验证，不重复验证相同行为；不得牺牲 Win7 兼容性、架构质量、安全性和数据可靠性。

## 二、需求分析与代码定位

每次开发先准确理解用户目标和可验收结果，检查 Git 工作区状态，避免覆盖用户已有修改。优先定位功能入口、直接依赖、现有实现和相关测试，只阅读当前任务涉及的必要文档，不全面扫描无关模块。

仅在涉及对应边界时阅读专项文档：Agent 执行、插件、Session、启动阅读 `docs/ARCHITECTURE.md`；运行时和平台兼容阅读 `docs/WIN7-COMPAT.md`；打包、更新和交付阅读 `docs/DESKTOP-DELIVERY.md`；Skill、MCP、插件分发阅读 `docs/EXTENSION-PACKAGES.md`。

需求明确时直接实施，不为非关键技术选择反复询问用户；遇到真正影响架构、数据安全或不可逆操作的问题再确认。不为普通功能开发额外编写冗长设计文档或实施计划，保持必要的内部任务拆解即可。

## 三、功能优先的实施策略

采用最小端到端交付（Vertical Slice）：明确本次功能的可验收结果，找到现有实现和可复用能力，确定最小必要修改范围，直接完成完整业务链路，验证实际运行效果，达到验收条件后停止扩展。

禁止为单个功能提前建设通用框架，或在没有实际需求时新增抽象层、服务层和管理器；禁止重复实现现有组件、工具、状态管理和事件机制。保持单一事实源，复用既有 Workflow revision、权限和 Cordis 生命周期，不另造机制；精简重复提取、索引、缓存和服务入口仅限当前必要修改范围，不借此清理无关模块。

禁止为了代码整洁进行无关重构、批量改名或目录迁移；未经需求要求不得擅自升级依赖或引入新的生产依赖。不得将临时 Mock、静态展示或仅通过类型检查的代码当作功能完成，不得为了追求完美持续扩大当前任务范围。发现非阻塞性架构优化时，记录为后续建议，不中断当前功能交付。

## 四、验证策略：最小充分验证

按照实际变更范围执行，不采用所有任务统一全量检查的方式。

### 普通修改

文案、样式、简单逻辑和局部组件修改，只检查改动文件并执行必要的静态检查；UI 修改必须进行一次对应的真实界面验证。不自动执行完整 E2E、全量检查和 Node16 全量验证，不自行把小修定义为“批次收口”。

### 普通功能开发

新增页面、业务组件、接口和常规业务能力，执行直接受影响的单元或集成测试，验证一条真实业务链路，并检查相关模块之间的契约。完整功能批次结束时，集中执行一次 `npm run check`。

完整功能批次指一个完整的用户可见功能闭环，不是每次代码修改、每次修复或每轮 Agent 迭代。

### 高风险边界修改

涉及 Electron Main、Preload、IPC；Node16 API、进程、文件系统和原生二进制；Cordis 插件生命周期和资源清理；Agent 状态机、Session、持久化与恢复；权限、CSP、签名和授权；数据库、离线能力包及外部工具副作用时，必须进行定向专项验证。

涉及 Node16 执行边界时，使用 Electron 内嵌 Node `16.17.1` 验证实际行为。优先通过现有 `npm run check:node16 -- <相关测试名>` 运行相关定向测试，不无条件执行全部测试；无参数的 `npm run check:node16` 仍是完整 Node16 验收。不得把构建机验证或兼容性检查冒充 Win7 真机验证。

### 正式交付

只有用户明确要求打包、交付或发版时才进入交付流程，严格执行原有交付契约，包括 `npm run check`、`npm run check:node16`、源码保护及覆盖率验证、离线运行与真实业务回归、构建清单、载荷摘要和签名验证，以及对应平台的安装包验收。日常功能开发不得自动进入完整交付流程。

## 五、减少重复执行

同一行为优先保留最接近实际改动边界的一层验证，避免在 service、HTTP、UI、安装包各层重复验证同一行为；必要的契约检查和高风险边界专项回归仍须保留。已通过的测试，在源码、依赖、配置和运行环境未发生相关变化时不重复执行；修改导致验证证据失效时，只重新执行受影响的检查。

独立的静态检查和测试允许并行，有依赖关系的任务按顺序执行。不重复运行已经被完整检查覆盖的类型检查、Smoke、E2E 等项目。后台任务使用完成通知，不持续轮询日志；需要输出时只在完成或用户询问时读取一次。不为了提速跳过失败测试，不以缓存结果冒充真实运行验证。

不为上述优化额外建设复杂的测试调度系统或重复的验证入口，优先使用现有脚本。

## 六、开发与交付彻底解耦

开发阶段只修改源码、执行局部测试和真实功能验证，不生成安装包。

功能批次收口时集中执行一次 `npm run check`、必要的专项回归并输出完成情况，不自动构建安装包。

正式交付阶段仅在用户明确提出打包、交付或发版后启动。普通打包默认构建本机平台，正式发版才构建全部支持平台；明确要求发版才升级版本。完整执行源码保护、授权、签名、哈希和安装包验证，严格遵守原有交付和回滚规则。交付性能采样沿用默认 30 组样本，失败只重跑受影响步骤；源码变化使证据失效的关联步骤必须重新验证。

功能完成不等于需要发布安装包，不因内部“批次收口”自动触发构建、保护载荷、安装包或交付性能采样。

## 七、任务完成与耗时记录

每项任务完成后简要记录实际完成的功能、修改的核心模块、实际执行的验证及结果、未执行的验证及原因，以及定位分析、编码、验证、收尾耗时和实际执行轮次、失败重试。发生打包时另列打包耗时；总耗时与等待时间如实区分，不把等待算作纯编码。

优先利用已有任务日志和执行记录，不为统计耗时增加额外工具、执行步骤或计时系统。不确定的时间不得虚构，无法准确取得的数据明确标注未记录。

## 八、完成标准

用户要求的功能已经实现，核心业务链路可以正常运行，当前变更范围内的必要验证通过，没有遗留的数据安全、架构和运行时问题，相关文档按实际变更需要更新，即可结束当前任务。无法验证的项目必须明确说明，不宣称已通过。

完成后立即汇报，不继续自行扩大需求或进行无关优化。把 AI 的主要执行时间用于理解真正的问题、编写有效代码和验证实际功能，而不是重复阅读、过度规划、重复测试和提前构建。
