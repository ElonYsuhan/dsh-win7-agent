# Agent

[简体中文](README.md) | [English](README.en.md)

A local Agent built on the actual Cordis runtime for offline intranet use, with Windows 7 SP1 x64 as the minimum supported Windows platform. Models can run on an intranet server; workspace, file and command operations execute on the machine hosting the Agent service.

Previously named DSH Agent, the repository retains the directory name `dsh-win7-agent`. See the delivery documentation for legacy data migration and preservation rules.

## Features

- Streaming conversations, multiple sessions, history, cancellation and context compression.
- Workspace file reading, writing, editing, search and local commands, subject to permissions and human approval.
- Workflow canvas, node configuration, human tasks, execution instances, schedules and artifact archiving.
- SQLite knowledge bases, document import, retrieval and version records.
- Built-in document MCP for basic Word and Excel operations, plus trusted local stdio and intranet Streamable HTTP MCP servers.
- On-demand Skills and tool/runtime plugins with Cordis-managed lifetimes.
- A desktop shell that manages a local Agent service by default, with an optional remote intranet service mode.

Availability depends on enablement, permissions, runtime requirements and actual invocation results. Built-in Excel tools store formulas without evaluating them; document tools do not provide a full Office layout engine.

## Compatibility and offline operation

The shipped runtime is pinned to **Electron 22.3.27 / Node 16.17.1 / Chromium 108**. Do not automatically upgrade it, add unauthorized production dependencies or download runtime components on target machines. Client resources ship with the application; model and external tool services use configured trusted intranet addresses.

Target Windows machines do not need Node.js, npm or Python installed. Static compatibility checks, embedded Node tests and tests on real Win7 hardware must be reported separately. A successful build does not prove target-machine compatibility.

## Development

Use Node.js 20.19.5 or newer and npm on the build machine. This does not change the embedded target runtime. Initial dependency and packaging-tool setup may require network access; prepare those resources before building offline.

```bash
npm ci
npm start
```

Configure the model Base URL, API key and model name in application settings. An example Base URL is `http://SERVER:11434/v1`. An OpenAI-compatible `/v1/chat/completions` endpoint with tool calling is recommended.

## Validation

```bash
npm run check
npm run check:node16
npm run check:workflows:properties:browser
npm run check:workflows:canvas:browser
```

Add relevant real UI, runtime and target-system checks for each change. `check:node16` runs tests using Electron's embedded Node 16.17.1.

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

Each platform directory contains one delivery entry. Shared checksums are stored in `release/desktop/SHA256SUMS.txt`, and intermediate output is stored in `release/.desktop-build/`. Legacy ZIP output is only for explicitly requested internal diagnostics. Routine tasks do not automatically bump versions. Delivery responses provide a clickable absolute link to the containing package directory.

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
- [Win7 compatibility](docs/WIN7-COMPAT.md)
- [Desktop delivery, updates, source protection and performance](docs/DESKTOP-DELIVERY.md)
- [Offline extension packages](docs/EXTENSION-PACKAGES.md)
- [Plugin development](docs/PLUGINS.md)
- [Software licensing](docs/SOFTWARE-LICENSING.md)
- [Standalone service deployment](server/README.md)
