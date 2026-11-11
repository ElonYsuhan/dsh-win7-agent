'use strict'

module.exports = {
  name: 'core/sessions', inject: ['state', 'contracts'],
  apply(ctx) {
    const states = new WeakMap()
    ctx.provide('sessions', {
      load(agent) { return states.get(agent) || ctx.state.initial() },
      append(agent, event) {
        ctx.contracts.assertEvent(event)
        const current = states.get(agent) || ctx.state.initial()
        if (current.sequence !== agent.state.sequence) throw Error('SESSION_STALE_WRITER')
        states.set(agent, ctx.state.reduce(current, event))
      },
      clear(agent) { states.delete(agent) },
      save(agent) {
        const current = states.get(agent)
        if (!current || current.sequence !== agent.state.sequence) throw Error('SESSION_STALE_WRITER')
      }
    })
  }
}
