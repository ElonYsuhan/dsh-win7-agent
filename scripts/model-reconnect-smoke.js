'use strict'

// Real Cordis Agent + isolated model/tool services; no real network or credentials.
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const https = require('https')
const net = require('net')
const tls = require('tls')
const { certForTest } = require('./test-support/ephemeral-tls')
const flow = require('../src/main/flow/turn-flow')
const contracts = require('../src/main/contracts')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { Agent } = require('../src/main/agent/agent')

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', resolve)) }
function close(server) { return new Promise(resolve => server.close(resolve)) }
function line(delta, finish) { return 'data: ' + JSON.stringify({ choices: [{ delta, finish_reason: finish || null }] }) + '\n\n' }
function tool(id) { return { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'counter', arguments: '{"value":1}' } }] } }

async function main() {
  assert.deepStrictEqual(flow.limits({}).reconnectDelaysMs, [1000, 2000, 4000, 8000, 16000])
  for (const input of [
    { code: 'ECONNRESET' }, { code: 'EAI_AGAIN' },
    { error: 'Client network socket disconnected before secure TLS connection was established' },
    { error: 'LLM_RESPONSE_ABORTED' }, { error: 'LLM_STREAM_INCOMPLETE: missing done' },
    { error: 'MODEL_PROXY_TIMEOUT' }, { error: 'LLM_HTTP_503: gateway' }
  ]) assert.strictEqual(flow.retry(input), 'reconnect', JSON.stringify(input))
  for (const input of [
    { code: 'CERT_HAS_EXPIRED' }, { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' },
    { error: 'LLM_HTTP_401: ECONNRESET' }, { error: 'LLM_HTTP_429: limit' },
    { error: 'MODEL_PROXY_CONNECT_407' }, { error: 'MODEL_PROXY_PAC_UNSUPPORTED' },
    { error: 'TASK_OUTPUT_LIMIT' }, { error: 'LLM_TOOL_CALL_INCOMPLETE: token limit' }, { code: 'ECONNRESET', aborted: true }
  ]) assert.strictEqual(flow.retry(input), 'stop', JSON.stringify(input))
  assert.throws(() => contracts.assertLimits({ ...flow.limits({}), reconnectDelaysMs: [-1] }), /reconnectDelaysMs/)
  assert.throws(() => contracts.assertLimits({ ...flow.limits({}), reconnectDelaysMs: [30001] }), /reconnectDelaysMs/)

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-reconnect-'))
  const settings = { data: { model: 'mock', maxIterations: 4, contextAutoCompress: false }, workspacePath: temp }
  const host = new PluginHost({ workspaceRoot: temp, settings })
  const servers = []
  const agents = []
  let counter = 0
  let delayMs = 5
  let maximum = 6
  let scenario = 'recover'
  let requests = []
  const server = http.createServer((request, response) => {
    let raw = ''
    request.setEncoding('utf8')
    request.on('data', chunk => { raw += chunk })
    request.on('end', () => {
      requests.push(JSON.parse(raw))
      const n = requests.length
      if (scenario === 'auth') { response.writeHead(401, { 'content-type': 'application/json' }); response.end('{"error":"ECONNRESET"}'); return }
      if (scenario === 'exhaust' && n > 1 || scenario === 'cancel' || scenario === 'deadline') {
        response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"temporary"}'); return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (n === 1) { response.end(line(tool('original'), 'tool_calls') + 'data: [DONE]\n\n'); return }
      if (n === 2 && (scenario === 'recover' || scenario === 'reset')) {
        // Even a fully formed tool fragment is untrusted without a completion marker.
        response.write(line({ content: '丢弃的半截回复', reasoning_content: '失败尝试的思考' }))
        response.write(line(tool('incomplete')))
        if (scenario === 'reset') setTimeout(() => response.destroy(), 10)
        else response.end()
        return
      }
      response.end(line({ content: '已从工具结果继续' }, 'stop') + 'data: [DONE]\n\n')
    })
  })
  servers.push(server)
  try {
    await listen(server)
    settings.data.baseURL = 'http://127.0.0.1:' + server.address().port + '/v1'
    host.use({ name: 'test/reconnect-counter', apply(ctx) {
      ctx.registerTool({ name: 'counter', permission: 'read', parameters: { type: 'object', required: ['value'], properties: { value: { type: 'integer' } } }, execute() {
        counter += 1
        fs.appendFileSync(path.join(temp, 'counter.log'), 'called\n')
        return 'tool-effect-' + counter
      } })
    } })
    await host.ready()
    await host.replace('core/flow', { name: 'core/flow', apply(ctx) {
      ctx.provide('flow', { ...flow, limits: (config) => ({ ...flow.limits(config), maxAttempts: maximum, reconnectDelaysMs: Array(maximum - 1).fill(delayMs) }) })
    } })
    let sequence = 0
    function createAgent(onEvent) {
      const events = []
      let agent
      const sessionDir = path.join(temp, 'session-' + (++sequence))
      agent = new Agent(settings, (event) => { events.push(event); if (onEvent) onEvent(event, agent) }, async () => true, sessionDir, host)
      agents.push(agent)
      return { agent, events }
    }
    for (const mode of ['recover', 'reset']) {
      scenario = mode; requests = []; counter = 0
      let persistedRetry = null
      const { agent, events } = createAgent((event, current) => {
        if (event.type !== 'assistant:retry') return
        const journal = fs.readFileSync(path.join(current.sessionDir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
        persistedRetry = journal.find(item => item.type === 'request.failed' && item.data.decision === 'reconnect')
        assert.strictEqual(current.state.execution.status, 'running')
      })
      await agent.run('测试在已完成工具之后断线', [])
      const snapshot = host.get('sessions').load(agent)
      assert.strictEqual(snapshot.execution.status, 'completed')
      assert.strictEqual(counter, 1, 'successful tool side effects must not be replayed')
      assert.strictEqual(requests.length, 3)
      for (const body of requests.slice(1)) {
        assert.strictEqual(body.messages.filter(m => m.role === 'tool' && m.tool_call_id === 'original').length, 1)
        assert(!JSON.stringify(body.messages).includes('incomplete'), 'partial tool call must never enter history')
      }
      assert(snapshot.messages.some(m => m.role === 'tool' && m.content === 'tool-effect-1'))
      assert(snapshot.messages.some(m => m.content === '已从工具结果继续'))
      assert(!JSON.stringify(snapshot.messages).includes('丢弃的半截回复'))
      assert(!events.some(e => e.type === 'error'))
      assert(persistedRetry && persistedRetry.data.decision === 'reconnect')
      const retry = events.find(e => e.type === 'assistant:retry')
      assert.strictEqual(retry.attempt, 2)
      const fragments = events.filter(e => e.type === 'assistant:delta')
      assert.strictEqual(fragments.length, 2)
      assert.notStrictEqual(fragments[0].requestId, fragments[1].requestId)
      assert.strictEqual(retry.requestId, fragments[0].requestId)
      console.log('PASS ' + mode + ': incomplete model stream retries without replaying tools or persisting partial output')
    }

    scenario = 'auth'; requests = []; maximum = 6
    const auth = createAgent()
    await auth.agent.run('鉴权失败', [])
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(host.get('sessions').load(auth.agent).execution.status, 'failed')
    assert(!auth.events.some(event => event.type === 'assistant:retry'))
    console.log('PASS authentication failures do not retry, even when the response body names a network error')

    scenario = 'exhaust'; requests = []; counter = 0; maximum = 3
    const exhausted = createAgent()
    await exhausted.agent.run('多次断线', [])
    const failed = host.get('sessions').load(exhausted.agent)
    assert.strictEqual(requests.length, 4, 'one completed tool request and three bounded network attempts')
    assert.strictEqual(counter, 1)
    assert.strictEqual(failed.execution.status, 'failed')
    assert(failed.execution.reason.startsWith('MODEL_RECONNECT_EXHAUSTED:'))
    assert(failed.messages.some(m => m.role === 'tool' && m.content === 'tool-effect-1'))
    assert.strictEqual(exhausted.events.filter(e => e.type === 'assistant:retry').length, 2)
    console.log('PASS bounded reconnect exhaustion preserves completed tool facts and conversation')

    scenario = 'cancel'; requests = []; maximum = 6; delayMs = 1000
    let cancelledAt = 0
    const cancelled = createAgent((event, agent) => {
      if (event.type === 'assistant:retry') setTimeout(() => { cancelledAt = Date.now(); agent.abort() }, 15)
    })
    await cancelled.agent.run('中断等待', [])
    assert(cancelledAt && Date.now() - cancelledAt < 500, 'abort must cancel backoff immediately')
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(host.get('sessions').load(cancelled.agent).execution.status, 'cancelled')
    console.log('PASS stop cancels reconnect delay promptly without another request')

    scenario = 'cancel'; requests = []; delayMs = 5
    settings.data.maxTokens = 1000
    settings.data.unattended = { maxRequests: 1, tokenBudget: 1000000, outputBytes: 100000, maxToolCalls: 1, tools: [] }
    const budget = createAgent()
    await budget.agent.run('无人值守预算', [])
    const bounded = host.get('sessions').load(budget.agent)
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(bounded.execution.status, 'failed')
    assert(bounded.execution.reason.startsWith('TASK_BUDGET_EXCEEDED:'))
    assert(!budget.events.some(e => e.type === 'assistant:retry'))
    delete settings.data.unattended
    console.log('PASS unattended retry never exceeds its request budget or announces an impossible retry')

    scenario = 'deadline'; requests = []; delayMs = 1000; settings.data.turnTimeoutMs = 50
    const timed = createAgent()
    await timed.agent.run('等待截止', [])
    assert.strictEqual(requests.length, 1)
    assert.strictEqual(host.get('sessions').load(timed.agent).execution.status, 'timed_out')
    settings.data.turnTimeoutMs = 0
    console.log('PASS turn deadline cancels reconnect delay')

    // First HTTPS request performs a tool, the next TLS handshake is dropped,
    // and a later verified handshake succeeds without replaying that tool.
    const credentials = certForTest()
    const accepted = []
    const secure = https.createServer(credentials, (request, response) => {
      let raw = ''; request.setEncoding('utf8'); request.on('data', chunk => { raw += chunk })
      request.on('end', () => {
        accepted.push(JSON.parse(raw))
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.end(accepted.length === 1
          ? line(tool('tls-completed'), 'tool_calls') + 'data: [DONE]\n\n'
          : line({ content: 'TLS 重连已完成' }, 'stop') + 'data: [DONE]\n\n')
      })
    })
    servers.push(secure); await listen(secure)
    let connections = 0
    const relay = net.createServer(client => {
      if (++connections === 2) { client.destroy(); return }
      const upstream = net.connect(secure.address().port, '127.0.0.1')
      client.on('error', () => upstream.destroy())
      upstream.on('error', () => client.destroy())
      client.pipe(upstream).pipe(client)
    })
    servers.push(relay); await listen(relay)
    settings.data.baseURL = 'https://127.0.0.1:' + relay.address().port + '/v1'
    delayMs = 5; counter = 0
    const tlsOriginal = tls.connect
    tls.connect = function () {
      const args = Array.from(arguments)
      if (args[0] && typeof args[0] === 'object') args[0] = Object.assign({}, args[0], { ca: credentials.cert })
      return tlsOriginal.apply(this, args)
    }
    const tlsRecovered = createAgent()
    try { await tlsRecovered.agent.run('已写入后 TLS 握手中断', []) } finally { tls.connect = tlsOriginal }
    assert.strictEqual(connections, 3)
    assert.strictEqual(accepted.length, 2)
    assert.strictEqual(counter, 1)
    assert.strictEqual(accepted[1].messages.filter(m => m.role === 'tool' && m.tool_call_id === 'tls-completed').length, 1)
    assert.strictEqual(host.get('sessions').load(tlsRecovered.agent).execution.status, 'completed')
    assert(tlsRecovered.events.some(e => e.type === 'assistant:retry' && e.reason === 'reconnect'))
    console.log('PASS verified TLS reconnect after completed tool preserves history and does not replay the effect')

    // Real TLS handshake disconnect is also immediately cancellable.
    const raw = net.createServer(socket => socket.destroy())
    servers.push(raw); await listen(raw)
    settings.data.baseURL = 'https://127.0.0.1:' + raw.address().port + '/v1'
    let tlsReason = ''
    const tlsCancelled = createAgent((event, agent) => {
      if (event.type === 'assistant:retry') {
        tlsReason = agent.state.execution.lastError
        agent.abort()
      }
    })
    await tlsCancelled.agent.run('真实 TLS 中断', [])
    assert(/secure TLS connection|socket hang up|ECONNRESET/i.test(tlsReason), tlsReason)
    assert.strictEqual(host.get('sessions').load(tlsCancelled.agent).execution.status, 'cancelled')
    console.log('PASS actual TLS handshake disconnect selects reconnect and remains cancellable')
  } finally {
    for (const agent of agents) await agent.dispose()
    await host.dispose()
    for (const item of servers) await close(item)
    fs.rmSync(temp, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
