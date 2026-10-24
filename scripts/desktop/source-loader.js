'use strict'
// Build template. The key is replaced in the staging tree only. An offline
// client necessarily carries decryption capability; this is not a trust boundary.
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const key = Buffer.from('__AGENT_SOURCE_KEY__', 'base64')
const magic = Buffer.from('AGENTP1\0')
exports.load = function load(mod, filename) {
  const relative = path.relative(__dirname, filename).split(path.sep).join('/')
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative) || mod.filename !== filename) throw Error('SOURCE_MODULE_PATH')
  const file = filename + '.agc', size = fs.statSync(file).size
  if (size < 36 || size > 8 * 1024 * 1024) throw Error('SOURCE_PAYLOAD_SIZE')
  const payload = fs.readFileSync(file)
  if (!payload.subarray(0, 8).equals(magic)) throw Error('SOURCE_PAYLOAD_FORMAT')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, payload.subarray(8, 20))
  decipher.setAAD(Buffer.from(relative))
  decipher.setAuthTag(payload.subarray(20, 36))
  // Authenticate completely before compiling any module code. No plaintext is
  // written to disk, and normal CommonJS caching owns the compiled module.
  const source = Buffer.concat([decipher.update(payload.subarray(36)), decipher.final()])
  try { mod._compile(source.toString('utf8'), filename) } finally { source.fill(0) }
}
