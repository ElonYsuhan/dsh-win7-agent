'use strict'

// Host environment lookup is IO policy in the transport adapter. Resolved secrets
// never go back into normalized config, connection status or settings snapshots.
function environmentValue(source, name) {
  if (!Object.prototype.hasOwnProperty.call(source, name) || source[name] === '') throw new Error('MCP_ENV_MISSING: ' + name)
  return String(source[name])
}
function childEnvironment(config, source) {
  source = source || process.env
  const pass = config.envPass || []
  const env = pass.length ? {} : Object.assign({}, source)
  if (pass.length) {
    const base = new Set(['path','systemroot','windir','temp','tmp','home','userprofile','comspec','pathext'])
    for (const key of Object.keys(source)) if (base.has(key.toLowerCase())) env[key] = source[key]
    for (const name of pass) env[name] = environmentValue(source, name)
  }
  return Object.assign(env, config.env || {})
}
function requestHeaders(config, source) {
  source = source || process.env
  const headers = Object.assign({}, config.headers || {})
  function set(name, value) {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
    headers[name] = value
  }
  for (const [name, variable] of Object.entries(config.headerEnv || {})) set(name, environmentValue(source, variable))
  if (config.bearerTokenEnv) set('Authorization', 'Bearer ' + environmentValue(source, config.bearerTokenEnv))
  return headers
}
module.exports = { childEnvironment, requestHeaders }
