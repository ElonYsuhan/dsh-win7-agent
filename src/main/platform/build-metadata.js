'use strict'

// Immutable packaging metadata is a build identifier, not a publisher signature.
const fs = require('fs')
const path = require('path')
const NAME = 'desktop-build.json'
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function read(appDirectory) {
  try {
    const file = path.join(appDirectory, NAME), stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > 8192) return null
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (value.formatVersion !== 1 || !hash(value.packageBuildId) || !hash(value.uiBuild) ||
      value.electron !== '22.3.27' || value.node !== '16.17.1' || value.chromium !== '108' ||
      !['win-x64', 'mac-arm64', 'mac-x64', 'linux-x64', 'linux-arm64'].includes(value.target)) return null
    return value
  } catch (error) { return null }
}
module.exports = { NAME, read }
