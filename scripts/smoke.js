'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { executeTool } = require('../src/main/agent/tools')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-'))
  const ctx = {
    workspaceRoot: root,
    settings: { approveWrites: false, approveCommands: false },
    signal: null,
    approve: async () => true
  }
  console.log(await executeTool('write_file', { path: 'hello.txt', content: 'hello world\nsecond line\n' }, ctx))
  console.log(await executeTool('read_file', { path: 'hello.txt' }, ctx))
  console.log(await executeTool('list_dir', { path: '.', depth: 1 }, ctx))
  console.log(await executeTool('search_files', { query: 'second', path: '.' }, ctx))
  console.log(await executeTool('edit_file', { path: 'hello.txt', oldText: 'world', newText: 'win7' }, ctx))
  console.log(await executeTool('read_file', { path: 'hello.txt' }, ctx))
  fs.rmSync(root, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
