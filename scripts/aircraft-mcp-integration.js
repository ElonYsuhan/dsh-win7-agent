'use strict'
// Opt-in integration against the EXISTING external MCP service. The local HTTP
// fixture below is an LLM transport only; no replacement MCP server is created.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),assert=require('assert')
const {HttpClient}=require('../src/main/mcp/http-client'),C=require('../src/main/contracts/mcp'),{Settings}=require('../src/main/agent/settings'),{PluginHost}=require('../src/main/plugins/plugin-host'),{AgentPool}=require('../src/main/agent/agent-pool')
const url=process.argv[2]||'http://127.0.0.1:4331/mcp',output=path.resolve(process.argv[3]||'release/validation/aircraft-mcp/integration.json')
const valid={waypoints:[{x:0,y:0,z:1000},{x:1000,y:0,z:1000}],speed:100,turnRate:10,sampleInterval:1,maxClimbRate:20}
function trajectory(result){assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content.find(x=>x.type==='text').text)}
async function main(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-aircraft-integration-')),config=C.normalizeServer({id:'aircraft-trajectory',name:'飞机轨迹计算',transport:'http',url,permission:'read',timeoutMs:15000}),client=new HttpClient(config),report={url,checks:[],model:'local deterministic LLM transport fixture; actual Agent loop and actual external MCP'};let pool,host,model
 try{
  await client.start();const tools=await client.listTools(),tool=tools.find(x=>x.name==='calculate_aircraft_trajectory');assert(tool,'tool discovery');report.protocolVersion=client.protocolVersion;report.server=client.serverInfo;report.inputSchema=tool.inputSchema;report.description=tool.description;report.checks.push('actual initialize/tools-list')
  const straight=trajectory(await client.callTool(tool.name,valid));assert.strictEqual(straight.coordinateSystem,'local-enu');assert.strictEqual(straight.distance,1000);assert.strictEqual(straight.duration,10);assert.strictEqual(straight.samples.length,11);assert.deepStrictEqual(straight.samples[10],{x:1000,y:0,z:1000,time:10,heading:90});report.straight=straight;report.checks.push('straight: 1000m/10s/11 samples')
  const turn=trajectory(await client.callTool(tool.name,{...valid,speed:50,waypoints:[...valid.waypoints,{x:1000,y:1000,z:1000}]}));assert(Math.abs(turn.turnRadius-50/(10*Math.PI/180))<1e-6);assert(turn.samples.some(x=>x.x<1000&&x.y>0));assert.strictEqual(turn.samples[turn.samples.length-1].y,1000);report.turn={distance:turn.distance,duration:turn.duration,turnRadius:turn.turnRadius,samples:turn.samples.length};report.checks.push('actual circular turn and final waypoint')
  const invalid=await client.callTool(tool.name,{...valid,speed:0});assert(invalid.isError);assert(C.formatToolResult(invalid).startsWith('ERROR:'));report.invalidSpeed=invalid;report.checks.push('remote validation isError preserved')
  await assert.rejects(client.callTool('agent_integration_nonexistent',valid),/MCP_RPC_ERROR/);const controller=new AbortController();controller.abort();await assert.rejects(client.callTool(tool.name,valid,{signal:controller.signal}),/ABORTED/);report.checks.push('unknown-tool JSON-RPC error and cancellation')
  let mode='valid',requests=0,rounds=0,modelErrors=[];const exposed=C.toolName(config.id,tool.name)
  model=http.createServer((request,response)=>{let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{try{
   const body=JSON.parse(text),definition=body.tools.find(x=>x.function.name===exposed);assert(definition);assert.deepStrictEqual(definition.function.parameters,tool.inputSchema);assert(definition.function.description.includes(tool.description));requests++
   const result=body.messages.filter(x=>x.role==='tool').slice(-1)[0];let delta
   if(result){assert.strictEqual(result.tool_call_id,'aircraft_call');if(mode==='valid'){const value=JSON.parse(result.content);assert.strictEqual(value.distance,1000);assert.strictEqual(value.duration,10)}else assert(result.content.startsWith('ERROR:'));rounds++;delta={content:mode==='valid'?'轨迹计算完成：1000米，10秒。':'轨迹计算失败：速度必须至少为0.1米/秒。'}}
   else delta={tool_calls:[{index:0,id:'aircraft_call',type:'function',function:{name:exposed,arguments:JSON.stringify(mode==='valid'?valid:{...valid,speed:0})}}]}
   response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:result?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
  }catch(error){modelErrors.push(error.message);response.writeHead(500);response.end(JSON.stringify({error:{message:error.message}}))}})})
  await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve))
  const settings=new Settings(directory);settings.update({workspacePath:directory,baseURL:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'local-fixture-only',model:'integration-fixture',permissionMode:'readonly',maxIterations:3,requestTimeoutMs:10000,mcpServers:[config],disabledBuiltinMcp:['documents']})
  host=new PluginHost({workspaceRoot:directory,settings});await host.ready();await host.get('mcp').ready();assert(host.tools.definitions().some(x=>x.function.name===exposed))
  pool=new AgentPool({settings,pluginHost:host,sessionRoot:path.join(directory,'sessions'),emit:()=>{},approve:async()=>{throw Error('read calculation must not request elevated permissions')}})
  for(const test of ['valid','invalid']){mode=test;const session='aircraft_'+test;await pool.run(session,'请调用飞机轨迹计算工具验证当前输入。',[]);const saved=JSON.parse(fs.readFileSync(path.join(pool.sessionDir(session),'last-session.json'),'utf8'));assert(saved.messages.some(x=>x.role==='tool'&&x.tool_call_id==='aircraft_call'));assert(saved.messages.some(x=>x.role==='assistant'&&String(x.content||'').includes(test==='valid'?'1000米':'速度必须')))}
  assert.deepStrictEqual(modelErrors,[]);assert.strictEqual(requests,4);assert.strictEqual(rounds,2);report.exposedName=exposed;report.modelRequests=requests;report.checks.push('full schema and description delivered to model','real AgentPool/Cordis executes external MCP tools','success AND error tool messages return to model and persist')
  const offline=new HttpClient({...config,url:'http://127.0.0.1:1/mcp',timeoutMs:1000});try{await assert.rejects(offline.start(),/ECONNREFUSED|EACCES|MCP_TIMEOUT/)}finally{await offline.close()}report.checks.push('offline service fails explicitly');report.passed=true
  fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({passed:true,server:report.server,checks:report.checks,straight:{distance:straight.distance,duration:straight.duration,samples:straight.samples.length},turn:report.turn,exposedName:exposed,report:output},null,2))
 }finally{if(pool)await pool.dispose();if(host)await host.dispose();await client.close();if(model)await new Promise(resolve=>model.close(resolve));fs.rmSync(directory,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
