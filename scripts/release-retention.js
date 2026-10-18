'use strict'

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')
const pattern = /^Agent-(win-x64|mac-arm64|mac-x64|linux-x64|linux-arm64)-(\d+\.\d+\.\d+)(\.zip)?$/
function compare(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}
function plan(entries, nativeTarget, activePaths) {
  const parsed = entries.map((name) => ({ name, match: pattern.exec(name) })).filter((item) => item.match)
  const latest = {}
  for (const item of parsed) {
    const [, target, version, zip] = item.match
    if (zip && (!latest[target] || compare(version, latest[target]) > 0)) latest[target] = version
  }
  return parsed.filter((item) => {
    const [, target, version, zip] = item.match
    if (!latest[target]) return false // 未成功归档的平台不清理。
    if (zip) return version !== latest[target]
    if (compare(version, latest[target]) > 0) return false // 保留尚未归档的新构建。
    if (activePaths === null || activePaths.some((name) => name === item.name)) return false
    return !(target === nativeTarget && version === latest[target])
  }).map((item) => item.name)
}
function prune(directory, options) {
  const settings = options || {}
  const nativeTarget = process.platform === 'darwin' ? 'mac-' + process.arch : null
  const entries = fs.readdirSync(directory)
  let activePaths = null
  if (process.platform !== 'win32') {
    try {
      const processes = execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8' })
      activePaths = entries.filter((name) => processes.includes(path.join(directory, name) + path.sep))
    } catch (error) { /* 无法识别活动进程时不删除任何解压目录。 */ }
  }
  const victims = plan(entries, nativeTarget, activePaths)
  for (const name of victims) {
    if (!settings.dryRun) fs.rmSync(path.join(directory, name), { recursive: true, force: true })
    console.log((settings.dryRun ? 'would remove ' : 'removed ') + name)
  }
  if (!settings.dryRun) {
    const packages = fs.readdirSync(directory).filter((name) => pattern.test(name) && name.endsWith('.zip')).sort()
    // 保留文件统一使用一份校验清单，避免历史清单继续累积。
    const sums = packages.map((name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') + '  ' + name + '\n').join('')
    fs.writeFileSync(path.join(directory, 'SHA256SUMS.txt'), sums)
    for (const name of fs.readdirSync(directory)) if (/^SHA256SUMS-\d+\.\d+\.\d+\.txt$/.test(name)) fs.unlinkSync(path.join(directory, name))
  }
  return victims
}
module.exports = { plan, prune }
