'use strict'

// Bounded ZIP32 OOXML container. Never extracts paths to disk. Rejects encrypted,
// multipart and ZIP64 archives rather than silently producing damaged documents.
const zlib = require('zlib')
const LIMIT = 32 * 1024 * 1024
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 })
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0 }
function readZip(buf) {
  if (buf.length > LIMIT || buf.length < 22) throw new Error('DOCUMENT_SIZE_LIMIT_OR_INVALID_ZIP')
  let end = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50 && i + 22 + buf.readUInt16LE(i + 20) === buf.length) { end = i; break }
  if (end < 0) throw new Error('INVALID_ZIP_DIRECTORY')
  const count = buf.readUInt16LE(end + 10), size = buf.readUInt32LE(end + 12), offset = buf.readUInt32LE(end + 16)
  if (buf.readUInt16LE(end + 4) || buf.readUInt16LE(end + 6) || count !== buf.readUInt16LE(end + 8) || count > 2048 || count === 65535 || offset + size !== end) throw new Error('UNSUPPORTED_ZIP_LAYOUT')
  const files = new Map(); let cursor = offset, total = 0
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || buf.readUInt32LE(cursor) !== 0x02014b50) throw new Error('INVALID_ZIP_ENTRY')
    const flags = buf.readUInt16LE(cursor + 8), method = buf.readUInt16LE(cursor + 10), crc = buf.readUInt32LE(cursor + 16), compressed = buf.readUInt32LE(cursor + 20), expanded = buf.readUInt32LE(cursor + 24), names = buf.readUInt16LE(cursor + 28), extra = buf.readUInt16LE(cursor + 30), comment = buf.readUInt16LE(cursor + 32), local = buf.readUInt32LE(cursor + 42)
    total += expanded
    if (flags & 1 || ![0, 8].includes(method) || expanded > LIMIT || total > LIMIT || cursor + 46 + names + extra + comment > end || local + 30 > offset || buf.readUInt32LE(local) !== 0x04034b50) throw new Error('UNSUPPORTED_OR_OVERSIZED_ZIP_ENTRY')
    const name = buf.subarray(cursor + 46, cursor + 46 + names).toString('utf8')
    if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').includes('..') || files.has(name)) throw new Error('INVALID_ZIP_NAME')
    if (buf.readUInt16LE(local + 8) !== method || buf.readUInt16LE(local + 6) & 1) throw new Error('ZIP_HEADER_MISMATCH')
    const localNames = buf.readUInt16LE(local + 26), start = local + 30 + localNames + buf.readUInt16LE(local + 28)
    if (buf.subarray(local + 30, local + 30 + localNames).toString('utf8') !== name || start + compressed > offset) throw new Error('INVALID_ZIP_DATA')
    const data = method === 0 ? Buffer.from(buf.subarray(start, start + compressed)) : zlib.inflateRawSync(buf.subarray(start, start + compressed), { maxOutputLength: LIMIT })
    if (data.length !== expanded || crc32(data) !== crc) throw new Error('ZIP_CRC_MISMATCH')
    files.set(name, data); cursor += 46 + names + extra + comment
  }
  if (cursor !== end) throw new Error('INVALID_ZIP_DIRECTORY_SIZE')
  return files
}
function writeZip(files) {
  const local = [], central = []; let offset = 0, total = 0
  for (const [name, value] of files) {
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value), n = Buffer.from(name), packed = zlib.deflateRawSync(data), crc = crc32(data)
    total += data.length; if (total > LIMIT || files.size > 2048) throw new Error('DOCUMENT_SIZE_LIMIT')
    const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt16LE(8, 8); h.writeUInt16LE(33, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(packed.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x800, 8); c.writeUInt16LE(8, 10); c.writeUInt16LE(33, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(packed.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    local.push(h, n, packed); central.push(c, n); offset += h.length + n.length + packed.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  const result = Buffer.concat([...local, directory, end]); if (result.length > LIMIT) throw new Error('DOCUMENT_SIZE_LIMIT'); return result
}
module.exports = { readZip, writeZip, LIMIT }
