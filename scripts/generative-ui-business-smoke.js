'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { AgentPool } = require('../src/main/agent/agent-pool')
const state = require('../src/main/state/session-state')
const UI = require('../src/main/contracts/generative-ui')
const interactions = require('../src/main/contracts/generative-ui-interaction')

function surface(revision) {
  return {
    version: 2, id: 'business', revision, title: '业务数据与离线位置', root: 'layout',
    state: { region: '', row: '', node: '', point: '', progress: 35, privateNote: '不回传的说明' },
    components: [
      { id: 'layout', type: 'column', children: ['regionFilter', 'records', 'progress', 'process', 'locations', 'send'] },
      { id: 'regionFilter', type: 'filter', label: '地区', stateKey: 'region', options: [{ value: '', label: '全部' }, { value: '华东', label: '华东' }, { value: '华北', label: '华北' }] },
      { id: 'records', type: 'table', title: '销售记录', columns: [{ id: 'name', label: '名称' }, { id: 'region', label: '地区' }, { id: 'amount', label: '金额' }], rows: [{ id: 'east', cells: ['记录甲', '华东', 12] }, { id: 'north', cells: ['记录乙', '华北', 8] }], selectionKey: 'row', filterKey: 'region', filterColumn: 'region' },
      { id: 'progress', type: 'progress', label: '模型提供的处理进度', valueKey: 'progress', max: 100, status: 'running' },
      { id: 'process', type: 'flow', title: '处理步骤', nodes: [{ id: 'collect', label: '收集', status: 'completed' }, { id: 'review', label: '核对', status: 'pending' }], edges: [{ from: 'collect', to: 'review', label: '待核对' }], selectionKey: 'node' },
      { id: 'locations', type: 'map', title: '标记位置', points: [{ id: 'shanghai', label: '上海', longitude: 121.47, latitude: 31.23 }, { id: 'beijing', label: '北京', longitude: 116.4, latitude: 39.9 }], selectionKey: 'point' },
      { id: 'send', type: 'button', label: '分析所选内容', actionId: 'analyze' }
    ],
    actions: [{ id: 'analyze', type: 'ask_agent', message: '分析当前选择', stateKeys: ['region', 'row', 'node', 'point'] }]
  }
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function component(value, id) { return value.components.find(item => item.id === id) }
function call(id, name, value) { return { id, function: { name, arguments: JSON.stringify(value) } } }
function edit(requestId, componentId, value, stateVersion, extra) {
  return { version: 1, sessionId: 'businessSession', surfaceId: 'business', revision: 1, expectedStateVersion: stateVersion, requestId, componentId, value, ...extra }
}
function action(requestId, stateVersion, extra) {
  return { version: 1, sessionId: 'businessSession', surfaceId: 'business', revision: 1, expectedStateVersion: stateVersion, requestId, componentId: 'send', actionId: 'analyze', ...extra }
}

function checkSchema() {
  let rejected = 0
  function bad(mutator, label, pattern) {
    const value = surface(1)
    mutator(value)
    assert.throws(() => UI.assertSurface(value), pattern || /GENERATIVE_UI_INVALID/, label)
    rejected++
  }
  UI.assertSurface(surface(1))
  UI.assertBlock({ type: 'ui', toolCallId: 'v2', surface: surface(1) })
  const legacy = { version: 1, id: 'legacy', revision: 1, title: '旧界面', root: 'text', state: {}, components: [{ id: 'text', type: 'text', text: '保留旧消息' }], actions: [] }
  UI.assertSurface(legacy)
  UI.assertBlock({ type: 'ui', toolCallId: 'v1', surface: legacy })
  bad(value => { value.version = 1 }, 'new components require an explicit v2 surface')
  bad(value => { value.version = 3 }, 'future versions cannot be executed')
  bad(value => { value.script = 'alert(1)' }, 'surface rejects executable additions')
  bad(value => { component(value, 'records').columns[0].formatter = 'return value' }, 'table columns cannot contain code')
  bad(value => { component(value, 'records').rows[0].cells[0] = { html: '<b>unsafe</b>' } }, 'cells contain primitives, not arbitrary objects')
  bad(value => { component(value, 'records').rows[0].cells[0] = () => 'unsafe' }, 'functions cannot be hidden in cell data')
  bad(value => { component(value, 'records').rows[0].cells[2] = Infinity }, 'infinite table values are rejected')
  bad(value => { component(value, 'records').rows[0].cells[2] = 1e12 + 1 }, 'table values stay within the numeric bound')
  bad(value => { component(value, 'records').rows[0].cells[0] = 'x'.repeat(2001) }, 'table string cells remain bounded')
  bad(value => { component(value, 'records').rows[1].id = 'east' }, 'table row identities are unique')
  bad(value => { component(value, 'records').columns[1].id = 'name' }, 'table column identities are unique')
  bad(value => { component(value, 'records').rows[0].cells.pop() }, 'table rows match the column shape')
  bad(value => { component(value, 'records').selectionKey = 'missing' }, 'table selection must reference saved state')
  bad(value => { value.state.row = 'absent' }, 'table selection must identify an existing row')
  bad(value => { component(value, 'records').filterColumn = 'absent' }, 'table filter must reference an existing column')
  bad(value => { delete component(value, 'records').filterKey }, 'partial table filter bindings are rejected')
  bad(value => { component(value, 'records').filterKey = 'progress' }, 'table filter state must be text')
  bad(value => { component(value, 'records').rows = Array.from({ length: 121 }, (_, index) => ({ id: 'row' + index, cells: ['', '', 0] })) }, 'table row capacity is bounded')
  bad(value => { component(value, 'records').columns = Array.from({ length: 13 }, (_, index) => ({ id: 'column' + index, label: '列' + index })) }, 'table column capacity is bounded')
  bad(value => { component(value, 'regionFilter').options[1].value = '' }, 'filter values are unique')
  bad(value => { component(value, 'regionFilter').options[0].onSelect = 'runTool()' }, 'filter options cannot execute code')
  bad(value => { component(value, 'regionFilter').options = [] }, 'a filter has at least one option')
  bad(value => { component(value, 'regionFilter').options = Array.from({ length: 65 }, (_, index) => ({ value: String(index), label: String(index) })) }, 'filter option capacity is bounded')
  bad(value => { value.state.region = '未声明地区' }, 'filter selection must belong to declared options')
  bad(value => { value.state.region = true }, 'filter state cannot change primitive type')
  bad(value => { value.state.progress = -1 }, 'progress cannot be negative')
  bad(value => { value.state.progress = 101 }, 'progress cannot exceed its declared maximum')
  bad(value => { component(value, 'progress').max = 0 }, 'progress maximum must be positive')
  bad(value => { component(value, 'progress').status = 'actually-completed' }, 'progress status is a bounded display enum')
  bad(value => { component(value, 'process').nodes[1].id = 'collect' }, 'flow node identities are unique')
  bad(value => { component(value, 'process').nodes[0].status = 'unknown' }, 'flow node status is bounded')
  bad(value => { component(value, 'process').edges[0].to = 'missing' }, 'flow edges cannot reference unknown nodes')
  bad(value => { component(value, 'process').edges[0].to = 'collect' }, 'flow self-edges are rejected')
  bad(value => { component(value, 'process').edges.push(clone(component(value, 'process').edges[0])) }, 'duplicate flow edges are rejected')
  bad(value => { component(value, 'process').edges[0].url = 'https://invalid.example/' }, 'flow edges cannot name external resources')
  bad(value => { value.state.node = 'missing' }, 'flow selection must reference an existing node')
  bad(value => { component(value, 'process').nodes = Array.from({ length: 33 }, (_, index) => ({ id: 'node' + index, label: '节点', status: 'pending' })) }, 'flow node capacity is bounded')
  bad(value => { component(value, 'process').edges = Array.from({ length: 65 }, () => ({ from: 'collect', to: 'review' })) }, 'flow edge capacity is bounded')
  bad(value => { component(value, 'locations').points[1].id = 'shanghai' }, 'map point identities are unique')
  bad(value => { component(value, 'locations').points[0].longitude = 180.01 }, 'longitude is bounded')
  bad(value => { component(value, 'locations').points[0].latitude = -90.01 }, 'latitude is bounded')
  bad(value => { component(value, 'locations').points[0].latitude = NaN }, 'map coordinates must be finite')
  bad(value => { component(value, 'locations').points[0].longitude = '121' }, 'map coordinates are numeric, not coercible strings')
  bad(value => { component(value, 'locations').points[0].url = 'file:///private/key' }, 'a map point cannot load a resource')
  bad(value => { component(value, 'locations').tileUrl = 'https://invalid.example/tiles' }, 'model data cannot configure map providers')
  bad(value => { component(value, 'locations').accessToken = 'not-a-token' }, 'model data cannot configure map tokens')
  bad(value => { value.state.point = 'missing' }, 'map selection must reference an existing point')
  bad(value => { component(value, 'locations').points = [] }, 'a map contains at least one bounded point')
  bad(value => { component(value, 'locations').points = Array.from({ length: 121 }, (_, index) => ({ id: 'point' + index, label: '点', longitude: 0, latitude: 0 })) }, 'map point capacity is bounded')
  bad(value => { value.state = { ...value.state, ...Object.fromEntries(Array.from({ length: 33 }, (_, index) => ['key' + index, 0])) } }, 'business data does not enlarge the state-key bound')
  bad(value => { component(value, 'records').rows = Array.from({ length: 25 }, (_, index) => ({ id: 'row' + index, cells: ['x'.repeat(2000), '', 0] })) }, 'business components retain the 48000-character surface bound', /size limit/)
  const boundaries = surface(1)
  component(boundaries, 'records').columns = Array.from({ length: 12 }, (_, index) => ({ id: index === 1 ? 'region' : 'column' + index, label: '列' + index }))
  component(boundaries, 'records').rows = Array.from({ length: 120 }, (_, index) => ({ id: 'row' + index, cells: Array.from({ length: 12 }, (_, column) => column === 1 ? '' : column % 3 === 0 ? null : column % 3 === 1 ? true : -1e12) }))
  UI.assertSurface(boundaries)
  const selectionBoundary = surface(1)
  component(selectionBoundary, 'locations').points = [{ id: 'west', label: '西南边界', longitude: -180, latitude: -90 }, { id: 'east', label: '东北边界', longitude: 180, latitude: 90 }]
  UI.assertSurface(selectionBoundary)
  const cycles = surface(1)
  component(cycles, 'process').edges.push({ from: 'review', to: 'collect', label: '退回' })
  UI.assertSurface(cycles)
  const empty = surface(1)
  component(empty, 'records').rows = []
  UI.assertSurface(empty)
  const readOnly = surface(1)
  delete component(readOnly, 'records').selectionKey
  UI.assertSurface(readOnly)
  assert.throws(() => interactions.changeState(readOnly, readOnly.state, 'records', 'east'), /selection binding/)
  const count = { version: 2, id: 'capacity', revision: 1, title: '容量', root: 'root', state: {}, actions: [], components: [{ id: 'root', type: 'column', children: [] }] }
  for (let index = 0; index < 63; index++) { count.components[0].children.push('text' + index); count.components.push({ id: 'text' + index, type: 'text', text: '' }) }
  UI.assertSurface(count)
  count.components[0].children.push('overflow'); count.components.push({ id: 'overflow', type: 'text', text: '' })
  assert.throws(() => UI.assertSurface(count), /length/)

  const capabilities = UI.capabilities()
  assert.deepStrictEqual(capabilities.versions, [1, 2])
  assert(['table', 'filter', 'progress', 'flow', 'map'].every(kind => capabilities.components.includes(kind)))
  assert.deepStrictEqual(UI.negotiate(capabilities), capabilities)
  const oldCapabilities = { versions: [1], components: UI.LEGACY_COMPONENTS.slice() }
  assert.deepStrictEqual(UI.negotiate(oldCapabilities), oldCapabilities)
  UI.assertRenderable(legacy, oldCapabilities)
  UI.assertRenderable(surface(1), capabilities)
  assert.throws(() => UI.assertRenderable(surface(1), oldCapabilities), /capability mismatch/)
  assert.throws(() => UI.assertRenderable(surface(1), { versions: [1, 2], components: capabilities.components.filter(kind => kind !== 'map') }), /capability mismatch/)
  assert.strictEqual(UI.negotiate({ versions: [3], components: ['future'] }), null)
  assert.strictEqual(UI.negotiate(undefined), null)
  assert.throws(() => UI.assertRenderable(surface(1), null), /capability mismatch/)
  assert.deepStrictEqual(UI.negotiate({ versions: [3, 2], components: ['future', 'map'] }), { versions: [2], components: ['map'] })
  for (const input of [{ versions: [1, 1], components: [] }, { versions: [], components: [] }, { versions: [2], components: ['map', 'map'] }, { versions: [2], components: ['../../main'] }, { versions: [2], components: ['map'], eval: true }]) assert.throws(() => UI.negotiate(input), /GENERATIVE_UI_INVALID/)
  capabilities.versions.push(99); capabilities.components.push('future')
  assert.deepStrictEqual(UI.capabilities().versions, [1, 2], 'capability negotiation cannot mutate the authoritative advertised versions')
  assert(!UI.capabilities().components.includes('future'))
  console.log('Generative UI P3 schema: ' + rejected + ' invalid business surfaces rejected; bounded tables, filters, progress, flow/map references, legacy v1 and capability negotiation passed.')
}

async function checkRuntime() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ui-business-'))
  const settings = { file: path.join(tmp, 'settings.json'), data: { maxIterations: 5, permissionMode: 'readonly', workspacePath: tmp }, all() { return this.data } }
  const host = new PluginHost({ workspaceRoot: tmp, settings, enableGenerativeUiProtocolForTests: true })
  const events = [], prompts = []
  let requests = 0, model, step = 0
  const pool = new AgentPool({ settings, pluginHost: host, sessionRoot: path.join(tmp, 'sessions'), emit: event => events.push(event), approve: async () => false })
  try {
    await host.ready()
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: input => { requests++; return model(input) } }) } })
    const ui = host.requireService('generativeUi')
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('business-create', 'render_ui', { operation: 'create', expectedRevision: 0, surface: surface(1) })] } : { content: '已记录业务界面', toolCalls: [] }
    await pool.run('businessSession', '生成业务界面', [])
    assert.strictEqual(pool.acquire('businessSession').messages.length, 0)
    let snapshot = ui.read(pool, { version: 1, sessionId: 'businessSession', surfaceId: 'business' })
    assert.deepStrictEqual(snapshot.definitions.business, surface(1))
    assert.strictEqual(snapshot.surfaces.business.stateVersion, 0)
    const edits = [edit('filter-change', 'regionFilter', '华东', 0), edit('table-change', 'records', 'east', 1), edit('flow-change', 'process', 'review', 2), edit('map-change', 'locations', 'shanghai', 3)]
    for (const request of edits) {
      snapshot = ui.change(pool, request)
      assert.strictEqual(snapshot.surfaces.business.stateVersion, request.expectedStateVersion + 1)
    }
    const savedValues = { region: '华东', row: 'east', node: 'review', point: 'shanghai', progress: 35, privateNote: '不回传的说明' }
    assert.deepStrictEqual(snapshot.surfaces.business.state, savedValues)
    const sequence = snapshot.sequence
    assert.strictEqual(ui.change(pool, edits[3]).sequence, sequence, 'the latest committed selection is acknowledged without appending another fact')
    const invalid = [
      [edit('filter-unknown', 'regionFilter', '不存在', 4), /GENERATIVE_UI_INVALID/],
      [edit('table-unknown', 'records', 'missing', 4), /GENERATIVE_UI_INVALID/],
      [edit('flow-unknown', 'process', 'missing', 4), /GENERATIVE_UI_INVALID/],
      [edit('map-unknown', 'locations', 'missing', 4), /GENERATIVE_UI_INVALID/],
      [edit('map-type', 'locations', 1, 4), /value type/],
      [edit('progress-forged', 'progress', 100, 4), /editable component/],
      [edit('button-forged', 'send', 'review', 4), /editable component/],
      [edit('missing-component', 'absent', 'review', 4), /editable component/],
      [edit('stale-cursor', 'records', 'north', 3), /STATE_UI_STATE_CONFLICT/],
      [edit('wrong-revision', 'locations', 'beijing', 4, { revision: 2 }), /STATE_UI_REVISION_CONFLICT/],
      [edit('injected-tool', 'locations', 'beijing', 4, { tool: 'shell' }), /fields/],
      [edit('injected-binding', 'records', 'north', 4, { stateKey: 'point' }), /fields/]
    ]
    for (const [request, pattern] of invalid) assert.throws(() => ui.change(pool, request), pattern)
    assert.strictEqual(ui.read(pool, { version: 1, sessionId: 'businessSession' }).sequence, sequence, 'rejected selections never become durable facts')
    assert.throws(() => ui.change(pool, edit('cross-session', 'locations', 'beijing', 4, { sessionId: 'anotherSession' })), /NOT_AUTHORITATIVE/)
    await pool.releaseWorker('businessSession')
    snapshot = ui.read(pool, { version: 1, sessionId: 'businessSession', surfaceId: 'business' })
    assert.deepStrictEqual(snapshot.surfaces.business.state, savedValues, 'all four control types recover through the real session repository')
    assert.strictEqual(snapshot.surfaces.business.stateVersion, 4)
    const worker = pool.acquire('businessSession')
    const persisted = host.requireService('sessions').load(worker)
    interactions.assertAggregate(persisted.ui)
    assert.deepStrictEqual(state.restore({ version: 2, ...persisted }).ui, persisted.ui)
    assert.strictEqual(persisted.ui.surfaces.business.lastChange.componentId, 'locations')
    assert.strictEqual(persisted.ui.surfaces.business.lastChange.value, 'shanghai')

    let release
    const gate = new Promise(resolve => { release = resolve })
    model = async input => { prompts.push(input.messages); await gate; return { content: '已分析所选记录、步骤和位置', toolCalls: [] } }
    const request = action('business-analyze', 4)
    const beforeAction = requests
    const accepted = ui.dispatch(pool, request)
    assert(accepted.started && pool.isRunning('businessSession'))
    assert.deepStrictEqual(accepted.receipt.values, { region: '华东', row: 'east', node: 'review', point: 'shanghai' })
    assert.strictEqual(ui.dispatch(pool, request).started, false)
    assert.throws(() => ui.dispatch(pool, { ...request, requestId: 'while-running' }), /SESSION_BUSY/)
    release()
    await pool.running.get('businessSession').done
    assert.strictEqual(requests, beforeAction + 1, 'duplicate clicks do not make a second model request')
    snapshot = ui.read(pool, { version: 1, sessionId: 'businessSession' })
    assert.strictEqual(snapshot.receipts.find(item => item.requestId === request.requestId).status, 'completed')
    const prompt = prompts[0].filter(message => message.role === 'user').pop().content
    for (const [key, value] of Object.entries(accepted.receipt.values)) assert(prompt.includes(JSON.stringify(key) + ':' + JSON.stringify(value)))
    assert(!prompt.includes('privateNote') && !prompt.includes('progress'), 'unselected business values are not sent as action parameters')
    assert(!JSON.stringify(prompts).includes('"type":"ui"'), 'providers receive the normal text projection, not internal UI blocks')
    assert.strictEqual(ui.dispatch(pool, request).started, false)
    assert.strictEqual(requests, beforeAction + 1)
    assert(events.some(event => event.type === 'finished' && event.ui && event.ui.receipts.some(receipt => receipt.requestId === request.requestId && receipt.status === 'completed')))

    step = 0
    model = async () => step++ === 0 ? { content: '', toolCalls: [call('business-update', 'update_ui', { expectedRevision: 1, surface: surface(2) })] } : { content: '已更新业务界面', toolCalls: [] }
    ui.dispatch(pool, action('business-update', 4))
    await pool.running.get('businessSession').done
    snapshot = ui.read(pool, { version: 1, sessionId: 'businessSession', surfaceId: 'business' })
    assert.strictEqual(snapshot.surfaces.business.revision, 2)
    assert.strictEqual(snapshot.surfaces.business.stateVersion, 0)
    assert.deepStrictEqual(snapshot.surfaces.business.state, surface(2).state, 'a new revision uses its explicit defaults, not guessed selection merging')
    assert.deepStrictEqual(snapshot.definitions.business, surface(2))
    assert.throws(() => ui.change(pool, edit('stale-after-update', 'locations', 'beijing', 4)), /REVISION_CONFLICT/)
    assert.throws(() => ui.dispatch(pool, action('stale-action', 4)), /REVISION_CONFLICT/)
    assert.throws(() => ui.dispatch(pool, action('mismatched-button', 0, { revision: 2, componentId: 'records' })), /ACTION_MISMATCH/)
    assert.throws(() => ui.dispatch(pool, action('mismatched-action', 0, { revision: 2, actionId: 'unknown' })), /ACTION_MISMATCH/)
    ui.change(pool, edit('cleared-selection', 'locations', '', 0, { revision: 2 }))
    await pool.releaseWorker('businessSession')
    snapshot = ui.read(pool, { version: 1, sessionId: 'businessSession' })
    assert.strictEqual(snapshot.surfaces.business.stateVersion, 1)
    assert.strictEqual(snapshot.surfaces.business.state.point, '')
    const recoveredWorker = pool.acquire('businessSession')
    const history = host.requireService('sessions').load(recoveredWorker).messages
    recoveredWorker.replaceHistory(history.concat([{ role: 'assistant', content: [{ type: 'ui', toolCallId: 'future-business', surface: { version: 3, id: 'business', revision: 3 } }] }]))
    assert(!ui.read(pool, { version: 1, sessionId: 'businessSession' }).surfaces.business)
    assert.throws(() => ui.change(pool, edit('future-change', 'locations', 'beijing', 1, { revision: 2 })), /VERSION_UNSUPPORTED/)
    assert.throws(() => ui.dispatch(pool, action('future-action', 1, { revision: 2 })), /VERSION_UNSUPPORTED/)
    const beforeRecovery = requests
    await pool.releaseWorker('businessSession')
    assert(!ui.read(pool, { version: 1, sessionId: 'businessSession' }).surfaces.business)
    assert.strictEqual(requests, beforeRecovery, 'loading an unknown future surface never executes or replays its action')
    console.log('Generative UI P3 runtime: real Cordis publication, durable filter/table/flow/map selections, exact binding/session/cursors, selected-state Agent feedback, duplicate protection, revision reset and future-version recovery passed. Node ' + process.versions.node)
  } finally {
    await pool.dispose()
    await host.dispose()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() { checkSchema(); await checkRuntime() }
main().catch(error => { console.error(error.stack || error); process.exitCode = 1 })
