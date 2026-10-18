'use strict'
// Pure calendar policy, evaluated against an injected wall clock. No IO or timers.
function parts(ms, timezone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const o = {}; for (const x of p) if (x.type !== 'literal') o[x.type] = Number(x.value)
  return o
}
function next(rule, after) {
  if (rule.kind === 'interval') return after + rule.minutes * 60000
  const local = parts(after, rule.timezone), [h, m] = rule.time.split(':').map(Number)
  for (let day = 0; day < 9; day++) {
    const target = Date.UTC(local.year, local.month - 1, local.day + day, h, m)
    if (rule.kind === 'weekly' && new Date(target).getUTCDay() !== rule.weekday) continue
    let candidate = target
    for (let i = 0; i < 4; i++) {
      const p = parts(candidate, rule.timezone)
      const represented = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute)
      candidate += target - represented
    }
    const p = parts(candidate, rule.timezone)
    // DST gaps are skipped instead of silently executing at a different local time.
    if (candidate > after && Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === target) return candidate
  }
  throw new Error('TASK_CALENDAR_NO_NEXT')
}
function advance(rule, due, now) {
  if (rule.kind === 'interval') return due + (Math.floor((now - due) / (rule.minutes * 60000)) + 1) * rule.minutes * 60000
  return next(rule, now)
}
function latest(rule, firstDue, now) {
  if (rule.kind === 'interval') return firstDue + Math.floor((now - firstDue) / (rule.minutes * 60000)) * rule.minutes * 60000
  let candidate = next(rule, now - 86400000 - 1), found = null
  while (candidate <= now) { if (candidate >= firstDue) found = candidate; candidate = next(rule, candidate) }
  return found
}
function due(task, now) {
  const late = now - task.nextAt
  if (!task.enabled || late < 0) return null
  if (late < 60000) return 'scheduled'
  const occurrence = task.catchUp ? latest(task.rule,task.nextAt,now) : null
  return occurrence !== null && occurrence >= now - 86400000 ? 'catchup' : 'skipped'
}
module.exports = { next, advance, latest, due }
