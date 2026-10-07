'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const not = (value) => value ? false : true
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const ID_RE = /^[a-f0-9]{64}$/
const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json'
}

function parseDataUrl(value) {
  const text = String(value || '')
  const match = /^data:([^;,]*)?(;base64)?,([\s\S]*)$/.exec(text)
  if (not(match)) return null
  const mime = match[1] || 'application/octet-stream'
  const isBase64 = Boolean(match[2])
  let buffer = null
  try {
    buffer = isBase64 ? Buffer.from(match[3], 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
  } catch (error) {
    return null
  }
  return { mime, buffer }
}

function safeName(value) {
  return String(value || '').replace(/[^\w.\-() \u4e00-\u9fa5]/g, '_').slice(0, 120)
}

class AssetStore {
  constructor(directory, options) {
    this.dir = path.resolve(String(directory || 'assets'))
    this.maxBytes = Math.max(1024, Number(options && options.maxBytes) || DEFAULT_MAX_BYTES)
    fs.mkdirSync(this.dir, { recursive: true })
  }

  pathFor(id) {
    const value = String(id || '').toLowerCase()
    if (not(ID_RE.test(value))) throw new Error('ASSET_ID_INVALID')
    return path.join(this.dir, value)
  }

  metaPathFor(id) {
    return this.pathFor(id) + '.json'
  }

  readMeta(id) {
    try {
      return JSON.parse(fs.readFileSync(this.metaPathFor(id), 'utf8'))
    } catch (error) {
      return {}
    }
  }

  saveBuffer(buffer, meta) {
    if (not(Buffer.isBuffer(buffer)) || buffer.length === 0) throw new Error('ASSET_EMPTY')
    if (buffer.length > this.maxBytes) throw new Error('ASSET_TOO_LARGE')
    const id = crypto.createHash('sha256').update(buffer).digest('hex')
    const file = this.pathFor(id)
    if (not(fs.existsSync(file))) fs.writeFileSync(file, buffer)
    const info = {
      id,
      mime: (meta && meta.mime) || 'application/octet-stream',
      name: safeName(meta && meta.name),
      size: buffer.length,
      createdAt: new Date().toISOString()
    }
    const existing = this.readMeta(id)
    if (not(fs.existsSync(this.metaPathFor(id))) || not(existing.id)) {
      fs.writeFileSync(this.metaPathFor(id), JSON.stringify(info, null, 2), 'utf8')
    }
    const result = Object.assign({}, info, existing, { id })
    const sessionDir = meta && meta.sessionDir ? path.resolve(String(meta.sessionDir)) : ''
    if (sessionDir) {
      const filesDir = path.join(sessionDir, 'files')
      fs.mkdirSync(filesDir, { recursive: true })
      const ext = this.extForMime(result.mime)
      const requested = safeName(result.name)
      const base = requested || ('image-' + id.slice(0, 12) + '.' + ext)
      const named = path.extname(base) ? base : (base + '.' + ext)
      const sessionPath = path.join(filesDir, id.slice(0, 12) + '-' + named)
      if (not(fs.existsSync(sessionPath))) fs.copyFileSync(file, sessionPath)
      result.sessionPath = sessionPath
    }
    return result
  }

  saveDataUrl(dataUrl, meta) {
    const parsed = parseDataUrl(dataUrl)
    if (not(parsed)) throw new Error('ASSET_BAD_DATA_URL')
    const mime = (meta && meta.mime) || parsed.mime
    return this.saveBuffer(parsed.buffer, Object.assign({}, meta || {}, { mime }))
  }

  has(id) {
    try {
      return fs.existsSync(this.pathFor(id))
    } catch (error) {
      return false
    }
  }

  get(id) {
    const file = this.pathFor(id)
    if (not(fs.existsSync(file))) throw new Error('ASSET_NOT_FOUND')
    const meta = this.readMeta(id)
    return {
      id: String(id).toLowerCase(),
      mime: meta.mime || 'application/octet-stream',
      name: meta.name || '',
      size: meta.size || 0,
      createdAt: meta.createdAt || '',
      buffer: fs.readFileSync(file)
    }
  }

  readDataUrl(id) {
    const asset = this.get(id)
    return 'data:' + asset.mime + ';base64,' + asset.buffer.toString('base64')
  }

  gc(referencedIds) {
    const keep = new Set()
    for (const id of (Array.isArray(referencedIds) ? referencedIds : [])) {
      const value = String(id || '').toLowerCase()
      if (ID_RE.test(value)) keep.add(value)
    }
    let removed = 0
    for (const entry of fs.readdirSync(this.dir)) {
      if (entry.endsWith('.json')) continue
      if (not(ID_RE.test(entry))) continue
      if (keep.has(entry)) continue
      try {
        fs.rmSync(path.join(this.dir, entry), { force: true })
        fs.rmSync(path.join(this.dir, entry + '.json'), { force: true })
        removed += 1
      } catch (error) {
        // ignore
      }
    }
    return removed
  }

  extForMime(mime) {
    return EXT_BY_MIME[String(mime || '').toLowerCase()] || 'bin'
  }
}

module.exports = { AssetStore, parseDataUrl, ID_RE }
