'use strict'

const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { McpManager } = require('../src/main/mcp/manager')
const contract = require('../src/main/contracts/mcp')
const { childEnvironment, requestHeaders } = require('../src/main/mcp/environment')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const { Settings } = require('../src/main/agent/settings')

function stdioServerSource() {
  return [
    "const readline = require('readline')",
    "const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })",
    "function send(value) { process.stdout.write(JSON.stringify(value) + '\\n') }",
    "rl.on('line', (line) => {",
    "  let message",
    "  try { message = JSON.parse(line) } catch (error) { return }",
    "  if (message.id === undefined) return",
    "  if (message.method === 'initialize') return send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-stdio', version: '1.0.0' } } })",
    "  if (message.method === 'tools/list') return send({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] } })",
    "  if (message.method === 'tools/call') return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'echo:' + String(message.params.arguments.text || '') }] } })",
    "  send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })",
    "})"
  ].join('\n')
}

async function main() {
  await require('./mcp-reliability-smoke')()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-'))
  try {
    assert.strictEqual(contract.toolName('Files Server', 'read file'), 'mcp__files_server__read_file')
    const normalized = contract.normalizeServers([
      { name: 'local', transport: 'stdio', command: process.execPath, args: ['x.js'], permission: 'read' },
      { name: 'bad', transport: 'http', url: 'ftp://example' }
    ])
    assert.strictEqual(normalized.length, 1)
    assert.strictEqual(normalized[0].permission, 'read')

    const serverFile = path.join(root, 'fake-stdio.js')
    fs.writeFileSync(serverFile, stdioServerSource(), 'utf8')
    const manager = new McpManager()
    const started = await manager.start([{
      name: 'echo', transport: 'stdio', command: process.execPath, args: [serverFile], permission: 'read', timeoutMs: 5000
    }])
    assert.strictEqual(started.connected, 1)
    assert.strictEqual(started.servers[0].tools[0].name, 'echo')
    assert.strictEqual(started.servers[0].tools[0].inputSchema.required[0], 'text')
    const echoed = await manager.call('echo', 'echo', { text: 'hello' })
    assert.strictEqual(echoed, 'echo:hello')
    const probe = await manager.probe({ name: 'probe', transport: 'stdio', command: process.execPath, args: [serverFile], permission: 'read', timeoutMs: 5000 })
    assert.strictEqual(probe.tools.length, 1)
    const exited = manager.servers.get('echo').client
    exited.child.kill(); await exited.exitPromise
    assert.strictEqual(manager.status().servers[0].status, 'error')
    await manager.stop()

    const fakeEnv = { PATH: '/bin', HOME: '/home/demo', TOKEN: 'sample-secret', UNUSED: 'not-passed' }
    const childEnv = childEnvironment({ envPass: ['TOKEN'], env: { EXTRA: 'literal' } }, fakeEnv)
    assert.strictEqual(childEnv.TOKEN, 'sample-secret'); assert.strictEqual(childEnv.EXTRA, 'literal'); assert.strictEqual(childEnv.UNUSED, undefined); assert.strictEqual(childEnv.PATH, '/bin')
    assert.throws(() => childEnvironment({ envPass: ['MISSING'] }, fakeEnv), /MCP_ENV_MISSING/)
    const references = { headers: { authorization: 'old', 'X-Demo': 'old' }, headerEnv: { 'x-demo': 'TOKEN' }, bearerTokenEnv: 'TOKEN' }
    const headers = requestHeaders(references, fakeEnv)
    assert.strictEqual(headers.Authorization, 'Bearer sample-secret'); assert.strictEqual(headers['x-demo'], 'sample-secret'); assert.strictEqual(headers.authorization, undefined)
    assert(!JSON.stringify(references).includes('sample-secret'))
    assert.throws(() => requestHeaders({ bearerTokenEnv: 'MISSING' }, fakeEnv), /MCP_ENV_MISSING/)
    const normalizedRefs = contract.normalizeServer({ transport: 'http', url: 'http://127.0.0.1/mcp', headerEnv: { 'X-Token': 'TOKEN' }, bearerTokenEnv: 'TOKEN' })
    assert.strictEqual(normalizedRefs.headerEnv['X-Token'], 'TOKEN')
    assert.throws(() => contract.normalizeServer({ command: 'node', envPass: ['bad name'] }), /MCP_ENV_NAME_INVALID/)
    process.env.AGENT_MCP_SMOKE_TOKEN = 'smoke-only-token'
    const headerRequests = []
    const requests = []
    const httpServer = http.createServer((request, response) => {
      let body = ''
      request.on('data', (chunk) => { body += chunk })
      request.on('end', () => {
        requests.push(request.method + ' ' + request.url)
        headerRequests.push(request.headers)
        if (request.method === 'DELETE') { response.writeHead(200); response.end('ok'); return }
        let message = {}
        try { message = JSON.parse(body || '{}') } catch (error) {}
        if (message.id === undefined) { response.writeHead(202); response.end(); return }
        response.setHeader('content-type', 'application/json')
        if (message.method === 'initialize') {
          response.setHeader('mcp-session-id', 'session-1')
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-http', version: '1.0.0' } } }))
          return
        }
        if (message.method === 'tools/list') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'remote_echo', description: 'Remote echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }))
          return
        }
        if (message.method === 'tools/call') {
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'remote:' + String(message.params.arguments.text || '') }] } }))
          return
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } }))
      })
    })
    await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const address = httpServer.address()
    const httpManager = new McpManager()
    const httpStatus = await httpManager.start([{
      name: 'remote', transport: 'http', bearerTokenEnv: 'AGENT_MCP_SMOKE_TOKEN', headerEnv: { 'X-Token': 'AGENT_MCP_SMOKE_TOKEN' }, url: 'http://127.0.0.1:' + address.port + '/mcp', permission: 'read', timeoutMs: 5000
    }])
    assert.strictEqual(httpStatus.connected, 1)
    assert.strictEqual(await httpManager.call('remote', 'remote_echo', { text: 'ok' }), 'remote:ok')
    await httpManager.stop()
    assert(requests.some((item) => item.indexOf('DELETE') === 0))
    assert(headerRequests.every(headers => headers.authorization === 'Bearer smoke-only-token' && headers['x-token'] === 'smoke-only-token'))
    assert(!JSON.stringify(httpStatus).includes('smoke-only-token'))
    delete process.env.AGENT_MCP_SMOKE_TOKEN
    await new Promise((resolve) => httpServer.close(resolve))

    const home = path.join(root, 'desktop')
    const workspace = path.join(root, 'workspace')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(workspace, { recursive: true })
    const settings = new Settings(home)
    settings.update({
      workspacePath: workspace,
      permissionMode: 'full',
      mcpServers: [{ name: 'echo', transport: 'stdio', command: process.execPath, args: [serverFile], permission: 'read', timeoutMs: 5000 }]
    })
    const host = new PluginHost({ workspaceRoot: workspace, settings })
    await host.ready()
    await host.get('mcp').ready()
    const mcpStatus = host.get('mcp').status()
    assert.strictEqual(mcpStatus.connected, 1)
    const definition = host.getToolDefinitions().find((item) => item.function.name === 'mcp__echo__echo')
    assert(definition)
    const toolResult = await host.executeTool('mcp__echo__echo', { text: 'plugin' }, { settings: settings.data, approve: async () => true })
    assert.strictEqual(toolResult, 'echo:plugin')
    await host.dispose()

    console.log('mcp smoke passed: contract, stdio, streamable HTTP, Cordis tool registration, node ' + process.version)
  } finally {
    delete process.env.AGENT_MCP_SMOKE_TOKEN
    fs.rmSync(root, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exit(1) })
