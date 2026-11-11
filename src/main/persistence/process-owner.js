'use strict'

const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

// PID existence alone is not ownership: Windows can reuse it for an unrelated app.
// Unknown identity is deliberately treated as occupied, never as permission to steal.
function identity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw Error('INVALID_OWNER_PID')
  if (process.platform === 'win32') {
    const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command',
      `$p = Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if ($p -and $p.ExecutablePath -and $p.CreationDate) { @{ executable = $p.ExecutablePath; started = $p.CreationDate.ToUniversalTime().Ticks.ToString() } | ConvertTo-Json -Compress }`],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 })
    if (result.error || result.status !== 0 || !result.stdout.trim()) return null
    return JSON.parse(result.stdout.trim())
  }
  if (process.platform === 'linux') {
    const stat = fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
    return { executable: fs.readlinkSync('/proc/' + pid + '/exe'), started: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] }
  }
  return null
}
let ownIdentity
function record() {
  if (ownIdentity === undefined) ownIdentity = identity(process.pid)
  return { pid: process.pid, ...(ownIdentity ? { processIdentity: ownIdentity } : {}) }
}
function alive(owner) {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw Error('INVALID_OWNER_PID')
  try { process.kill(owner.pid, 0) } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
  const current = identity(owner.pid)
  if (!current) return true
  if (owner.processIdentity) return current.started === owner.processIdentity.started && current.executable === owner.processIdentity.executable
  // Legacy PID-only locks: reclaim only when the executable is provably not this
  // Node/Electron runtime. Preserve locks for another live Agent, including desktop.
  const name = path.basename(current.executable).toLowerCase()
  // WebView is a renderer, never the Node/Electron main process owning a store.
  return name !== 'msedgewebview2.exe'
}
module.exports = { record, alive }
