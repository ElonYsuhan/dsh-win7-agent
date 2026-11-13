'use strict'

const path = require('path')
const { AgentService } = require('../../agent-service')

module.exports = {
  name: 'core/agent-service',
  inject: ['agentConfig', 'licensing'],
  apply(ctx) {
    const settings = ctx.agentConfig.settings
    if (!settings || !settings.file) throw Error('AGENT_SERVICE_HOME_UNAVAILABLE')
    const service = new AgentService({ root: path.resolve(__dirname, '../../../..'), home: path.join(path.dirname(settings.file), 'agent-service'), settingsHome: path.dirname(settings.file) })
    let pending = Promise.resolve()
    let closed = false
    const run = action => {
      const next = pending.then(async () => {
        if (closed) throw Error('AGENT_SERVICE_CLOSED')
        if (action === 'status') return service.status()
        if (action === 'start') { ctx.licensing.assert('all'); return service.start() }
        if (action === 'stop') return service.stop()
        throw Error('AGENT_SERVICE_ACTION_INVALID')
      })
      pending = next.catch(() => {})
      return next
    }
    ctx.provide('agentService', { request: run })
    ctx.effect(() => async () => { closed = true; await pending; await service.stop() })
  }
}
