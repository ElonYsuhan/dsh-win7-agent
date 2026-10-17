# Agent 0.3.0 — four-layer architecture

Cordis remains the runtime foundation. Agent semantics are implemented above it,
separated into contracts, orchestration policy, state model and runtime plugins.

## Delivered

- Versioned domain events and service interfaces, model-result and tool-argument
  validation at actual execution boundaries.
- Replaceable pure flow policy: prompts, retry/compaction, completion/tool/block
  decisions, limits and optional whole-turn deadlines.
- Immutable guarded state: messages, memory, turn status, step/attempt, active
  tool, denial counts, tool fallback and request errors.
- Append-only JSONL facts plus atomic compatible snapshots. Restore older
  snapshots, replay newer facts, detect interrupted turns and repair uncommitted
  tails. Reject committed corruption, unknown versions and sequence gaps.
- Recovered tool exchanges preserve all recorded results; missing results become
  placeholders. Uncertain tool side effects are never automatically repeated.
- Native runtime plugins split by responsibility; profile is composition only.
  Agent facade delegates execution and compaction through injected services.
- `executions` diagnostics through HTTP and IPC, with distinct completed,
  cancelled, failed, blocked, exhausted, timed_out and interrupted states.
- Architecture guardrails and regression tests enforce boundaries and prove
  policy replacement, persistence recovery, cancellation and timeout behavior.

## Acceptance

Run `npm run check` and `npm run check:node16`. `layered-agent-smoke.js`
checks contracts, legal/illegal state transitions, actual flow replacement,
legacy migration, durable recovery, committed-corruption rejection, tool batch
history, cancellation/deadlines/limits and avoidance of automatic side-effect
replay. Existing UI, permissions, compression and concurrency suites remain.

Target runtime remains Electron 22 / Node 16.17.1 / Win7 SP1 x64. Cordis stays
pinned and bundled for offline use; no production dependencies were added.
Hardware-specific Windows behavior still requires a Windows machine.
