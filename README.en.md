# Agent

[简体中文](README.md) | [English](README.en.md)

A local Agent built on the actual Cordis runtime for offline intranet use, with Windows 7 SP1 x64 as the minimum supported Windows platform. Models can run on an intranet server; workspace, file and command operations execute on the machine hosting the Agent service.

Previously named DSH Agent, the repository retains the directory name `dsh-win7-agent`. See the delivery documentation for legacy data migration and preservation rules.

## Features

- Streaming conversations, multiple sessions, history, cancellation and context compression.
- Workspace file reading, writing, editing, search and local commands, subject to permissions and human approval.
- A project can associate multiple workspace folders. In Edit Workspace, any associated folder opens in the system file manager; non-desktop pages copy the path rather than attempting to open a remote machine folder.
- Workflow canvas, node configuration, human tasks, execution instances, schedules and artifact archiving.
- SQLite knowledge bases, document import, retrieval and version records.
- Built-in document MCP for basic Word and Excel operations, plus trusted local stdio and intranet Streamable HTTP MCP servers.
- On-demand Skills and tool/runtime plugins with Cordis-managed lifetimes.
- A desktop shell that manages a local Agent service by default, with an optional remote intranet service mode.

Availability depends on enablement, permissions, runtime requirements and actual invocation results. Built-in Excel tools store formulas without evaluating them; document tools do not provide a full Office layout engine.

Sidebar counts for knowledge bases, the capability center and workflows use numbers only (`0` for an empty list). Knowledge-base counts load asynchronously at startup and update when knowledge changes, without first opening the page; hidden pages do not poll the full list.

## Ordinary conversations and project directories

Ordinary conversations use a separate `recentWorkspacePath` (by default, `workspace` under the user-data directory), not the active project's directory or a project path left in an old conversation. Loading or saving settings repairs ordinary defaults that point into a project directory; historical messages remain unchanged. Creating an ordinary conversation never reuses an empty project conversation, and switching projects does not retarget other sessions' established execution directories. Project conversations retain their associated folder; knowledge conversations use their server-owned bound directory. Commands retain existing permissions and approval; this is not an operating-system sandbox.

## Compatibility and offline operation

The shipped runtime is pinned to **Electron 22.3.27 / Node 16.17.1 / Chromium 108**. Do not automatically upgrade it, add unauthorized production dependencies or download runtime components on target machines. Client resources ship with the application; model and external tool services use configured trusted intranet addresses.

Target Windows machines do not need Node.js, npm or Python installed. Static compatibility checks, embedded Node tests and tests on real Win7 hardware must be reported separately. A successful build does not prove target-machine compatibility.

See the [TypeScript refactoring plan](docs/TYPESCRIPT-REFACTOR-PLAN.md) for migration phases, compatibility boundaries, and acceptance criteria.

## Development

Use Node.js 20.19.5 or newer and npm on the build machine. This does not change the embedded target runtime. Initial dependency and packaging-tool setup may require network access; prepare those resources before building offline.

```bash
npm ci
npm start
```

Configure the model Base URL, API key and model name in application settings. An example Base URL is `http://SERVER:11434/v1`. An OpenAI-compatible `/v1/chat/completions` endpoint with tool calling is recommended.

### Model networking and proxies

Model catalog, OpenAI-compatible chat and Ollama requests use the network of the **machine hosting the Agent service**. Explicit environment variables take priority, followed by the current user's manual HTTP/HTTPS system proxies on macOS or Windows; Linux uses environment variables. The order is `AGENT_MODEL_PROXY`, `AGENT_HTTPS_PROXY` / `AGENT_HTTP_PROXY`, `HTTPS_PROXY` / `HTTP_PROXY` (and lowercase forms), `AGENT_PROXY`, then `ALL_PROXY` / `all_proxy`. Values may be HTTP or HTTPS proxy URLs; `direct` / `off` explicitly selects direct connections, and empty values are ignored. There is no model proxy setting in the UI. System discovery reads only the proxy host and port; it does not retrieve keychain or integrated proxy credentials. System proxy changes take effect after a short cache period.

Loopback, private IP literals, single-label hostnames, `.local`, `.home.arpa` and entries in `NO_PROXY` / `no_proxy` always connect directly; system proxy exception lists are also honored when using system proxies. Other domains resolving to private addresses are not automatically recognized; add them to the bypass list. Proxy errors, system discovery failures and detected but unsupported PAC/WPAD or SOCKS-only configurations are reported; not every Windows automatic-detection setting can be detected. Configure a trusted HTTP(S) proxy or use a validated system networking solution for those cases. Linux desktop proxies, Windows WinHTTP, MCP/tools/browser traffic and other applications are outside this adapter's scope.

HTTPS model requests use CONNECT and retain target TLS certificate and hostname verification. A proxy can read plaintext HTTP model traffic, so do not use it for sensitive information. Configure trusted intranet proxies, models and certificates; do not disable certificate verification.

### Reconnecting a conversation's model request

Within an Agent conversation, transient connection loss, TLS handshake disconnects, interrupted response streams, timeouts and HTTP 408/502/503/504 trigger up to five automatic retries by default (at most six requests per model step, with waits of 1, 2, 4, 8 and 16 seconds; request durations are additional). The conversation shows reconnect progress and can be stopped. Whole-turn deadlines and unattended request, token and output budgets still apply. Authentication, certificate and proxy configuration errors and HTTP 429 are not automatically retried. Exhausting the limit ends the current turn with a message, while retaining the conversation and completed tool results so work can continue after the network recovers.

Reconnection reissues the **current model request**; it does not resume the server's original byte stream. Incomplete text or tool-call fragments are discarded and completed tool steps are not automatically replayed. OpenAI-compatible SSE must terminate with `[DONE]` or a `finish_reason`, and an Ollama stream must terminate with `done: true`; otherwise it is treated as interrupted. The server may have processed or billed the failed request, so retries can add charges. The model may independently propose another tool call afterwards; this is not an exactly-once guarantee across process crashes. The mechanism covers model requests in the Agent conversation loop, not model catalog, MCP, browser or other application traffic.

### Generative UI

The P0–P4 source path now covers the bounded Surface/Component/State/Action protocol, mixed messages, versioned session facts, Vue/Naive UI/ECharts rendering, durable parameters, unified confirmation, Agent feedback, streamed revisions, cancellation and recovery. Before sending, the normal client advertises the renderer versions and components it supports; the model receives only the matching tools and guidance. Without a renderer the app stays text-only and exposes no `render_ui`/`update_ui`. Legacy v1 messages remain readable; v2 adds filter, table, progress, flow, offline map and sandboxed static page components. Generated HTML/SVG/CSS can render directly in the chat while scripts, forms, links and network access are disabled. Unknown future versions remain opaque and are never executed.

The map uses the explicitly authorized, pinned `cesium@1.104.0` offline bundle. It shows an ellipsoid and place markers without imagery or terrain and ships fixed local IAU data; unavailable WebGL or context loss falls back visibly to a longitude/latitude diagram. Vue, Naive UI, ECharts, Vite, the Vue plugin, TypeScript and Cesium are pinned development dependencies; actual browser code is distributed offline with third-party licenses. The root `@types/node` was restored to `16.18.126` under explicit authorization. Isolated Electron 22.3.27/Node 16.17.1/Chromium 108 tests cover real components, business selections, maps and fallback, narrow-screen touch, CSP and offline resources. Windows 7 hardware, Android WebView, OS input methods and screen readers are not yet accepted. Actions still require a matching server-confirmed definition, saved parameters and an idle session; subsequent tools retain existing permissions and approval. See the [Generative UI protocol](docs/GENERATIVE-UI.md).

## Validation

For routine changes, check the changed files and select one relevant regression instead of automatically running full acceptance or packaging:

```bash
npm run check:syntax -- src/renderer/app.js src/renderer/knowledge.js
npm run check:footer
# Select relevant Node16 suites only when target-runtime boundaries are affected
npm run check:node16 -- renderer-smoke web-bridge-smoke
# Preview the suite list without executing tests or verifying the runtime
npm run check:node16 -- --list
```

`check:syntax` checks syntax only, not behavior; without file arguments it still scans the original source directories. `check:node16` uses Electron's embedded Node 16.17.1 and accepts suite names or paths such as `scripts/renderer-smoke.js`; unknown targets fail immediately and duplicates run once. Checks report actual elapsed time. UI changes use the relevant real-window regression (such as `check:footer`), without stacking every UI test on top.

Run full acceptance once for an agreed feature batch or explicit delivery, selecting additional checks as needed:

```bash
npm run check
npm run check:node16
# Optional selections; check already includes typecheck:core and check:adaptive
npm run typecheck:core
npm run check:adaptive
npm run check:workflows:properties:browser
npm run check:workflows:canvas:browser
```

Without arguments, `check` and `check:node16` retain their full scope; targeted checks are not full acceptance. Preserve focused regressions for permissions, persistence, recovery, CSP and signatures. Build-host or embedded Node16 checks do not replace target-system testing. Generate installers only when packaging, delivery or a release is explicitly requested; delivery still requires complete protection, manifest, hash and signature verification.

## Build and delivery

```bash
npm run build:desktop:win
# Build all five targets when explicitly preparing a release
npm run build:desktop
```

| Platform | Default delivery entry |
| --- | --- |
| Windows x64 | `release/desktop/Agent-win-x64/Agent.exe` |
| macOS Apple Silicon | `release/desktop/Agent-mac-arm64/Agent.app` |
| macOS Intel | `release/desktop/Agent-mac-x64/Agent.app` |
| Linux x64 | `release/desktop/Agent-linux-x64/Agent.AppImage` |
| Linux ARM64 | `release/desktop/Agent-linux-arm64/Agent.AppImage` |

The Windows `Agent.exe` is a complete offline installation and launch entry; installed applications use stable locations and shortcuts. A macOS `.app` is a standard application bundle. Linux requires verification of system dependencies and executable permissions.

Each platform directory contains one delivery entry. Shared checksums are stored in `release/desktop/SHA256SUMS.txt`, and intermediate output is stored in `release/.desktop-build/`. Staged candidates and published deliveries have separate audit reports. Legacy ZIP output is only for explicitly requested internal diagnostics. Routine tasks do not automatically bump versions. Delivery responses provide a clickable absolute link to the containing package directory.

The default pipeline includes minification, obfuscation, per-module protection and manifest validation. ASAR is not encryption, and embedded keys cannot guarantee secrecy. Release packages enforce offline licensing; missing license public keys must fail the build. Trusted online updates, signing and rollback require separate acceptance; local package takeover is not proof of a completed online updater.

## Data and security

- Desktop service data lives under `agent-home` in Electron's user data directory. Standalone services use `AGENT_HOME`. Updates must preserve sessions, knowledge bases and offline extension packages.
- In remote service mode, workspaces reside on the service machine. Local files are not automatically synchronized to the remote server.
- Models receive the context, file content and tool results required for a task. Use trusted model services and appropriate write/command approval.
- Session recovery restores context without automatically replaying uncertain external side effects.

## Extensions and architecture

Contracts, pure flow policy, the state reducer and upper execution plugins form separate layers. Cordis manages assembly and lifetimes. New capabilities are registered as runtime services/plugins; existing tool plugins retain compatibility adapters.

Skills provide instructions, MCP defines a tool protocol, and plugins implement runtime capabilities. Offline extensions share formatVersion 1 manifests: `.skill.pgk`, `.mcp.pgk` and `.plugin.pgk`, with legacy `.agentpkg` compatibility. Installation and activation are separate operations.

## Documentation and collaboration

- [Project rules](AGENTS.md): future Git commit subjects and bodies use Chinese, retaining technical identifiers where needed. Maintain both README language versions together.
- [Architecture](docs/ARCHITECTURE.md)
- [Generative UI protocol and stage status](docs/GENERATIVE-UI.md)
- [Long-term memory and adaptive Agent](docs/ADAPTIVE-AGENT.md)
- [Win7 compatibility](docs/WIN7-COMPAT.md)
- [Desktop delivery, updates, source protection and performance](docs/DESKTOP-DELIVERY.md)
- [Offline extension packages](docs/EXTENSION-PACKAGES.md)
- [Plugin development](docs/PLUGINS.md)
- [Software licensing](docs/SOFTWARE-LICENSING.md)
- [Standalone service deployment](server/README.md)

## Install from the repository

The repository mirror directory contains the [Windows x64 offline installer](installers/Agent-win-x64/Agent.exe) and the [macOS Apple Silicon app](installers/Agent-mac-arm64/Agent.app). Platform builds may have different source states; see the [installer guide and build records](installers/README.md). An Electron file inside the Mac app exceeds GitHub’s per-file limit for ordinary Git pushes, so remote distribution requires a separate solution. This directory does not use LFS pointers.

See [desktop security](docs/DESKTOP-SECURITY.md) for renderer isolation, IPC validation, signed code manifests, and short license request labels. Initialize the separate build signing identity with `node scripts/desktop/release-signing.js init`; its private key stays on the build host and is never shipped. Official platform certificates and trusted online updates still require separate setup and acceptance.

The license issuer supports desktop and intranet browser access with the fixed `admin` / `admin123` account and no registration. Signing and private keys stay on the owner computer; the signed-in page shows LAN addresses. Closing the issuer stops its service. See [licensing](docs/SOFTWARE-LICENSING.md).

Workflow canvases redraw when sidebar or properties-panel dimensions change while preserving node positions and viewport. Workflow pages hide the chat/project caption and restore it when returning to chat. Layout arrangement has no success banner; workflow context and composer surfaces use subtle theme-aware fills without borders.

A new workflow starts with a start and an end node already wired together, so it can be saved right away; pick “Blank workflow” under “More creation options” to build from an empty canvas. The canvas toolbar has two line icons: “Connection” draws a normal flow edge from a port, while “Rejection” is added the same way by dragging — hold on the node (or one of its inbound connections), drag to an upstream human step and release to set the return target. The “Connection settings” panel on the right and the connection context menu configure the same target. A connection-level target takes precedence over the node-level setting, and removing a referenced human step clears the reference automatically.

The bundled `workflow-process-designer` Skill adapts a pinned official Camunda BPMN Skill and OMG BPMN 2.0.2 modeling principles to local approvals, rejection/correction, and resubmission. The workflow catalog provides the enabled guide on demand; it can be disabled in the capability center. A standard offline `.skill.pgk` is available. See [design Skill provenance and limits](docs/WORKFLOW-DESIGN-SKILL.md).

The bundled `workflow-suggestion` Skill receives a live, read-only saved-workflow summary automatically on every ordinary conversation turn (up to 50 entries and approximately 16,000 characters; truncation is explicit and missing details are retrieved on demand). Users need not say that a workflow exists, and discovery does not require a preliminary file search or catalog call. The model compares meaning, goal, steps, human checkpoints and deliverable; unspecified details in a short task are not contradictions, explicit constraints take precedence, and matching quality still depends on the selected model. Only a genuine fit triggers `workflow_suggest`. Its actionable card appears in the chat body, outside collapsed execution details, and is restored from actual tool records when revisiting the conversation. Cards contain only the name, revision and actions, including an optional workflow-panel action. Follow-up text is concise and mentions only necessary inputs or real risks, not repeated checklists or startup tutorials. Actions retain readable hover, keyboard-focus and disabled states in both themes. Suggesting is read-only: it never edits definitions or creates instances. Clicking starts the run and keeps its forms in the current conversation without automatic navigation.

A run started in chat is linked to its originating conversation; current and subsequent human tasks appear there without automatically creating an execution conversation. A conversation can retain references and results for multiple runs, and clicking an unfinished workflow again does not start a duplicate. Schema forms, attachments, review, approval and rejection with a reason use the original workflow service and current taskId validation. Submission continues the original run, reload restores actual execution records, and AI does not submit on the user's behalf. The workflow panel opens on demand and returning preserves the unsubmitted chat form. Legacy dedicated execution conversations remain readable. When another conversation is selected, new replies (including streaming replies) or workflow records add an unread dot at the top-right of the original conversation row; it survives reload and clears after opening and reading that conversation.

Complex coding tasks keep the existing Cordis Agent and `update_plan`, guiding the model through a concise plan, relevant files and constraints, a minimal change, the nearest meaningful check, and fixes based on real errors. Progress reports use actual tool results, verification evidence and blockers. This neither displays nor fabricates private chain-of-thought, nor establishes model capability equivalent to Claude.

Conditional nodes select the first matching rule or the default exit; merge nodes accept the active path. Resubmission reevaluates routing while preserving history. Unselected paths do not execute. Parallel approvals and role-based approval permissions remain unsupported.

The license authority displays clickable LAN URLs with individual copy buttons for sharing with intranet administrators.

Saved AI workflow drafts expose Edit and Start actions. Starting opens a real workflow instance and its human task; approvals remain manual.

Shared borders and separators use subtler neutral colors in both light and dark themes.

Workflow links transition from blue outputs to green inputs, with ports aligned to card edges and consistent direction colors in editor and execution graphs.

Workflow graphs distinguish forward branches using solid arrows with named exits, so a skipped approval is never mistaken for a rejection. A dashed reverse arrow labeled with its return target is drawn only when a human node explicitly configures that rejection target; the runtime still falls back to the nearest upstream handling step, but no automatic cable is derived, so a plain sequential edge is never read as a rejection. Rejection overlays do not add cycles to executable graphs.

The canvas context menu is target-aware: on empty space it restores 100% zoom or fits the whole graph, on a card it deletes that node together with its cables, and on a cable it deletes just that connection. Deletions only change the current draft and take effect after saving.
