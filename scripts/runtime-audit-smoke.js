'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { createLibrary } = require('../src/main/agent/md-skills')
const { SessionRepository } = require('../src/main/state/session-repository')
const state = require('../src/main/state/session-state')
const contracts = require('../src/main/contracts')
const { AgentPool } = require('../src/main/agent/agent-pool')
const { McpManager } = require('../src/main/mcp/manager')
const { StdioClient } = require('../src/main/mcp/stdio-client')
const { ProcessManager } = require('../src/main/agent/process-manager')
const { BrowserDriver } = require('../src/main/agent/browser-driver')
const { PassThrough } = require('stream')
const { writeEvent, MAX_QUEUED_BYTES } = require('../server/event-stream')
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-audit-'))
  try {
    const library = createLibrary()
    const folded = library.parseFrontmatter('---\r\nname: demo\r\ndescription: >-\r\n  第一行\r\n  第二行\r\nversion: 1\r\n---\r\nbody')
    assert.strictEqual(folded.description, '第一行 第二行')
    assert.strictEqual(folded.version, '1')
    assert.strictEqual(library.parseFrontmatter('---\ndescription: |\n  one\n  two\n---').description, 'one\ntwo')
    const skills = library.list()
    assert(skills.length >= 60)
    for (const item of skills) {
      assert(item.description && !/^[>|][+-]?$/.test(item.description), item.id + ' must have a real description')
      assert(Number.isInteger(item.files) && item.files > 0, item.id)
      const loaded = library.read(item.id)
      assert(loaded.ok && loaded.id === item.id, item.id)
    }
    assert(library.search('professional judgment').items.some(i => i.name === 'recommend-experts'))
    console.log('Skill inventory: ' + skills.length + ' bundled entries have valid descriptions, file counts and readable bodies')

    const pool = new AgentPool({ sessionRoot: home })
    for (const id of ['.', '..', '...', 'CON', 'con.txt', 'NUL', 'COM1', 'LPT9', 'trailing.', '../outside', '中文']) {
      const relative = path.relative(home, pool.sessionDir(id))
      assert(relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative), id)
      assert(!/[.]$/.test(relative) && !/^(con|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(relative), id)
      assert.strictEqual(pool.sessionDir(relative), pool.sessionDir(id), 'normalized IDs remain stable')
    }
    assert.strictEqual(pool.sessionDir('normal-session'), path.join(home, 'normal-session'))

    const exitListeners = process.listenerCount('exit')
    for (let index = 0; index < 12; index++) {
      const processes = new ProcessManager({ workspaceRoot: home })
      try {
        processes.start({ name: 'short', command: '"' + process.execPath + '" -e "process.stdout.write(\'done\')"' })
        await new Promise(resolve => processes.record('short').child.once('close', resolve))
        assert(processes.logs('short').text.includes('done'))
      } finally { await processes.dispose() }
      assert.strictEqual(process.listenerCount('exit'), exitListeners, 'disposed workers must not retain exit hooks')
      assert.strictEqual(processes.procs.size, 0)
      assert.throws(() => processes.start({ name: 'late', command: 'unused' }), /CLOSED/)
    }
    console.log('Process lifecycle: 12 real subprocess managers disposed; exit listener count returned to baseline')

    const browser = new BrowserDriver(), stderr = new PassThrough()
    const missingPort = assert.rejects(browser.readDebugPort(stderr, 20), /DEBUG_TIMEOUT/)
    for (let index = 0; index < 100; index++) stderr.write('x'.repeat(8192))
    await missingPort
    assert.strictEqual(stderr.listenerCount('data'), 0, 'failed startup must detach stderr capture')
    stderr.end()
    const exitedStderr = new PassThrough()
    const exitedPort = assert.rejects(browser.readDebugPort(exitedStderr, 1000), /EXITED_BEFORE/)
    exitedStderr.end()
    await exitedPort
    assert.strictEqual(exitedStderr.listenerCount('data'), 0)
    const { runSuite } = require('../src/main/agent/test-runner')
    const assertionOnly = await runSuite({ snapshot: () => ({}), evaluate: async () => false }, [{ name: 'assertions only', assertions: [{ type: 'eval_expr', expression: 'false' }] }])
    assert.strictEqual(assertionOnly.suite.failed, 1, 'assertion-only cases must really execute')
    for (let index = 0; index < 200; index++) browser.capture(browser.consoleErrors, { type: 'console', text: 'old' })
    const capped = await runSuite({
      consoleErrors: browser.consoleErrors,
      snapshot: () => browser.snapshot(),
      evaluate: async () => browser.capture(browser.consoleErrors, { type: 'console', text: 'new error after cap' })
    }, [{ name: 'ring rollover', steps: [{ action: 'eval', expression: 'console.error()' }], assertions: [{ type: 'console_clean' }] }])
    assert.strictEqual(capped.suite.failed, 1, 'a full ring cannot hide new failures')
    assert.strictEqual(capped.suite.consoleErrors.length, 1)

    const agent = { sessionDir: path.join(home, 'journal') }
    fs.mkdirSync(agent.sessionDir)
    const journal = path.join(agent.sessionDir, 'events.jsonl')
    const fd = fs.openSync(journal, 'w')
    const text = '中文恢复'.repeat(8192)
    try {
      for (let sequence = 1; sequence <= 160; sequence++) fs.writeSync(fd, JSON.stringify({ version: 1, sequence, at: '2026-10-22T00:00:00Z', type: contracts.EVENTS.MEMORY, data: { memory: { text: text + sequence } } }) + '\n')
      fs.writeSync(fd, '{"incomplete":')
    } finally { fs.closeSync(fd) }
    const repo = new SessionRepository(state, contracts)
    const loaded = repo.load(agent)
    assert.strictEqual(loaded.sequence, 160)
    assert.strictEqual(loaded.memory.text, text + 160)
    const repaired = fs.statSync(journal).size
    agent.state = loaded
    const event = { version: 1, sequence: 161, at: '2026-10-22T00:00:00Z', type: contracts.EVENTS.MEMORY, data: { memory: null } }
    repo.append(agent, event)
    agent.state = state.reduce(loaded, event)
    assert.strictEqual(repo.load(agent).memory, null)
    assert(fs.statSync(journal).size > repaired)
    fs.appendFileSync(journal, '{bad committed}\n')
    const corruptSize = fs.statSync(journal).size
    assert.throws(() => repo.load(agent))
    assert.strictEqual(fs.statSync(journal).size, corruptSize, 'committed corruption is preserved')
    console.log('Recovery: ' + repaired + ' journal bytes replayed incrementally; split UTF-8, incomplete tail, next append and committed corruption passed')

    // A shutdown during removal must prevent a replacement from being spawned.
    const manager = new McpManager(), closing = gate(), entered = gate()
    const old = require('../src/main/contracts/mcp').normalizeServer({ id: 'old', command: 'old' })
    manager.servers.set('old', { config: old, status: 'connected', tools: [], client: { status: () => 'connected', close: () => { entered.resolve(); return closing.promise } } })
    let created = 0
    manager.createClient = () => { created++; throw Error('must not spawn after stop') }
    const reconciliation = manager.reconcile([{ id: 'new', command: 'new' }])
    await entered.promise
    const stopping = manager.stop()
    closing.resolve()
    await Promise.all([reconciliation, stopping])
    assert.strictEqual(created, 0)
    assert.strictEqual(manager.servers.size, 0)

    // The same guarantee applies while initial tool discovery is still pending.
    const starting = new McpManager(), connected = gate(), release = gate()
    let discoveries = 0
    starting.createClient = () => ({ start: () => { connected.resolve(); return release.promise }, close: async () => {}, listTools: async () => { discoveries++; return [] } })
    const start = starting.start([{ command: 'test' }])
    await connected.promise
    await starting.stop()
    release.resolve()
    await start
    assert.strictEqual(discoveries, 0)
    assert.strictEqual(starting.servers.size, 0)
    const stdio = new StdioClient({ command: process.execPath })
    await stdio.close()
    await assert.rejects(stdio.start(), /CLOSED/)
    console.log('MCP lifecycle: shutdown during reconcile/handshake and closed-client restart refusal passed')

    // Real HTTP response buffering against a paused reader, rather than a mock
    // writableLength. One slow viewer closes, while healthy SSE remains usable.
    let writes = 0, peak = 0, guarded = false
    const sockets = new Set()
    const server = http.createServer((req, res) => {
      res.on('error', () => {})
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url === '/healthy') { assert(writeEvent(res, 'data: ready\n\n')); res.end(); return }
      const frame = 'data: ' + 'x'.repeat(64 * 1024) + '\n\n'
      for (let i = 0; i < 1000; i++) {
        if (!writeEvent(res, frame)) { guarded = true; break }
        writes++; peak = Math.max(peak, res.writableLength)
      }
    })
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      await new Promise(resolve => {
        const req = http.get('http://127.0.0.1:' + server.address().port + '/slow', res => { res.pause(); res.on('error', () => {}); res.on('close', resolve) })
        req.on('error', resolve)
      })
      assert(guarded && writes < 150 && peak <= MAX_QUEUED_BYTES)
      const body = await new Promise((resolve, reject) => http.get('http://127.0.0.1:' + server.address().port + '/healthy', res => { let data = ''; res.on('data', chunk => { data += chunk }); res.on('end', () => resolve(data)) }).on('error', reject))
      assert.strictEqual(body, 'data: ready\n\n')
      console.log('SSE backpressure: stalled connection buffered at most ' + peak + ' bytes; healthy connection remained available')
    } finally {
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
