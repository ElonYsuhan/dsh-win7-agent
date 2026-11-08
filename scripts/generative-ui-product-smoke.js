'use strict'

// Production-profile capability negotiation. Unlike the protocol fixtures this
// host has no test-only enable flag: clients must advertise what they can
// render before the model is offered UI tools.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { AgentPool } = require('../src/main/agent/agent-pool')
const UI = require('../src/main/contracts/generative-ui')

const LEGACY = { versions: [1], components: UI.LEGACY_COMPONENTS.slice() }
const FULL = UI.capabilities()
const BASIC = { versions: [1, 2], components: ['column', 'text', 'slider', 'chart', 'button'] }
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function call(id, name, args) { return { id, function: { name, arguments: JSON.stringify(args) } } }
function legacySurface(revision) {
  return { version: 1, id: 'legacy', revision, title: '旧版图表', root: 'layout', state: { factor: 1 },
    components: [
      { id: 'layout', type: 'column', children: ['chart', 'slider'] },
      { id: 'chart', type: 'chart', chartType: 'line', title: '收入', labels: ['一', '二'], series: [{ id: 'income', name: '收入', values: [1, 2] }], multiplierKey: 'factor' },
      { id: 'slider', type: 'slider', label: '倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 }
    ], actions: [] }
}
function businessSurface(revision) {
  return { version: 2, id: 'product', revision, title: '生产业务面板', root: 'layout',
    state: { region: '', row: '', point: '', done: 20 },
    components: [
      { id: 'layout', type: 'column', children: ['region', 'records', 'progress', 'places', 'send'] },
      { id: 'region', type: 'filter', label: '地区', stateKey: 'region', options: [{ value: '', label: '全部' }, { value: '华东', label: '华东' }] },
      { id: 'records', type: 'table', title: '记录', columns: [{ id: 'name', label: '名称' }, { id: 'region', label: '地区' }], rows: [{ id: 'east', cells: ['记录甲', '华东'] }], selectionKey: 'row', filterKey: 'region', filterColumn: 'region' },
      { id: 'progress', type: 'progress', label: '模型提供的进度', valueKey: 'done', max: 100, status: 'running' },
      { id: 'places', type: 'map', title: '位置', points: [{ id: 'shanghai', label: '上海', longitude: 121.47, latitude: 31.23 }], selectionKey: 'point' },
      { id: 'send', type: 'button', label: '分析选择', actionId: 'analyze' }
    ], actions: [{ id: 'analyze', type: 'ask_agent', message: '分析所选内容', stateKeys: ['region', 'row', 'point'] }] }
}
function visualSurface(revision) {
  return { version: 2, id: 'drawing', revision, title: '静态绘图', root: 'visual', state: {},
    components: [{ id: 'visual', type: 'visual', title: '沙箱绘图', height: 260, html: '<style>.ink{fill:#1f8a7a}</style><svg viewBox="0 0 40 40"><circle class="ink" cx="20" cy="20" r="12"/></svg>' }], actions: [] }
}
function actionRequest(sessionId, requestId, version) {
  return { version: 1, sessionId, surfaceId: 'product', revision: 1, expectedStateVersion: version, requestId, componentId: 'send', actionId: 'analyze' }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-product-'))
  const settings = { file: path.join(tmp, 'settings.json'), data: { maxIterations: 4, permissionMode: 'readonly', workspacePath: tmp }, all() { return this.data } }
  const host = new PluginHost({ workspaceRoot: tmp, settings })
  const events = [], seen = [], prompts = []
  let script = []
  const pool = new AgentPool({ settings, pluginHost: host, sessionRoot: path.join(tmp, 'sessions'), emit: event => events.push(event), approve: async () => false })
  async function turn(session, text, caps, responses) {
    seen.length = 0; prompts.length = 0; script = responses.slice()
    await pool.run(session, text, [], undefined, undefined, undefined, undefined, undefined, caps)
    assert.strictEqual(script.length, 0, 'synthetic model script must be fully consumed')
    for (const input of seen) prompts.push(input.messages.find(message => message.role === 'system').content)
    return { first: seen[0], last: seen[seen.length - 1] }
  }
  function toolNames(input) { return (input.tools || []).map(tool => tool.function.name) }
  function persisted(session) { return host.requireService('sessions').load(pool.acquire(session)) }
  function surfaceIds(session) { return Object.keys(persisted(session).ui.surfaces) }
  try {
    await host.ready()
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: async input => { seen.push(input); const next = script.shift(); if (!next) throw new Error('UNEXPECTED_MODEL_REQUEST'); return next } }) } })
    const ui = host.requireService('generativeUi')

    // 1. No renderer negotiation: ordinary chat, no UI tools or UI prompt.
    await turn('plain', '你好', undefined, [{ content: '普通回复', toolCalls: [] }])
    assert(!toolNames(seen[0]).includes('render_ui') && !toolNames(seen[0]).includes('update_ui'))
    assert(!prompts[0].includes('Negotiated renderer'))
    assert.strictEqual(pool.acquire('plain').rendererCapabilities, null)
    assert.deepStrictEqual(surfaceIds('plain'), [])

    // 2. A guessed call without capabilities is refused and commits no surface.
    await turn('guess', '生成界面', undefined, [
      { content: '', toolCalls: [call('guess-create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(1) })] },
      { content: '当前客户端无法显示交互界面。', toolCalls: [] }
    ])
    assert(seen[1].messages.some(message => message.role === 'tool' && /DENIED: render_ui: client capability unavailable/.test(message.content)))
    assert.deepStrictEqual(surfaceIds('guess'), [])
    assert(!events.some(event => event.type === 'ui:surface' && event.surface && event.surface.id === 'product'))

    // 3. v1 clients only receive legacy components; a v2 guess is rejected.
    assert.deepStrictEqual(UI.negotiate(LEGACY), LEGACY)
    await turn('legacy', '生成旧版图表', LEGACY, [
      { content: '', toolCalls: [call('v2-guess', 'render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(1) })] },
      { content: '已拒绝超出渲染能力的界面。', toolCalls: [] }
    ])
    assert(toolNames(seen[0]).includes('render_ui'))
    assert(seen[1].messages.some(message => message.role === 'tool' && /renderer capability mismatch/.test(message.content)))
    assert.deepStrictEqual(surfaceIds('legacy'), [])
    await turn('legacy', '生成旧版图表', LEGACY, [
      { content: '', toolCalls: [call('v1-create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: legacySurface(1) })] },
      { content: '完成', toolCalls: [] }
    ])
    assert.deepStrictEqual(surfaceIds('legacy'), ['legacy'])
    assert.strictEqual(persisted('legacy').messages.flatMap(message => message.content || []).find(part => part.type === 'ui').surface.version, 1)
    assert.strictEqual(pool.acquire('legacy').rendererCapabilities, null, 'renderer metadata is cleared after the turn')

    // 4. A v2 subset only receives that subset; an unadvertised component is refused.
    assert.deepStrictEqual(UI.negotiate(BASIC), BASIC)
    await turn('basic', '生成面板', BASIC, [
      { content: '', toolCalls: [call('map-guess', 'render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(1) })] },
      { content: '已拒绝。', toolCalls: [] }
    ])
    assert(seen[1].messages.some(message => message.role === 'tool' && /renderer capability mismatch/.test(message.content)))
    assert.deepStrictEqual(surfaceIds('basic'), [])

    // 4b. A visual is a static sandboxed page, not arbitrary executable HTML.
    await turn('visual-basic', '生成绘图', BASIC, [
      { content: '', toolCalls: [call('visual-guess', 'render_ui', { operation: 'create', expectedRevision: 0, surface: visualSurface(1) })] },
      { content: '已拒绝。', toolCalls: [] }
    ])
    assert(seen[1].messages.some(message => message.role === 'tool' && /renderer capability mismatch/.test(message.content)))
    assert.deepStrictEqual(surfaceIds('visual-basic'), [])
    await turn('visual', '生成绘图', FULL, [
      { content: '', toolCalls: [call('visual-create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: visualSurface(1) })] },
      { content: '已显示绘图', toolCalls: [] }
    ])
    assert.deepStrictEqual(surfaceIds('visual'), ['drawing'])
    assert(prompts[0].includes('visual {id,type,title,html,height?}'))
    assert(prompts[0].includes('Do NOT use browser_launch'))
    assert.throws(() => UI.assertSurface({ ...visualSurface(1), components: [{ ...visualSurface(1).components[0], height: 900 }] }), /visual height/)
    assert.throws(() => UI.assertSurface({ ...visualSurface(1), components: [{ ...visualSurface(1).components[0], src: 'https://invalid.example/' }] }), /not allowed/)
    assert.throws(() => UI.assertSurface({ ...visualSurface(1), components: [{ ...visualSurface(1).components[0], html: '' }] }), /visual.html/)

    // 5. Full v2 capabilities publish the complete surface durably.
    await turn('product', '生成生产面板', FULL, [
      { content: '', toolCalls: [call('product-create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(1) })] },
      { content: '已提供交互界面', toolCalls: [] }
    ])
    assert(toolNames(seen[0]).includes('render_ui') && toolNames(seen[0]).includes('update_ui'))
    assert(prompts[0].includes('Negotiated renderer'))
    assert.deepStrictEqual(surfaceIds('product'), ['product'])
    assert.strictEqual(persisted('product').messages.flatMap(message => message.content || []).find(part => part.type === 'ui').surface.version, 2)

    // 6. Capabilities belong to a turn and a conversation, never the shared plugin.
    await turn('plain', '再次普通聊天', undefined, [{ content: '普通回复', toolCalls: [] }])
    assert(!toolNames(seen[0]).includes('render_ui'))
    assert.strictEqual(pool.acquire('plain').rendererCapabilities, null)
    assert.deepStrictEqual(surfaceIds('product'), ['product'])
    assert.strictEqual(pool.acquire('product').rendererCapabilities, null)

    // 7. Future-only or malformed negotiation never offers tools or starts work.
    await turn('future', '未来客户端', { versions: [3], components: ['map'] }, [{ content: '纯文本回复', toolCalls: [] }])
    assert(!toolNames(seen[0]).includes('render_ui'))
    await assert.rejects(pool.run('malformed', '非法能力', [], undefined, undefined, undefined, undefined, undefined, { versions: [2], components: [], extra: true }), /GENERATIVE_UI_INVALID/)
    assert.deepStrictEqual(surfaceIds('malformed'), [])

    // 8. Durable selections and the existing action permission chain still apply.
    const edits = [
      { version: 1, sessionId: 'product', surfaceId: 'product', revision: 1, expectedStateVersion: 0, requestId: 'region', componentId: 'region', value: '华东' },
      { version: 1, sessionId: 'product', surfaceId: 'product', revision: 1, expectedStateVersion: 1, requestId: 'row', componentId: 'records', value: 'east' },
      { version: 1, sessionId: 'product', surfaceId: 'product', revision: 1, expectedStateVersion: 2, requestId: 'point', componentId: 'places', value: 'shanghai' }
    ]
    for (const edit of edits) ui.change(pool, edit)
    seen.length = 0; script = [{ content: '已分析所选内容', toolCalls: [] }]
    const accepted = ui.dispatch(pool, actionRequest('product', 'analyze-1', 3), FULL)
    assert.strictEqual(accepted.started, true)
    assert.deepStrictEqual(accepted.receipt.values, { region: '华东', row: 'east', point: 'shanghai' })
    const sequence = ui.read(pool, { version: 1, sessionId: 'product' }).sequence
    const duplicate = ui.dispatch(pool, actionRequest('product', 'analyze-1', 3), BASIC)
    assert.strictEqual(duplicate.started, false)
    assert.strictEqual(ui.read(pool, { version: 1, sessionId: 'product' }).sequence, sequence, 'changing capability metadata does not rewrite idempotency facts')
    await pool.running.get('product').done
    assert.strictEqual(script.length, 0)
    const actionPrompt = seen[0].messages.filter(message => message.role === 'user').pop().content
    for (const value of ['"region":"华东"', '"row":"east"', '"point":"shanghai"']) assert(actionPrompt.includes(value))
    assert(!actionPrompt.includes('"done"') && !actionPrompt.includes('"progress"'))
    assert.strictEqual(ui.dispatch(pool, actionRequest('product', 'analyze-1', 3), FULL).started, false)
    assert.throws(() => ui.dispatch(pool, { ...actionRequest('product', 'bad-cap', 3) }, { versions: [2], components: [], extra: true }), /GENERATIVE_UI_INVALID/)
    assert.strictEqual(ui.read(pool, { version: 1, sessionId: 'product' }).receipts.some(receipt => receipt.requestId === 'bad-cap'), false)

    // 9. Direct execution can never bypass the availability predicate, and
    //    a disabled plugin is removed from both definitions and execution.
    const tools = host.requireService('tools')
    const render = tools.get('render_ui')
    assert.strictEqual(render.available({ agent: { rendererCapabilities: FULL } }), true)
    assert.strictEqual(render.available({ agent: { rendererCapabilities: null } }), false)
    assert.strictEqual(render.available({ agent: { unattended: true, rendererCapabilities: FULL } }), false)
    assert.strictEqual(render.available({ settings: { unattended: { tools: ['render_ui'] } }, agent: { rendererCapabilities: FULL } }), false)
    const denied = await tools.execute('render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(2) }, { agent: { rendererCapabilities: null }, settings: { permissionMode: 'readonly' } })
    assert(/^DENIED: render_ui: client capability unavailable/.test(denied))
    settings.data.disabledPlugins = ['core/generative-ui']
    assert(!host.getToolDefinitions({ rendererCapabilities: FULL }).some(tool => tool.function.name === 'render_ui'))
    const disabled = await tools.execute('render_ui', { operation: 'create', expectedRevision: 0, surface: businessSurface(2) }, { agent: { rendererCapabilities: FULL }, settings: { permissionMode: 'readonly', disabledPlugins: ['core/generative-ui'] } })
    assert(/^DISABLED: render_ui/.test(disabled))
    assert.throws(() => ui.change(pool, { ...edits[2], expectedStateVersion: 3, requestId: 'disabled' }), /GENERATIVE_UI_DISABLED/)
    delete settings.data.disabledPlugins

    console.log('Generative UI P4 product: production-profile negotiation, no-capability refusal, legacy/v2/subset enforcement, per-turn and per-session isolation, malformed/future negotiation, durable selections, capability-stable action idempotency, unattended/disabled gates and no direct tool bypass passed. Node ' + process.versions.node)
  } finally {
    await pool.dispose()
    await host.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
