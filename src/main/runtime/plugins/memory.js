'use strict'

module.exports = {
  name: 'core/memory', inject: ['llm', 'context', 'sessions', 'state'],
  apply(ctx) {
    const { operations } = require('../context-memory')
    const service = {}
    for (const name of Object.keys(operations)) service[name] = (agent, ...args) => operations[name].call(agent, ...args)
    ctx.provide('memory', service)
  }
}
