'use strict'
const { assertRunRecord, TERMINAL } = require('../contracts/tasks')
function runTransition(previous, next) {
  assertRunRecord(next)
  if (!previous) {
    if (!['pending', 'skipped'].includes(next.status)) throw new Error('TASK_STATE_INITIAL')
  } else {
    if (previous.id !== next.id || previous.taskId !== next.taskId || next.sequence !== previous.sequence + 1) throw new Error('TASK_STATE_SEQUENCE')
    if (!((previous.status === 'pending' && ['running', 'interrupted', 'cancelled'].includes(next.status)) || (previous.status === 'running' && TERMINAL.includes(next.status)))) throw new Error('TASK_STATE_TRANSITION')
  }
  return Object.assign({}, next)
}
module.exports = { runTransition }
