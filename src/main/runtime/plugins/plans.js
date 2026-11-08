'use strict'

// Plan updates are ordinary tool-result facts in the session journal. This plugin
// holds no conversation state and cannot change the Agent's execution policy.
module.exports = {
  name: 'core/plans', inject: ['tools', 'prompts'],
  apply(ctx) {
    ctx.effect(() => ctx.tools.register({
      name: 'update_plan', plugin: 'core/plans', permission: 'read',
      description: 'Publish a short task plan and update its progress. Report only actual progress. This tool does not execute any step.',
      parameters: {
        type: 'object', properties: {
          steps: { type: 'array', items: { type: 'object', properties: {
            title: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'blocked'] }
          }, required: ['title', 'status'], additionalProperties: false } }
        }, required: ['steps'], additionalProperties: false
      },
      execute: async (args) => {
        if (!args.steps.length || args.steps.length > 12) throw new Error('PLAN_STEPS_LIMIT: expected 1 to 12 steps')
        if (args.steps.some((step) => !step.title.trim() || step.title.length > 200)) throw new Error('PLAN_TITLE_INVALID')
        if (args.steps.filter((step) => step.status === 'in_progress').length > 1) throw new Error('PLAN_MULTIPLE_ACTIVE_STEPS')
        return '[agent-plan:v1]' + JSON.stringify({ steps: args.steps })
      }
    }))
    ctx.effect(() => ctx.prompts.add(() => 'For multi-step tasks, publish a concise plan using update_plan and update it after verified progress. Do not invent completion. For coding tasks: inspect the relevant files and constraints, make the smallest end-to-end change, then run the nearest meaningful check. If a check fails, use its actual error to revise the change; do not repeat unrelated checks or mark verification complete before evidence exists. Keep the user informed with brief progress summaries, actual tool results and blockers, not private chain-of-thought or invented reasoning. Finish with the change, verification evidence and any unverified limits. Simple questions need no plan. If recommending a workflow, wait for the user to start it; a recommendation is not execution. Diagram replies can use fenced SVG or flowchart Mermaid; complex unsupported diagram syntax remains available as source.'))
  }
}
