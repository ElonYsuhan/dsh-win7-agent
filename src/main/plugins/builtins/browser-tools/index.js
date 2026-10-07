'use strict'

const {
  agentDriver,
  browserWorking,
  browserAct,
  runTestCases
} = require('../../../agent/tools')

const definitions = require('../../../agent/tools').toolDefinitions
  .filter((item) => ['browser_launch', 'browser_act', 'browser_eval', 'browser_close', 'test_run'].includes(item.function.name))

module.exports = {
  name: 'builtin/browser-tools',
  version: '0.1.0',
  description: 'Persistent browser automation and end-to-end test tools.',
  apply(ctx) {
    for (const definition of definitions) {
      const name = definition.function.name
      ctx.registerTool({
        name,
        permission: 'command',
        description: definition.function.description,
        parameters: definition.function.parameters,
        execute: async (args, toolCtx) => {
          const input = args && typeof args === 'object' ? args : {}
          if (name === 'browser_launch') {
            const result = await agentDriver(toolCtx).launch(input.url, {
              width: input.width,
              height: input.height,
              noSandbox: process.env.SMOKE_NO_SANDBOX === '1'
            })
            return JSON.stringify(Object.assign({ url: input.url }, result))
          }
          if (name === 'browser_close') {
            /* 收尾：关掉自己起的验证窗口（进程 + 临时 profile 一起收）。没开也当成功。 */
            await agentDriver(toolCtx).close()
            return 'browser closed'
          }
          if (name === 'browser_act') return browserAct(toolCtx.workspaceRoot, input, toolCtx)
          if (name === 'browser_eval') {
            const value = await browserWorking(toolCtx).evaluate(String(input.expression), { awaitPromise: input.awaitPromise === true })
            return value === undefined ? '(undefined)' : (typeof value === 'string' ? value : JSON.stringify(value, null, 1))
          }
          return runTestCases(toolCtx.workspaceRoot, input, toolCtx)
        }
      })
    }
  }
}
