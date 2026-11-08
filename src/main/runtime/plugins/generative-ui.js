'use strict'

const UI = require('../../contracts/generative-ui')
const { EVENTS } = require('../../contracts')

module.exports = {
  name: 'core/generative-ui', inject: ['agentConfig', 'tools', 'prompts', 'sessions', 'licensing', 'agentLoop'],
  apply(ctx) {
    ctx.provide('generativeUi', require('../generative-ui-service').createGenerativeUiService(ctx))
    const testing = ctx.agentConfig.enableGenerativeUiProtocolForTests === true
    function renderer(agent) {
      if (agent && Object.prototype.hasOwnProperty.call(agent, 'rendererCapabilities')) return agent.rendererCapabilities
      return testing ? UI.capabilities() : null
    }
    const available = context => !(context.agent && context.agent.unattended) && !(context.settings && context.settings.unattended) && Boolean(renderer(context.agent)?.components.length)
    const parameters = {
      type: 'object', properties: {
        operation: { type: 'string', enum: ['create', 'update'], description: 'Use create for a new surface or update to replace an existing surface.' },
        expectedRevision: { type: 'integer', description: '0 for create; the current revision for update.' },
        surface: { type: 'object', description: 'Complete declarative Surface using only the negotiated renderer versions and components.' }
      }, required: ['operation', 'expectedRevision', 'surface'], additionalProperties: false
    }
    async function publish(args, context) {
      UI.assertSurface(args.surface)
      if (!context || !context.agent || typeof context.agent.record !== 'function' || typeof context.toolCallId !== 'string') throw new Error('GENERATIVE_UI_AGENT_CONTEXT_REQUIRED')
      if (context.signal && context.signal.aborted) throw new Error('ABORTED')
      const agent = context.agent
      UI.assertRenderable(args.surface, renderer(agent))
      agent.record(EVENTS.UI_SURFACE, { operation: args.operation, expectedRevision: args.expectedRevision, toolCallId: context.toolCallId, surface: args.surface })
      try { agent.emit({ type: 'ui:surface', toolCallId: context.toolCallId, surface: args.surface, ...(agent.sessionId ? { snapshot: require('../../contracts/generative-ui-interaction').snapshot(agent.state, agent.sessionId) } : {}) }) } catch (_) {}
      return JSON.stringify({ id: args.surface.id, revision: args.surface.revision, recorded: true, rendered: false })
    }
    ctx.effect(() => ctx.tools.register({
      name: 'render_ui', plugin: 'core/generative-ui', permission: 'read', parameters, available,
      description: 'Publish an interactive chart, form, table, progress view, flow diagram or offline map in the connected chat renderer. Use only its negotiated capabilities.',
      execute: publish
    }))
    ctx.effect(() => ctx.tools.register({
      name: 'update_ui', plugin: 'core/generative-ui', permission: 'read', available,
      parameters: { type: 'object', properties: { expectedRevision: parameters.properties.expectedRevision, surface: parameters.properties.surface }, required: ['expectedRevision', 'surface'], additionalProperties: false },
      description: 'Publish a complete new revision of an existing UI surface using its current expectedRevision. A new revision explicitly resets state to its supplied defaults.',
      execute: (args, context) => publish({ ...args, operation: 'update' }, context)
    }))
    const guides = {
      column: 'column {id,type,children:[componentId]}', row: 'row {id,type,children:[componentId]}', form: 'form {id,type,label,children:[componentId]}',
      text: 'text {id,type,text}', input: 'input {id,type,label,stateKey,maxLength}', checkbox: 'checkbox {id,type,label,stateKey}',
      slider: 'slider {id,type,label,stateKey,min,max,step}',
      chart: 'chart {id,type,chartType:line|bar,title,labels:[text],series:[{id,name,values:[number]}],multiplierKey?:stateKey}',
      button: 'button {id,type,label,actionId}', filter: 'filter {id,type,label,stateKey,options:[{value:string,label}]}',
      table: 'table {id,type,title,columns:[{id,label}],rows:[{id,cells:[primitive]}],selectionKey?:string,filterKey?:string,filterColumn?:columnId}; use both filterKey and filterColumn or neither',
      progress: 'progress {id,type,label,valueKey,max,status}; status is pending|running|paused|completed|failed|cancelled; this is supplied display data, NOT proof of real task execution',
      flow: 'flow {id,type,title,nodes:[{id,label,status}],edges:[{from,to,label?}],selectionKey}; nodes use the same bounded display statuses; selecting never runs a workflow',
      map: 'map {id,type,title,points:[{id,label,longitude,latitude}],selectionKey}; offline ellipsoid and markers only, no imagery/terrain or external resources; unsupported graphics uses an explicit coordinate view',
      visual: 'visual {id,type,title,html,height?}; html is a complete static HTML/SVG/CSS fragment, height 200-800; scripts, forms, links, external URLs, network access and same-origin access are blocked, so embed data: images and use pure CSS/SVG'
    }
    ctx.effect(() => ctx.prompts.add(context => {
      const capabilities = context.rendererCapabilities === undefined && testing ? UI.capabilities() : context.rendererCapabilities
      if (!capabilities?.components.length) return ''
      return [
        'Use render_ui for interactive data when useful; ordinary prose does not need a UI. The client can display committed surfaces; recorded:true is durable publication, not proof of display or a completed user action.',
        'When the user asks to draw, design, preview or show a custom visual or page in the conversation, publish a v2 visual component containing the complete static HTML/SVG/CSS. Do NOT use browser_launch, browser_act, browser_eval, browser_close or a screenshot to present chat output; browser tools are only for verifying real web apps or files, never a substitute for chat rendering.',
        'Negotiated renderer: ' + JSON.stringify(capabilities) + '. Never use unlisted versions or components. New business components require version 2; version 1 histories remain readable.',
        'Surface: {version,id,revision,title,root,state,components,actions}. IDs begin with an ASCII letter and contain only letters, digits, underscore or hyphen. Every component must belong to one bounded tree.',
        'Available component shapes: ' + capabilities.components.filter(kind => capabilities.versions.includes(2) || UI.LEGACY_COMPONENTS.includes(kind)).map(kind => guides[kind]).filter(Boolean).join('; '),
        'Actions: {id,type:ask_agent,message,stateKeys:[stateKey]}. State contains bounded JSON primitives. Bind only existing keys; selection keys are empty string or a declared row/node/point ID; filter values must belong to its options. Button actions require application confirmation and saved parameters; subsequent tools retain existing permissions and approval.',
        'Limits: surface 48000 JSON characters, 64 components, depth 8, 32 state keys, 16 actions; charts <=120 labels/8 series, tables <=120 rows/12 columns, filters <=64 options, flow <=32 nodes/64 edges, maps <=120 points with longitude [-180,180]/latitude [-90,90]. No scripts, HTML, URL assets, expressions, arbitrary tool names, formatters or ECharts options.',
        'Create with operation=create, expectedRevision=0, revision=1. Update with the complete replacement, current expectedRevision and next revision. Preserve saved selections explicitly if they should survive a new revision; never infer execution progress or repeat an uncertain external effect.'
      ].join('\n')
    }))
  }
}
