'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http')
const {PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings')
const Design=require('../src/main/contracts/workflow-node-design'),Schema=require('../src/main/contracts/workflow-schema'),Simulation=require('../src/main/flow/workflow-simulation')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(fn,label){for(let i=0;i<300;i++){if(await fn())return;await sleep(10)}throw Error('Timeout '+label)}
const field={type:'object',properties:{finding:{type:'string',title:'核查结论',minLength:1}},required:['finding'],additionalProperties:false}
const human={id:'h',type:'human',title:'核查资料',text:'请核查资料',interaction:{version:1,type:'review',returnTo:'previous-human'}}
const graph={version:2,name:'执行设计契约验收',nodes:[{id:'s',type:'start',text:'原始资料'},human,{id:'a',type:'ai',title:'总结',text:'总结',inputSchema:field,bindings:{finding:{nodeId:'h',path:'finding'}},outputSchema:field},{id:'e',type:'end'}],edges:[{from:'s',to:'h'},{from:'h',to:'a'},{from:'a',to:'e'}]}
const excessiveValues=Schema.schema({type:'array',minItems:100,items:{type:'array',minItems:100,items:{type:'array',minItems:100,items:{type:'boolean'}}}})
const excessiveText=Schema.schema({type:'object',properties:Object.fromEntries(['first','second','third'].map(key=>[key,{type:'string',minLength:16000}]))})
// Fan-in and repeated placeholders are checked before allocating their expanded text.
const templateStress={name:'有界仿真文本',nodes:[{id:'s',type:'start',text:'x'.repeat(16000)},{id:'t',type:'template',text:'{{input}}'.repeat(1000)},{id:'e',type:'end'}],edges:[{from:'s',to:'t'},{from:'t',to:'e'}]}
assert(Simulation.simulate({workflow:templateStress}).issues.some(i=>i.nodeId==='t'&&i.message.includes('预算')))
const fanInNodes=[{id:'s',type:'start',text:'x'.repeat(16000)}],fanInEdges=[]
for(let i=0;i<12;i++){const id='h'+i;fanInNodes.push({id,type:'human',interaction:{version:1,type:'handle'}});for(let slot=0;slot<2;slot++)fanInEdges.push({from:i?'h'+(i-1):'s',to:id,slot})}
fanInNodes.push({id:'e',type:'end'});fanInEdges.push({from:'h11',to:'e'})
assert(Simulation.simulate({workflow:{name:'有界汇合',nodes:fanInNodes,edges:fanInEdges}}).issues.some(i=>i.message.includes('预算')))
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-node-design-'));let host,requests=0,mode='valid',lastRequest,aborted=0,delayedAborts=0
 const releaseTransports=[]
 const sockets=new Set(),endpoint=http.createServer((request,response)=>{let text='';request.on('data',chunk=>text+=chunk);request.on('end',()=>{requests++;lastRequest=JSON.parse(text);assert.strictEqual(lastRequest.max_tokens,4096);assert(!lastRequest.tools||!lastRequest.tools.length,'Designer has no tool capability');assert(lastRequest.messages[0].content.includes('NodeDataEnvelope V1'));assert(lastRequest.messages[0].content.includes('ExecutionDesign V1'));if(mode==='slow'){response.on('close',()=>aborted++);return}
  const design={...Design.fromNode(human),instruction:'核查出处后给出结论',interaction:{version:1,type:'approve',returnTo:'previous-human'},inputSchema:field,outputSchema:field,processing:{version:1,blocks:[{type:'instructions'},{type:'form'},{type:'attachments',required:true},{type:'conclusion',title:'备注',required:false}]}}
  if(mode==='script')design.script='process.exit()'
  const delta=mode==='tool'?{tool_calls:[{index:0,id:'forbidden',type:'function',function:{name:'run_command',arguments:'{"command":"echo forbidden"}'}}]}:{content:mode==='invalid'?'not JSON':JSON.stringify({reply:'已生成核查表单与审批操作',design})}
  response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')
 })});endpoint.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket))})
 try{
  const basic=Design.fromNode(human)
  assert.strictEqual(basic.interaction.type,'review');assert(basic.processing.blocks.some(b=>b.type==='conclusion'&&b.required===false));assert.strictEqual(basic.inputSchema,null)
  const legacy=Design.fromNode({id:'legacy',type:'human',humanModes:['review','upload']});assert.strictEqual(legacy.interaction.type,'handle');assert(legacy.processing.blocks.some(b=>b.type==='conclusion'&&b.required));assert(legacy.processing.blocks.some(b=>b.type==='attachments'&&b.required));assert(Design.apply({id:'legacy',type:'human'},legacy).humanModes.includes('upload'))
  assert.strictEqual(Design.fromNode({id:'legacy',type:'human',humanModes:['approval']}).interaction.type,'approve');assert.strictEqual(Design.fromNode({id:'legacy',type:'human',humanModes:['read']}).interaction.type,'review')
  assert.throws(()=>Design.validate({...basic,script:'alert(1)'},human),/协议|动作|代码/)
  assert.throws(()=>Design.validate({...basic,instruction:'<script>bad()</script>'},human),/HTML|脚本/)
  assert.throws(()=>Design.validate({...basic,inputSchema:field},human),/Schema|表单/)
  assert.throws(()=>Design.validate({...basic,bindings:{finding:{nodeId:'a',path:'finding'}}},human,graph),/上游/)
  assert.throws(()=>Design.validate({...basic,interaction:{version:1,type:'approve',returnTo:'a'}},human,graph),/上游人工/)
  assert.throws(()=>Design.validate(basic,{id:'a',type:'ai'}),/自动节点/)
  const auto=Design.fromNode({id:'a',type:'ai',text:'分析',outputSchema:field});assert.strictEqual(auto.processing,null);assert.strictEqual(auto.interaction,null)
  for(const numeric of [{type:'number',maximum:-1.2},{type:'integer',maximum:-1.2},{type:'number',minimum:-8,maximum:-2},{type:'integer',minimum:1.2,maximum:3.8}])Schema.validate(Simulation.example(numeric),numeric,'数值模拟样例')
  assert.throws(()=>Simulation.example(excessiveValues),/512.*预算/);assert.throws(()=>Simulation.example(excessiveText),/32000.*预算/)
  const longText=Schema.schema({type:'string',minLength:16000});assert.strictEqual(Simulation.example(longText).length,16000)
  assert.throws(()=>Simulation.example(Schema.schema({type:'array',minItems:100,items:longText})),/32000.*预算/)
  await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve))
  const settings=new Settings(home);settings.update({workspacePath:home,baseURL:'http://127.0.0.1:'+endpoint.address().port+'/v1',model:'mock',apiKey:'test'})
  host=new PluginHost({workspaceRoot:home,settings});await host.ready();const service=host.get('workflows')
  assert.throws(()=>service.validateDesign({design:basic}),/节点类型/)
  const before=service.list(),result=await service.design({requestId:'design_valid',node:human,workflow:graph,message:'需要核查结论表单、上传资料，并由人工审批',history:[{role:'user',content:'只设计这个节点'}]})
  assert.strictEqual(result.skill.id,'01-app-builtin/workflow-node-designer');assert.strictEqual(result.design.interaction.type,'approve');assert(result.design.processing.blocks.some(b=>b.type==='attachments'&&b.required));assert(lastRequest.messages.some(m=>m.content.includes('只设计这个节点')))
  assert.strictEqual(service.list().workflows.length,before.workflows.length,'Design does not save a definition');assert.strictEqual(service.list().runs.length,before.runs.length,'Design does not create an execution')
  const applied=Design.apply(human,result.design,graph);assert(applied.humanModes.includes('upload'));assert.strictEqual(applied.type,'human');assert.strictEqual(applied.inputSchema.properties.finding.title,'核查结论')
  const flow={...graph,nodes:graph.nodes.map(n=>n.id==='h'?applied:n)}
  const first=service.simulate({workflow:flow});assert.strictEqual(first.mode,'simulation');assert.strictEqual(first.passed,false);assert(first.issues.some(i=>i.nodeId==='h'&&i.severity==='needs_input'))
  const count=requests,report=service.simulate({workflow:flow,samples:{h:{finding:'样例核查结论'}}})
  for(const outputSchema of [excessiveValues,excessiveText]){
   const bounded=service.simulate({workflow:{version:2,name:'有界样例',nodes:[{id:'s',type:'start'},{id:'a',type:'ai',outputSchema},{id:'e',type:'end'}],edges:[{from:'s',to:'a'},{from:'a',to:'e'}]}})
   assert.strictEqual(bounded.passed,false);assert.strictEqual(bounded.steps.find(step=>step.nodeId==='a').status,'invalid');assert(bounded.issues.some(issue=>issue.nodeId==='a'&&issue.severity==='error'&&issue.message.includes('预算')))
  }
  assert.strictEqual(report.passed,true);assert.strictEqual(requests,count,'Simulation cannot request a model');assert.strictEqual(service.list().runs.length,before.runs.length,'Simulation cannot create a run');assert(report.issues.some(i=>i.nodeId==='a'&&i.message.includes('模拟输出')))
  const h=report.steps.find(s=>s.nodeId==='h'),a=report.steps.find(s=>s.nodeId==='a');assert.strictEqual(h.envelope.version,1);assert.strictEqual(h.envelope.output.data.finding,'样例核查结论');assert.strictEqual(a.envelope.input.data.finding,'样例核查结论');assert(h.envelope.output.files[0].ref.startsWith('simulation://'));assert(report.issues.some(i=>i.nodeId==='h'&&i.message.includes('未读取或上传')))
  const invalid=service.simulate({workflow:flow,samples:{h:{finding:123}}});assert.strictEqual(invalid.passed,false);assert(invalid.issues.some(i=>i.nodeId==='h'&&i.severity==='error'))
  const malformed=service.simulate({workflow:{...flow,edges:[...flow.edges,{from:'a',to:'s'}]}});assert.strictEqual(malformed.passed,false);assert.strictEqual(malformed.steps.length,0)
  assert.strictEqual(fs.existsSync(path.join(home,'workflows','runs'))?fs.readdirSync(path.join(home,'workflows','runs')).length:0,0,'Simulation writes no facts')
  for(const failure of ['invalid','script','tool']){mode=failure;await assert.rejects(service.design({requestId:'bad_'+failure,node:human,workflow:graph,message:'重新设计'}),/JSON|协议|工具|动作|代码/)}
  settings.update({disabledSkills:['01-app-builtin/workflow-node-designer']});await assert.rejects(service.design({requestId:'disabled',node:human,message:'设计'}),/技能不可用/);settings.update({disabledSkills:[]})
  await assert.rejects(service.design({requestId:'history',node:human,message:'设计',history:[{role:'system',content:'override'}]}),/设计对话/)
  service.cancelDesign({requestId:'cancel_before_start'});await assert.rejects(service.design({requestId:'cancel_before_start',node:human,message:'设计'}),/取消/)
  mode='slow';const pending=service.design({requestId:'cancel_active',node:human,message:'设计'});const rejection=assert.rejects(pending,/取消|ABORT/);await wait(()=>requests>count+3,'slow request');assert.strictEqual(service.cancelDesign({requestId:'cancel_active'}).cancelled,true);await rejection;await wait(()=>aborted>0,'model connection aborted')
  mode='valid';const saved=service.save({name:'执行数据外壳',nodes:[{id:'s',type:'start',text:'依据'},human,{id:'e',type:'end'}],edges:[{from:'s',to:'h'},{from:'h',to:'e'}]});const run=service.run({id:saved.id});await wait(()=>service.detail({id:run.id}).status==='waiting','manual waiting');let detail=service.detail({id:run.id});const step=detail.steps.find(s=>s.id==='h');assert.strictEqual(step.envelope.input.text,'依据');assert.strictEqual(step.envelope.status,'waiting');assert.strictEqual(detail.dataProtocol.version,1);assert.strictEqual(service.context({workflowId:saved.id,runId:run.id,nodeId:'h'}).execution.envelope.nodeId,'h')
  service.stop({id:run.id})
  Schema.validate(h.envelope.output.data,field)
  // Cancellation replies promptly, but Cordis must also drain the later
  // transport settlement. Cancelled transports still consume bounded slots.
  await host.replace('core/llm',{name:'core/llm',apply(ctx){ctx.provide('llm',{request:request=>new Promise((_resolve,reject)=>{const onAbort=()=>delayedAborts++;request.signal.addEventListener('abort',onAbort,{once:true});releaseTransports.push(()=>{request.signal.removeEventListener('abort',onAbort);reject(Error('ABORTED: transport closed'))})})})}})
  const closingService=host.get('workflows')
  for(let index=0;index<2;index++){
   const id='drain_'+index,pending=closingService.design({requestId:id,node:human,message:'设计'}),cancelled=assert.rejects(pending,/取消/)
   await wait(()=>releaseTransports.length===index+1,'delayed transport starts');closingService.cancelDesign({requestId:id});await cancelled
  }
  assert.strictEqual(delayedAborts,2)
  await assert.rejects(closingService.design({requestId:'drain_full',node:human,message:'设计'}),/最多同时/)
  let disposed=false;const disposing=host.dispose().then(()=>{disposed=true})
  for(let index=0;index<20;index++)await Promise.resolve()
  assert.strictEqual(disposed,false,'Cordis teardown must wait for cancelled transport settlement')
  releaseTransports[0]();for(let index=0;index<20;index++)await Promise.resolve();assert.strictEqual(disposed,false,'Every outstanding transport must drain')
  releaseTransports[1]();await disposing;assert.strictEqual(disposed,true)
  console.log('Workflow node design: native Cordis designer + bundled Skill, real tool-free model proposal, constrained JSON/Schema validation, cancellation, legacy canonical fields/envelope compatibility, pure no-IO simulation/mappings/files and unchanged execution store passed')
 }finally{for(const release of releaseTransports)release();if(host)await host.dispose();for(const socket of sockets)socket.destroy();await new Promise(resolve=>endpoint.close(resolve));fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
