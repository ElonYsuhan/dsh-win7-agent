'use strict'

const contract = require('../../contracts/mcp')
const policy = require('../../flow/mcp-policy')
const { McpManager } = require('../../mcp/manager')
const { createDocumentHost } = require('../../mcp/documents/host')

module.exports = {
  name: 'core/mcp',
  inject: ['agentConfig', 'tools', 'prompts', 'contracts'],
  apply(ctx) {
    const manager = new McpManager()
    const documents = createDocumentHost()
    const unregister = []
    const packageUnregister = new Map()
    let chain = Promise.resolve()
    let closed = false
    let lastError = ''
    let packageServers = []

    function settingsData() {
      const settings = ctx.agentConfig.settings
      if (not(settings)) return {}
      if (typeof settings.all === 'function') return settings.all()
      return settings.data || {}
    }

    function status() {
      const value = manager.status()
      const enabled = !(settingsData().disabledBuiltinMcp || []).includes('documents')
      const builtin = documents.status(enabled)
      for (const server of value.servers) { const item=packageServers.find(p=>p.id===server.id);if(item)server.packageId=item.packageId }
      value.servers.unshift(builtin)
      value.tools += builtin.tools.length
      value.available = value.connected + (enabled ? 1 : 0)
      value.error = lastError
      value.protocolVersion = contract.PROTOCOL_VERSION
      value.httpProtocolVersion = contract.HTTP_PROTOCOL_VERSION
      value.supportedProtocolVersions = contract.SUPPORTED_PROTOCOL_VERSIONS.slice()
      return value
    }

    async function unregisterTools() {
      const pending = unregister.splice(0, unregister.length).concat(...packageUnregister.values())
      packageUnregister.clear()
      for (const off of pending) {
        try { await off() } catch (error) {}
      }
    }

    async function sync() {
      if (closed) return status()
      await unregisterTools()
      lastError = ''
      const servers = contract.normalizeServers(settingsData().mcpServers)
      if (servers.length + packageServers.length > contract.MAX_SERVERS) throw Error('MCP 服务总数不能超过32个')
      await manager.start(servers.concat(packageServers))
      if (closed) return status()
      if (!(settingsData().disabledBuiltinMcp || []).includes('documents')) {
        for (const tool of documents.definitions) {
          unregister.push(ctx.tools.register({
            name: contract.toolName('documents', tool.name), plugin: 'core/mcp',
            permission: tool.permission, description: '[内置文档 MCP / Document Tools] ' + tool.description,
            parameters: tool.inputSchema,
            execute: async (args, toolCtx) => {
              try { return await documents.execute(tool, args, toolCtx) }
              catch (error) { if (toolCtx.signal.aborted) throw new Error('ABORTED'); return 'ERROR: ' + error.message }
            }
          }))
        }
      }
      for (const server of manager.status().servers) {
        if (server.status !== 'connected') continue
        for (const tool of policy.exposedTools(server.config, server.tools)) {
          const off = ctx.tools.register({
            name: tool.name,
            plugin: 'core/mcp',
            permission: server.permission,
            description: '[MCP:' + server.name + '] ' + (tool.description || tool.rawName),
            parameters: tool.parameters,
            execute: async (args, toolCtx) => {
              try {
                return await manager.call(server.id, tool.rawName, args, { signal: toolCtx && toolCtx.signal })
              } catch (error) {
                if (String(error && error.message) === 'ABORTED') throw error
                return 'ERROR: ' + String((error && error.message) || error)
              }
            }
          })
          if(packageServers.some(item=>item.id===server.id)){if(!packageUnregister.has(server.id))packageUnregister.set(server.id,[]);packageUnregister.get(server.id).push(off)}else unregister.push(off)
        }
      }
      return status()
    }


    async function syncPackages(items) {
      if(closed)throw Error('MCP_CLOSED')
      const manual=contract.normalizeServers(settingsData().mcpServers)
      if(manual.length+items.length>contract.MAX_SERVERS)throw Error('MCP 服务总数不能超过32个')
      if(items.some(item=>manual.some(server=>server.id===item.id)))throw Error('MCP 扩展标识与手工配置冲突')
      lastError=''
      const keep=new Set(items.filter(item=>packageServers.some(old=>old.id===item.id&&JSON.stringify(old)===JSON.stringify(item))).map(item=>item.id))
      for(const [id,disposers] of packageUnregister){if(keep.has(id))continue;for(const off of disposers)await off();packageUnregister.delete(id)}
      packageServers=items.slice()
      await manager.reconcile(manual.concat(packageServers))
      for(const server of manager.status().servers){
        if(!packageServers.some(item=>item.id===server.id)||packageUnregister.has(server.id)||server.status!=='connected')continue
        const disposers=[];packageUnregister.set(server.id,disposers)
        for(const tool of policy.exposedTools(server.config,server.tools))disposers.push(ctx.tools.register({name:tool.name,plugin:'core/mcp',permission:server.permission,description:'[MCP:'+server.name+'] '+(tool.description||tool.rawName),parameters:tool.parameters,execute:async(args,toolCtx)=>{try{return await manager.call(server.id,tool.rawName,args,{signal:toolCtx&&toolCtx.signal})}catch(error){if(error.message==='ABORTED')throw error;return 'ERROR: '+error.message}}}))
      }
      return status()
    }

    function schedule() {
      chain = chain.then(() => sync()).catch((error) => {
        lastError = String((error && error.message) || error).slice(0, 2000)
        return status()
      })
      return chain
    }

    const service = {
      setPackages: items => { const result=chain.then(()=>syncPackages(items));chain=result.catch(error=>{lastError=error.message;return status()});return result },
      ready: () => chain,
      reload: () => schedule(),
      status: () => status(),
      test: (raw) => manager.probe(raw)
    }

    ctx.effect(() => ctx.prompts.add(() => 'Built-in mcp__documents tools read/create/edit DOCX and XLSX offline. Always use the current workspace; read before editing and pass its revision; edits save a NEW output file. Explain unsupported complex formatting. Do not claim formulas were recalculated. MCP tools, when configured, are exposed with the prefix mcp__<server>__<tool>. Use an MCP tool only when its description matches the task, and treat its result as external tool output. Never claim an MCP call succeeded unless the tool output says so.'))
    ctx.contracts.assertService('mcp', service)
    ctx.provide('mcp', service)
    ctx.effect(() => () => {
      closed = true
      return unregisterTools().then(() => Promise.all([manager.stop(), documents.close()]))
    })
    schedule()
  }
}

const not = (value) => value ? false : true
