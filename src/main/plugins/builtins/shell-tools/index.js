'use strict'

const { runCommand } = require('../../../agent/tools')

const not = (value) => value ? false : true

module.exports = {
  name: 'builtin/shell-tools',
  version: '0.1.0',
  description: 'Local command execution tools.',
  apply(ctx) {
    ctx.registerTool({
      name: 'run_command',
      permission: 'command',
      description: 'Run a local shell command in the workspace. On Windows uses cmd.exe. Requires approval by default.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Command line to run.' },
          cwd: { type: 'string', description: 'Workspace-relative working directory. Default is .' },
          timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Default 60000.' }
        },
        required: ['command']
      },
      execute: async (args, toolCtx) => {
        // 拦截与审批统一由 tool-registry 决定：readonly 询问、workspace/full 仅危险命令询问
        return runCommand(toolCtx.workspaceRoot, args.command, args.cwd, args.timeoutMs, toolCtx)
      }
    })
  }
}
