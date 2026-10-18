'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const contracts = require('../src/main/contracts')
const state = require('../src/main/state/session-state')
const flow = require('../src/main/flow/turn-flow')
const { SessionRepository } = require('../src/main/state/session-repository')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { Agent } = require('../src/main/agent/agent')
const { EVENTS } = contracts

function event(type, sequence, data) { return { version: 1, at: '2026-10-17T00:00:00.000Z', type, sequence, data: data || {} } }
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-layers-'))
  const host = new PluginHost({ workspaceRoot: root, settings: { data: {} } })
  try {
    // Contract and pure flow modules work without a Cordis runtime or IO.
    assert.throws(() => contracts.assertArguments({ type: 'object', required: ['path'], properties: { path: { type: 'string' } } }, { path: 5 }), /CONTRACT_INVALID/)
    assert.throws(() => contracts.assertArguments({ type: 'object', required: ['path'] }, {}), /required/)
    assert.throws(() => contracts.assertModelResult({ toolCalls: [{ function: { name: 'x', arguments: {} } }] }), /CONTRACT_INVALID/)
    assert.strictEqual(flow.retry({ error: 'does not support tools', toolsEnabled: true }), 'without-tools')
    assert.strictEqual(flow.retry({ contextLengthError: true, attempt: 0 }), 'compact')
    assert.strictEqual(flow.retry({ contextLengthError: true, attempt: 2 }), 'stop')
    assert.strictEqual(flow.next({ calls: [], deniedCount: 0, maxDenied: 3 }), 'complete')
    assert.strictEqual(flow.next({ calls: [{}], deniedCount: 3, maxDenied: 3 }), 'blocked')
    assert.strictEqual(flow.next({ calls: [{}], aborted: true }), 'cancel')
    const batch = contracts.sanitizeHistory([
      { role: 'assistant', content: null, tool_calls: ['a', 'b'].map((id) => ({ id, function: { name: 'tool', arguments: '{}' } })) },
      { role: 'tool', tool_call_id: 'a', content: 'first real result' },
      { role: 'tool', tool_call_id: 'b', content: 'second real result' }
    ])
    assert.deepStrictEqual(batch.filter((item) => item.role === 'tool').map((item) => item.content), ['first real result', 'second real result'])
    let s = state.initial()
    assert.throws(() => state.reduce(s, event(EVENTS.STEP, 1)), /STATE_INVALID_TRANSITION/)
    s = state.reduce(s, event(EVENTS.START, 1, { id: 'test', maxSteps: 1 }))
    assert.throws(() => state.reduce(s, event(EVENTS.START, 2, { id: 'bad', maxSteps: 1 })), /STATE_TURN_BUSY/)
    s = state.reduce(s, event(EVENTS.STEP, 2))
    assert.throws(() => state.reduce(s, event(EVENTS.STEP, 3)), /STATE_STEP_LIMIT/)
    s = state.reduce(s, event(EVENTS.REQUEST, 3))
    s = state.reduce(s, event(EVENTS.TOOL_START, 4, { id: 'a', name: 'tool' }))
    assert.throws(() => state.reduce(s, event(EVENTS.TOOL_END, 5, { id: 'b', name: 'tool', outcome: 'success' })), /MISMATCH/)
    s = state.reduce(s, event(EVENTS.CANCEL, 5, { reason: 'user' }))
    assert.strictEqual(s.execution.status, 'cancelled')
    assert.throws(() => state.reduce(s, event(EVENTS.REQUEST, 6)), /INVALID_TRANSITION/)
    assert.throws(() => state.reduce(s, event(EVENTS.MEMORY, 8, { memory: null })), /SEQUENCE_GAP/)
    assert(Object.isFrozen(s) && Object.isFrozen(s.messages))

    const repository = new SessionRepository(state, contracts)
    const legacy = { sessionDir: path.join(root, 'legacy') }
    fs.mkdirSync(legacy.sessionDir)
    fs.writeFileSync(path.join(legacy.sessionDir, 'last-session.json'), JSON.stringify({ version: 2, messages: [{ role: 'user', content: 'legacy history' }], memory: null }))
    assert.strictEqual(repository.load(legacy).messages[0].content, 'legacy history')
    const interrupted = { sessionDir: path.join(root, 'interrupted'), state: state.initial() }
    for (const e of [event(EVENTS.START, 1, { id: 'unfinished', maxSteps: 3 }), event(EVENTS.MESSAGE, 2, { message: { role: 'user', content: 'durable before crash' } })]) {
      repository.append(interrupted, e)
      interrupted.state = state.reduce(interrupted.state, e)
    }
    fs.appendFileSync(path.join(interrupted.sessionDir, 'events.jsonl'), '{"partial":')
    const recovered = repository.load(interrupted)
    assert.strictEqual(recovered.sequence, 2)
    assert.strictEqual(recovered.messages[0].content, 'durable before crash')
    assert(fs.readFileSync(path.join(interrupted.sessionDir, 'events.jsonl'), 'utf8').endsWith('\n'))
    fs.appendFileSync(path.join(interrupted.sessionDir, 'events.jsonl'), '{bad committed json}\n')
    assert.throws(() => repository.load(interrupted), /JSON|position|property|Unexpected/)
    // Committed corruption is never silently truncated or overwritten.
    assert(fs.readFileSync(path.join(interrupted.sessionDir, 'events.jsonl'), 'utf8').includes('{bad committed json}'))

    await host.ready()
    let model = async () => ({ content: 'normal result', toolCalls: [] })
    await host.replace('core/llm', { name: 'core/llm', apply(ctx) { ctx.provide('llm', { request: (request) => model(request) }) } })
    const settings = { data: { maxIterations: 2 }, workspacePath: root }
    const outputs = []
    const agent = new Agent(settings, (e) => outputs.push(e), async () => true, path.join(root, 'conversation'), host)
    await agent.run('hello', [])
    assert.strictEqual(agent.state.execution.status, 'completed')
    assert.strictEqual(agent.messages.length, 0, 'idle worker releases heavy conversation payload')
    const saved = host.get('sessions').load(agent)
    assert(saved.messages.some((m) => m.content === 'normal result'))
    assert.strictEqual(saved.execution.status, 'completed')
    /* 持久化的唯一真相是快照：save() 之后日志必须被清空。
       不清的话每轮 replaceHistory 会把整份历史再写一遍（按轮次平方增长），
       下一轮 sessions.load() 又把整份日志读回内存 —— 2026-10-17 的内存实测就是查到这里。
       所以这里改成断言「日志已空 + 快照带着完整事实 + 序号单调」，而不是去日志里找事件。 */
    const onDisk = fs.readFileSync(path.join(agent.sessionDir, 'events.jsonl'), 'utf8')
    assert.strictEqual(onDisk, '', 'journal must be truncated after the snapshot is written')
    const snapshot = JSON.parse(fs.readFileSync(path.join(agent.sessionDir, 'last-session.json'), 'utf8'))
    assert(snapshot.messages.some((m) => m.content === 'normal result'), 'snapshot must carry the conversation')
    assert.strictEqual(snapshot.execution.status, 'completed')
    assert(snapshot.sequence > 0, 'snapshot must carry the event sequence')

    model = async () => ({ content: 'bad', toolCalls: [{ function: { name: 'x', arguments: {} } }] })
    await agent.run('invalid model result', [])
    assert.strictEqual(agent.state.execution.status, 'failed')
    assert(outputs.some((e) => e.type === 'error' && e.message.includes('CONTRACT_INVALID')))
    assert.strictEqual(host.get('sessions').load(agent).execution.status, 'failed')

    let entered
    model = (request) => new Promise((resolve, reject) => {
      entered()
      request.signal.addEventListener('abort', () => reject(new Error('ABORTED')), { once: true })
    })
    const running = new Promise((resolve) => { entered = resolve })
    const turn = agent.run('cancel me', [])
    await running
    agent.abort()
    await turn
    assert.strictEqual(host.get('sessions').load(agent).execution.status, 'cancelled')
    settings.data.turnTimeoutMs = 10
    await agent.run('time out', [])
    assert.strictEqual(host.get('sessions').load(agent).execution.status, 'timed_out')
    settings.data.turnTimeoutMs = 0

    let toolRuns = 0
    host.use({ name: 'test/counter', apply(ctx) {
      ctx.registerTool({ name: 'counter', permission: 'read', parameters: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } }, execute: () => { toolRuns += 1; return 'counted' } })
    } })
    await host.ready()
    await assert.rejects(host.executeTool('counter', { value: 'bad' }, {}), /CONTRACT_INVALID/)
    assert.strictEqual(toolRuns, 0)
    // Replacing FLOW (not the executor) changes the actual public Agent path.
    await host.replace('core/flow', { name: 'core/flow', apply(ctx) { ctx.provide('flow', { ...flow, limits: (config) => ({ ...flow.limits(config), maxSteps: 1 }) }) } })
    model = async () => ({ content: null, toolCalls: [{ id: 'counter-1', function: { name: 'counter', arguments: '{"value":1}' } }] })
    await agent.run('bounded flow', [])
    assert.strictEqual(agent.state.execution.status, 'exhausted')
    assert.strictEqual(toolRuns, 1)
    assert.strictEqual(agent.state.execution.step, 1)

    for (const decision of ['cancel', 'blocked']) {
      await host.replace('core/flow', { name: 'core/flow', apply(ctx) { ctx.provide('flow', { ...flow, next: () => decision }) } })
      await agent.run('policy decision', [])
      assert.strictEqual(agent.state.execution.status, decision === 'cancel' ? 'cancelled' : 'blocked')
      assert.strictEqual(toolRuns, 1, 'policy must prevent tool execution')
    }
    await host.replace('core/flow', { name: 'core/flow', apply(ctx) { ctx.provide('flow', flow) } })

    // Replay committed facts after a simulated process loss, without retrying tools.
    const crash = { sessionDir: path.join(root, 'crash'), state: state.initial() }
    const journal = host.get('sessions')
    const crashEvents = [
      event(EVENTS.START, 1, { id: 'crashed', maxSteps: 2 }),
      event(EVENTS.STEP, 2),
      event(EVENTS.REQUEST, 3),
      event(EVENTS.MESSAGE, 4, { message: { role: 'assistant', content: null, tool_calls: [{ id: 'unknown-effect', function: { name: 'counter', arguments: '{"value":1}' } }] } }),
      event(EVENTS.TOOL_START, 5, { id: 'unknown-effect', name: 'counter' })
    ]
    for (const e of crashEvents) { journal.append(crash, e); crash.state = state.reduce(crash.state, e) }
    /* 日志在轮次收尾 save() 时会被截断（快照才是唯一真相），所以「恢复时记了一条 INTERRUPT」
       要在这一轮**还没收尾**的时候验 —— 正好借模型被调用的这一刻读日志。 */
    let sawInterrupt = false
    model = async (request) => {
      assert(request.messages.some((m) => m.role === 'tool' && m.tool_call_id === 'unknown-effect'))
      const lines = fs.readFileSync(path.join(crash.sessionDir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)
      sawInterrupt = lines.some((line) => JSON.parse(line).type === EVENTS.INTERRUPT)
      return { content: 'recovered context', toolCalls: [] }
    }
    const resumed = new Agent(settings, () => {}, async () => true, crash.sessionDir, host)
    await resumed.run('continue')
    assert.strictEqual(resumed.state.execution.status, 'completed')
    assert.strictEqual(toolRuns, 1, 'uncertain side effects must not automatically replay')
    assert(sawInterrupt, 'recovery must record INTERRUPT so the uncertain previous turn is not silently trusted')
    const resumedSnapshot = JSON.parse(fs.readFileSync(path.join(crash.sessionDir, 'last-session.json'), 'utf8'))
    assert(resumedSnapshot.execution.status === 'completed')
    assert.strictEqual(fs.readFileSync(path.join(crash.sessionDir, 'events.jsonl'), 'utf8'), '')
    await resumed.dispose()
    await agent.dispose()

    // A failed durable append cannot expose a state change or overwrite snapshots.
    let savedAfterFailure = false
    await host.replace('core/sessions', { name: 'core/sessions', apply(ctx) {
      ctx.provide('sessions', {
        load: () => state.initial(),
        append: () => { throw new Error('SIMULATED_DISK_FULL') },
        save: () => { savedAfterFailure = true }
      })
    } })
    const failedOutput = []
    const failedAgent = new Agent(settings, (e) => failedOutput.push(e), async () => true, path.join(root, 'disk-full'), host)
    await failedAgent.run('must not commit')
    assert.strictEqual(failedAgent.state.sequence, 0)
    assert.strictEqual(failedAgent.state.execution.status, 'idle')
    assert(!savedAfterFailure)
    assert(failedOutput.some((e) => e.type === 'error' && e.message === 'SIMULATED_DISK_FULL'))
    assert(!failedOutput.find((e) => e.type === 'finished').messages, 'failed admission cannot erase client history')
    await failedAgent.dispose()
    console.log('Layered Agent OK: contracts, pure flow replacement, guarded state transitions, legacy migration, journal replay/tail recovery, cancellation, deadlines, step limits, no duplicate tool side effects')
  } finally {
    await host.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
