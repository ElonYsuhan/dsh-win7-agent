'use strict'
const VERSION = 1
const DEFAULT_TOOLS = ['list_dir', 'read_file', 'search_files']
const TOOLS = DEFAULT_TOOLS.concat(['write_file', 'edit_file', 'update_plan', 'search_skills', 'load_skill', 'read_skill_file', 'run_command', 'browser_launch', 'browser_act', 'browser_close'])
function check(ok, message) { if (!ok) throw new Error('TASK_INVALID: ' + message) }
function integer(value, fallback, min, max) { const n = value === undefined ? fallback : Number(value); check(Number.isInteger(n) && n >= min && n <= max, 'limit ' + min + '..' + max); return n }
function definition(raw) {
  check(raw && typeof raw === 'object', 'object required')
  const name = String(raw.name || '').trim(), prompt = String(raw.prompt || '').trim()
  check(name.length > 0 && name.length <= 100, 'name'); check(prompt.length > 0 && prompt.length <= 20000, 'prompt')
  let workflow
  if(raw.workflow!==undefined){const w=raw.workflow;check(w&&typeof w==='object'&&!Array.isArray(w)&&Object.keys(w).every(k=>['id','revision'].includes(k))&&typeof w.id==='string'&&/^[A-Za-z0-9_-]{1,80}$/.test(w.id)&&Number.isInteger(w.revision)&&w.revision>0,'workflow target');workflow={id:w.id,revision:w.revision}}
  const rule = raw.rule || {}, kind = rule.kind
  check(['daily', 'weekly', 'interval'].includes(kind), 'rule.kind')
  const timezone = String(rule.timezone || 'UTC')
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0) } catch (_) { check(false, 'timezone') }
  const normalized = { kind, timezone }
  if (kind === 'interval') normalized.minutes = integer(rule.minutes, 60, 1, 525600)
  else {
    check(/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time || ''), 'HH:mm')
    normalized.time = rule.time
    if (kind === 'weekly') normalized.weekday = integer(rule.weekday, 1, 0, 6)
  }
  const permission = raw.permission || 'readonly'; check(['readonly', 'workspace'].includes(permission), 'permission')
  const tools = raw.tools === undefined ? DEFAULT_TOOLS.slice() : raw.tools
  check(Array.isArray(tools) && tools.length <= TOOLS.length && tools.every(t => TOOLS.includes(t)), 'tools')
  const commands = raw.commands || []; check(Array.isArray(commands) && commands.length <= 20 && commands.every(c => typeof c === 'string' && c.trim() && c.length <= 2000), 'commands')
  const origins = raw.origins || []; check(Array.isArray(origins) && origins.length <= 20 && origins.every(x => typeof x === 'string' && /^https?:\/\/[^/]+$/.test(x)), 'origins')
  const normalizedOrigins = origins.map(value=>{let url;try{url=new URL(value)}catch(_){check(false,'origin')};check(['http:','https:'].includes(url.protocol)&&!url.username&&!url.password,'origin');return url.origin})
  return { name, prompt, ...(workflow?{workflow}:{}), projectId: String(raw.projectId || ''), rule: normalized, permission, tools: [...new Set(tools)], commands, origins: [...new Set(normalizedOrigins)],
    enabled: raw.enabled === true, catchUp: raw.catchUp === true,
    timeoutMs: integer(raw.timeoutMs, 600000, 1000, 3600000), maxSteps: integer(raw.maxSteps, 20, 1, 100),
    tokenBudget: integer(raw.tokenBudget, 100000, 4096, 2000000), maxTokens: integer(raw.maxTokens, 4096, 256, 32768),
    maxRequests: integer(raw.maxRequests, 20, 1, 100), outputBytes: integer(raw.outputBytes, 262144, 1024, 2097152),
    failureLimit: integer(raw.failureLimit, 3, 1, 20) }
}
const TERMINAL = ['completed', 'failed', 'needs_attention', 'interrupted', 'cancelled', 'timed_out', 'exhausted', 'skipped']
function assertRunRecord(next) {
  check(next && next.version === VERSION && typeof next.id === 'string' && next.id && typeof next.taskId === 'string' && next.taskId && Number.isInteger(next.sequence) && next.sequence > 0, 'run identity/version/sequence')
  check(['pending', 'running'].concat(TERMINAL).includes(next.status), 'run status')
  check(Number.isFinite(next.createdAt) && next.task && typeof next.task === 'object', 'run snapshot')
  definition(next.task)
  if(next.workflowRunId!==undefined)check(!!next.task.workflow&&typeof next.workflowRunId==='string'&&/^[a-f0-9]{24}$/.test(next.workflowRunId),'workflow instance reference')
  return next
}
module.exports = { VERSION, DEFAULT_TOOLS, TOOLS, definition, assertRunRecord, TERMINAL }
