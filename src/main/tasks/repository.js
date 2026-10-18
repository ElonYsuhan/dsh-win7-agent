'use strict'
const fs = require('fs'), path = require('path')
const { runTransition } = require('../state/task-state')
const { assertRunRecord } = require('../contracts/tasks')
class TaskRepository {
  constructor(home) { this.dir = path.join(home, 'tasks'); this.snapshot = path.join(this.dir, 'tasks.json'); this.log = path.join(this.dir, 'runs.jsonl'); this.tasks = []; this.runs = new Map(); this.locked = false }
  open() {
    fs.mkdirSync(this.dir, { recursive: true })
    this.lock = path.join(this.dir, 'owner.json')
    try { this.fd = fs.openSync(this.lock, 'wx'); this.locked = true } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(fs.readFileSync(this.lock, 'utf8')); process.kill(owner.pid, 0) } catch (e) {
        if (e.code !== 'ESRCH') throw new Error('TASK_OWNER_LOCKED: ' + this.dir)
        fs.unlinkSync(this.lock); return this.open()
      }
      throw new Error('TASK_OWNER_LOCKED: ' + this.dir)
    }
    fs.writeFileSync(this.fd, JSON.stringify({ pid: process.pid, version: 1 }))
    try {
      if (fs.existsSync(this.snapshot)) {
        let data
        try { data = JSON.parse(fs.readFileSync(this.snapshot, 'utf8')) } catch (error) { data = JSON.parse(fs.readFileSync(this.snapshot + '.bak', 'utf8')) }
        if (data.version !== 1 || !Array.isArray(data.tasks)) throw new Error('TASK_STORE_VERSION')
        this.tasks = data.tasks
      }
      if (fs.existsSync(this.log)) {
        const bytes = fs.readFileSync(this.log), end = bytes.lastIndexOf(10) + 1
        if (end !== bytes.length) fs.truncateSync(this.log, end)
        for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
          const row = JSON.parse(line), old = this.runs.get(row.id)
          // A compacted terminal record is a self-contained checkpoint.
          if (old || !row.checkpoint) runTransition(old, row)
          else assertRunRecord(row)
          this.runs.set(row.id, row)
        }
      }
      for (const run of Array.from(this.runs.values())) if (run.status === 'running') this.transition(run.id, { status: 'interrupted', endedAt: Date.now(), summary: '服务重启，未自动重复执行' })
      this.compact()
    } catch (e) { this.close(); throw e }
  }
  atomic(file, text) { fs.writeFileSync(file + '.tmp', text, 'utf8'); fs.renameSync(file + '.tmp', file) }
  save(tasks) {
    const text = JSON.stringify({ version: 1, tasks }, null, 2)
    if (fs.existsSync(this.snapshot)) this.atomic(this.snapshot + '.bak', JSON.stringify({version:1,tasks:this.tasks},null,2))
    this.atomic(this.snapshot, text); this.tasks = tasks
  }
  append(row) { if(this.failed)throw new Error('TASK_REPOSITORY_RESTART_REQUIRED: '+this.failed);runTransition(this.runs.get(row.id), row); try{fs.appendFileSync(this.log, JSON.stringify(row) + '\n')}catch(error){this.failed=error.message;throw error}; this.runs.set(row.id, row); return row }
  transition(id, patch) { const previous = this.runs.get(id); if (!previous) throw new Error('TASK_RUN_NOT_FOUND'); return this.append({ ...previous, ...patch, sequence: previous.sequence + 1, checkpoint: false }) }
  compact() {
    const counts = new Map(), rows = Array.from(this.runs.values()).sort((a,b) => b.createdAt-a.createdAt)
    const live = rows.filter(r=>['pending','running'].includes(r.status))
    const terminal = rows.filter(r=>!['pending','running'].includes(r.status)).filter(r=>{const n=counts.get(r.taskId)||0;counts.set(r.taskId,n+1);return n<100})
    const kept = live.concat(terminal.slice(0,Math.max(0,1000-live.length))).sort((a,b)=>b.createdAt-a.createdAt)
    this.atomic(this.log, kept.reverse().map(r => JSON.stringify({ ...r, checkpoint: true })+'\n').join('')); this.runs = new Map(kept.map(r=>[r.id,r]))
  }
  close() { if (this.locked) { fs.closeSync(this.fd); fs.unlinkSync(this.lock); this.locked = false } }
}
module.exports = { TaskRepository }
