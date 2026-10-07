'use strict'

module.exports = {
  name: 'example/hello-tool',
  version: '0.1.0',
  description: 'Example user plugin for the local Win7 Agent.',
  apply(ctx) {
    ctx.registerTool({
      name: 'hello_world',
      description: 'Return a greeting from the example plugin.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Optional name.' }
        }
      },
      execute: async (args) => {
        const name = args.name || 'Win7'
        return 'Hello ' + name + ' from example/hello-tool plugin'
      }
    })
    ctx.addSystemPrompt(() => 'The hello_world tool is provided by an example plugin.')
  }
}
