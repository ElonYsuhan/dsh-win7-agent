'use strict'

const crypto = require('crypto')
const { VERSION } = require('../../contracts/host-integration')

module.exports = {
  name: 'service/host-connector',
  inject: ['agentConfig', 'tools'],
  apply(ctx) {
    const repo = ctx.agentConfig.serviceRepository
    const connections = new Map()
    const pending = new Map()
    const registrations = new Map()
    let closed = false
    function uncertain(id) {
      try { repo.data.calls[id].status = 'uncertain'; repo.save() } catch (_) {}
    }
    function disconnect(hostId, connection) {
      if (connections.get(hostId) !== connection) return
      connections.delete(hostId)
      for (const [id, item] of pending) {
        if (item.hostId !== hostId) continue
        clearTimeout(item.timer)
        pending.delete(id)
        if (item.mutating) uncertain(id)
        item.reject(Error(item.mutating ? 'HOST_RESULT_UNCERTAIN' : 'HOST_DISCONNECTED'))
      }
    }
    const service = {
      async register(hostId, rawTools) {
        const definitions = require('../../contracts/host-integration').tools(rawTools)
        const previous = registrations.get(hostId) || []
        for (const dispose of previous) await dispose()
        const disposers = []
        try {
          for (const tool of definitions) {
            const name = 'host__' + hostId + '__' + tool.name
            disposers.push(ctx.tools.register({
              name, description: tool.description, permission: tool.permission, parameters: tool.parameters,
              plugin: 'service/host-connector',
              available: context => Boolean(context.agent && context.agent.serviceBinding && context.agent.serviceBinding.hostId === hostId),
              execute: async (args, context) => {
                const binding = context.agent && context.agent.serviceBinding
                if (!binding || binding.hostId !== hostId) throw Error('HOST_SESSION_NOT_BOUND')
                const result = await service.request(hostId, { method: 'tools.call', sessionId: binding.id, userId: binding.userId, tool: tool.name, args, deadline: Date.now() + 30000 }, { signal: context.signal })
                return typeof result === 'string' ? result : JSON.stringify(result)
              }
            }))
          }
        } catch (error) { for (const dispose of disposers) await dispose(); throw error }
        registrations.set(hostId, disposers)
        return definitions
      },
      connect(hostId, response) {
        if (closed) throw Error('HOST_CONNECTOR_CLOSED')
        const old = connections.get(hostId)
        if (old) { disconnect(hostId, old); old.end() }
        connections.set(hostId, response)
        response.on('close', () => disconnect(hostId, response))
      },
      online(hostId) { return connections.has(hostId) },
      event(hostId, event) {
        const stream = connections.get(hostId)
        if (!stream || stream.destroyed) return false
        if (!stream.write('data: ' + JSON.stringify({ protocolVersion: VERSION, method: 'event', event }) + '\n\n')) { disconnect(hostId, stream); stream.destroy(); return false }
        return true
      },
      async request(hostId, command, options) {
        const stream = connections.get(hostId)
        if (!stream || stream.destroyed) throw Error('HOST_OFFLINE')
        const mutating = command.method === 'tools.call'
        const id = crypto.randomUUID()
        const data = { protocolVersion: VERSION, ...command, id }
        if (mutating) {
          repo.data.calls[id] = { hostId, sessionId: command.sessionId, status: 'prepared', at: Date.now() }
          repo.save()
          repo.audit('host.call.prepared', { hostId, sessionId: command.sessionId, userId: command.userId, callId: id, tool: command.tool })
        }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            const item = pending.get(id)
            if (!item) return
            pending.delete(id)
            if (mutating) uncertain(id)
            item.reject(Error(mutating ? 'HOST_RESULT_UNCERTAIN' : 'HOST_REQUEST_TIMEOUT'))
          }, Math.min(Math.max(Number(options && options.timeoutMs) || 30000, 1000), 120000))
          const abort = () => {
            const item = pending.get(id)
            if (!item) return
            pending.delete(id); clearTimeout(timer)
            if (mutating) uncertain(id)
            item.reject(Error(mutating ? 'HOST_RESULT_UNCERTAIN' : 'ABORTED'))
          }
          const signal = options && options.signal
          if (signal && signal.aborted) { clearTimeout(timer); reject(Error('ABORTED')); return }
          const finish = fn => value => { if (signal) signal.removeEventListener('abort', abort); fn(value) }
          pending.set(id, { hostId, mutating, timer, resolve: finish(resolve), reject: finish(reject) })
          if (signal) signal.addEventListener('abort', abort, { once: true })
          if (mutating) { repo.data.calls[id].status = 'running'; repo.save() }
          if (!stream.write('data: ' + JSON.stringify(data) + '\n\n')) {
            disconnect(hostId, stream); stream.destroy()
          }
        })
      },
      result(hostId, result) {
        if (!result || result.protocolVersion !== VERSION || typeof result.id !== 'string') throw Error('HOST_RESULT_INVALID')
        if (!['succeeded', 'failed', 'uncertain'].includes(result.status)) throw Error('HOST_RESULT_INVALID')
        if (Buffer.byteLength(JSON.stringify(result)) > 131072) throw Error('HOST_RESULT_TOO_LARGE')
        const item = pending.get(result.id)
        const call = repo.data.calls[result.id]
        if ((item && item.hostId !== hostId) || (call && call.hostId !== hostId) || (!item && !call)) throw Error('HOST_RESULT_UNKNOWN')
        if (result.resultHash !== undefined && !/^[0-9a-f]{64}$/.test(result.resultHash)) throw Error('HOST_RESULT_INVALID')
        const hasResult = Object.prototype.hasOwnProperty.call(result, 'result')
        const digest = hasResult ? require('../../service/repository').hash(result.result) : (result.resultHash || (result.status !== 'succeeded' ? require('../../service/repository').hash('') : undefined))
        if (hasResult && result.resultHash !== undefined && result.resultHash !== digest) throw Error('HOST_RESULT_CONFLICT')
        if (call) {
          if (result.status === 'succeeded' && !digest) throw Error('HOST_RESULT_INVALID')
          if (call.status === 'uncertain' && result.status === 'uncertain' && call.resultHash === digest) return
          if (['succeeded', 'failed'].includes(call.status)) {
            if (call.status !== result.status || (call.resultHash || undefined) !== digest) throw Error('HOST_RESULT_CONFLICT')
            return
          }
          // Uncertainty can be resolved by a later authenticated result, never by replaying the call.
          call.status = result.status
          if (digest) call.resultHash = digest
          try {
            repo.save()
            repo.audit('host.call.result', { hostId, sessionId: call.sessionId, callId: result.id, status: result.status })
          } catch (error) { if (item) { pending.delete(result.id); clearTimeout(item.timer); item.reject(Error('HOST_RESULT_UNCERTAIN')) } throw error }
        }
        if (!item) return
        pending.delete(result.id); clearTimeout(item.timer)
        if (result.status === 'succeeded' && hasResult) item.resolve(result.result)
        else item.reject(Error(result.status === 'failed' ? 'HOST_CALL_FAILED' : 'HOST_RESULT_UNCERTAIN'))
      }
    }
    ctx.provide('hostConnector', service)
    ctx.effect(() => async () => {
      closed = true
      for (const [hostId, stream] of connections) { disconnect(hostId, stream); stream.end() }
      for (const disposers of registrations.values()) for (const dispose of disposers) await dispose()
      registrations.clear()
    })
  }
}
