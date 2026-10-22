'use strict'

const fs = require('fs')

// The IO adapter visits one committed fact at a time. Domain validation and
// sequence/state rules remain in the caller's contracts and pure reducer.
function visitJsonLines(file, repair, visit) {
  const fd = fs.openSync(file, repair ? 'r+' : 'r')
  const chunk = Buffer.allocUnsafe(64 * 1024)
  let pending = [], position = 0, committed = 0
  try {
    let length
    while ((length = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      let start = 0
      for (let index = 0; index < length; index++) {
        if (chunk[index] !== 10) continue
        const part = chunk.subarray(start, index)
        const line = (pending.length ? Buffer.concat(pending.concat([part])) : part).toString('utf8')
        pending = []
        committed = position + index + 1
        start = index + 1
        if (line) visit(JSON.parse(line))
      }
      if (start < length) pending.push(Buffer.from(chunk.subarray(start, length)))
      position += length
    }
    // Corrupt committed records throw before any repair. Only the final line
    // without a commit newline can be removed after a successful replay.
    if (repair && committed !== position) fs.ftruncateSync(fd, committed)
  } finally { fs.closeSync(fd) }
}
module.exports = { visitJsonLines }
