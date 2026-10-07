---
name: nexa-deployment-plugin-change
description: Change NEXA AeroShield deployment code (packages/deployment-contracts, plugins/*, projects/software-mtzw0qhw-5gz0) and get the gates green. Use when editing the AeroShield digital-environment / scene plugins, adding or changing deployment contracts (State paths, Commands, Events, Capabilities, Ports), or when a NEXA workspace check/test/build must be run from WorkBuddy. Covers the local-pnpm workaround, the mandatory plugin dist rebuild + sha384 refill in three places, the contracts dist alias pitfall, and the exact gate list.
agent_created: true
---

# NEXA AeroShield 契约 / 插件改动工作流

## 何时用

- 改 `packages/deployment-contracts`（领域类型、State 路径、Command/Event/Capability 常量、Port、错误码）。
- 改 `plugins/digital-environment-modeling`（或后续其他 AeroShield 业务插件）。
- 改 `projects/software-mtzw0qhw-5gz0`（产品壳、Adapter、composition、UI）。
- 需要在 WorkBuddy 沙箱里跑 nexa 的 test / lint / typecheck / build / check:* 门禁。

仓库根：`/Users/ysuhan/Elon/Project/product/nexa`（**不是** WorkBuddy 工作区目录，工作区可能是空目录）。

## 坑 0：pnpm 必须先绕开 corepack

`which pnpm` 指向 corepack shim。corepack 要在 `~/.cache/node/corepack` 建目录，而 `~/.cache` 属 root → `EACCES`；把 `COREPACK_HOME` 指到可写目录又会卡在下载 pnpm（长时间无输出）。

直接调用本机已安装的 pnpm：

```bash
PNPM="/Users/ysuhan/Library/pnpm/.tools/pnpm/10.10.0/node_modules/pnpm/bin/pnpm.cjs"
node "$PNPM" --version      # 10.10.0
```

`package.json` 的 `packageManager` 是 `pnpm@10.10.0`，用这个版本才匹配。

需要递归调用（`check:architecture` 内部会调 `pnpm check:features`、`test:all` 内部递归）时，先在工作区建 PATH 前置包装脚本：

```bash
mkdir -p <workspace>/.bin
printf '#!/bin/sh\nexec /Users/ysuhan/.workbuddy/binaries/node/versions/22.22.2-3/bin/node %s "$@"\n' "$PNPM" > <workspace>/.bin/pnpm
chmod +x <workspace>/.bin/pnpm
export PATH="<workspace>/.bin:$PATH"
```

否则内层 `pnpm` 又回到 corepack shim 并失败。

## 坑 1：契约改了必须 `build:lib`，否则产品测试用的是旧 dist

`projects/software-mtzw0qhw-5gz0/vitest.config.ts` 把 `@nexa/deployment-contracts` **别名到 `../../packages/deployment-contracts/dist/index.js`**，插件与产品也按 `dist` 消费。

```bash
node "$PNPM" --filter @nexa/deployment-contracts run build:lib
```

改完契约不重建 → 测试报「导出不存在 / 行为是旧的」，很容易误判成业务代码写错。

`pnpm build` 的 `build:packages` 名单**已包含** `@nexa/deployment-contracts`（本轮补上的）；若在别的分支上发现没有，加回去。

## 坑 2：插件源改完必须重建，并把 sha384 回填到三处

`plugins/<name>/plugin.manifest.json` 的 `artifact.integrity` = **`dist/index.js` 的 sha384**（见 `scripts/release-plugins.mjs`）。

```bash
node "$PNPM" --filter @nexa/<plugin>-plugin run build
node -e "const c=require('crypto'),fs=require('fs');const b=fs.readFileSync('plugins/<name>/dist/index.js');console.log('sha384-'+c.createHash('sha384').update(b).digest('base64'))"
```

回填到**三处**，漏一处就前后不一致：

1. `plugins/<name>/plugin.manifest.json` → `artifact.integrity`
2. `plugins/<name>/src/manifest.ts` → `artifact.integrity`（构建后进 `dist/manifest.js`，运行时读的是它）
3. `projects/software-mtzw0qhw-5gz0/software.project.json` → `document.pluginPlan.plugins[].integrity` **和** `document.pluginManifests[].artifact.integrity`

同时把新命令 / 事件 / state 路径 / services / `requires.capabilities` 同步进 `manifest.ts`、`plugin.manifest.json`、`software.project.json` 的 `pluginManifests[]`——三份 manifest 内容必须一致。

好消息：`dist/index.js` 通过 `export ... from './manifest.js'` 再导出清单，所以**改 manifest.ts 不会改变 `dist/index.js` 的哈希**，摘要可以稳定回填。

改了插件源就必须重建 dist，否则产品测试跑的是旧插件（症状：command 报「不支持的操作」或走旧端口实现）。

## 坑 3：同一消息里对同一文件发多个 Edit 会静默丢改动

实测：一条消息里对同一文件发 4 个 Edit，返回都显示成功，但只有其中一部分落盘。**改完必须复核**（`Read` 或 `Grep` 关键行），不要凭「success」继续往下跑，否则会在很久之后以 `is not defined` 之类的运行时错误暴露。

## 坑 4：本环境 shell

- `grep --include=...` 与 BSD grep 的 `\|` 交替会静默失败或无输出 → 用内置 Grep 工具。
- `rg` 不存在。
- 环境变量赋值不会自动分词：`PNPM="node /x/y.cjs"; $PNPM --version` 在 zsh 下会失败，直接写全命令或用函数。
- 内置 Grep 工具对本仓库的 Markdown / JSON 也可能返回空（`^#{2,4}` 之类锚点匹配不到）→ 换普通关键字或直接 `Read`。

## 坑 5：新增 Command / Event 必须同步六个位置

漏一处就会出现「插件能跑、门禁红」或「清单与实现不一致」。清单：

1. `packages/deployment-contracts/src/commands.ts` / `events.ts` 常量数组
2. `packages/deployment-contracts/test/contracts.spec.ts` 的条数断言（`ENVIRONMENT_COMMANDS` 等 `toHaveLength`）——增量命名，改完立刻跑契约测试
3. `plugins/<name>/src/index.ts` 的 `context.commands.register`
4. `plugins/<name>/src/manifest.ts` 的 `permissions.commands` + `subscriptions.commands` + `permissions.events.publish`
5. `plugins/<name>/plugin.manifest.json` 同上三处
6. `projects/software-mtzw0qhw-5gz0/software.project.json` → `document.pluginManifests[0]` 同上三处（该文件的 pluginManifests 是**压缩单行 JSON**，直接 Edit 单行最省事）

另外 `plugins/<name>/src/__tests__/plugin.spec.ts` 里断言 `handlers.size` 的用例要跟着命令数一起改。

## 坑 6：两套错误字段名不一样，别混

- **Port / Provider 侧**（`portFail`）：字段是 `detail`（单数），如 `error.detail.reason`。
- **插件 CommandResult 侧**（`rejected`/`failed`）：字段是 `details`（复数），即 `error.details.reason`。

写测试断言时按被测对象选对；`toMatchObject({ error: { detail: { reason: ... } } })` 用于 Adapter，`{ error: { details: { reason: ... } } }` 用于插件。

## 坑 7：lint 与 typecheck 的两个反直觉点

- `pnpm typecheck` **包含**插件 `src/__tests__`，但 `tsconfig.build.json` 不含；所以测试里写错类型会让 `typecheck` 红、`build` 绿。给测试的辅助窄化类型（如 `type Outcome = {...}`）要预留用到的字段（`output` 等）。
- `.vue` 的 `<script setup>` 里**不能用 DOM 全局类型**（`HTMLSelectElement` 等会触发 `no-undef`）→ 用结构化断言代替：`const target = event.target as { value?: unknown } | null`。
- `@stylistic/object-property-newline`：多行对象字面量必须每个属性独占一行。`pnpm exec eslint --fix <file>` 可自动修，先 `--fix` 再手工处理剩余项最快。

## 坑 8：git 提交会被 pre-commit 钩子拦，pnpm 必须走真身

仓库用 `simple-git-hooks` + `pnpm exec lint-staged`。钩子里的 `pnpm` 若解析到 corepack shim，会因 `~/.cache/node/corepack` 属 root 报 `EACCES` 而**整条提交失败**。解法（**不要**用 `--no-verify` 跳过钩子）：

```bash
mkdir -p /tmp/yb-bin
printf '#!/bin/sh\nexec /Users/ysuhan/.nvm/versions/node/v24.15.0/bin/node /Users/ysuhan/Library/pnpm/.tools/pnpm/10.10.0/node_modules/pnpm/bin/pnpm.cjs "$@"\n' > /tmp/yb-bin/pnpm
chmod +x /tmp/yb-bin/pnpm
export PATH="/tmp/yb-bin:/Users/ysuhan/.nvm/versions/node/v24.15.0/bin:$PATH"
git commit -m ...        # 钩子现在能拿到真 pnpm
```

## 坑 9：本环境 shell 的 grep 不可信（含 plain grep）

`grep` / `rg` 走 shell 可能**静默返回空**——不只是 `grep --include`，**plain `grep -n "foo" file.ts` 也可能匹配不到实际存在的行**。判断符号/能力是否存在一律用内置 Grep / Glob 工具，或直接 `Read`。

## 坑 10：把 workspace 包别名到**源码**时，typecheck 会连带检查该包源码

产品 tsconfig 里若把 `@nexa/gis-cesium` 之类的包 `paths` 指向 `src/**`（而非 `dist` 类型），TS 会顺着 import 走进该包源码并逐文件检查。SDK 源码依赖**自己的环境增补声明**（`packages/gis-cesium/src/types/cesium-internal.d.ts`、`src/lib/cesium.d.ts`，为 `Scene._defaultView`、`cesium.Framebuffer`、`Viewer._clockViewModel` 等私有成员做 interface 合并），而这些 `.d.ts` 不在产品的 `include` 里 → 一堆 `TS2339 Property '_defaultView' does not exist` / `TS2694 Namespace 'cesium' has no exported member 'Framebuffer'`。

修法：把这两份增补 `.d.ts` 加进产品 `tsconfig.json` 的 `include`：

```json
"include": ["src/**/*.ts", "src/**/*.vue", "software.project.json",
  "../../packages/gis-cesium/src/types/cesium-internal.d.ts",
  "../../packages/gis-cesium/src/lib/cesium.d.ts"]
```

对照：`apps/earth-viewer` **不**别名 gis-cesium，直接走包 `exports` → `dist/types`，所以没这问题。子路径（`/draw`、`/utils-gis`）不在包 `exports` 里，只能用源别名 + 上面的 include 组合。

附：SDK 根入口会拖入 `cesium-heatmap-es6`（UMD，依赖 `window`），在 **node 测试环境**无法解析 → vitest 里只引纯计算子模块（如 `@nexa/gis-cesium/utils-gis` → `BufferAnalysis.ts`）。

## 提交前的门禁清单（按序）

```bash
node "$PNPM" --filter @nexa/deployment-contracts run test
node "$PNPM" --filter @nexa/<plugin>-plugin run test        # 与 typecheck、build
node "$PNPM" --filter @nexa/software-mtzw0qhw-5gz0 run test  # 与 typecheck、build
pnpm lint            # 期望 0 error；warning 数不得比上轮增加
pnpm typecheck
pnpm build
pnpm test:all
pnpm check:architecture
pnpm check:composition   # 输出「已检查 N 个文件」
pnpm check:features
pnpm context:check       # 输出任务数与 activeFocus
```

改 GIS 公共 API（`packages/gis-cesium`）时追加 `build:lib`、`check:governance`、`docs:build`，并按 `docs/specs` 与方案 §11 补齐类型 / 公共导出 / 测试 / 示例 / JSDoc / VitePress / 治理门禁。

## 语义约定（容易搞错）

- **State 路径单写者**：`STATE_OWNERS` 每条路径一个 owner；插件只能写自己 owner 的路径，越权抛 `PERMISSION_DENIED`。新增路径要同步改 `state-paths.ts` **和** `packages/deployment-contracts/test/contracts.spec.ts` 的路径条数断言。
- **错误码收敛**：只能用 `DEPLOYMENT_ERROR_CODES` 锁定清单里的码；精确原因放 `error.details.reason`（`PluginContext` 的 `CommandError` 支持 `details`），**不要**扩充错误码清单，也不要再用 `LAYER_NOT_FOUND` 之类的历史自定义码。
- **插件只依赖 Port**：Capability → Provider 实例 id 的映射在 `src/kernel/createPluginHost.ts`；新增 Capability 时在那里注册 Provider id，并加进插件 manifest 的 `permissions.services`。
- **持久化归 Runtime**：`src/composition/persistence.ts` 的 `PERSISTENT_STATE_PATHS` 白名单决定刷新后恢复什么；会话级历史（如 importTasks）刻意不入白名单。新增业务事实要同时把对应 revision 纳入，否则刷新后过期判定失效。
- **恢复后必须重投影**：`createProductRuntime` 的 `start()` 里要把恢复的图层 / 区域重新推给 GIS Adapter，否则 State 有数据、地球是空的。

## 汇报口径

严格用例口径由用户掌握（AeroShield 共 24 个用例）。只有「真实能力 + 页面级证据」都具备才计 1，**不得用 Runtime 级测试或可验证投影冒充页面验收**。

**重要更正（2026-09-17）**：此前把 0/24 归因为「`gis-cesium/core/plugins` 无绘制 mixin、`@nexa/earth-viewer` 未暴露拾取通道」是**错的**。经内置检索逐文件复核：库内**已有** `core/draw/DrawManager`（点/折线/面/矩形逐点绘制）、`core/draw/MilitaryPlotEditor`（折线/面/圆 + 顶点拖拽 + 选中高亮 + `positionPicker` 注入）、`core/utils-gis/BufferAnalysis` + `createBufferRing`（`@turf/turf` 真实缓冲 + 实体渲染）、`core/mouse-events/MouseEvents`（拾取回调含 `cartographic{longitude,latitude,height}`），且 `earth-viewer` 通过 `spatial.viewer/1` 端口把 **raw Viewer** 直接交给宿主（`earthViewerOf(ctx) → Viewer`）。真正的缺口是**产品侧 `src/adapters/gis/*` 从未接线**（几乎全是 `portOk(null)` 桩），加上项目内 `plans/gis-capability-audit.md` 曾是一份**虚构文档**（登记 13 个不存在的 mixin）。
**改 GIS 相关方案前必须先做一遍真实文件检索，不要采信任何「能力清单」文档。**

**接线进展（2026-09-18）**：产品侧 GIS Adapter 已完成真实 Cesium 接线——`src/adapters/gis/cesiumGeometryEdit.ts` 用 `viewer.entities` + `DrawManager` 渲染/交互，`geometryBuffer.ts` 改用 `createBufferRing`，`createProductRuntime` 经 `spatial.viewer/1` 解析宿主 Viewer。严格口径仍 **0/24**，剩余阻塞项是**页面级（浏览器点击）走查未实测**与 UC-ENV-01 真实图层加载器、`MilitaryPlotEditor` 节点拖拽未接——属工作量，非能力缺口。
