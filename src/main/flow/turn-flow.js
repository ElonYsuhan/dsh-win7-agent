'use strict'

// Pure orchestration policy: no Cordis, filesystem, timers, network or Agent.
function limits(settings) {
  return { maxSteps: Math.max(1, Math.min(500, Math.floor(Number(settings.maxIterations) || 100))), maxAttempts: 4, maxDenied: settings.unattended ? 1 : 3, turnTimeoutMs: Math.max(0, Math.min(86400000, Math.floor(Number(settings.turnTimeoutMs) || 0))) }
}
function retry(input) {
  if (input.aborted) return 'stop'
  if (input.toolsEnabled && /does not support tools?/.test(String(input.error || '').toLowerCase())) return 'without-tools'
  if (input.contextLengthError && input.attempt < 2) return 'compact'
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
