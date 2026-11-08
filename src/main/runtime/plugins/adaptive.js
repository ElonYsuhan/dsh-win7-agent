'use strict'

const { AdaptiveService } = require('../../adaptive/service')
module.exports = {
  name: 'core/adaptive', inject: ['memoryStore', 'capabilities', 'tools', 'prompts'],
  apply(ctx) {
    const service = new AdaptiveService(ctx)
    ctx.provide('adaptive', service)
    ctx.effect(() => ctx.tools.register({
      name: 'adaptive_plan', plugin: 'core/adaptive', permission: 'read',
      description: 'Analyze a complex task using long-term memory and the live capability directory, then return a read-only plan. It never executes a workflow or installs anything.',
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      execute: async (args, toolCtx) => {
        const agent = toolCtx && toolCtx.agent
        return JSON.stringify(await service.plan({ task: String(args.task || ''), sessionId: agent && agent.sessionId, workspaceRoot: agent && agent.workspaceRoot }))
      }
    }))
    ctx.effect(() => ctx.tools.register({
      name: 'adaptive_recommend', plugin: 'core/adaptive', permission: 'read',
      description: 'Return user-reviewable recommendations for a task. Recommendations never install, authorize or execute a capability.',
      parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
      execute: async (args, toolCtx) => {
        const agent = toolCtx && toolCtx.agent
        return JSON.stringify(await service.recommend({ task: String(args.task || ''), sessionId: agent && agent.sessionId, workspaceRoot: agent && agent.workspaceRoot }))
      }
    }))
    ctx.effect(() => ctx.prompts.add(() => 'For multi-step work, consider adaptive_plan and adaptive_recommend before implementing. They are read-only: they cannot install, authorize or run a capability. Follow the normal permission and approval chain for any execution. Do not turn simple chat into a workflow.'))
  }
}
