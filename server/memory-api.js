'use strict'

// Loopback-only memory management API. Scope is derived from the active
// workspace and never from arbitrary renderer-provided user identity.
async function handleMemoryApi(request, response, url, options) {
  if (!url.pathname.startsWith('/api/memory')) return false
  const { memory, json, readBody, workspace } = options
  try {
    if (!memory) throw new Error('MEMORY_UNAVAILABLE')
    const route = url.pathname.slice('/api/memory'.length)
    const data = request.method === 'POST' ? await readBody(request) : {}
    const root = workspace() || ''
    const scope = data.scope === 'user' ? 'user' : root ? 'project' : 'session'
    const scopeId = scope === 'user' ? '' : root || String(data.sessionId || '')
    let result
    if (route === '' || route === '/list') result = await memory.list({ ...data, scope, scopeId })
    else if (route === '/search') result = await memory.search({ ...data, scope, scopeId })
    else if (route === '/update') result = await memory.update(data)
    else if (route === '/forget') result = await memory.forget(data.id)
    else if (route === '/candidates') result = await memory.candidates({ ...data, scope, scopeId })
    else if (route === '/confirm') result = await memory.confirm(data)
    else if (route === '/reject') result = await memory.reject(data)
    else if (route === '/preferences') result = await memory.preferences({ ...data, scope, scopeId })
    else if (route === '/preference') result = await memory.setPreference({ ...data, scope, scopeId })
    else if (route === '/feedback') result = await memory.feedback({ ...data, scope, scopeId })
    else if (route === '/feedback-list') result = await memory.feedbackList(data)
    else throw new Error('MEMORY_ROUTE_INVALID')
    json(response, 200, result)
  } catch (error) { json(response, 400, { error: error.message }) }
  return true
}
module.exports = { handleMemoryApi }
