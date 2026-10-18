'use strict'

async function handleMcpApi(request, response, url, options) {
  if (url.pathname.startsWith('/api/mcp') === false) return false
  const { mcp, json, readBody } = options
  try {
    const route = url.pathname.slice('/api/mcp'.length)
    if (route === '' && request.method === 'GET') json(response, 200, mcp.status())
    else if (route === '/test' && request.method === 'POST') json(response, 200, await mcp.test(await readBody(request)))
    else if (route === '/reload' && request.method === 'POST') {
      await mcp.reload()
      json(response, 200, mcp.status())
    } else json(response, 404, { error: 'MCP_ROUTE_NOT_FOUND' })
  } catch (error) {
    json(response, 400, { error: error.message })
  }
  return true
}

module.exports = { handleMcpApi }
