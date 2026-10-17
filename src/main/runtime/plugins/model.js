'use strict'

module.exports = {
  name: 'core/llm', inject: ['contracts'],
  apply(ctx) {
    const { requestChat } = require('../../agent/llm')
    ctx.provide('llm', {
      request: async (request) => ctx.contracts.assertModelResult(await ctx.waterfall('llm:request', request, () => requestChat(request)))
    })
  }
}
