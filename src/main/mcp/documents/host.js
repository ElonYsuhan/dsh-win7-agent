'use strict'
const fs = require('fs')
const path = require('path')
const { StdioClient } = require('../stdio-client')
const mcp = require('../../contracts/mcp')
const { TOOLS, SERVER_ID, SERVER_NAME } = require('../../contracts/document-tools')

// Per-call subprocess: no shared conversation cwd or user document state.
// All operations go through real initialize -> tools/list -> tools/call messages.
function createDocumentHost() {
  let closed=false
  const clients=new Set(),pending=new Set()
  async function call(tool,args,context) {
    if(closed)throw new Error('MCP_CLIENT_CLOSED')
    if(context.signal.aborted)throw new Error('ABORTED')
    if(!context.workspaceRoot)throw new Error('WORKSPACE_NOT_SET')
    if(clients.size>=8)throw new Error('DOCUMENT_CONCURRENCY_LIMIT')
    const root=fs.realpathSync(context.workspaceRoot)
    const client=new StdioClient({command:process.execPath,args:[path.join(__dirname,'server.js'),'--root',root],cwd:root,env:{ELECTRON_RUN_AS_NODE:'1'},timeoutMs:30000}, {shell:false})
    clients.add(client)
    const cancel=()=>{client.close().catch(()=>{})}
    context.signal.addEventListener('abort',cancel,{once:true})
    try {
      await client.start()
      const listed=await client.listTools(), found=listed.find(t=>t.name===tool.name)
      if(!found||JSON.stringify(found.inputSchema)!==JSON.stringify(tool.inputSchema))throw new Error('DOCUMENT_MCP_CONTRACT_MISMATCH')
      const result=await client.callTool(tool.name,args,{signal:context.signal})
      return mcp.formatToolResult(result)
    } finally {context.signal.removeEventListener('abort',cancel);await client.close();clients.delete(client)}
  }
  return {
    definitions:TOOLS,
    status(enabled) {return {id:SERVER_ID,name:SERVER_NAME,builtin:true,enabled,transport:'stdio',status:enabled?'available':'disabled',error:'',tools:enabled?TOOLS.map(t=>({name:t.name,description:t.description,exposedName:mcp.toolName(SERVER_ID,t.name)})):[]}},
    execute(tool,args,context){const work=call(tool,args,context);pending.add(work);return work.finally(()=>pending.delete(work))},
    async close(){closed=true;await Promise.allSettled(Array.from(clients,c=>c.close()));await Promise.allSettled(Array.from(pending))}
  }
}
module.exports = { createDocumentHost }
