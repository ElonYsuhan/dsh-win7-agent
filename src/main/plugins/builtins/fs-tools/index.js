'use strict'

const {
  listDirectory,
  readTextFile,
  lineNumbered,
  writeFile,
  editFile
} = require('../../../agent/tools')

const not = (value) => value ? false : true

module.exports = {
  name: 'builtin/fs-tools',
  version: '0.1.0',
  description: 'Local workspace file tools.',
  apply(ctx) {
    ctx.registerTool({
      name: 'list_dir',
      permission: 'read',
      description: 'List files and directories under a workspace-relative path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative path. Default is .' },
          depth: { type: 'number', description: 'Recursion depth, 1 to 3. Default is 1.' }
        }
      },
      execute: async (args, toolCtx) => {
        return listDirectory(toolCtx.workspaceRoot, args.path || '.', args.depth || 1)
      }
    })

    ctx.registerTool({
      name: 'read_file',
      permission: 'read',
      description: 'Read a UTF-8 text file from the workspace. Returns line-numbered content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          startLine: { type: 'number', description: 'Optional 1-based start line.' },
          endLine: { type: 'number', description: 'Optional 1-based end line.' }
        },
        required: ['path']
      },
      execute: async (args, toolCtx) => {
        const { text } = await readTextFile(toolCtx.workspaceRoot, args.path || '.')
        const lines = text.split(/\r?\n/)
        const start = Math.max(1, Number(args.startLine) || 1)
        const end = Math.min(lines.length, Number(args.endLine) || lines.length)
        const slice = lines.slice(start - 1, end).join('\n')
        return 'file=' + (args.path || '.') + ' lines=' + start + '-' + end + ' of ' + lines.length + '\n' + lineNumbered(slice)
      }
    })

    ctx.registerTool({
      name: 'write_file',
      permission: 'write',
      description: 'Create or overwrite a UTF-8 text file in the workspace atomically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          content: { type: 'string', description: 'Full file content.' }
        },
        required: ['path', 'content']
      },
      execute: async (args, toolCtx) => {
        // 审批/拒绝统一由 tool-registry 按权限档位决定，这里不再重复判断
        return writeFile(toolCtx.workspaceRoot, args.path, args.content)
      }
    })

    ctx.registerTool({
      name: 'edit_file',
      permission: 'write',
      description: 'Replace exact text in a workspace file. Requires exactly one match unless replaceAll is true.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Workspace-relative file path.' },
          oldText: { type: 'string', description: 'Exact text to replace.' },
          newText: { type: 'string', description: 'Replacement text.' },
          replaceAll: { type: 'boolean', description: 'Replace every match. Default false.' }
        },
        required: ['path', 'oldText', 'newText']
      },
      execute: async (args, toolCtx) => {
        return editFile(toolCtx.workspaceRoot, args.path, args.oldText, args.newText, args.replaceAll === true)
      }
    })
  }
}
