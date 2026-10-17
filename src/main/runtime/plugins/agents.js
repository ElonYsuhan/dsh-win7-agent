'use strict'

module.exports = {
  name: 'core/agents',
  apply(ctx) {
    const workers = new Set()
    ctx.provide('agents', {
      release: (worker) => workers.delete(worker),
      create: (...args) => {
        const { Agent } = require('../../agent/agent')
        const worker = new Agent(...args)
        workers.add(worker)
        return worker
      }
    })
    ctx.effect(() => async () => {
      await Promise.all(Array.from(workers, (worker) => worker.dispose()))
      workers.clear()
    })
  }
}
