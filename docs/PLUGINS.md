# Agent Plugin System

The local Win7 Agent uses a lightweight plugin host inspired by dsh.

A plugin is a CommonJS module that exports an object:

```js
module.exports = {
  name: 'my-plugin',
  version: '0.1.0',
  description: 'My custom tools',
  apply(ctx) {
    ctx.registerTool({
      name: 'my_tool',
      description: 'Do something.',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string' }
        },
        required: ['input']
      },
      execute: async (args, toolCtx) => {
        return 'result: ' + args.input
      }
    })
  }
}
```

## Plugin locations

Built-in plugins live in:

```text
src/main/plugins/builtins/
```

User plugins are loaded from:

```text
Windows local agent: %APPDATA%/Agent/plugins
Server agent:        $AGENT_HOME/plugins
```

A user plugin can be a .js file or a directory containing package.json or index.js.

## Plugin context API

- ctx.registerTool(tool)
- ctx.provide(name, service)
- ctx.get(name)
- ctx.has(name)
- ctx.on(event, listener)
- ctx.emit(event, payload)
- ctx.hook(event, payload)
- ctx.addSystemPrompt(resolver)
- ctx.effect(disposer)
- ctx.logger.info / warn / error

## Tool contract

```js
{
  name: 'string',
  description: 'string',
  parameters: { type: 'object', properties: {} },
  execute: async (args, toolCtx) => 'string result'
}
```

The tool result is sent back to the model as text.

Optional field:

- permission: read | write | command (default write). In readonly permission mode, tools whose permission is not read are denied before execute.

## Tool context

The second argument to execute contains:

- workspaceRoot
- settings
- signal
- approve
- agent

Use toolCtx.approve before dangerous actions.

## Events

The Agent emits:

- agent:beforeRun
- agent:afterRun
- tool:before
- tool:after
- tool:error

A plugin can observe these with ctx.on(event, listener).

## Prompt extension

ctx.addSystemPrompt(async (toolCtx) => 'extra rules')

The returned text is appended to the system prompt.

## Services

A plugin can share a service:

```js
ctx.provide('gitService', service)
const service = ctx.get('gitService')
```

## Notes

Plugins run in the same process as the Agent. Treat plugin code as trusted.
For fully offline machines, ship plugin dependencies inside the plugin directory.
