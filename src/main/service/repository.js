'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { visitJsonLines } = require('../persistence/jsonl')
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

class ServiceRepository {
  constructor(home, options = {}) {
    this.eventBufferMaxBytes = options.eventBufferMaxBytes || 4 * 1024 * 1024
    this.dir = path.join(home, 'service')
    fs.mkdirSync(this.dir, { recursive: true })
    this.lock = path.join(this.dir, 'owner.json')
    try { this.lockFd = fs.openSync(this.lock, 'wx') } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = JSON.parse(fs.readFileSync(this.lock, 'utf8'))
      if (!require('../persistence/process-owner').alive(owner)) {
        fs.unlinkSync(this.lock)
        this.lockFd = fs.openSync(this.lock, 'wx')
      }
      if (this.lockFd === undefined) throw Error('SERVICE_HOME_IN_USE')
    }
    fs.writeFileSync(this.lockFd, JSON.stringify(require('../persistence/process-owner').record()))
    this.eventBuffers = new Map()
    this.epoch = crypto.randomUUID()
    this.file = path.join(this.dir, 'state.json')
    try {
      this.data = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { version: 1, sessions: {}, tickets: {}, cookies: {}, receipts: {}, calls: {}, hosts: {} }
      if (this.data.version !== 1) throw Error('SERVICE_STORE_VERSION')
      this.auditFile = path.join(this.dir, 'audit.jsonl')
      this.auditSequence = 0
      this.auditHash = ''
      if (fs.existsSync(this.auditFile)) visitJsonLines(this.auditFile, true, row => {
        const { digest, ...fact } = row
        if (fact.sequence !== this.auditSequence + 1 || fact.previous !== this.auditHash || digest !== hash(fact)) throw Error('SERVICE_AUDIT_CORRUPT')
        this.auditSequence = fact.sequence; this.auditHash = digest
      })
      for (const row of Object.values(this.data.calls)) if (['prepared', 'running'].includes(row.status)) row.status = 'uncertain'
      for (const row of Object.values(this.data.receipts)) if (row.status === 'running') row.status = 'interrupted'
      this.save()
    } catch (error) { this.close(); throw error }
  }
  save() {
    if (this.failed) throw Error('SERVICE_STORAGE_FAILED')
    let fd
    try {
      fd = fs.openSync(this.file + '.tmp', 'w', 0o600)
      fs.writeFileSync(fd, JSON.stringify(this.data)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined
      fs.renameSync(this.file + '.tmp', this.file)
    } catch (error) { this.failed = true; if (fd !== undefined) fs.closeSync(fd); throw error }
  }
  audit(action, metadata) {
    const fact = { version: 1, sequence: this.auditSequence + 1, previous: this.auditHash, at: Date.now(), action, ...metadata }
    const digest = hash(fact)
    this.append(this.auditFile, { ...fact, digest })
    this.auditSequence = fact.sequence; this.auditHash = digest
  }
  append(file, value) {
    if (this.failed) throw Error('SERVICE_STORAGE_FAILED')
    let fd
    try { fd = fs.openSync(file, 'a', 0o600); fs.writeFileSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd) }
    catch (error) { this.failed = true; throw error } finally { if (fd !== undefined) fs.closeSync(fd) }
  }
  event(sessionId, event) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(sessionId)) throw Error('SERVICE_SESSION_INVALID')
    let buffer = this.eventBuffers.get(sessionId)
    if (!buffer) { buffer = { sequence: 0, bytes: 0, rows: [] }; this.eventBuffers.set(sessionId, buffer) }
    const row = { sequence: ++buffer.sequence, event }
    const bytes = Buffer.byteLength(JSON.stringify(row))
    buffer.rows.push({ row, bytes }); buffer.bytes += bytes
    while (buffer.rows.length > 500 || buffer.bytes > this.eventBufferMaxBytes) buffer.bytes -= buffer.rows.shift().bytes
    return row
  }
  events(sessionId, after) {
    const buffer = this.eventBuffers.get(sessionId)
    return buffer ? buffer.rows.filter(item => item.row.sequence > after).map(item => item.row) : []
  }
  eventGap(sessionId, after, epoch) {
    const buffer = this.eventBuffers.get(sessionId)
    return Boolean((epoch && epoch !== this.epoch) || (buffer && buffer.rows.length && after < buffer.rows[0].row.sequence - 1) || (buffer && !buffer.rows.length && after < buffer.sequence) || (buffer && after > buffer.sequence) || (!buffer && after > 0))
  }
  close() {
    if (this.lockFd !== undefined) { fs.closeSync(this.lockFd); this.lockFd = undefined; fs.unlinkSync(this.lock) }
  }
}
module.exports = { ServiceRepository, hash }
