'use strict'

module.exports = {
  name: 'core/agent-loop', inject: ['llm', 'context', 'sessions', 'skills', 'tools', 'prompts', 'contracts', 'flow', 'state', 'memory'],
  apply(ctx) {
    const { run } = require('../run-turn')
    for (const name of ['contracts', 'flow', 'state', 'sessions', 'llm', 'tools', 'prompts', 'skills', 'context', 'memory']) ctx.contracts.assertService(name, ctx[name])
    const active = new Set()
    ctx.provide('agentLoop', {
      async run(agent, ...args) {
        // Hold the service dependencies until cancelled turns have settled.
        let settle
        const ticket = { agent, done: new Promise((resolve) => { settle = resolve }) }
        active.add(ticket)
        agent.executionContext = ctx
        try { return await run.call(agent, ...args) } finally {
          agent.executionContext = null
          active.delete(ticket)
          settle()
        }
      }
    })
    ctx.effect(() => async () => {
      for (const ticket of active) ticket.agent.abort()
      await Promise.all(Array.from(active, (ticket) => ticket.done))
    })
  }
}
