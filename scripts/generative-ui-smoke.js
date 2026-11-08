'use strict'

const assert = require('assert')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const UI = require('../src/main/contracts/generative-ui')
const contracts = require('../src/main/contracts')
const state = require('../src/main/state/session-state')
const context = require('../src/main/agent/context-compressor')
const { SessionRepository } = require('../src/main/state/session-repository')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { Agent } = require('../src/main/agent/agent')
const { requestChat } = require('../src/main/agent/llm')
const { EVENTS } = contracts

function example(revision, title) {
  return {
    version: 1, id: 'sales', revision, title: title || '季度收入', root: 'layout',
    state: { factor: 1 },
    components: [
      { id: 'layout', type: 'column', children: ['description', 'graph', 'scale', 'send'] },
      { id: 'description', type: 'text', text: '以滑块调整倍数' },
      { id: 'graph', type: 'chart', chartType: 'line', title: '收入', labels: ['第一季', '第二季'], series: [{ id: 'income', name: '收入', values: [2, 4] }], multiplierKey: 'factor' },
      { id: 'scale', type: 'slider', label: '倍数', stateKey: 'factor', min: 0, max: 5, step: 0.5 },
      { id: 'send', type: 'button', label: '分析', actionId: 'analyze' }
    ],
    actions: [{ id: 'analyze', type: 'ask_agent', message: '分析当前数据', stateKeys: ['factor'] }]
  }
}
function formExample() {
  const surface = example(1)
  Object.assign(surface.state, { note: '初始', confirmed: false })
  surface.components[0].children.push('form')
  surface.components.push(
    { id: 'form', type: 'form', label: '查询条件', children: ['input', 'checkbox'] },
    { id: 'input', type: 'input', label: '关键词', stateKey: 'note', maxLength: 12 },
    { id: 'checkbox', type: 'checkbox', label: '包含归档', stateKey: 'confirmed' }
  )
  return surface
}
function clone(value) { return JSON.parse(JSON.stringify(value)) }
function e(type, sequence, data) { return { version: 1, sequence, type, at: '2026-11-07T00:00:00.000Z', data: data || {} } }
function call(id, name, args) { return { id, function: { name, arguments: JSON.stringify(args) } } }
function blocks(messages) {
  return messages.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part && part.type === 'ui') : [])
}
function bad(change, label) {
  const value = example(1)
  change(value)
  assert.throws(() => UI.assertSurface(value), /GENERATIVE_UI_INVALID/, label)
}

async function checkProviderProjection(mode) {
  let body = ''
  const server = http.createServer((request, response) => {
    request.setEncoding('utf8')
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      response.writeHead(200, { 'content-type': mode === 'ollama' ? 'application/x-ndjson' : 'text/event-stream' })
      response.end(mode === 'ollama'
        ? JSON.stringify({ message: { role: 'assistant', content: 'ok' }, done: true }) + '\n'
        : 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const messages = await context.buildPayloadMessages({ messages: [
      { role: 'system', content: 'system' },
      { role: 'assistant', content: [{ type: 'text', text: '说明' }, { type: 'ui', toolCallId: 'ui1', surface: example(1) }], tool_calls: [call('ui1', 'render_ui', {})] },
      { role: 'tool', tool_call_id: 'ui1', content: 'recorded' },
      { role: 'user', content: '继续' }
    ] })
    const port = server.address().port
    const result = await requestChat({ settings: { baseURL: 'http://127.0.0.1:' + port + (mode === 'ollama' ? '/11434' : '/v1'), model: 'mock' }, messages })
    assert.strictEqual(result.content, 'ok')
    const payload = JSON.parse(body)
    const assistant = payload.messages.find(message => message.role === 'assistant')
    assert.strictEqual(typeof assistant.content, 'string')
    assert(assistant.content.includes('交互界面'))
    assert(!body.includes('"type":"ui"'), mode + ' must never receive internal UI blocks')
  } finally { await new Promise(resolve => server.close(resolve)) }
}

async function main() {
  UI.assertSurface(example(1))
  bad(s => { s.version = 3 }, 'unsupported version is never executed')
  bad(s => { s.components[2].chartType = 'pie' }, 'only supported chart types')
  bad(s => { s.components[2].option = { formatter: 'function() {}' } }, 'arbitrary chart options')
  bad(s => { s.components[1].html = '<script>run()</script>' }, 'untrusted HTML')
  bad(s => { s.components[3].onchange = 'window.fetch("https://example.com")' }, 'event handlers')
  bad(s => { s.actions[0].type = 'invoke_tool'; s.actions[0].tool = 'shell' }, 'arbitrary tools')
  bad(s => { s.components[0].children.push('layout') }, 'cyclic tree')
  bad(s => { s.components[0].children.push('send') }, 'duplicate child')
  bad(s => { s.components[4].actionId = 'missing' }, 'missing action')
  bad(s => { s.components[3].stateKey = 'missing' }, 'missing state binding')
  bad(s => { s.components[2].series[0].values = [1] }, 'chart data lengths')
  bad(s => { s.components[2].series[0].values[0] = Infinity }, 'finite chart values')
  bad(s => { s.state.factor = 0.3 }, 'slider step alignment')
  bad(s => { s.state.factor = 1.0000002 }, 'slider alignment tolerance')
  bad(s => { s.components[3].step = 0.000001 }, 'slider step count')
  bad(s => { s.state.factor = 6 }, 'slider range')
  bad(s => { s.state = JSON.parse('{"__proto__": 1}') }, 'prototype keys')
  bad(s => { s.components[1].text = 'x'.repeat(50000) }, 'size bounds')
  const form = formExample()
  UI.assertSurface(form)
  for (const [label, change] of [
    ['form without accessible label', s => { s.components[5].label = '' }],
    ['form cannot add submit action', s => { s.components[5].action = 'https://invalid.example/' }],
    ['form child cycle', s => { s.components[5].children.push('layout') }],
    ['input must bind existing text', s => { s.components[6].stateKey = 'missing' }],
    ['input cannot bind number', s => { s.components[6].stateKey = 'factor' }],
    ['input rejects HTML attributes', s => { s.components[6].oninput = 'run()' }],
    ['input does not select an HTML input type', s => { s.components[6].inputType = 'password' }],
    ['input max length minimum', s => { s.components[6].maxLength = 0 }],
    ['input max length maximum', s => { s.components[6].maxLength = 2001 }],
    ['input max length integer', s => { s.components[6].maxLength = 1.5 }],
    ['input initial value respects length', s => { s.state.note = 'a'.repeat(13) }],
    ['input rejects line breaks', s => { s.state.note = 'a\nb' }],
    ['checkbox requires a boolean', s => { s.state.confirmed = 'true' }],
    ['checkbox requires existing state', s => { s.components[7].stateKey = 'missing' }]
  ]) {
    const invalid = clone(form); change(invalid)
    assert.throws(() => UI.assertSurface(invalid), /GENERATIVE_UI_INVALID/, label)
  }
  const bound = { ...form.state, note: '新值', confirmed: true }
  UI.assertSurfaceState(form, bound)
  assert.throws(() => UI.assertSurfaceState(form, { ...bound, note: 'x'.repeat(13) }), /input value is invalid/)
  assert.throws(() => UI.assertSurfaceState(form, { ...bound, confirmed: 1 }), /checkbox state is invalid/)
  const future = { type: 'ui', toolCallId: 'future', surface: { version: 3, opaque: { feature: 'new' } } }
  UI.assertBlock(future)
  // A valid near-limit surface must remain valid after the message envelope is added.
  const large = example(1)
  for (let i = 0; i < 11; i += 1) {
    const id = 'large' + i
    large.components[0].children.push(id)
    large.components.push({ id, type: 'text', text: 'x'.repeat(4000) })
  }
  large.components[0].children.push('tail')
  large.components.push({ id: 'tail', type: 'text', text: '' })
  const remaining = 47990 - JSON.stringify(large).length
  assert(remaining >= 0 && remaining <= 4000)
  large.components[large.components.length - 1].text = 'x'.repeat(remaining)
  UI.assertSurface(large)
  UI.assertBlock({ type: 'ui', toolCallId: 'x'.repeat(256), surface: large })
  state.restore({ version: 2, messages: [{ role: 'assistant', content: [{ type: 'ui', toolCallId: 'x'.repeat(256), surface: large }] }], memory: null })
  let nested = {}; const deep = nested
  for (let i = 0; i < 40; i += 1) { nested.child = {}; nested = nested.child }
  assert.throws(() => UI.assertBlock({ type: 'ui', toolCallId: 'deep', surface: { version: 3, deep } }), /nesting/ )
  assert.throws(() => UI.assertBlock({ type: 'ui', toolCallId: 'prototype', surface: JSON.parse('{"version":2,"constructor":{}}') }), /reserved key/ )
  assert.throws(() => UI.assertBlock({ ...future, surface: { version: 3, large: 'x'.repeat(50000) } }), /size limit/)
  assert.throws(() => contracts.assertMessage({ role: 'user', content: [future] }), /ui block role/)
  const legacy = state.restore({ version: 1, messages: [{ role: 'assistant', content: 'old string' }], memory: null })
  assert.strictEqual(legacy.messages[0].content, 'old string')
  const restoredFuture = state.restore({ version: 2, messages: [{ role: 'assistant', content: [future] }], memory: null })
  assert.deepStrictEqual(restoredFuture.messages[0].content[0], future)
  const projectedFuture = await context.buildPayloadMessages({ messages: [{ role: 'system', content: 'system' }, ...restoredFuture.messages] })
  assert(projectedFuture[1].content.includes('不支持'))
  assert(!JSON.stringify(projectedFuture).includes('"type":"ui"'))
  await checkProviderProjection('openai')
  await checkProviderProjection('ollama')

  // Verify reducer transitions independently of any transport or plugin.
  let s = state.initial()
  const reduce = (type, data) => { s = state.reduce(s, e(type, s.sequence + 1, data)); return s }
  reduce(EVENTS.START, { id: 'turn', maxSteps: 3 }); reduce(EVENTS.STEP); reduce(EVENTS.REQUEST)
  reduce(EVENTS.MESSAGE, { message: { role: 'assistant', content: '这是说明', tool_calls: [call('one', 'render_ui', {})] } })
  reduce(EVENTS.TOOL_START, { id: 'one', name: 'render_ui' })
  const first = { operation: 'create', expectedRevision: 0, toolCallId: 'one', surface: example(1) }
  assert.throws(() => state.reduce(s, e(EVENTS.UI_SURFACE, s.sequence + 1, { ...first, toolCallId: 'wrong' })), /STATE_UI_TOOL_MISMATCH/)
  const before = s
  reduce(EVENTS.UI_SURFACE, first)
  assert.strictEqual(before.messages[0].content, '这是说明')
  assert.deepStrictEqual(s.messages[0].content.map(part => part.type), ['text', 'ui'])
  assert(Object.isFrozen(s.messages[0].content[1].surface))
  assert.throws(() => state.reduce(s, e(EVENTS.UI_SURFACE, s.sequence + 1, first)), /STATE_UI_REVISION_CONFLICT/)
  assert.throws(() => contracts.assertEvent(e(EVENTS.UI_SURFACE, s.sequence + 1, { ...first, surface: example(2) })), /revision/)
  reduce(EVENTS.TOOL_END, { id: 'one', name: 'render_ui', outcome: 'success' })
  reduce(EVENTS.STEP); reduce(EVENTS.REQUEST)
  reduce(EVENTS.MESSAGE, { message: { role: 'assistant', content: null, tool_calls: [call('two', 'update_ui', {})] } })
  reduce(EVENTS.TOOL_START, { id: 'two', name: 'update_ui' })
  const update = { operation: 'update', expectedRevision: 1, toolCallId: 'two', surface: example(2) }
  const wrongOperation = example(1); wrongOperation.id = 'new_surface'
  assert.throws(() => state.reduce(s, e(EVENTS.UI_SURFACE, s.sequence + 1, { operation: 'create', expectedRevision: 0, toolCallId: 'two', surface: wrongOperation })), /STATE_UI_TOOL_MISMATCH/)
  reduce(EVENTS.UI_SURFACE, update)
  assert.strictEqual(UI.latest(s.messages, 'sales').revision, 2)
  assert.throws(() => state.reduce(s, e(EVENTS.UI_SURFACE, s.sequence + 1, { ...update, expectedRevision: 2, surface: example(3) })), /STATE_UI_ALREADY_PUBLISHED/)
  let forward = state.restore({ version: 2, messages: [{ role: 'assistant', content: [{ type: 'ui', toolCallId: 'future', surface: { version: 3, id: 'sales', revision: 3 } }] }], memory: null })
  const applyForward = (type, data) => { forward = state.reduce(forward, e(type, forward.sequence + 1, data)) }
  applyForward(EVENTS.START, { id: 'future-turn', maxSteps: 2 }); applyForward(EVENTS.STEP); applyForward(EVENTS.REQUEST)
  applyForward(EVENTS.MESSAGE, { message: { role: 'assistant', content: null, tool_calls: [call('future-update', 'update_ui', {})] } })
  applyForward(EVENTS.TOOL_START, { id: 'future-update', name: 'update_ui' })
  assert.throws(() => state.reduce(forward, e(EVENTS.UI_SURFACE, forward.sequence + 1, { operation: 'update', expectedRevision: 1, toolCallId: 'future-update', surface: example(2) })), /STATE_UI_VERSION_UNSUPPORTED/)
  const cappedMessages = []
  for (let i = 0; i < UI.MAX_SURFACES_PER_CONVERSATION; i += 1) {
    const surface = example(1); surface.id = 'surface_' + i
    cappedMessages.push({ role: 'assistant', content: [{ type: 'ui', toolCallId: 'old_' + i, surface }] })
  }
  let capped = state.restore({ version: 2, messages: cappedMessages, memory: null })
  const applyCap = (type, data) => { capped = state.reduce(capped, e(type, capped.sequence + 1, data)) }
  applyCap(EVENTS.START, { id: 'cap', maxSteps: 2 }); applyCap(EVENTS.STEP); applyCap(EVENTS.REQUEST)
  applyCap(EVENTS.MESSAGE, { message: { role: 'assistant', content: null, tool_calls: [call('cap-call', 'render_ui', {})] } })
  applyCap(EVENTS.TOOL_START, { id: 'cap-call', name: 'render_ui' })
  const extra = example(1); extra.id = 'new_surface'
  assert.throws(() => state.reduce(capped, e(EVENTS.UI_SURFACE, capped.sequence + 1, { operation: 'create', expectedRevision: 0, toolCallId: 'cap-call', surface: extra })), /STATE_UI_SURFACE_LIMIT/)
  const existing = example(2); existing.id = 'surface_0'
  applyCap(EVENTS.UI_SURFACE, { operation: 'update', expectedRevision: 1, toolCallId: 'cap-call', surface: existing })
  assert.strictEqual(UI.latest(capped.messages, 'surface_0').revision, 2, 'revisions remain possible at the distinct-surface limit')

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-generative-ui-'))
  const settings = { data: { maxIterations: 5 }, workspacePath: root }
  const disabled = new PluginHost({ workspaceRoot: root, settings })
  let host
  const agents = []
  try {
    await disabled.ready()
    assert(!disabled.getToolDefinitions().some(tool => ['render_ui', 'update_ui'].includes(tool.function.name)), 'clients without renderer negotiation are not offered UI tools')
    host = new PluginHost({ workspaceRoot: root, settings, enableGenerativeUiProtocolForTests: true })
    await host.ready()
    assert(host.getTool('render_ui') && host.getTool('update_ui'), 'Cordis must register the experimental tools')
    await assert.rejects(host.executeTool('render_ui', { operation: 'create', expectedRevision: 0, surface: example(1) }, { settings: {} }), /AGENT_CONTEXT_REQUIRED/)
    let recorded = 0, emitted = 0
    const fake = { record: () => { recorded += 1; throw new Error('DISK_FULL') }, emit: () => { emitted += 1 } }
    await assert.rejects(host.executeTool('render_ui', { operation: 'create', expectedRevision: 0, surface: example(1) }, { agent: fake, toolCallId: 'fake', settings: {} }), /DISK_FULL/)
    assert.strictEqual(recorded, 1)
    assert.strictEqual(emitted, 0, 'never announce an uncommitted surface')
    const denied = await host.executeTool('render_ui', { operation: 'create', expectedRevision: 0, surface: example(1) }, { agent: fake, toolCallId: 'fake', settings: { unattended: { tools: [] } } })
    assert(/^DENIED:/.test(denied))
    assert.strictEqual(recorded, 1, 'the existing permission gate must run before the UI tool')
    const disabledResult = await host.executeTool('render_ui', { operation: 'create', expectedRevision: 0, surface: example(1) }, { agent: fake, toolCallId: 'fake', settings: { disabledPlugins: ['core/generative-ui'] } })
    assert(/^DISABLED:/.test(disabledResult))
    assert.strictEqual(recorded, 1, 'disabled plugins cannot record UI')
    const cancelled = new AbortController(); cancelled.abort()
    await assert.rejects(host.executeTool('render_ui', { operation: 'create', expectedRevision: 0, surface: example(1) }, { agent: fake, toolCallId: 'fake', signal: cancelled.signal, settings: {} }), /ABORTED/)
    assert.strictEqual(recorded, 1, 'cancelled calls cannot record UI')

    const requests = [], counters = { A: 0, B: 0 }
    let model = async (request) => {
      requests.push(clone(request.messages))
      const lastUser = request.messages.filter(message => message.role === 'user').pop()
      const who = lastUser && lastUser.content
      const step = counters[who]++
      if (who === 'A' && step === 0) return { content: '创建说明', toolCalls: [call('a1', 'render_ui', { operation: 'create', expectedRevision: 0, surface: example(1, '会话甲') })] }
      if (who === 'A' && step === 1) return { content: null, toolCalls: [call('a2', 'render_ui', { operation: 'update', expectedRevision: 1, surface: example(2, '会话甲更新') })] }
      if (who === 'A' && step === 2) return { content: null, toolCalls: [call('a3', 'update_ui', { expectedRevision: 2, surface: example(3, '会话甲最终') })] }
      if (who === 'B' && step === 0) return { content: null, toolCalls: [call('b1', 'update_ui', { expectedRevision: 1, surface: example(2, '不应跨会话更新') })] }
      if (who === 'B' && step === 1) return { content: null, toolCalls: [call('b2', 'render_ui', { operation: 'create', expectedRevision: 0, surface: example(1, '会话乙') })] }
      return { content: '协议事实已记录，尚未渲染', toolCalls: [] }
    }
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: request => model(request) }) } })
    const outputA = [], outputB = []
    const a = new Agent(settings, event => outputA.push(event), async () => true, path.join(root, 'a'), host)
    const b = new Agent(settings, event => outputB.push(event), async () => true, path.join(root, 'b'), host)
    agents.push(a, b)
    await Promise.all([a.run('A', []), b.run('B', [])])
    const savedA = host.get('sessions').load(a), savedB = host.get('sessions').load(b)
    assert.strictEqual(savedA.execution.status, 'completed')
    assert.strictEqual(savedB.execution.status, 'completed')
    assert.deepStrictEqual(blocks(savedA.messages).map(block => block.surface.revision), [1, 2, 3])
    assert.deepStrictEqual(blocks(savedB.messages).map(block => block.surface.revision), [1])
    assert.strictEqual(UI.latest(savedA.messages, 'sales').title, '会话甲最终')
    assert.strictEqual(UI.latest(savedB.messages, 'sales').title, '会话乙')
    assert(savedB.messages.some(message => message.role === 'tool' && /STATE_UI_REVISION_CONFLICT/.test(message.content)))
    assert.strictEqual(outputA.filter(event => event.type === 'ui:surface').length, 3)
    assert.strictEqual(outputB.filter(event => event.type === 'ui:surface').length, 1)
    assert(requests.some(messages => JSON.stringify(messages).includes('交互界面')))
    assert(requests.every(messages => !JSON.stringify(messages).includes('"type":"ui"')), 'custom UI blocks cannot leak into provider payloads')
    assert(savedA.messages.some(message => message.role === 'tool' && message.content.includes('"rendered":false')))

    // Replaying a committed UI fact after a crash restores it without running a tool again.
    const journal = new SessionRepository(state, contracts)
    const crash = { sessionDir: path.join(root, 'crash'), state: state.initial() }
    const crashEvents = [
      e(EVENTS.START, 1, { id: 'crash', maxSteps: 3 }), e(EVENTS.STEP, 2), e(EVENTS.REQUEST, 3),
      e(EVENTS.MESSAGE, 4, { message: { role: 'assistant', content: null, tool_calls: [call('crash-call', 'render_ui', {})] } }),
      e(EVENTS.TOOL_START, 5, { id: 'crash-call', name: 'render_ui' }),
      e(EVENTS.UI_SURFACE, 6, { operation: 'create', expectedRevision: 0, toolCallId: 'crash-call', surface: example(1, '崩溃恢复') })
    ]
    for (const event of crashEvents) { journal.append(crash, event); crash.state = state.reduce(crash.state, event) }
    assert.strictEqual(UI.latest(journal.load(crash).messages, 'sales').title, '崩溃恢复')
    model = async () => ({ content: '恢复完成', toolCalls: [] })
    const recoveryEvents = []
    const recovery = new Agent(settings, event => recoveryEvents.push(event), async () => true, crash.sessionDir, host)
    agents.push(recovery)
    await recovery.run('继续')
    const recovered = host.get('sessions').load(recovery)
    assert.strictEqual(UI.latest(recovered.messages, 'sales').title, '崩溃恢复')
    assert(!recoveryEvents.some(event => event.type === 'ui:surface'), 'recovery must not repeat the tool')
    assert(recovered.messages.some(message => message.role === 'tool' && message.tool_call_id === 'crash-call'))
    await host.unload('core/generative-ui')
    assert(!host.getTool('render_ui') && !host.getTool('update_ui'), 'Cordis teardown must remove both tools')
    console.log('Generative UI P0 OK: bounded schema, security, versioning, mixed blocks, real Cordis tools, revision conflicts, session isolation, provider projection, persistence and crash recovery; renderer disabled')
  } finally {
    for (const agent of agents) await agent.dispose()
    if (host) await host.dispose()
    await disabled.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
