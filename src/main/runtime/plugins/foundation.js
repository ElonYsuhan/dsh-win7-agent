'use strict'

const { ToolRegistry } = require('../../plugins/tool-registry')

function foundation(options) {
  return [
    { name: 'core/contracts', apply(ctx) { ctx.provide('contracts', require('../../contracts')) } },
    { name: 'core/state', inject: ['contracts'], apply(ctx) { ctx.provide('state', require('../../state/session-state')) } },
    { name: 'core/flow', inject: ['contracts'], apply(ctx) { ctx.provide('flow', require('../../flow/turn-flow')) } },
    { name: 'core/config', apply(ctx) { ctx.provide('agentConfig', options) } },
    { name: 'core/permissions', apply(ctx) { ctx.provide('permissions', require('../../agent/permission-policy')) } },
    {
      name: 'core/tools', inject: ['permissions', 'contracts'],
      apply(ctx) { ctx.provide('tools', new ToolRegistry(ctx.permissions, ctx.contracts)) }
    },
    {
      name: 'core/prompts',
      apply(ctx) {
        const sections = new Set()
        ctx.provide('prompts', {
          add(resolver) { sections.add(resolver); return () => sections.delete(resolver) },
          async build(base, context) {
            const parts = base ? [String(base)] : []
            for (const resolver of sections) {
              const value = await resolver(context)
              if (value) parts.push(String(value))
            }
            return parts.join('\n')
          }
        })
      }
    },
    { name: 'core/context', apply(ctx) { ctx.provide('context', require('../../agent/context-compressor')) } },
    {
      name: 'core/skills',
      apply(ctx) {
        const { SkillHost } = require('../../agent/skills')
        ctx.provide('skills', new SkillHost().loadAll())
      }
    }
  ]
}
module.exports = { foundation }
