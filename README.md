# Agent

A small Windows 7 compatible local coding agent. Renamed from `DSH Agent`; the
repository directory keeps its historical name `dsh-win7-agent`, and an install
made under the old name migrates its data directory on first launch.

The model can run on a remote server. The agent, workspace, file tools and shell
commands stay on the Windows machine.

> **硬约束：所有开发必须在 Windows 7 SP1 x64 可运行的前提下进行。**
> 运行时上限为 Electron 22.3.27 / Node 16.17.1 / Chromium 108，禁用 API 与验收命令见
> [docs/WIN7-COMPAT.md](docs/WIN7-COMPAT.md)。提交前必须完成该文档第 6 节的验收清单。

> **硬约束：本产品全部功能在内网（离线）环境使用，禁止依赖任何互联网资源。**
> 客户端不得引用外网 http(s) 资源（CDN、外链字体、在线脚本、在线数据服务等）；
> 一切资源必须随包分发，或只使用系统本地能力。
> `npm run check:win7` 中的 OFFLINE_PATTERNS 守卫会扫描客户端外链引用，命中即失败。

## What it does

- Electron 22 shell for Windows 7 SP1 x64.
- Local directory picker.
- Local file read, write, edit, directory listing and text search.
- Local shell command execution through `cmd.exe` on Windows.
- OpenAI-compatible chat completions client with streaming.
- Human approval for file writes and command execution.
- Session history stored under Electron userData.

## Requirements

Build machine:

- Node.js 20.19.5 or newer for building. The desktop packaging script rewrites
  the Windows exe's icon and version resources with `resedit`, which requires it.
  The build machine and the target machine are unrelated: what ships inside the
  bundle is still Electron 22's Node 16.
- npm.
- Internet access for the first `npm install`.

Target machine:

- Windows 7 SP1 x64.
- No Node.js, npm, Python or dsh installation required.

Model server:

- Any OpenAI-compatible `/v1/chat/completions` endpoint.
- A model with tool calling support is strongly recommended. If the model
  cannot use native tools, the agent still sends tool definitions but results
  depend on the model.

## Development

```bash
npm install
npm start
```

Open Settings in the app and configure:

- Base URL: `http://SERVER:11434/v1`
- API Key: any string for Ollama
- Model: `qwen3.5:4b` or another tool-capable model

## Build Windows package

Run on Windows x64:

```bash
npm install
npm run dist:win
```

Artifacts are written to `release/`.

## Security notes

This tool can read files inside the selected workspace and can run commands.

- Keep the workspace directory narrow.
- Keep write and command approval enabled unless you trust the model output.
- The remote model receives file contents and tool results that are needed for
  the task.
- Do not expose Ollama or the model endpoint directly to an untrusted network.
  Use a gateway, token or VPN.

## Current limitations

- No automatic updates.
- No built-in diff viewer yet. Tool results show changed content.
- The shell tool uses `cmd.exe` by default. PowerShell and Git Bash detection
  can be added later.
- Native tool calling must be provided by the server-side model.

## Offline deployment

The target Windows 7 machine needs no internet and no package manager.

Build once on an internet-connected Windows x64 machine:

```bat
npm install
npm run dist:win:portable
```

Then copy this one file to the intranet:

```text
release\Agent-0.1.0-x64-portable.exe
```

The portable exe contains Electron, the agent code and the renderer UI. It does
not download anything at runtime.

The agent only talks to the configured model Base URL. Point that Base URL to
an internal server address. No external internet access is required.

## Offline server + shell architecture

The repository now contains two thin layers for an offline intranet deployment:

1. server/ - agent service. It runs on the server and owns the workspace.
2. shell/ - Electron thin shell. It only loads the configured service URL.
3. The model service is external. Configure its OpenAI-compatible endpoint in
   the service Settings page.

### Server

Build a Linux amd64 image on an internet-connected machine:

```bash
docker buildx build --platform linux/amd64 -t dsh-agent-service:0.1.0 -f server/Dockerfile .
docker save dsh-agent-service:0.1.0 -o release/server/dsh-agent-service-0.1.0-linux-amd64.tar
```

Offline server:

```bash
docker load -i release/server/dsh-agent-service-0.1.0-linux-amd64.tar
docker compose -f server/docker-compose.yml up -d
```

The service listens on port `8080`. Open `http://SERVER_IP:8080` and set the
model Base URL.

That tar is a build output, not something checked in — see `npm run clean:release`.

### Electron shell

`shell/` is the shell source; the portable bundle to hand out is produced by
`scripts/build-desktop.js` (see "Desktop builds" below):

```text
release/desktop/Agent-win-x64-0.1.2.zip
```

Unpack it and run `Agent.exe`. The shell starts the local agent service
itself and picks a free port, so nothing else needs to be running. To point at
a service on another machine instead, switch the service mode to `remote` in
the settings dialog.

The older split into `DSH-Win7-Shell` / `DSH-Win7-Service` / `DSH-Win7-Agent-Plugin`
bundles is gone — one desktop bundle now covers all three roles.

### Workspace

By default the workspace is a server directory:

```text
$AGENT_HOME/workspace
```

The browser UI can change it through the workspace prompt. If a local Windows
workspace is required, it must be added as a separate sync or mount layer.

## Desktop builds (no install, double-click to run)

`scripts/build-desktop.js` produces one portable desktop bundle per platform.
The thin shell and the agent service share **a single** Electron runtime: on
startup the app re-launches its own binary with `ELECTRON_RUN_AS_NODE=1` to run
`service/index.js`. There is no second executable and no second 220 MB copy.

```bash
node scripts/build-desktop.js win-x64        # Win7 SP1 / Win10 / Win11
node scripts/build-desktop.js mac-arm64      # macOS Apple Silicon
node scripts/build-desktop.js linux-x64      # Linux x64
node scripts/build-desktop.js all            # the three above
node scripts/build-desktop.js mac-x64        # macOS Intel (opt-in, not in `all`)
```

Artifacts land in `release/desktop/` and are named after the platform people
actually recognise — `Agent-mac-arm64-0.1.2.zip`, not `darwin`. Unpacked
bundles use versioned directories, such as `Agent-mac-arm64-0.1.2/`, so building
a new release does not replace a running copy of an older release:

```text
release/desktop/Agent-win-x64-0.1.2.zip    Win7 SP1 / Win10 / Win11
release/desktop/Agent-mac-arm64-0.1.2.zip  macOS Apple Silicon
release/desktop/Agent-linux-x64-0.1.2.zip  Linux x64
release/desktop/Agent-linux-arm64-0.1.2.zip Linux ARM64
```

`darwin-arm64`, `macos-arm64` and plain `mac` are accepted as aliases on the
command line. `all` ships one macOS bundle only (Apple Silicon); the Intel build
is available on demand but costs another 88 MB runtime for a machine class we do
not target.

### Icons

Each platform gets its own mark, generated by `scripts/make-logo.py`
(Pillow + numpy; run it with `npm run make:icons`) into `assets/icons/`:

| Mark | Platform | Where the build puts it |
| --- | --- | --- |
| AM | macOS | `Agent.app/Contents/Resources/electron.icns` |
| AL | Linux | window icon, read at runtime from `assets/icons/al.png` |
| AW | Windows | rewritten into `Agent.exe`'s icon resource, plus the window icon |

The in-app brand mark `src/renderer/logo.png` is overwritten with the matching
platform PNG while packaging, so a macOS bundle never shows the Windows mark.

The Windows step uses `resedit` (pure JS — no Wine, so a Windows package can be
built from macOS) to rewrite the exe's icon group and version info. That drops
Electron's Authenticode signature, which is unavoidable: editing resources
invalidates it and this repo has no certificate. `CompanyName` / `ProductName` /
`FileDescription` all become `Agent`, so the taskbar tooltip and the file
properties dialog stop saying `Electron`. Packaging therefore needs Node
20.19.5+ on the build machine; if a run reports the icon was skipped, that is
why.

`release/` holds exactly two things:

```text
release/desktop/*.zip     the bundles you hand out        (~290 MB)
release/.electron-dist/   Electron runtime build cache    (~960 MB)
```

Everything else a build creates — the per-target unpacked staging directories
(~650 MB) — is disposable. Clean it with:

```bash
npm run clean:release          # drop staging, keep the cache
npm run clean:release:dry      # show what would go
node scripts/clean-release.js --drop-cache   # also drop the cache
```

Keep the cache: it is the only part that needs the network to rebuild, and
`scripts/shell-page-smoke.js` uses it as the Electron runtime for the shell
page smoke test.

### Startup sequence and port handling

1. Probe ports starting at `8080` with `GET /api/health` (400 ms timeout each).
2. If the port answers `{"app":"dsh-agent-service"}` it is **our own** service
   already running -> reuse it, never start a second one.
3. If the port is taken by anything else -> try the next port, up to `8099`.
4. All candidate ports busy -> show an explicit error page instead of a blank
   window.
5. Otherwise spawn the service, poll `/api/health` until ready, then load the UI.

Two safety nets: the service itself catches `EADDRINUSE` and walks forward up to
20 ports, reporting the real port on stdout (covers the race between probing and
spawning); and the shell reads that line so it always connects to the truth.

The last port that worked is remembered, so later launches probe it first.

### Shutdown

Only the service that *this* app started gets stopped; a service it reused (for
example one you started by hand) is left alone.

Exit paths covered: window close / `Cmd+Q` (Electron `before-quit`),
plus `SIGTERM` / `SIGINT` / `SIGHUP` and a synchronous `process.on('exit')`
fallback — Electron exits immediately on `SIGTERM` without firing `before-quit`,
which would otherwise leave an orphan service sharing the same data directory.

### Service mode

Stored in the app config, switchable from Service Settings (`Cmd+,` on macOS,
`Ctrl+,` on Windows/Linux, or the settings button on the startup/offline page):

- `local` (default): autostart and manage a service on this machine.
- `remote`: point at an agent service on another intranet machine.

Native application menus are removed on all desktop platforms. Electron 22 on
macOS requires replacing the native menu with an empty instance. Copy, paste,
undo and window shortcuts remain available. The independent 48px titlebar keeps
window controls and page actions above the chat and file panel. macOS keeps
native controls on the left; Windows uses controls on the right; Linux reads
the GNOME/KDE button-side preference and defaults to the right. The dark theme
uses neutral gray and black surfaces, while the light theme uses white and
light gray. Buttons use flat fills and theme selection also updates auxiliary
windows and their native backgrounds. Run `npm run check:theme` for the real
Electron appearance and contrast checks. Sending the first message creates
and saves a session automatically, including workspaces without a project.

Data (sessions, settings, workspace) lives in the Electron userData directory
under `agent-home` — never inside the program folder, so the bundle stays
read-only and portable.

### Updating: double-click the new bundle

There is no in-app updater and nothing is downloaded. Hand out the new bundle;
the user opens it, and it takes over the old one.

On every launch the app records where it runs in `<userData>/install.json`
(`path` / `version` / `pid`). When the recorded path is not the current one —
i.e. the user just double-clicked a *different* copy — the app shows a
replace prompt instead of the chat UI:

1. stop the running old instance (its whole process tree, service included);
2. rename the old directory aside, which doubles as a file-lock probe — on
   Windows a directory holding an open executable cannot be renamed;
3. copy the current bundle into the old location;
4. delete the renamed leftover, or if it is still locked, leave it for
   `cleanupTrash` to remove on the next launch;
5. relaunch from the old location and exit.

Data is untouched because `config.json`, `install.json` and `agent-home` all
live in userData, not in the program folder.

Notes:

- Relaunching forwards the original command-line arguments (minus our own
  `--dsh-auto-update` marker). Dropping them would move the new process to a
  different data directory and look like a wiped install.
- `--dsh-auto-update` skips the confirmation step. With no arguments the prompt
  costs exactly one click; the flag is there for a shortcut that updates silently.
- The data directory name is pinned with `app.setName('Agent')`. The macOS
  bundle keeps its inner binary named `Electron` (per `Info.plist`), so
  `app.isPackaged` is false and `app.getName()` would otherwise drift with how
  the app was started — taking `userData` with it.
- Renaming the product moved `userData` from `.../DSH-Agent` to `.../Agent`.
  `migrateLegacyUserData()` renames the old directory on launch — only when the
  old one exists *and* the new one does not, so it can never clobber a live
  install. Sessions, `config.json` and `install.json` all come along. If the old
  instance is still running and holds the directory, the rename fails harmlessly
  and the new directory is simply created empty.
- The app never deletes the folder it is currently running from. After updating,
  the temporary unzip directory can be removed by hand.

## Plugins

The local Agent now has a plugin host inspired by dsh.

Built-in plugins:

- builtin/fs-tools
- builtin/search-tools
- builtin/shell-tools

Example user plugin:

- plugins/examples/hello-tool

Plugin guide:

- docs/PLUGINS.md

User plugins are loaded from the Agent user data directory:

- Windows local Agent: %APPDATA%/Agent/plugins
- Server Agent: $AGENT_HOME/plugins

## Automatic context compression memory

Long conversations can exceed the model context window. The agent now keeps a
durable summary ("memory") of older messages and sends only that summary plus
the recent turns to the model.

- `maxTokens` (default 8192) is sent as `max_tokens` so the server does not
  reserve a huge completion budget.
- When `contextWindowTokens` is greater than 0, the agent estimates the prompt
  size before every request and compresses older messages when the prompt plus
  the completion reserve gets close to the window.
- When the model endpoint still returns a context length error, the agent
  compresses and retries automatically. If the first attempt is not enough it
  keeps fewer recent messages and retries again.
- The full transcript stays in the session and the UI. Compression never
  deletes visible history and never splits an assistant tool call from its
  tool result.
- The compressed memory is saved with the session and reused on later turns.
  It is shown in the UI as a collapsed memory block.

Settings:

- Context window tokens: `0` means unknown; compression is then triggered by a
  context length error from the server.
- Max reply tokens: completion budget sent as `max_tokens`.
- Keep recent messages: how many recent message groups stay uncompressed.
- Auto compress context: turn the whole feature off if needed.

Images are stored as content-addressed assets, not as inline base64 in the
session:

- Local agent: `%APPDATA%/Agent/assets`
- Server agent: `$AGENT_HOME/assets`
- Session messages keep a small reference (`{ type: "image", assetId }`).
- The data URL is only reconstructed when a request is sent to the model.
