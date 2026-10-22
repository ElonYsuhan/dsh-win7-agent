'use strict'

// IO adapter. State structures and transition rules belong to the state model.
const fs = require('fs')
const path = require('path')
const { visitJsonLines } = require('../persistence/jsonl')
class SessionRepository {
  constructor(state, contracts) { this.state = state; this.contracts = contracts; this.writers = new Map() }
  files(agent) { return { snapshot: path.join(agent.sessionDir, 'last-session.json'), journal: path.join(agent.sessionDir, 'events.jsonl') } }
  visitJournal(file, repair, visit) {
    if (!fs.existsSync(file)) return 0
    let sequence = 0
    visitJsonLines(file, repair, value => {
      const event = this.contracts.assertEvent(value)
      if (sequence && event.sequence !== sequence + 1) throw new Error('SESSION_JOURNAL_SEQUENCE_GAP')
      sequence = event.sequence
      visit(event)
    })
    return sequence
  }

  load(agent) {
    const files = this.files(agent)
    const snapshot = fs.existsSync(files.snapshot) ? JSON.parse(fs.readFileSync(files.snapshot, 'utf8')) : null
    let state = this.state.restore(snapshot)
    const tail = this.visitJournal(files.journal, true, event => {
      if (event.sequence > state.sequence) state = this.state.reduce(state, event)
    })
    if (tail && tail < state.sequence) throw new Error('SESSION_SNAPSHOT_AHEAD_OF_JOURNAL')
    this.writers.set(agent.sessionDir, state.sequence)
    return state
  }
  append(agent, event) {
    this.contracts.assertEvent(event)
    if (!this.writers.has(agent.sessionDir)) {
      const recovered = this.load(agent)
      if (recovered.sequence !== agent.state.sequence) throw new Error('SESSION_STALE_WRITER')
    }
    if (this.writers.get(agent.sessionDir) + 1 !== event.sequence) throw new Error('SESSION_STALE_WRITER')
    fs.mkdirSync(agent.sessionDir, { recursive: true })
    try { fs.appendFileSync(this.files(agent).journal, JSON.stringify(event) + '\n', 'utf8') } catch (error) {
      this.writers.delete(agent.sessionDir)
      throw error
    }
    this.writers.set(agent.sessionDir, event.sequence)
  }
  save(agent) {
    const file = this.files(agent).snapshot
    fs.mkdirSync(agent.sessionDir, { recursive: true })
    fs.writeFileSync(file + '.tmp', JSON.stringify({ version: 2, ...agent.state }, null, 2), 'utf8')
    fs.renameSync(file + '.tmp', file)
    // 快照写成功之后，日志里 <= 快照序号的事件全是重复的，必须清掉：
    // ① 每轮开头 replaceHistory 会把整份历史作为一条事件再写一遍，不清就按轮次**平方**增长；
    // ② 每轮 sessions.load() 会把整份日志 readFileSync + 逐行 JSON.parse 读回内存。
    // 实测（同一会话 12 轮）：不清时 events.jsonl 已 4.8MB、进程 RSS 98MB；
    // 40 轮时 RSS 涨到 380MB 且不回落。清空是安全的：load() 对空日志放行
    // （tail=0，不触发 SESSION_SNAPSHOT_AHEAD_OF_JOURNAL），后续事件从 sequence+1 继续追加。
    try { fs.writeFileSync(this.files(agent).journal, '') } catch (error) { /* 清不掉只是慢，不该让 save 失败 */ }
  }
}
module.exports = { SessionRepository }
