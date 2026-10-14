'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

// Identify the UI actually served, including same-version development builds.
function uiBuild(rendererDir) {
  const hash = crypto.createHash('sha256')
  function visit(dir, prefix) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const relative = prefix + name
      if (fs.statSync(file).isDirectory()) visit(file, relative + '/')
      else if (/\.(?:js|css|html)$/.test(name)) {
        hash.update(relative + '\0')
        hash.update(fs.readFileSync(file))
      }
    }
  }
  visit(rendererDir, '')
  return hash.digest('hex')
}

module.exports = { uiBuild }
