'use strict'

// Test-only service and deterministic model. Never use with real user data.
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { createService } = require('../service')
const { startHesynBridge } = require('../src/main/host-connector/hesyn-local')
const { hash } = require('../src/main/service/repository')
const home = process.env.HESYN_TEST_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'hesyn-agent-test-'))
const hostHome = process.env.HESYN_TEST_HOST_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'hesyn-host-test-'))
const hostToken = 'h'.repeat(32), userToken = 'u'.repeat(32)
const servicePort = Number(process.env.HESYN_TEST_SERVICE_PORT || 18390)
const bridgePort = Number(process.env.HESYN_TEST_BRIDGE_PORT || 18391)
const auditPort = Number(process.env.HESYN_TEST_AUDIT_PORT || 18392)
const webPort = Number(process.env.HESYN_TEST_WEB_PORT || 5197)
let service, bridge, model, auditServer
async function main() {
  model = http.createServer((req, res) => {
    let text = ''
    req.on('data', chunk => { text += chunk })
    req.on('end', () => {
      const input = JSON.parse(text)
      const lastUser = input.messages.map(message => message.role).lastIndexOf('user')
      const result = input.messages.slice(lastUser + 1).find(message => message.role === 'tool')
      const prompt = String(input.messages[lastUser].content)
      const creating = prompt.includes('创建装备')
      const tool = creating
        ? 'host__host__entity_create'
        : prompt.includes('读取上下文')
          ? 'host__host__get_context'
          : 'host__host__get_selected_entity'
      const args = creating
        ? JSON.stringify({ resourceId: 'builtin-default-2d-command-post', point: { lon: 116.4, lat: 39.9, alt: 0 } })
        : '{}'
      const delta = result
        ? { content: '读取结果：' + result.content }
        : { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: tool, arguments: args } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + servicePort, webOrigin = 'http://127.0.0.1:' + webPort
  service = await createService({ home, config: { publicOrigin: origin, host: '127.0.0.1', port: servicePort, panelOrigins: [webOrigin], allowPanelSettings: true, users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }], hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: { get_context: 'read', list_equipment: 'read', get_selected_entity: 'read', entity_list: 'read', resource_search: 'read', entity_create: 'write', entity_update: 'write', entity_delete: 'write', hesyn_capabilities: 'read', hesyn_call: 'command' } }] } })
  if (process.env.HESYN_TEST_MODEL_SETTINGS) {
    // Keep the selected model credentials in memory; never copy the settings file.
    const source = JSON.parse(fs.readFileSync(process.env.HESYN_TEST_MODEL_SETTINGS, 'utf8'))
    const active = (source.models || []).find(item => item.id === source.currentModelId)
    if (!active || !active.model || !active.baseURL || !active.apiKey) throw Error('TEST_MODEL_NOT_CONFIGURED')
    const settings = service.plugins.options.settings
    settings.data = { ...settings.data, baseURL: active.baseURL, apiKey: active.apiKey, model: active.model, thinking: active.thinking === true, models: [active], currentModelId: active.id, maxIterations: 5 }
  } else {
    service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })
  }
  bridge = await startHesynBridge({ serviceOrigin: origin, origin: webOrigin, hostId: 'host', hostToken, userToken, home: hostHome, port: bridgePort })
  auditServer = http.createServer((req, res) => {
    const file = path.join(home, 'service', 'audit.jsonl')
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse) : []
    const calls = lines.filter(row => row.action === 'host.call.prepared').map(row => ({ tool: row.tool, status: (lines.find(item => item.action === 'host.call.result' && item.callId === row.callId) || {}).status }))
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(calls))
  })
  await new Promise(resolve => auditServer.listen(auditPort, '127.0.0.1', resolve))
  console.log('HESYN_TEST_FIXTURE_READY')
}
async function stop() {
  if (auditServer) await new Promise(resolve => auditServer.close(resolve))
  if (bridge) await bridge.close()
  if (service) await service.close()
  if (model) await new Promise(resolve => model.close(resolve))
  if (!process.env.HESYN_TEST_HOME) fs.rmSync(home, { recursive: true, force: true })
  if (!process.env.HESYN_TEST_HOST_HOME) fs.rmSync(hostHome, { recursive: true, force: true })
}
process.once('SIGINT', () => stop().then(() => process.exit(0)))
process.once('SIGTERM', () => stop().then(() => process.exit(0)))
main().catch(error => { console.error(error); stop().finally(() => { process.exitCode = 1 }) })
