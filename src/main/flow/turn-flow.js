'use strict'

// Pure orchestration policy: no Cordis, filesystem, timers, network or Agent.
function limits(settings) {
  return { maxSteps: Math.max(1, Math.min(500, Math.floor(Number(settings.maxIterations) || 100))), maxAttempts: 6, reconnectDelaysMs: [1000, 2000, 4000, 8000, 16000], maxDenied: settings.unattended ? 1 : 3, turnTimeoutMs: Math.max(0, Math.min(86400000, Math.floor(Number(settings.turnTimeoutMs) || 0))) }
}
// Only transient transport/gateway failures are eligible: never retry credentials,
// certificate verification, invalid configuration, policy errors or arbitrary tool IO.
function transientNetworkError(input) {
  const code = String(input.code || '').toUpperCase()
  if (['ECONNRESET', 'ECONNABORTED', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code)) return true
  const message = String(input.error || '')
  return /^(?:LLM_RESPONSE_ABORTED|LLM_STREAM_INCOMPLETE|LLM_TIMEOUT|MODEL_PROXY_TIMEOUT)(?::|$)/.test(message) ||
    /^MODEL_PROXY_CONNECT_(?:502|503|504)(?::|$)/.test(message) ||
    /^LLM_HTTP_(?:408|502|503|504)(?::|$)/.test(message) ||
    /^Client network socket disconnected before secure TLS connection was established$/i.test(message) ||
    /^(?:connect |read |write )?(?:ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENETDOWN|ENETUNREACH|EHOSTUNREACH)(?:\s|:|$)/i.test(message) ||
    /^socket hang up$/i.test(message)
}
function retry(input) {
  if (input.aborted) return 'stop'
  if (input.toolsEnabled && /does not support tools?/.test(String(input.error || '').toLowerCase())) return 'without-tools'
  if (input.contextLengthError && input.attempt < 2) return 'compact'
  if (transientNetworkError(input)) return 'reconnect'
  return 'stop'
}
function next(input) {
  if (input.aborted) return 'cancel'
  if (input.deniedCount >= input.maxDenied) return 'blocked'
  if (input.calls.length === 0) return 'complete'
  return 'tools'
}
function normalizeCalls(raw, prefix) {
  return (raw || []).map((call, index) => ({
    id: call.id || ('call_' + prefix + '_' + index), type: 'function',
    function: { name: call.function.name, arguments: call.function.arguments }
  }))
}
function outcome(result, aborted) {
  if (aborted) return 'cancelled'
  if (String(result).startsWith('DENIED')) return 'denied'
  if (String(result).startsWith('DISABLED')) return 'disabled'
  if (String(result).startsWith('ERROR') || /^exitCode=(-?[1-9]\d*|null)(?:\n|$)/.test(String(result))) return 'error'
  return 'success'
}
module.exports = { limits, retry, next, normalizeCalls, outcome, systemPrompt: require('./prompt-policy').systemPrompt }
