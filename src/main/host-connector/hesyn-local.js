'use strict'

// Local development bridge. Secrets stay in this process, never in the renderer.
const http = require('http')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { HostConnector } = require('./client')

async function startHesynBridge(options) {
  const { serviceOrigin, hostToken, userToken, hostId, home, origin } = options
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin || '')) throw Error('HESYN_ORIGIN_INVALID')
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(serviceOrigin || '')) throw Error('HESYN_SERVICE_ORIGIN_INVALID')
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(userToken || '')) throw Error('HESYN_USER_TOKEN_INVALID')
  if (!/^[A-Za-z0-9_-]{1,24}$/.test(hostId || '')) throw Error('HESYN_HOST_ID_INVALID')
  let snapshot = null, owner = null, connection = null
  const sessionOwners = new Map()
  // Session routing metadata, not chat history or business state. Unknown legacy sessions
  // are deliberately not adopted by whichever project happens to be open.
  fs.mkdirSync(home, { recursive: true })
  const sceneBindingsFile = path.join(home, 'session-scenes.json')
  const sessionScenes = new Map(fs.existsSync(sceneBindingsFile)
    ? Object.entries(JSON.parse(fs.readFileSync(sceneBindingsFile, 'utf8'))) : [])
  function saveSceneBinding(id, sceneId) {
    sessionScenes.set(id, sceneId)
    const temporary = sceneBindingsFile + '.tmp'
    fs.writeFileSync(temporary, JSON.stringify(Object.fromEntries(sessionScenes)), { mode: 0o600 })
    fs.renameSync(temporary, sceneBindingsFile)
  }
  const pendingCalls = new Map()
  function current(sessionId) {
    if (!snapshot || !connection || !snapshot.ready) throw Error('HESYN_CONTEXT_UNAVAILABLE')
    if (!sessionId || sessionOwners.get(sessionId) !== owner) throw Error('HESYN_SESSION_NOT_BOUND')
    if (!sessionScenes.has(sessionId) || sessionScenes.get(sessionId) !== snapshot.sceneId) throw Error('HESYN_SESSION_PROJECT_MISMATCH')
    snapshot.observedAt = new Date().toISOString()
    return snapshot
  }
  function rejectPendingCalls(message) {
    for (const [callId, item] of pendingCalls) {
      clearTimeout(item.timer)
      pendingCalls.delete(callId)
      item.reject(Error(message))
    }
  }
  // 能力调用经 SSE 下发到浏览器，由 HESYN 的 Host Adapter 执行后回传结果。
  function forwardToHost(call, payload) {
    return new Promise((resolve, reject) => {
      const state = current(call.sessionId)
      if (pendingCalls.size >= 16) { reject(Error('HESYN_BUSY')); return }
      const callId = crypto.randomUUID()
      const timer = setTimeout(() => { pendingCalls.delete(callId); reject(Error('HESYN_CALL_TIMEOUT')) }, 25000)
      pendingCalls.set(callId, { resolve, reject, timer, clientId: owner })
      // 场景代次随调用下发；HESYN 侧代次不匹配时按 STALE_CONTEXT 拒绝，避免误操作新场景。
      const frame = 'id: ' + callId + '\nevent: tool-call\ndata: ' + JSON.stringify({ callId, sceneEpoch: state.sceneEpoch, payload }) + '\n\n'
      if (!connection.write(frame)) { clearTimeout(timer); pendingCalls.delete(callId); reject(Error('HESYN_DISCONNECTED')) }
    })
  }
  const emptySchema = { type: 'object', properties: {}, additionalProperties: false }
  const capabilitiesSchema = {
    type: 'object',
    properties: { capabilityId: { type: 'string' } },
    additionalProperties: false
  }
  const callSchema = {
    type: 'object',
    properties: {
      capabilityId: { type: 'string' },
      input: { type: 'object' },
      operationId: { type: 'string' },
      confirmed: { type: 'boolean' }
    },
    required: ['capabilityId', 'input'],
    additionalProperties: false
  }
  const entityPointSchema = {
    type: 'object',
    properties: { lon: { type: 'number' }, lat: { type: 'number' }, alt: { type: 'number' } },
    required: ['lon', 'lat'],
    additionalProperties: false
  }
  const entityCreateSchema = {
    type: 'object',
    properties: { resourceId: { type: 'string' }, point: entityPointSchema, operationId: { type: 'string' } },
    required: ['resourceId', 'point'],
    additionalProperties: false
  }
  const entityUpdateSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      expectedRevision: { type: 'integer' },
      patch: { type: 'object' },
      operationId: { type: 'string' }
    },
    required: ['id', 'expectedRevision', 'patch'],
    additionalProperties: false
  }
  const entityDeleteSchema = {
    type: 'object',
    properties: { id: { type: 'string' }, expectedRevision: { type: 'integer' }, operationId: { type: 'string' } },
    required: ['id', 'expectedRevision'],
    additionalProperties: false
  }
  // 语义化实体工具：模型直接看到并调用的真实工具，执行仍经 HESYN Capability Registry。
  function entityTool(name, capabilityId, permission, description, parameters) {
    return {
      name,
      description,
      permission,
      parameters,
      execute: async (args, call) => forwardToHost(call, {
        kind: 'call',
        capabilityId,
        input: args,
        operationId: args.operationId || call.idempotencyKey
      })
    }
  }
  const tools = [
    { name: 'get_context', description: '读取当前工作台的只读上下文', permission: 'read', parameters: emptySchema, execute: async (_, call) => current(call.sessionId) },
    { name: 'list_equipment', description: '读取当前场景装备列表', permission: 'read', parameters: emptySchema, execute: async (_, call) => current(call.sessionId).equipment },
    { name: 'get_selected_entity', description: '读取当前选中装备', permission: 'read', parameters: emptySchema, execute: async (_, call) => current(call.sessionId).selectedEntity },
    entityTool('entity_list', 'entity.list', 'read', '列出 HESYN 当前场景全部装备（id、名称、revision、显隐）。', emptySchema),
    entityTool('resource_search', 'resource.search', 'read', '按名称或 ID 搜索可部署的装备资源，返回 resourceId、名称和二维/三维模式。创建装备前先用它确认 resourceId。', {
      type: 'object',
      properties: { query: { type: 'string' }, limit: { type: 'integer' } },
      additionalProperties: false
    }),
    entityTool('entity_create', 'entity.create', 'write', '在 HESYN 场景中部署一个装备实体。resourceId 来自 resource_search；point 为经度/纬度/高度。重复调用不会重复创建。', entityCreateSchema),
    entityTool('entity_update', 'entity.update', 'write', '按字段修改 HESYN 装备。必须携带 entity_list 返回的当前 revision；revision 过期会被拒绝。', entityUpdateSchema),
    entityTool('entity_delete', 'entity.delete', 'write', '删除 HESYN 装备。必须携带当前 revision，执行前需人工审批。', entityDeleteSchema),
    {
      name: 'hesyn_capabilities',
      description: '列出 HESYN 当前可执行能力（含输入 Schema）。写操作前先调用，按返回的 capabilityId 使用 hesyn_call。',
      permission: 'read',
      parameters: capabilitiesSchema,
      execute: async (args, call) => forwardToHost(call, { kind: 'capabilities', ...(args.capabilityId ? { capabilityId: args.capabilityId } : {}) })
    },
    {
      name: 'hesyn_call',
      description: '调用 HESYN 能力。capabilityId 来自 hesyn_capabilities；input 按该能力 Schema 填写，不要编造 ID。HESYN 负责权限、场景代次、revision 与幂等校验。',
      permission: 'command',
      parameters: callSchema,
      execute: async (args, call) => forwardToHost(call, {
        kind: 'call',
        capabilityId: args.capabilityId,
        input: args.input,
        // Host 命令 ID 在重试间稳定，可直接作为幂等键。
        operationId: args.operationId || call.idempotencyKey,
        ...(args.confirmed === undefined ? {} : { confirmed: args.confirmed })
      })
    }
  ]
  const connector = new HostConnector({ url: serviceOrigin, token: hostToken, home, allowLoopbackHttp: true, getContext: async call => current(call.sessionId), tools })
  async function callService(route, body) {
    return new Promise((resolve, reject) => {
      const payload = Buffer.from(JSON.stringify(body))
      const request = http.request(serviceOrigin + route, { method: 'POST', headers: { authorization: 'Bearer ' + userToken, 'content-type': 'application/json', 'content-length': payload.length } }, response => {
        if (response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(Error('SERVICE_HTTP_' + response.statusCode)); return }
        let data = '', size = 0
        response.on('data', chunk => { size += chunk.length; if (size > 131072) request.destroy(Error('SERVICE_RESPONSE_TOO_LARGE')); else data += chunk })
        response.on('end', () => { try { resolve(JSON.parse(data)) } catch (error) { reject(error) } })
        response.on('error', reject)
      })
      request.setTimeout(15000, () => request.destroy(Error('SERVICE_TIMEOUT')))
      request.on('error', reject)
      request.end(payload)
    })
  }
  const server = http.createServer(async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)) }
    const url = new URL(req.url, origin)
    if (req.method === 'GET' && url.pathname === '/stream') {
      const clientId = url.searchParams.get('clientId') || ''
      const sameOrigin = req.headers.origin === origin || (!req.headers.origin && req.headers['sec-fetch-site'] === 'same-origin' && req.headers.host === new URL(origin).host)
      if (!sameOrigin || !/^[0-9a-f-]{36}$/.test(clientId)) return reply(403, { error: 'DENIED' })
      if (connection) return reply(409, { error: 'HOST_ALREADY_ACTIVE' })
      owner = clientId; snapshot = null; connection = res
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.write(': connected\n\n')
      const heartbeat = setInterval(() => { if (!res.write(': heartbeat\n\n')) res.destroy() }, 15000)
      res.on('close', () => { clearInterval(heartbeat); if (connection === res) { connection = null; snapshot = null; owner = null; rejectPendingCalls('HESYN_DISCONNECTED') } })
      return
    }
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') return reply(403, { error: 'DENIED' })
    try {
      let size = 0, data = ''
      for await (const chunk of req) { size += chunk.length; if (size > 131072) throw Error('BODY_TOO_LARGE'); data += chunk }
      const input = JSON.parse(data || '{}')
      if (req.url === '/context') {
        if (!input || !/^[0-9a-f-]{36}$/.test(input.clientId || '')) throw Error('INVALID_CLIENT')
        if (input.active === false) {
          if (owner === input.clientId) { snapshot = null; if (connection) connection.end() }
          return reply(200, { ok: true })
        }
        if (!connection || owner !== input.clientId) return reply(409, { error: 'HOST_NOT_ACTIVE' })
        if (!input || typeof input.ready !== 'boolean' || !Array.isArray(input.equipment) || !(input.sceneId === null || typeof input.sceneId === 'string')) throw Error('INVALID_CONTEXT')
        if (snapshot && snapshot.sceneId !== input.sceneId) rejectPendingCalls('HESYN_PROJECT_CHANGED')
        const { clientId, ...context } = input
        snapshot = { ...context, observedAt: new Date().toISOString() }
        const sessions = Array.from(sessionOwners.entries()).filter(([id, value]) => value === clientId && sessionScenes.get(id) === snapshot.sceneId).map(([id]) => id)
        if (sessions.length) await connector.request('POST', '/api/v1/hosts/self/context-changed', { protocolVersion: 1, sessions })
        return reply(200, { ok: true })
      }
      if (req.url === '/ticket') {
        if (!input.clientId || input.clientId !== owner || !snapshot || !connection) return reply(409, { error: 'HOST_NOT_ACTIVE' })
        if (typeof input.sessionId !== 'string' || (input.sessionId && !/^[0-9a-f-]{36}$/.test(input.sessionId))) throw Error('INVALID_SESSION')
        const sceneId = snapshot.sceneId
        if (input.projectId !== undefined && input.projectId !== sceneId) return reply(409, { error: 'PROJECT_CONTEXT_MISMATCH' })
        if (input.sessionId) {
          if (!sessionScenes.has(input.sessionId) || sessionScenes.get(input.sessionId) !== sceneId) return reply(409, { error: 'SESSION_PROJECT_MISMATCH' })
          const ticket = await callService('/api/v1/sessions/' + input.sessionId + '/tickets', {})
          if (owner !== input.clientId || !snapshot || snapshot.sceneId !== sceneId) throw Error('HOST_CHANGED')
          sessionOwners.set(input.sessionId, owner)
          return reply(200, { sessionId: input.sessionId, credential: ticket.credential })
        }
        const session = await callService('/api/v1/sessions', { hostId, requestId: crypto.randomUUID() })
        if (owner !== input.clientId || !snapshot || snapshot.sceneId !== sceneId) throw Error('HOST_CHANGED')
        saveSceneBinding(session.sessionId, sceneId)
        sessionOwners.set(session.sessionId, owner)
        return reply(200, { sessionId: session.sessionId, credential: session.launchCredential })
      }
      if (req.url === '/tool-result') {
        if (!input || !/^[0-9a-f-]{36}$/.test(input.clientId || '') || !/^[0-9a-f-]{36}$/.test(input.callId || '')) throw Error('INVALID_CALL_RESULT')
        if (!connection || owner !== input.clientId) return reply(409, { error: 'HOST_NOT_ACTIVE' })
        const item = pendingCalls.get(input.callId)
        if (!item || item.clientId !== owner) return reply(404, { error: 'CALL_NOT_FOUND' })
        pendingCalls.delete(input.callId); clearTimeout(item.timer)
        if (input.ok === false) {
          const failure = input.error && typeof input.error === 'object'
            ? String(input.error.code || 'HESYN_CALL_FAILED') + ': ' + String(input.error.message || '')
            : String(input.error || 'HESYN_CALL_FAILED')
          item.reject(Error(failure.slice(0, 500)))
        } else item.resolve(input.result === undefined ? null : input.result)
        return reply(200, { ok: true })
      }
      reply(404, { error: 'NOT_FOUND' })
    } catch (error) { reply(503, { error: error.message }) }
  })
  await connector.start()
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port === undefined ? 18100 : options.port, '127.0.0.1', resolve) }) } catch (error) { await connector.close(); throw error }
  return { server, connector, close: async () => { rejectPendingCalls('HESYN_DISCONNECTED'); snapshot = null; if (connection) connection.end(); await new Promise(resolve => server.close(resolve)); await connector.close() } }
}

module.exports = { startHesynBridge }
