'use strict'
const assert = require('assert')
const { EventEmitter } = require('events')
const plugin = require('../src/main/runtime/plugins/host-connector')
const { Context } = require('../src/main/runtime/vendor/cordis')

async function main() {
  const repo = { data: { calls: {} }, save() {}, audit() {} }
  const ctx = new Context()
  ctx.provide('agentConfig', { serviceRepository: repo })
  const tools = new Map()
  ctx.provide('tools', { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } })
  ctx.plugin(plugin)
  await new Promise(resolve => setImmediate(resolve))
  const connector = ctx.get('hostConnector')
  assert(connector, 'Cordis must activate Host connector')
  const definition = { name: 'write', permission: 'write', parameters: { type: 'object', properties: {} } }
  const fingerprint = tool => require('../src/main/service/repository').hash({ name: tool.name, permission: tool.permission, plugin: tool.plugin, parameters: tool.parameters })
  await connector.register('host', [definition])
  const originalFingerprint = fingerprint(tools.get('host__host__write'))
  await connector.register('host', [definition])
  assert.equal(fingerprint(tools.get('host__host__write')), originalFingerprint)
  await connector.register('host', [{ ...definition, permission: 'read' }])
  assert.notEqual(fingerprint(tools.get('host__host__write')), originalFingerprint)
  class Stream extends EventEmitter {
    write(text) { this.command = JSON.parse(text.slice(6)); return true }
    end() { this.emit('close') }
  }
  const stream = new Stream()
  connector.connect('host', stream)
  const context = connector.request('host', { method: 'context.get', sessionId: 's' })
  connector.result('host', { protocolVersion: 1, id: stream.command.id, status: 'succeeded', result: { current: 'ok' } })
  assert.deepStrictEqual(await context, { current: 'ok' })
  const call = connector.request('host', { method: 'tools.call', sessionId: 's', tool: 'write' })
  assert.equal(repo.data.calls[stream.command.id].status, 'running')
  stream.emit('close')
  await assert.rejects(call, /HOST_RESULT_UNCERTAIN/)
  assert.equal(repo.data.calls[stream.command.id].status, 'uncertain')
  const id = stream.command.id
  assert.throws(() => connector.result('other', { protocolVersion: 1, id, status: 'succeeded', result: 'secret' }), /HOST_RESULT_UNKNOWN/)
  connector.result('host', { protocolVersion: 1, id, status: 'succeeded', result: 'secret' })
  assert.equal(repo.data.calls[id].status, 'succeeded')
  assert(!JSON.stringify(repo.data.calls[id]).includes('secret'))
  connector.result('host', { protocolVersion: 1, id, status: 'succeeded', result: 'secret' })
  assert.throws(() => connector.result('host', { protocolVersion: 1, id, status: 'succeeded', result: 'different' }), /HOST_RESULT_CONFLICT/)
  assert.throws(() => connector.result('host', { protocolVersion: 1, id, status: 'failed' }), /HOST_RESULT_CONFLICT/)
  const summaryId = require('crypto').randomUUID()
  repo.data.calls[summaryId] = { hostId: 'host', status: 'uncertain' }
  const resultHash = require('../src/main/service/repository').hash('done')
  connector.result('host', { protocolVersion: 1, id: summaryId, status: 'succeeded', resultHash })
  connector.result('host', { protocolVersion: 1, id: summaryId, status: 'succeeded', resultHash })
  assert.equal(repo.data.calls[summaryId].resultHash, resultHash)
  await ctx.fiber.dispose()
  console.log('host connector Cordis lifecycle checks passed')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
