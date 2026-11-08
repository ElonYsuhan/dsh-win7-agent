'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { AgentPool } = require('../src/main/agent/agent-pool')
const { EVENTS } = require('../src/main/contracts')
const state = require('../src/main/state/session-state')
const UI = require('../src/main/contracts/generative-ui-interaction')
function surface(revision) {
  return { version: 1, id: 'sales', revision, title: '交互分析', root: 'layout', state: { factor: 1, note: '初始', archived: false }, components: [
    { id: 'layout', type: 'column', children: ['scale', 'note', 'archived', 'send'] },
    { id: 'scale', type: 'slider', label: '倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 },
    { id: 'note', type: 'input', label: '说明', stateKey: 'note', maxLength: 12 },
    { id: 'archived', type: 'checkbox', label: '包含归档', stateKey: 'archived' },
    { id: 'send', type: 'button', label: '分析', actionId: 'analyze' }
  ], actions: [{ id: 'analyze', type: 'ask_agent', message: '分析当前参数', stateKeys: ['factor', 'note'] }] }
}
function call(id, name, value) { return { id, function: { name, arguments: JSON.stringify(value) } } }
function request(requestId, operation, version, extra) {
  return { version: 1, sessionId: 'sessionA', surfaceId: 'sales', revision: 1, expectedStateVersion: version, requestId, componentId: operation === 'change' ? 'scale' : 'send', ...(operation === 'change' ? { value: 2 } : { actionId: 'analyze' }), ...extra }
}
async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-interaction-'))
  const settings = { file: path.join(tmp, 'settings.json'), data: { maxIterations: 5, permissionMode: 'readonly', workspacePath: tmp }, all() { return this.data } }
  const host = new PluginHost({ workspaceRoot: tmp, settings, enableGenerativeUiProtocolForTests: true })
  const events = [], prompts = []
  let approvals = 0, effects = 0, step = 0, model
  const pool = new AgentPool({ settings, pluginHost: host, sessionRoot: path.join(tmp, 'sessions'), emit: event => events.push(event), approve: async () => { approvals++; return false } })
  try {
    await host.ready()
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: request => model(request) }) } })
    const ui = host.requireService('generativeUi')
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: surface(1) })] } : { content: '完成', toolCalls: [] }
    await pool.run('sessionA', '生成界面', [])
    assert.strictEqual(pool.acquire('sessionA').messages.length, 0, 'completed workers release their history')
    let snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA' })
    assert.strictEqual(snapshot.surfaces.sales.stateVersion, 0)
    snapshot = ui.change(pool, request('edit1', 'change', 0))
    assert.strictEqual(snapshot.surfaces.sales.state.factor, 2)
    assert.strictEqual(snapshot.surfaces.sales.stateVersion, 1)
    const sequence = snapshot.sequence
    assert.strictEqual(ui.change(pool, request('edit1', 'change', 0)).sequence, sequence, 'retry acknowledges the same committed edit without a second fact')
    assert.throws(() => ui.change(pool, request('old', 'change', 0)), /STATE_UI_STATE_CONFLICT/)
    assert.throws(() => ui.change(pool, request('invalid', 'change', 1, { value: 2.3 })), /GENERATIVE_UI_INVALID/)
    assert.throws(() => ui.change(pool, request('hidden', 'change', 1, { componentId: 'send' })), /editable component/)
    assert.throws(() => ui.change(pool, { ...request('extra', 'change', 1), tool: 'shell' }), /fields/)
    assert.throws(() => ui.change(pool, request('cross', 'change', 1, { sessionId: 'sessionB' })), /NOT_AUTHORITATIVE/)
    ui.change(pool, request('note', 'change', 1, { componentId: 'note', value: '已修改' }))
    ui.change(pool, request('checkbox', 'change', 2, { componentId: 'archived', value: true }))
    await pool.releaseWorker('sessionA')
    snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA' })
    assert.deepStrictEqual(snapshot.surfaces.sales.state, { factor: 2, note: '已修改', archived: true }, 'reacquire replays durable edits, not client history')
    assert.strictEqual(snapshot.surfaces.sales.stateVersion, 3)
    let releaseModel
    const gate = new Promise(resolve => { releaseModel = resolve })
    model = async payload => { prompts.push(payload.messages); await gate; return { content: '收到参数', toolCalls: [] } }
    const action = request('action1', 'action', 3)
    const accepted = ui.dispatch(pool, action)
    assert(accepted.started && pool.isRunning('sessionA'))
    assert.strictEqual(accepted.receipt.values.factor, 2)
    assert(!Object.prototype.hasOwnProperty.call(accepted.receipt.values, 'archived'), 'send only the selected keys')
    assert.strictEqual(ui.dispatch(pool, action).started, false, 'duplicate action never starts another run')
    assert.throws(() => ui.dispatch(pool, { ...action, actionId: 'other' }), /REQUEST_ID_REUSED/)
    assert.throws(() => ui.dispatch(pool, { ...action, requestId: 'busy' }), /SESSION_BUSY/)
    releaseModel()
    await pool.running.get('sessionA').done
    snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA' })
    assert.strictEqual(snapshot.receipts[0].status, 'completed')
    assert.strictEqual(ui.dispatch(pool, action).started, false)
    const prompt = prompts[0].filter(message => message.role === 'user').pop().content
    assert(prompt.includes('"factor":2') && prompt.includes('已修改') && !prompt.includes('"archived"'))
    assert(events.some(event => event.type === 'finished' && event.ui && event.ui.receipts.some(item => item.status === 'completed')), 'finished snapshots recover action status')

    const disposeTool = host.requireService('tools').register({ name: 'ui_write_probe', permission: 'write', parameters: { type: 'object', properties: {} }, execute: async () => { effects++; return 'wrote' } })
    step = 0
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('side-effect', 'ui_write_probe', {})] } : { content: '操作被拦截', toolCalls: [] }
    ui.dispatch(pool, { ...action, requestId: 'denied' })
    await pool.running.get('sessionA').done
    assert.strictEqual(effects, 0, 'UI actions use the existing read-only tool permission gate')
    assert.strictEqual(approvals, 0)
    assert(events.some(event => event.type === 'tool:result' && event.name === 'ui_write_probe' && event.outcome === 'denied'))
    await disposeTool()

    settings.data.permissionMode = 'readonly'
    const disposeCommand = host.requireService('tools').register({ name: 'ui_command_probe', permission: 'command', parameters: { type: 'object', properties: { command: { type: 'string' } } }, execute: async () => { effects++; return 'ran' } })
    step = 0
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('ask-command', 'ui_command_probe', { command: 'echo ui' })] } : { content: '已拒绝', toolCalls: [] }
    ui.dispatch(pool, { ...action, requestId: 'approval' })
    await pool.running.get('sessionA').done
    assert.strictEqual(approvals, 1, 'UI actions do not bypass the existing manual approval')
    assert.strictEqual(effects, 0)
    await disposeCommand()
    ui.dispatch(pool, { ...action, requestId: 'toString' })
    await pool.running.get('sessionA').done
    assert.strictEqual(ui.dispatch(pool, { ...action, requestId: 'toString' }).started, false, 'valid IDs that shadow Object.prototype still use own recorded receipts')
    const repository = host.requireService('sessions'), append = repository.append
    const beforeFailure = events.length
    repository.append = function (agent, event) { if ([EVENTS.UI_ACTION, EVENTS.UI_CHANGE].includes(event.type)) throw new Error('DISK_FULL'); return append.call(this, agent, event) }
    try {
      assert.throws(() => ui.dispatch(pool, { ...action, requestId: 'uncommitted' }), /DISK_FULL/)
      assert.throws(() => ui.change(pool, request('uncommitted-edit', 'change', 3, { value: 4 })), /DISK_FULL/)
      assert.strictEqual(pool.runningCount(), 0)
      assert.strictEqual(events.length, beforeFailure, 'failed commits never notify or start a turn')
    } finally { repository.append = append }
    repository.append = function (agent, event) { if (event.type === EVENTS.START && event.data.uiActionId === 'fail-start') throw new Error('START_DISK_FULL'); return append.call(this, agent, event) }
    try {
      ui.dispatch(pool, { ...action, requestId: 'fail-start' })
      await pool.running.get('sessionA').done
      await Promise.resolve(); await Promise.resolve()
      assert(events.some(event => event.type === 'ui:interaction' && event.snapshot.receipts.some(item => item.requestId === 'fail-start' && item.status === 'interrupted')), 'a swallowed pre-start failure still settles and notifies the accepted receipt')
    } finally { repository.append = append }
    const worker = pool.acquire('sessionA')
    worker.state = host.requireService('sessions').load(worker)
    worker.record(EVENTS.UI_ACTION, { ...action, requestId: 'crash-before-run' })
    snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA' })
    assert.strictEqual(snapshot.receipts.find(item => item.requestId === 'crash-before-run').status, 'interrupted')
    assert.strictEqual(ui.dispatch(pool, { ...action, requestId: 'crash-before-run' }).started, false, 'accepted-but-unstarted action is never recovered by executing it')
    worker.record(EVENTS.UI_ACTION, { ...action, requestId: 'crash-after-start' })
    worker.record(EVENTS.START, { id: 'uncertain', maxSteps: 5, uiActionId: 'crash-after-start' })
    snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA' })
    assert.strictEqual(snapshot.receipts.find(item => item.requestId === 'crash-after-start').status, 'interrupted')
    assert.strictEqual(pool.runningCount(), 0)
    const saved = host.requireService('sessions').load(worker)
    const restored = state.restore({ version: 2, ...saved })
    assert.deepStrictEqual(restored.ui, saved.ui)
    const legacy = JSON.parse(JSON.stringify({ version: 2, ...saved })); delete legacy.ui; delete legacy.execution.uiActionId
    assert.strictEqual(state.restore(legacy).ui.surfaces.sales.stateVersion, 0, 'legacy server snapshots migrate published defaults')
    step = 0
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('new-revision', 'update_ui', { expectedRevision: 1, surface: surface(2) })] } : { content: '已更新', toolCalls: [] }
    ui.dispatch(pool, { ...action, requestId: 'new-revision' })
    await pool.running.get('sessionA').done
    snapshot = ui.read(pool, { version: 1, sessionId: 'sessionA', surfaceId: 'sales' })
    assert.strictEqual(snapshot.surfaces.sales.revision, 2)
    assert.strictEqual(snapshot.surfaces.sales.stateVersion, 0, 'a complete published revision starts its explicit new defaults')
    assert.deepStrictEqual(snapshot.definitions.sales, surface(2), 'only the server-confirmed definition enables the renderer')
    assert.throws(() => ui.dispatch(pool, { ...action, requestId: 'stale-revision' }), /REVISION_CONFLICT/)
    const validHistory = host.requireService('sessions').load(worker).messages
    worker.replaceHistory([{ role: 'assistant', content: [{ type: 'ui', toolCallId: 'forged', surface: { ...surface(1), title: '修改了历史' } }] }])
    assert.throws(() => ui.dispatch(pool, { ...action, requestId: 'forged' }), /NOT_AUTHORITATIVE/, 'client history cannot redefine a published action')
    const bad = JSON.parse(JSON.stringify(restored.ui)); bad.receipts.action1.status = 'unknown'
    assert.throws(() => UI.assertAggregate(bad), /receipt identity/)
    worker.replaceHistory(validHistory.concat([{ role: 'assistant', content: [{ type: 'ui', toolCallId: 'future', surface: { version: 3, id: 'sales', revision: 3 } }] }, validHistory.find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'ui' && part.surface.revision === 2))]))
    assert(!ui.read(pool, { version: 1, sessionId: 'sessionA' }).surfaces.sales, 'an unknown future version prevents state recovery into an old surface')
    assert.throws(() => ui.dispatch(pool, { ...action, requestId: 'future-barrier', revision: 2, expectedStateVersion: 0 }), /VERSION_UNSUPPORTED/)
    worker.replaceHistory(validHistory)
    let lateModelCalls = 0
    model = async () => { lateModelCalls++; return { content: 'should not run', toolCalls: [] } }
    ui.dispatch(pool, { ...action, requestId: 'teardown', revision: 2, expectedStateVersion: 0 })
    await host.unload('core/generative-ui')
    await Promise.all(Array.from(pool.running.values(), ticket => ticket.done))
    assert.strictEqual(lateModelCalls, 0, 'teardown cancels an accepted action before the readiness gate without a deadlock')
    assert.strictEqual(host.requireService('sessions').load(worker).ui.receipts.teardown.status, 'interrupted')
    assert.throws(() => ui.read(pool, { version: 1, sessionId: 'sessionA' }), /GENERATIVE_UI_DISABLED/, 'a disposed service cannot be reused')
    pool.clear('sessionA')
    const cleared = host.requireService('sessions').load(worker)
    assert.strictEqual(cleared.messages.length, 0)
    assert(cleared.ui.receipts.action1 && cleared.ui.receipts.teardown, 'clearing released history preserves the durable anti-replay ledger')
    state.restore({ version: 2, ...state.release(cleared) })

    console.log('Generative UI P2 runtime: durable validated edits, conflicts, recovery, exact sessions, real Cordis Agent dispatch, selected state, duplicate suppression, tool permissions and no uncertain replay passed.')
  } finally { await pool.dispose(); await host.dispose(); fs.rmSync(tmp, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
