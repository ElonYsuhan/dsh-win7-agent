'use strict'
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const ui = require('../src/renderer/ui-enhancements')
const flow = require('../src/main/flow/turn-flow')
const { PluginHost } = require('../src/main/plugins/plugin-host')
async function main() {
  assert.strictEqual(ui.outcome('exitCode=1\nno'), 'failed')
  assert.strictEqual(ui.outcome('exitCode=0\nok'), 'completed')
  assert.strictEqual(ui.outcome('DENIED: approval'), 'failed')
  assert.strictEqual(flow.outcome('exitCode=-1\nfailed', false), 'error')
  assert.strictEqual(flow.outcome('exitCode=0\nok', true), 'cancelled')
  assert.strictEqual(flow.outcome('exitCode=0\nok', false), 'success')
  const diff = ui.lineDiff('a\nold\nz', 'a\nnew\nz')
  assert(diff.includes('-old') && diff.includes('+new') && diff.includes(' a'))
  const svg = ui.flowSvg('flowchart TB\nA["<script>"] --> B["Result"]\nB --> C["Done"]')
  assert(svg.includes('&lt;script&gt;') && !svg.includes('<script>'))
  assert(svg.includes('Result') && svg.includes('Done'))
  const both = ui.flowSvg('flowchart TB\nA <--> B')
  assert.strictEqual((both.match(/marker-end=/g) || []).length, 2)
  assert.throws(() => ui.flowSvg('sequenceDiagram\nA->>B: hi'), /语法/)
  const policy = require('../src/main/agent/permission-policy')
  assert.strictEqual(policy.decideToolPermission('command', 'workspace', { command: 'npm test' }, { approveCommands: true }), 'ask')
  assert.strictEqual(policy.decideToolPermission('command', 'full', { command: 'npm test' }, { approveCommands: false }), 'allow')
  assert.strictEqual(policy.decideToolPermission('command', 'full', { command: 'rm file.txt' }, { approveCommands: false }), 'ask')
  const stateModel = require('../src/main/state/session-state'), { EVENTS } = require('../src/main/contracts')
  const at = '2026-10-17T00:00:00.000Z'
  const started = stateModel.reduce(stateModel.initial(), { version: 1, sequence: 1, at, type: EVENTS.START, data: { id: 'ux-turn', maxSteps: 5 } })
  assert.strictEqual(started.execution.startedAt, at)
  const restored = stateModel.restore({ version: 2, messages: [], memory: null, execution: started.execution })
  assert.strictEqual(restored.execution.startedAt, at)
  assert(ui.estimatedTokens([{ role: 'user', content: '你好世界' }]) >= 4)
  assert.strictEqual(ui.estimatedTokens([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }]), 4)
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ux-'))
  const host = new PluginHost({ workspaceRoot: root, settings: { data: {} } })
  try {
    await host.ready()
    assert(host.getTool('update_plan'))
    const result = await host.executeTool('update_plan', { steps: [{ title: 'Inspect', status: 'completed' }, { title: 'Test', status: 'in_progress' }] }, { settings: {} })
    assert.strictEqual(JSON.parse(result.slice('[agent-plan:v1]'.length)).steps.length, 2)
    await assert.rejects(() => host.executeTool('update_plan', { steps: [{ title: 'A', status: 'in_progress' }, { title: 'B', status: 'in_progress' }] }, { settings: {} }), /MULTIPLE_ACTIVE/)
    await assert.rejects(() => host.executeTool('update_plan', { steps: [{ title: 'bad', status: 'invented' }] }, { settings: {} }), /enum/)
    await assert.rejects(() => host.executeTool('update_plan', { steps: [] }, { settings: {} }), /LIMIT/)
    assert((await host.buildSystemPrompt('BASE')).includes('Do not invent completion'))
    const { Agent } = require('../src/main/agent/agent')
    let calls = 0
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: async () => ++calls === 1
      ? { content: null, toolCalls: [{ id: 'plan-real', type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ steps: [{ title: '可恢复的计划', status: 'completed' }] }) } }] }
      : { content: '完成', toolCalls: [] } }) } })
    const output = [], agent = new Agent({ data: { maxIterations: 2 }, workspacePath: root }, event => output.push(event), async () => true, path.join(root, 'journal-session'), host)
    try {
      await agent.run('带计划的任务', [])
      const saved = host.get('sessions').load(agent)
      assert(saved.messages.some(m => m.role === 'tool' && m.content.startsWith('[agent-plan:v1]')))
      assert(saved.execution.startedAt && saved.execution.status === 'completed')
      assert(output.some(e => e.type === 'tool:result' && e.outcome === 'success' && e.id === 'plan-real'))
      const restarted = new Agent({ data: {}, workspacePath: root }, () => {}, async () => true, agent.sessionDir, host)
      try { assert(host.get('sessions').load(restarted).messages.some(m => m.role === 'tool' && m.content.includes('可恢复的计划'))) } finally { await restarted.dispose() }
    } finally { await agent.dispose() }

  } finally { await host.dispose(); fs.rmSync(root, { recursive: true, force: true }) }
  console.log('Agent UX: tool outcomes, diff snippets, escaped flow SVG, unsupported syntax fallback, native Cordis plan registration/validation/disposal passed')
}
main().catch(error=>{console.error(error);process.exitCode=1})
