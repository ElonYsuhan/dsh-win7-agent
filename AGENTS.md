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

- 每次完成修改后，必须在交付前重新打包，确保交付产物包含本次最终修改；
  不得仅更新源码后让用户继续使用旧包。至少重新构建当前 Mac 平台包；
  涉及其他平台或用户指定的平台时，也必须构建对应平台包。
- 默认交付解压后的 Mac 运行程序 `Agent.app`，不能只给 ZIP。
  根据本机架构选择 `mac-arm64` 或 `mac-x64`，保留最新版的解压目录，
  并在最终回复中提供 `Agent.app` 的绝对路径链接。无需自动启动应用。
- 打包后核对包内修改文件与最终源码一致；清理历史产物时，必须保留
  最新版压缩包、校验文件，以及默认 Mac 版的解压运行程序。
- 如果打包失败，修复后重试；无法完成时明确说明阻塞，不能宣称已交付新版。
