# Agent 0.2.0 — Cordis runtime migration

The execution foundation is now actual Cordis 4.0.0-rc.11. The upstream runtime
is pinned, MIT notices included, and bundled into a local CJS file targeting
Electron 22's Node 16.17.1. No production dependencies or runtime downloads added.

## Changes

- Compose native plugins for model access, context, sessions, tools, permissions,
  prompts, skills, agent creation, configuration and the default turn loop.
- Public Agent execution goes through the selected `agentLoop` service. The loop
  uses its injected service view while draining so provider teardown is safe.
- Preserve existing tool plugins with a Cordis compatibility facade. Remove the
  homegrown dependency/effect scheduler; Cordis owns services and lifecycles.
- Add dependent-first unloading, service reactivation, asynchronous resource
  cleanup, safe model/loop replacement and rollback of failed replacements.
- Settings disable/re-enable now dispose/remount actual plugin fibers. In-flight
  tools drain and pending approvals can be cancelled during unload.
- Await runtime activation at both HTTP and Electron IPC startup, expose runtime
  diagnostics, and drain runtime resources during normal shutdown.
- Keep current session JSON, model protocol, approval behavior, multiple sessions
  and existing UI. Session snapshots now use a temporary file and rename.
- Publish the enduring extension contract in root AGENTS.md and ARCHITECTURE.md;
  guard core service boundaries, upstream bundle integrity and offline packaging.
- Add native-runtime lifecycle tests and an embedded Node 16 check command.
- Update renderer smoke fixtures to the existing UI contract: computed styles,
  320px minimum chat area, confirmation-based forced saving, explicit no-workspace
  path fixture and recent-session title fixture. No renderer UI changes.

## Validation commands

```sh
npm run check
npm run check:node16
node scripts/build-desktop.js all
node scripts/packaged-ui-smoke.js
node scripts/first-chat-e2e-smoke.js
```

Platform packages target Windows x64, macOS ARM64/x64, Linux x64/ARM64. A successful
cross-build does not prove Windows 7 hardware behavior; validate native Windows
shell/encoding/installer behavior on a target machine before deployment.
