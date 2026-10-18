'use strict'

// Standalone MCP tools server over standard newline-delimited stdio JSON-RPC.
// stdout is protocol-only. Root is fixed by the trusted launching host, not args
// to individual tools. Also usable by other MCP clients with --root <directory>.
const fs = require('fs')
const { StringDecoder } = require('string_decoder')
const { TOOLS, VERSION, PROTOCOLS } = require('../../contracts/document-tools')
const { assertArguments } = require('../../contracts')
const { execute } = require('./service')
function serve(root, input, output) {
  root=fs.realpathSync(root)
  if(!fs.statSync(root).isDirectory())throw new Error('WORKSPACE_NOT_DIRECTORY')
  let phase='new',buffer='',chain=Promise.resolve(),ended=false
  const decoder=new StringDecoder('utf8'),active=new Map(),MAX_LINE=2*1024*1024
  const send=value=>output.write(JSON.stringify(value)+'\n')
  const fail=(id,code,message)=>send({jsonrpc:'2.0',id,error:{code,message}})
  async function dispatch(m,controller) {
    if(!m||Array.isArray(m)||typeof m!=='object'||m.jsonrpc!=='2.0'||typeof m.method!=='string'||(m.id!==undefined&&typeof m.id!=='string'&&!(typeof m.id==='number'&&Number.isFinite(m.id)))){fail(null,-32600,'Invalid Request');return}
    const notification=m.id===undefined
    if(notification){if(m.method==='notifications/initialized'&&phase==='initializing')phase='ready';return}
    const result=value=>send({jsonrpc:'2.0',id:m.id,result:value})
    const params=m.params===undefined?{}:m.params
    if(!params||typeof params!=='object'||Array.isArray(params)){fail(m.id,-32602,'Invalid params');return}
    if(m.method==='ping'){result({});return}
    if(m.method==='initialize'){
      if(phase!=='new'){fail(m.id,-32600,'Already initialized');return}
      if(typeof params.protocolVersion!=='string'||!params.clientInfo||typeof params.clientInfo.name!=='string'||typeof params.clientInfo.version!=='string'||!params.capabilities||typeof params.capabilities!=='object'){fail(m.id,-32602,'initialize requires protocolVersion, capabilities and clientInfo');return}
      const version=PROTOCOLS.includes(params.protocolVersion)?params.protocolVersion:PROTOCOLS[0]
      phase='initializing';result({protocolVersion:version,capabilities:{tools:{listChanged:false}},serverInfo:{name:'agent-document-tools',version:VERSION},instructions:'Offline Word/Excel tools. Paths are confined to the root supplied by the host. Writes always create new files. No macro execution or formula evaluation.'});return
    }
    if(phase!=='ready'){fail(m.id,-32000,'Initialization required');return}
    if(m.method==='tools/list'){
      if(params.cursor!==undefined){fail(m.id,-32602,'Invalid cursor: tool list has only one page');return}
      result({tools:TOOLS.map(({permission,...tool})=>tool)});return
    }
    if(m.method!=='tools/call'){fail(m.id,-32601,'Method not found');return}
    const tool=TOOLS.find(t=>t.name===params.name)
    if(!tool){fail(m.id,-32602,'Unknown tool');return}
    const args=params.arguments===undefined?{}:params.arguments
    try{assertArguments(tool.inputSchema,args)}catch(error){fail(m.id,-32602,error.message);return}
    try {
      const value=await execute(root,tool.name,args,controller.signal),text=JSON.stringify(value)
      if(Buffer.byteLength(text)>512*1024)throw new Error('DOCUMENT_RESULT_TOO_LARGE: request a smaller page/range')
      if(!controller.signal.aborted)result({content:[{type:'text',text}],isError:false})
    } catch(error) { if(!controller.signal.aborted)result({content:[{type:'text',text:String(error.message||error).slice(0,2000)}],isError:true}) }
  }
  function receive(line) {
    let m;try{m=JSON.parse(line)}catch(error){fail(null,-32700,'Parse error');return}
    if(m&&m.jsonrpc==='2.0'&&m.method==='notifications/cancelled'&&m.id===undefined){const call=m.params&&active.get(m.params.requestId);if(call)call.abort();return}
    if(m&&m.id!==undefined&&active.has(m.id)){fail(m.id,-32600,'Request ID already active');return}
    if(active.size>=32){if(m&&m.id!==undefined)fail(m.id,-32000,'Too many pending requests');return}
    const controller=new AbortController();if(m&&m.id!==undefined)active.set(m.id,controller)
    chain=chain.then(()=>controller.signal.aborted?undefined:dispatch(m,controller)).catch(error=>{if(m&&m.id!==undefined)fail(m.id,-32603,'Internal error')}).finally(()=>{if(m&&m.id!==undefined)active.delete(m.id)})
  }
  input.on('data',chunk=>{
    buffer+=decoder.write(chunk)
    let index
    while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).replace(/\r$/,'');buffer=buffer.slice(index+1);if(Buffer.byteLength(line)>MAX_LINE){fail(null,-32600,'Message too large');continue}receive(line)}
    if(Buffer.byteLength(buffer)>MAX_LINE){for(const call of active.values())call.abort();input.destroy(new Error('MCP_MESSAGE_TOO_LARGE'))}
  })
  input.on('end',()=>{ended=true;for(const call of active.values())call.abort();chain.finally(()=>output.end())})
  input.on('error',()=>{for(const call of active.values())call.abort();if(!ended)output.end()})
  return {close:()=>{for(const call of active.values())call.abort();return chain}}
}
if(require.main===module){const at=process.argv.indexOf('--root');try{if(at<0||!process.argv[at+1])throw new Error('Usage: document-server --root <workspace>');serve(process.argv[at+1],process.stdin,process.stdout)}catch(error){process.stderr.write(error.message+'\n');process.exitCode=1}}
module.exports = { serve }
