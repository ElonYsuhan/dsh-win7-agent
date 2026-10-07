const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')
const policy = require('../src/main/agent/permission-policy')
const not = (value) => value ? false : true

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-perm-'))
  const host = new PluginHost({ workspaceRoot: root, settings: { data: {} } })
  host.loadBuiltins()
  host.use({
    name: 'fake-command-plugin',
    apply(ctx) {
      ctx.registerTool({
        name: 'fake_command',
        permission: 'command',
        description: 'test double for command tools (never really runs anything)',
        parameters: { type: 'object', properties: { command: { type: 'string' } } },
        execute: async () => 'fake-command-ok'
      })
    }
  })
  let approveCalls = []
  const approve = async (request) => { approveCalls.push(request); return true }
  const baseCtx = (mode) => ({ workspaceRoot: root, settings: { permissionMode: mode }, signal: null, approve })

  /* ---- 决策函数单测（不执行任何命令，跨平台） ---- */
  const D = policy.decideToolPermission
  const cases = [
    ['readonly + read    ', D('read', 'readonly', {}), 'allow'],
    ['readonly + write   ', D('write', 'readonly', {}), 'deny'],
    ['readonly + edit    ', D('edit', 'readonly', {}), 'deny'],
    ['readonly + command ', D('command', 'readonly', {}), 'ask'],
    ['workspace + read   ', D('read', 'workspace', {}), 'allow'],
    ['workspace + write  ', D('write', 'workspace', {}), 'allow'],
    ['workspace + echo   ', D('command', 'workspace', { command: 'echo ok' }), 'allow'],
    ['workspace + npm i  ', D('command', 'workspace', { command: 'npm install' }), 'allow'],
    ['workspace + git st ', D('command', 'workspace', { command: 'git status' }), 'allow'],
    ['workspace + rm -rf ', D('command', 'workspace', { command: 'rm -rf node_modules' }), 'ask'],
    ['workspace + force  ', D('command', 'workspace', { command: 'git push --force' }), 'ask'],
    ['workspace + del /s ', D('command', 'workspace', { command: 'del /s /q build' }), 'ask'],
    ['full + write       ', D('write', 'full', {}), 'allow'],
    ['full + echo        ', D('command', 'full', { command: 'echo ok' }), 'allow'],
    ['full + rm -rf      ', D('command', 'full', { command: 'rm -rf x' }), 'ask']
  ]
  let failed = 0
  for (const [name, got, want] of cases) {
    const pass = got === want
    if (not(pass)) failed++
    console.log((pass ? 'PASS  ' : 'FAIL  ') + name + ' -> ' + got + (pass ? '' : ' (want ' + want + ')'))
  }

  /* ---- 真实插件宿主集成 ---- */
  const roWrite = await host.executeTool('write_file', { path: 'a.txt', content: 'x' }, baseCtx('readonly'))
  console.log('readonly write_file   :', roWrite)
  if (roWrite.indexOf('DENIED') === -1) throw new Error('readonly must deny write_file')
  if (fs.existsSync(path.join(root, 'a.txt'))) throw new Error('readonly must not touch the disk')

  const roEdit = await host.executeTool('edit_file', { path: 'a.txt', oldText: 'a', newText: 'b' }, baseCtx('readonly'))
  console.log('readonly edit_file    :', roEdit)
  if (roEdit.indexOf('DENIED') === -1) throw new Error('readonly must deny edit_file')

  const roRead = await host.executeTool('list_dir', { path: '.' }, baseCtx('readonly'))
  console.log('readonly list_dir     : allow (len=' + String(roRead).length + ')')
  if (String(roRead).indexOf('DENIED') !== -1) throw new Error('readonly must allow read tools')

  approveCalls = []
  const roCmd = await host.executeTool('fake_command', { command: 'echo hi' }, baseCtx('readonly'))
  console.log('readonly command      :', roCmd, '| approveCalls=' + approveCalls.length)
  if (roCmd.indexOf('DENIED') !== -1) throw new Error('readonly must ask (not deny) for commands')
  if (approveCalls.length !== 1) throw new Error('readonly command must ask exactly once')
  if (approveCalls[0].kind !== 'command') throw new Error('approval request must carry kind=command')

  approveCalls = []
  const wsWrite = await host.executeTool('write_file', { path: 'a.txt', content: 'y' }, baseCtx('workspace'))
  console.log('workspace write_file  :', String(wsWrite).slice(0, 24) + '...', '| approveCalls=' + approveCalls.length)
  if (fs.readFileSync(path.join(root, 'a.txt'), 'utf8') !== 'y') throw new Error('workspace write must succeed')
  if (approveCalls.length !== 0) throw new Error('workspace write must not ask')

  approveCalls = []
  await host.executeTool('fake_command', { command: 'echo ok' }, baseCtx('workspace'))
  console.log('workspace normal cmd  : approveCalls=' + approveCalls.length)
  if (approveCalls.length !== 0) throw new Error('workspace normal command must not ask')

  approveCalls = []
  const wsDanger = await host.executeTool('fake_command', { command: 'rm -rf build' }, baseCtx('workspace'))
  console.log('workspace danger cmd  :', wsDanger, '| approveCalls=' + approveCalls.length)
  if (approveCalls.length !== 1) throw new Error('workspace dangerous command must ask once')
  if (approveCalls[0].signature !== 'command:rm') throw new Error('dangerous approval must carry signature command:rm, got ' + approveCalls[0].signature)

  approveCalls = []
  await host.executeTool('fake_command', { command: 'echo ok' }, baseCtx('full'))
  console.log('full normal cmd       : approveCalls=' + approveCalls.length)
  if (approveCalls.length !== 0) throw new Error('full normal command must not ask')

  approveCalls = []
  await host.executeTool('fake_command', { command: 'git push --force' }, baseCtx('full'))
  console.log('full danger cmd       : approveCalls=' + approveCalls.length)
  if (approveCalls.length !== 1) throw new Error('full dangerous command must ask once')

  const denyCtx = { workspaceRoot: root, settings: { permissionMode: 'readonly' }, signal: null, approve: async () => false }
  const refused = await host.executeTool('fake_command', { command: 'echo hi' }, denyCtx)
  console.log('readonly 拒绝后        :', refused)
  if (refused.indexOf('DENIED') === -1) throw new Error('deny must produce DENIED')

  fs.rmSync(root, { recursive: true, force: true })
  if (failed > 0) throw new Error(failed + ' decision case(s) failed')
  console.log('')
  console.log('permission test passed')
}
main().catch((error) => { console.error(error); process.exitCode = 1 })
