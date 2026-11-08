'use strict'

const { CapabilityRegistry } = require('../../capability/registry')
module.exports = {
  name: 'core/capability-registry',
  inject: ['tools', 'skillLibrary', 'workflows', 'mcp', 'extensions', 'prompts'],
  apply(ctx) {
    const service = new CapabilityRegistry(ctx)
    ctx.provide('capabilities', service)
    ctx.effect(() => ctx.tools.register({
      name: 'capability_search', plugin: 'core/capability-registry', permission: 'read',
      description: 'Search the live capability directory (workflows, skills, MCP tools, plugins and tools) before building a new capability. Results are read-only suggestions.',
      parameters: { type: 'object', properties: { intent: { type: 'string' }, types: { type: 'array', items: { type: 'string' } }, limit: { type: 'integer' } }, required: ['intent'], additionalProperties: false },
      execute: args => JSON.stringify(service.search(String(args.intent || ''), { types: args.types, limit: args.limit }))
    }))
    ctx.effect(() => ctx.tools.register({
      name: 'capability_inspect', plugin: 'core/capability-registry', permission: 'read',
      description: 'Inspect one live capability by the ID returned from capability_search.',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
      execute: args => JSON.stringify(service.inspect(String(args.id || '')))
    }))
    ctx.effect(() => ctx.prompts.add(() => 'A live capability directory is available through capability_search. Before inventing a new tool, workflow or skill, check whether a saved workflow, enabled skill, MCP tool or plugin already covers the task. A match is a suggestion; installation, permission changes and execution still require the user and existing approval policy.'))
  }
}
