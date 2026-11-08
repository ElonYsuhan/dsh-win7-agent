# TypeScript 渐进重构计划

状态：核心层类型边界已落地（2026-11-08）；全面源码迁移仍需按批次继续。制定日期：2026-11-08。本文描述目标、顺序与验收门槛，不表示这些能力已经完成。与 [架构](ARCHITECTURE.md)、[Win7 兼容](WIN7-COMPAT.md)、[桌面交付](DESKTOP-DELIVERY.md)及根目录 `AGENTS.md` 冲突时，以后者的强制约束为准。

## 本轮核心层落地记录（2026-11-08）

按“核心层一次落地”的范围完成了 P0 的可运行类型检查基础，以及 contracts/flow/state/runtime 的类型边界：

- 新增 `tsconfig.base.json`、`tsconfig.types.json`、`tsconfig.core.json`、`tsconfig.preload.json`、`tsconfig.renderer.json`、`tsconfig.adapters.json`。`types/` 下的新契约使用 `strict: true`；legacy JS 通过 `checkJs` 以非严格模式检查，后续按模块收紧。
- `types/core/contracts.ts`、`flow.ts`、`state.ts`、`runtime.ts`、`memory.ts`、`capability.ts`、`adaptive.ts` 定义事件、消息、工具、模型、流程决策、reducer 状态、长期记忆/能力/自适应服务、Cordis 服务/插件和 runtime 服务边界；`types/browser/` 定义 preload/`window.dsh`/UI 交互边界；`types/build/` 和 `types/node/` 定义构建、server、shell、Agent/AgentPool/PluginHost 边界。类型夹具包含合法和 `@ts-expect-error` 非法样例。
- `src/main/contracts`、`src/main/flow`、`src/main/state`、两个 preload、`src/renderer` 的 `markdown.js`、`ui-enhancements.js`、`web-bridge.js`、`workflow-auto-layout.js`、`workflow-link-routing.js`，以及 `agent/cdp-client`、`browser-driver`、`test-runner`、`tools`、`validation-ledger`、`runtime/context-memory`、`runtime/generative-ui-service`、`server/native-folder` 纳入 `checkJs`。运行时仍是 CommonJS JavaScript，未新增 TS 运行时依赖或生成物。
- `scripts/typecheck-core.js` 校验 5 个配置、类型夹具、目标路径不含 `.ts/.tsx`、类型契约无 `@ts-ignore/@ts-nocheck`，并纳入 `npm run check`；`check:node16` 跳过构建机专用的 TypeScript 检查，仍执行全部目标运行时回归。`build-desktop` 在组装应用前运行同一检查。
- server/shell 主入口、renderer 的 DOM/大型 `app.js` 尚未迁移；它们保留 JS，通过 `types/node`、`types/browser` 声明和编译夹具约束。Vue 模板、真实 Chromium 和完整保护包仍需按原阶段门槛单独验证。

本次没有把 JS 改名为 TS，也没有引入 TypeScript 运行时或改变 Cordis/事件/状态路径；这是计划中“先给 JS 调用方提供可验证类型边界”的落地方式。后续批次可按 P1/P2 的具体模块把实现迁为 TS，再收紧 `strict` 选项。

## 目标和现状

随着 Agent、工作流、插件和界面增长，跨模块事件与服务接口越来越多。目标是让关键契约、状态迁移和运行时调用能够静态检查，降低新增功能和替换实现时的回归风险；同时保持 Cordis 生命周期、运行时数据校验、历史数据兼容和现有行为。

当前工作区（含未提交的生成式界面工作）中，`src/main/contracts/`、`flow/`、`state/`、`runtime/` 仍以 CommonJS `.js` 为主；`ui/generative-ui/` 已有 TypeScript 和 Vue，其 `tsconfig.json` 使用 `strict: true`、`target: ES2020`、`module: commonjs`、`allowJs: true`、`checkJs: false`。构建机依赖已锁定 `typescript@5.9.3`、`@types/node@16.18.126`；不能据此推断整个仓库已经严格类型化。2026-11-08 在当前工作区执行 `./node_modules/.bin/tsc --noEmit -p ui/generative-ui/tsconfig.json` 通过；它不覆盖 Vue 模板，也不是全项目检查。

## 不可突破的边界

- 运行时固定 Electron `22.3.27`、内嵌 Node `16.17.1`、Chromium `108`，最低 Windows 7 SP1 x64。TS 仅在构建机编译；交付及目标机执行路径不依赖 TS、npm、Python 或运行时下载。不得为迁移擅自升级锁定版本或新增生产依赖。
- TS 的 `target`、`lib`、类型声明和模块设置要与运行位置匹配。`target` 只影响部分语法输出，**不提供 API polyfill，也不能证明 Win7 兼容**。Node 侧使用 Node 16 类型，禁止因较新 DOM/Node 类型而误用目标环境不存在的 API；浏览器、主进程、preload 和构建脚本分开配置与验证。
- 保留真实 Cordis 底座与 profile 注入；`contracts`、`flow` 不依赖 IO、平台或运行时实现；纯 reducer 只依赖契约。运行时插件执行副作用并持久化事实。不可引入第二服务容器、事件总线或绕过既有 Agent 循环。
- 不改写 `src/main/runtime/vendor/cordis` 生成代码；第三方、许可、Skill 资源和可编辑示例按现有契约处理。旧 `PluginHost` / `PluginContext` 用户插件继续兼容，新增核心代码使用 Cordis 原生上下文。
- TS 类型会擦除，外部输入、模型输出、插件、MCP、IPC/HTTP、持久化与旧快照仍从 `unknown` 出发做运行时校验。状态继续通过版本化、校验和记录的事件改变；恢复不得自动重放不确定外部副作用。
- 保留 `agent-source-v1`、签名清单、强制授权、许可与离线包规则；禁止发布原始自研 TS、源码映射、测试及开发配置。构建错误不得退回明文包。

## 工程策略

1. **渐进替换，单一事实源。** 同一个模块任何时刻只允许一个可编辑的权威实现。迁移模块时将 TS 编译到独立、可清理的构建暂存目录，再按既有目录布局放入应用；不把生成的 JS 覆盖成另一份长期手工维护的源码。仍为 JS 的调用方可通过稳定的 CommonJS 导出和路径过渡。构建清单记录源、配置和产物摘要，避免发布旧产物。
2. **先验证模块互操作。** 单独做最小样板，验证 `require` / `module.exports` 形状、循环依赖、相对路径、`__dirname`、动态加载、预加载和既有用户插件。不要先批量切换 ESM 或重命名所有模块。入口、测试与打包必须使用同一份编译产物，不得只让开发机路径跑通。
3. **类型契约与运行时校验同源。** 为事件、服务、数据结构定义明确类型，复用现有验证器或从同一受控定义生成；避免维护两套会漂移的 Schema。涉及旧事件或快照时保留版本联合类型，并用真实旧样本验证。JSON、插件和 IPC 边界不靠 `as` 强转替代校验。
4. **严格性按边界逐步收紧。** 新 TS 模块默认 `strict`；迁移期间保留必要的 JS 互操作，按目录启用检查。禁止新增无理由的 `any`、大范围 `@ts-ignore` 或把未知输入断言成可信类型；确有历史兼容例外时登记位置、原因和清理条件。`skipLibCheck` 不能替代对实际运行依赖的兼容检查。
5. **兼容迁移按行为而非文件数量验收。** 每个批次先保留行为基线和可回滚提交，再迁移一个清晰边界；类型化和业务行为调整分开评审。不要把类型覆盖率作为唯一完成指标。

## 分阶段实施

| 阶段 | 交付与迁移范围 | 完成门槛 |
| --- | --- | --- |
| P0 基线和样板 | 清点权威源码、历史协议与跨层依赖；记录构建和性能基线。使用已有固定 TS 工具做最小 CommonJS 模块，在隔离暂存区验证 JS↔TS 调用、源码保护和打包。分别建立主进程、浏览器、preload、构建脚本的配置边界。 | 同一路径可在开发、测试、真实保护包及内嵌 Node16 运行；无新增生产依赖。明确迁移产物、映射和回滚方案。 |
| P1 契约和校验 | 优先 `src/main/contracts/`：服务接口、事件版本、会话、工作流、工具、MCP、生成式界面与外部输入。先给 JS 调用方提供可验证类型边界，逐个迁移运行时校验器。 | 合法与非法输入、旧版本、未知版本、序列化/反序列化及 JS 消费者回归通过；静态类型和验证规则不漂移。 |
| P2 纯策略与状态 | 迁移 `src/main/flow/` 和 `src/main/state/`；用可辨识联合类型表达事件、状态及策略结果，覆盖非法迁移、重试、取消、驳回和历史回放。持久化 IO 仍在独立仓库。 | 架构边界检查通过；新旧事件样本回放和行为一致性、恢复和不重放副作用测试通过。 |
| P3 Cordis 运行时与持久化适配 | 逐项迁移 `src/main/runtime/`、Agent 执行和仓库适配。为原生 Cordis 注入服务、生命周期、取消、异步清理及错误建立类型。沿用真实 Cordis 和兼容插件适配器。 | 真实 Cordis 装配、服务替换、插件停用、并发隔离、取消、异步清理、日志恢复和旧插件回归通过；没有绕过 profile 的新执行路径。 |
| P4 服务、壳与桥接 | 分批迁移 `server/`、`shell/`、主进程和 preload。协议类型共享，但分别约束 Node、Electron sandbox 和浏览器可用 API；确保 IPC 来源检查、授权与 CSP 仍在运行边界生效。 | HTTP/IPC、隔离上下文、授权、取消、离线启动和旧客户端兼容通过；真实加密包及内嵌 Node16 验证通过。 |
| P5 渲染层与插件开发体验 | 在已用 TS 的生成式界面基础上逐模块迁移 `src/renderer/`，先提取纯布局/路由和传输契约，再处理 DOM 和状态；为公开插件 API 提供版本化声明及兼容示例。 | Chromium108 实际界面覆盖深浅主题、键盘、工作流及主要功能；旧 JS 插件继续加载、运行和清理。Vue 模板检查需单独验证，不能以 `tsc` 覆盖声明冒充。 |
| P6 收口与持续治理 | 逐项移除已无消费者的临时适配器、旧构建路径和例外；建立新增代码准入、模块负责人及依赖升级评审。 | 范围清单和例外关闭；不再存在两套权威实现；文档、类型检查、保护清单与回归同步。保留必要的对外 JS 兼容层。 |

各阶段可按业务风险拆分为更小提交；前一阶段的约束和门槛须先满足。预计工期需在 P0 完成基线与样板后按模块实测，不在当前阶段承诺日期。

## 构建、类型检查与发布接入

- P0 设计并验证构建顺序：固定依赖与锁文件 → 分环境类型检查 → 编译到独立暂存 → 依既有目录组装 JS 和资源 → 现有源码保护及签名 → 清单、摘要和平台封装 → 对最终产物回归。生成式界面现有构建链先保持独立，验证后再考虑共用配置，不替换其已验证的资源/许可清单。
- 为新配置设计明确的 `noEmit` 类型检查入口；仅在构建机运行编译器。`npm run check` 与 `npm run check:node16` 保持各自语义：前者覆盖源码/构建检查，后者用 Electron 内嵌 Node 16 执行目标运行时回归；不得让后一项依赖构建机专用、不能在 Node16 运行的 TypeScript 编译器。若调整命令编排，需同步 `scripts/check-node16.js` 的命令解析及验证。
- 编译时避免引入未经验证的运行时 helper、自动 polyfill、原生模块或网络下载；逐项核对编译后导入、第三方依赖、许可、CSP、沙箱 preload 和 `source-protection.json` 覆盖率。测试和生产使用同一构建配置与产物；每次构建不复用未经摘要验证的旧产物。
- 改动程序功能或构建路径后依现有交付规则完成本机保护包、性能和安装程序镜像；明确发版才构建全部平台和升级版本。失败不替换有效旧包。构建产物、记录和 SHA-256 必须对应实际源码，不能把脏工作区标成纯提交。

## 验证与阶段退出标准

每批至少执行该模块的类型检查、行为回归、`npm run check`、`npm run check:node16`；涉及界面、流程、插件、持久化或传输时增加相应真实链路测试。检查必须覆盖取消和失败路径，而不是只检查类型能编译。重大执行路径应比较相同输入的事件序列、外部调用次数与持久化结果，校验历史快照、日志回放和旧插件行为。

交付验收还需核对固定运行时、真实受保护载荷、资源及第三方许可、签名/哈希、离线启动与相关平台行为；对启动、首屏、冷/热切换和重复切换资源使用按交付契约测量。区分构建机检查、内嵌 Node16、跨平台静态检查和 **Win7 真机**结果；未做的不能标为通过。对于数据与插件兼容，保留旧包、旧样本及可恢复用户数据，不能靠降级覆盖唯一有效安装。

每个批次的完成记录应列明：模块和责任人、源码提交、迁移前后公开接口、类型检查范围及例外、事件/数据兼容证据、运行时与包验证、性能结果、已知限制和可回滚版本。若类型正确但行为回归、保护覆盖不足或目标机兼容未验证，该批次不能宣称完成。

## 优先启动的首批任务

1. 在不干扰当前未提交工作的隔离变更中建立 P0 基线：列出执行入口、模块依赖及旧快照/插件样本，确认开发态、测试态和打包态目前各自加载的文件。
2. 对一个无 IO 的小型契约做 TS 样板，证明 CommonJS 导出与旧 JS 调用完全兼容；完成独立暂存、源码保护、Node16 和旧插件端到端验证。
3. 再选择一个 reducer 的单一事件链迁移，比较前后状态与持久化事实，覆盖错误输入和恢复。
4. 基于样板测量迁移成本，更新阶段拆分、依赖顺序和工作量，然后逐批推进。任何工具新增或版本变化另按项目依赖授权与兼容规则处理。
