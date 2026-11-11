'use strict'
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http')
const { createService } = require('../service')
const { HostConnector } = require('../src/main/host-connector/client')
const { hash } = require('../src/main/service/repository')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-service-browser-'))
const hostHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-host-browser-'))
const userToken = 'u'.repeat(32), hostToken = 'h'.repeat(32), origin = 'http://127.0.0.1:18329'
let service, connector, model
async function main() {
  model = http.createServer((req, res) => {
    let data = ''; req.on('data', chunk => { data += chunk }); req.on('end', () => {
      const input = JSON.parse(data), hasTool = input.messages.some(message => message.role === 'tool')
      const delta = hasTool ? { content: '测试 Host 已返回结果。' } : { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'host__host__lookup', arguments: '{}' } }] }
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end('data: ' + JSON.stringify({ choices: [{ delta }] }) + '\n\ndata: [DONE]\n\n')
    })
  })
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  service = await createService({ home, config: { publicOrigin: origin, host: '127.0.0.1', port: 18329, users: [{ id: 'user', tokenHash: hash(userToken), hosts: ['host'] }], hosts: [{ id: 'host', tokenHash: hash(hostToken), users: ['user'], tools: { lookup: 'write' } }] } })
  service.plugins.options.settings.update({ baseURL: 'http://127.0.0.1:' + model.address().port + '/v1', apiKey: 'test', model: 'test-model', maxIterations: 5 })
  connector = new HostConnector({ url: origin, token: hostToken, home: hostHome, allowLoopbackHttp: true, getContext: async () => ({ page: '测试页面' }), tools: [{ name: 'lookup', permission: 'write', parameters: { type: 'object', properties: {} }, execute: async () => '测试工具结果' }] })
  await connector.start()
  const response = await new Promise((resolve, reject) => {
    const data = JSON.stringify({ hostId: 'host', requestId: 'browser_test_123' })
    const req = http.request(origin + '/api/v1/sessions', { method: 'POST', headers: { authorization: 'Bearer ' + userToken, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, res => {
      let value = ''; res.on('data', chunk => { value += chunk }); res.on('end', () => resolve(JSON.parse(value)))
    }); req.on('error', reject); req.end(data)
  })
  console.log('BROWSER_TEST_URL=' + response.sessionUrl + '#launch=' + response.launchCredential)
}
async function stop() {
  if (connector) await connector.close()
  if (service) await service.close()
  if (model) await new Promise(resolve => model.close(resolve))
  fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(hostHome, { recursive: true, force: true })
}
process.once('SIGINT', () => stop().then(() => process.exit(0)))
process.once('SIGTERM', () => stop().then(() => process.exit(0)))
main().catch(error => { console.error(error); stop().finally(() => { process.exitCode = 1 }) })
