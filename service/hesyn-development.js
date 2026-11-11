'use strict'

// Isolated local development launcher. Tokens are generated in memory on every start.
const crypto = require('crypto')
const path = require('path')
const { createService } = require('./index')
const { startHesynBridge } = require('../src/main/host-connector/hesyn-local')
const { hash } = require('../src/main/service/repository')

function port(name, fallback) {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < 1024 || value > 65535) throw Error(name + '_INVALID')
  return value
}
async function main() {
  if (!process.env.HESYN_AGENT_HOME || !path.isAbsolute(process.env.HESYN_AGENT_HOME)) throw Error('HESYN_AGENT_HOME_MUST_BE_ABSOLUTE')
  const home = path.resolve(process.env.HESYN_AGENT_HOME)
  const servicePort = port('HESYN_SERVICE_PORT', 18090), bridgePort = port('HESYN_BRIDGE_PORT', 18100)
  const serviceOrigin = 'http://127.0.0.1:' + servicePort
  const origin = process.env.HESYN_ORIGIN || 'http://127.0.0.1:5180'
  const hostToken = crypto.randomBytes(32).toString('base64url'), userToken = crypto.randomBytes(32).toString('base64url')
  let service, bridge
  try {
    service = await createService({ home: path.join(home, 'service-data'), config: {
      publicOrigin: serviceOrigin, host: '127.0.0.1', port: servicePort, panelOrigins: [origin], allowPanelSettings: true,
      ...(process.env.HESYN_MESSAGE_BODY_MAX_BYTES ? { messageBodyMaxBytes: Number(process.env.HESYN_MESSAGE_BODY_MAX_BYTES) } : {}),
      users: [{ id: 'hesyn-user', tokenHash: hash(userToken), hosts: ['hesyn'] }],
      hosts: [{ id: 'hesyn', tokenHash: hash(hostToken), users: ['hesyn-user'], tools: { get_context: 'read', list_equipment: 'read', get_selected_entity: 'read', entity_list: 'read', resource_search: 'read', entity_create: 'write', entity_update: 'write', entity_delete: 'write', hesyn_capabilities: 'read', hesyn_call: 'command' } }]
    } })
    // Existing preview settings may retain a tiny test-model turn budget (e.g. 6).
    // Multi-entity editing must not stop every few calls; keep the same Agent loop
    // and publish the effective budget through the existing model settings UI.
    const settings = service.plugins.options.settings
    const minimumIterations = Number(process.env.HESYN_MIN_ITERATIONS || 100)
    if (!Number.isInteger(minimumIterations) || minimumIterations < 1 || minimumIterations > 500) throw Error('HESYN_MIN_ITERATIONS_INVALID')
    if (settings.data.maxIterations < minimumIterations) settings.update({ maxIterations: minimumIterations })
    bridge = await startHesynBridge({ serviceOrigin, origin, hostId: 'hesyn', hostToken, userToken, home: path.join(home, 'host-data'), port: bridgePort })
  } catch (error) { if (service) await service.close(); throw error }
  console.log('HESYN local Agent Service: ' + serviceOrigin + '; bridge: 127.0.0.1:' + bridgePort)
  const stop = () => bridge.close().then(() => service.close()).then(() => process.exit(0), () => process.exit(1))
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
}
main().catch(error => { console.error('HESYN local startup failed:', error.message); process.exitCode = 1 })
