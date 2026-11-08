'use strict'

// Long-term memory uses the already-shipped SQLite 3.54/FTS5 bridge. This is a
// separate database from knowledge so its lifecycle and deletion semantics do
// not affect user documents.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const APPLICATION_ID = 1262634802
const schema = `
PRAGMA application_id=${APPLICATION_ID};
CREATE TABLE IF NOT EXISTS memories(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  normalized TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  expires INTEGER,
  metadata TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS memories_scope_status ON memories(scope,scope_id,status);
CREATE INDEX IF NOT EXISTS memories_key_status ON memories(scope,scope_id,key,status);
CREATE TABLE IF NOT EXISTS memory_evidence(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_evidence_memory ON memory_evidence(memory_id);
CREATE TABLE IF NOT EXISTS memory_revisions(
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL REFERENCES memories(id),
  version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  UNIQUE(memory_id,version)
);
CREATE TABLE IF NOT EXISTS memory_candidates(
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  key TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  confidence REAL NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  quote TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL,
  decided INTEGER
);
CREATE INDEX IF NOT EXISTS memory_candidates_status ON memory_candidates(status,created);
CREATE TABLE IF NOT EXISTS memory_preferences(
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated INTEGER NOT NULL,
  PRIMARY KEY(scope,scope_id,key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, memory_id UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS memory_feedback(
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  task TEXT NOT NULL,
  outcome TEXT NOT NULL,
  capabilities TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_feedback_created ON memory_feedback(created);
PRAGMA user_version=1;
`

function sql(value) {
  if (value === null || value === undefined) return 'NULL'
  return "CAST(X'" + Buffer.from(String(value), 'utf8').toString('hex') + "' AS TEXT)"
}

class MemoryRepository {
  constructor(home) {
    this.dir = path.join(home, 'memory')
    this.file = path.join(this.dir, 'memory.db')
    this.chain = Promise.resolve()
    this.pending = new Set()
    this.closed = false
    this.opened = false
  }

  async open() {
    if (this.opened) return
    fs.mkdirSync(this.dir, { recursive: true })
    this.lock = path.join(this.dir, 'owner.json')
    try { this.fd = fs.openSync(this.lock, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      let owner
      try { owner = JSON.parse(fs.readFileSync(this.lock, 'utf8')); process.kill(owner.pid, 0) } catch (e) {
        if (e.code === 'ESRCH') { fs.unlinkSync(this.lock); return this.open() }
        throw new Error('MEMORY_OWNER_LOCKED')
      }
      throw new Error('MEMORY_OWNER_LOCKED')
    }
    fs.writeFileSync(this.fd, JSON.stringify({ pid: process.pid }))
    this.opened = true
    try {
      const engine = await this.raw('SELECT sqlite_version() AS version;')
      if (engine[0].version !== '3.54.0') throw new Error('MEMORY_SQLITE_VERSION_MISMATCH')
      const identity = await this.raw('PRAGMA application_id;')
      if (!['0', String(APPLICATION_ID)].includes(identity[0].application_id)) throw new Error('MEMORY_DATABASE_IDENTITY')
      const version = await this.raw('PRAGMA user_version;')
      if (Number(version[0].user_version) > 1) throw new Error('MEMORY_DATABASE_NEWER')
      await this.raw('BEGIN IMMEDIATE;' + schema + 'COMMIT;')
      const integrity = await this.raw('PRAGMA quick_check;')
      if (integrity[0].quick_check !== 'ok') throw new Error('MEMORY_DATABASE_CORRUPT')
    } catch (error) { await this.close(); throw error }
  }

  raw(query) {
    if (this.closed) return Promise.reject(new Error('MEMORY_CLOSED'))
    const binary = path.join(__dirname, '..', 'knowledge', 'vendor', 'sqlite', process.platform + '-' + process.arch + (process.platform === 'win32' ? '.exe' : '')).replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)
    if (!fs.existsSync(binary)) return Promise.reject(new Error('MEMORY_PLATFORM_NOT_BUILT'))
    return new Promise((resolve, reject) => {
      let child, output = [], bytes = 0, done = false
      const finish = (error, rows) => {
        if (done) return
        done = true
        clearTimeout(timer)
        this.pending.delete(child)
        if (error) reject(error); else resolve(rows)
      }
      const timer = setTimeout(() => { if (child) child.kill(); finish(new Error('MEMORY_DB_TIMEOUT')) }, 15000)
      try {
        child = spawn(binary, [this.file], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
        this.pending.add(child)
        child.on('error', finish)
        child.stdin.on('error', () => {})
        child.stdout.on('data', chunk => {
          bytes += chunk.length
          if (bytes > 16 * 1024 * 1024) { child.kill(); finish(new Error('MEMORY_DB_OUTPUT_LIMIT')); return }
          output.push(chunk)
        })
        child.on('close', code => {
          try {
            const value = JSON.parse(Buffer.concat(output).toString('utf8'))
            if (code !== 0 || value.error) throw new Error('MEMORY_DB: ' + (value.error || code))
            finish(null, value.rows)
          } catch (error) { finish(error) }
        })
        child.stdin.end(query)
      } catch (error) { finish(error) }
    })
  }

  query(query) {
    const work = this.chain.then(() => this.raw(query))
    this.chain = work.catch(() => {})
    return work
  }

  async close() {
    this.closed = true
    await this.chain
    for (const child of this.pending) child.kill()
    if (this.fd !== undefined) {
      fs.closeSync(this.fd); this.fd = undefined
      try { fs.unlinkSync(this.lock) } catch (_) {}
    }
    this.opened = false
  }
}

module.exports = { MemoryRepository, sql, APPLICATION_ID }
