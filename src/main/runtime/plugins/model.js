'use strict'

module.exports = {
  name: 'core/llm', inject: ['contracts', 'licensing'],
  apply(ctx) {
    const { requestChat } = require('../../agent/llm')
    ctx.provide('llm', {
      request: async (request) => { ctx.licensing.assert('chat'); return ctx.contracts.assertModelResult(await ctx.waterfall('llm:request', request, () => requestChat(request))) }
    })
  }
}
