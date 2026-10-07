'use strict'

const { searchFiles } = require('../../../agent/tools')

module.exports = {
  name: 'builtin/search-tools',
  version: '0.1.0',
  description: 'Workspace text search tools.',
  apply(ctx) {
    ctx.registerTool({
      name: 'search_files',
      permission: 'read',
      description: 'Search text in workspace files. Skips .git, node_modules and common build directories.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Literal text to search.' },
          path: { type: 'string', description: 'Workspace-relative directory. Default is .' },
          maxResults: { type: 'number', description: 'Maximum matches. Default is 50.' }
        },
        required: ['query']
      },
      execute: async (args, toolCtx) => {
        return searchFiles(toolCtx.workspaceRoot, args.path || '.', args.query, args.maxResults || 50)
      }
    })
  }
}
