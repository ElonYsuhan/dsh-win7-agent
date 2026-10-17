'use strict'

module.exports = {
  name: 'core/sessions', inject: ['state', 'contracts'],
  apply(ctx) {
    const { SessionRepository } = require('../../state/session-repository')
    ctx.provide('sessions', new SessionRepository(ctx.state, ctx.contracts))
  }
}
