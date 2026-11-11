'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), net = require('net'), { spawn } = require('child_process')
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hesyn-launcher-smoke-'))
function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)) }) }) }
async function main() {
  const servicePort = await freePort(), bridgePort = await freePort()
  const child = spawn(process.execPath, ['service/hesyn-development.js'], { cwd: path.resolve(__dirname, '..'), env: { ...process.env, HESYN_AGENT_HOME: home, HESYN_SERVICE_PORT: String(servicePort), HESYN_BRIDGE_PORT: String(bridgePort) }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('LAUNCH_TIMEOUT: ' + output)), 15000)
      child.once('exit', code => { clearTimeout(timer); reject(Error('LAUNCH_FAILED_' + code + ': ' + output)) })
      child.stdout.on('data', () => { if (output.includes('HESYN local Agent Service:')) { clearTimeout(timer); resolve() } })
    })
    const response = await new Promise((resolve, reject) => { http.get('http://127.0.0.1:' + servicePort + '/panel/1.0.8/manifest.json', resolve).on('error', reject) })
    assert.equal(response.statusCode, 200); assert.match(response.headers['content-type'], /application\/json/); response.resume()
    assert(!output.includes('Bearer '))
    console.log('HESYN isolated launcher and panel manifest passed')
  } finally {
    if (child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)) }
    fs.rmSync(home, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
