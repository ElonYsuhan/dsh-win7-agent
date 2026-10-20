'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http'),{PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(fn,label){for(let i=0;i<500;i++){if(await fn())return;await sleep(10)}throw Error('Interaction timeout: '+label)}
const interaction=(type='handle',returnTo='previous-human')=>({version:1,type,returnTo})
const findingSchema={type:'object',properties:{finding:{type:'string',minLength:1,maxLength:2000}},required:['finding'],additionalProperties:false}
function chain(nodes,name='简化人工交互'){const all=[{id:'s',type:'start',text:'原始任务依据'},...nodes,{id:'e',type:'end'}];return{name,version:2,editor:'steps',nodes:all,edges:all.slice(1).map((n,i)=>({from:all[i].id,to:n.id}))}}
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-interaction-'));let host,service,endpoint,requests=0
 async function start(){host=new PluginHost({workspaceRoot:home,settings:new Settings(home)});await host.ready();service=host.get('workflows')}
 const detail=id=>service.detail({id}),step=(run,nodeId)=>detail(run.id).steps.find(s=>s.id===nodeId)
 async function waiting(run,nodeId){await wait(()=>detail(run.id).status==='waiting'&&step(run,nodeId).status==='waiting','waiting '+nodeId);return step(run,nodeId)}
 function submit(run,nodeId,payload={}){return service.submit({id:run.id,nodeId,taskId:step(run,nodeId).taskId,...payload})}
 try{
  await start()
  assert.throws(()=>service.save(chain([{id:'h',type:'human',interaction:interaction('unknown')}])),/交互|处理|类型/)
  assert.throws(()=>service.save(chain([{id:'h',type:'human',interaction:interaction('review','later')},{id:'later',type:'human',interaction:interaction()}])),/上游|退回|驳回/)
  assert.throws(()=>service.save(chain([{id:'h',type:'human',interaction:interaction('review','s')}])),/人工|退回|驳回/)

  // A simple task has no compulsory attachment, extra conclusion or redundant read checkbox.
  const plain=service.save(chain([{id:'h',type:'human',text:'阅读描述，处理完成后继续。',interaction:interaction()}])),plainRun=service.run({id:plain.id})
  await waiting(plainRun,'h');assert.strictEqual(detail(plainRun.id).interactionViews.h.type,'handle');assert.strictEqual(detail(plainRun.id).interactionViews.h.canReject,false)
  assert.throws(()=>submit(plainRun,'h',{decision:'reject',conclusion:'需要退回'}),/退回|驳回|上游/)
  submit(plainRun,'h');await wait(()=>detail(plainRun.id).status==='succeeded','plain completed')

  const graph={name:'审阅退回与产物历史',version:2,nodes:[
   {id:'s',type:'start',text:'填写核查发现'},
   {id:'h',type:'human',title:'办理登记',interaction:interaction(),inputSchema:findingSchema,outputSchema:findingSchema},
   {id:'archive',type:'end',title:'阶段报告',deliverable:{format:'markdown',name:'阶段报告'}},
   {id:'review',type:'human',title:'审阅资料',interaction:interaction('review')},
   {id:'end',type:'end',title:'最终结果'}
  ],edges:[{from:'s',to:'h'},{from:'h',to:'archive'},{from:'h',to:'review'},{from:'review',to:'end'}]}
  const flow=service.save(graph),run=service.run({id:flow.id}),other=service.run({id:flow.id})
  await waiting(run,'h');await waiting(other,'h');const untouched=detail(other.id),firstTask=step(run,'h').taskId
  assert.throws(()=>submit(run,'h',{values:{}}),/缺少|表单/)
  submit(run,'h',{values:{finding:'第一版核查发现'}});await waiting(run,'review')
  const beforeReturn=detail(run.id),archive=beforeReturn.artifacts.find(a=>a.nodeId==='archive'),archivePath=beforeReturn.steps.find(s=>s.id==='archive').artifactPath,originalBytes=fs.readFileSync(archivePath)
  assert(archive);assert.strictEqual(beforeReturn.interactionViews.review.returnTargetId,'h');assert.strictEqual(beforeReturn.interactionViews.review.returnTargetTitle,'办理登记')
  assert.throws(()=>submit(run,'review',{decision:'reject'}),/原因|理由|结论/)
  const staleReviewTask=step(run,'review').taskId
  submit(run,'review',{decision:'reject',conclusion:'请补充来源与核实依据'})
  await waiting(run,'h');let returned=detail(run.id)
  assert.notStrictEqual(step(run,'h').taskId,firstTask);assert.strictEqual(step(run,'h').attempt,2);assert.deepStrictEqual(step(run,'h').partialData,{finding:'第一版核查发现'},'Returned form retains editable values');assert.strictEqual(step(run,'h').attempts[0].data.finding,'第一版核查发现')
  assert.strictEqual(returned.steps.find(s=>s.id==='review').status,'pending');assert.strictEqual(returned.artifacts.length,0,'Only current downstream artifacts become invalid')
  assert(returned.steps.find(s=>s.id==='review').timeline.some(t=>JSON.stringify(t).includes('请补充来源与核实依据')),'Return reason must be durable execution evidence')
  assert(returned.steps.find(s=>s.id==='archive').attempts[0].artifacts.some(a=>a.id===archive.id),'Earlier artifact metadata stays in attempt history')
  assert.deepStrictEqual(fs.readFileSync(archivePath),originalBytes,'Return must not delete or overwrite archived files')
  assert.deepStrictEqual(detail(other.id),untouched,'Return cannot change another instance')
  assert.throws(()=>service.submit({id:run.id,nodeId:'review',taskId:staleReviewTask,decision:'reject',conclusion:'重复驳回'}),/过期|处理/)
  const returnedTask=step(run,'h').taskId,sequence=returned.sequence
  await host.dispose();host=null;await start();returned=detail(run.id);assert.strictEqual(returned.status,'waiting');assert.strictEqual(step(run,'h').taskId,returnedTask);assert.strictEqual(returned.sequence,sequence)
  submit(run,'h',{values:{finding:'第二版：已补充可核实的来源'}});await waiting(run,'review');submit(run,'review');await wait(()=>detail(run.id).status==='succeeded','review completed')
  assert.strictEqual(step(run,'review').reviewed,true,'Single review action records the read confirmation')
  assert.strictEqual(step(run,'review').attempts.length,2);assert.strictEqual(step(run,'archive').attempts.length,2)
  assert(detail(run.id).artifacts.some(a=>a.id!==archive.id&&a.nodeId==='archive'));assert.deepStrictEqual(fs.readFileSync(archivePath),originalBytes)

  // Explicit return targets may select an upstream review step instead of the default handling step.
  const fixed=service.save(chain([{id:'h',type:'human',interaction:interaction()},{id:'review',type:'human',interaction:interaction('review')},{id:'approve',type:'human',interaction:interaction('approve','review')}],'指定退回与审批')),fixedRun=service.run({id:fixed.id})
  await waiting(fixedRun,'h');submit(fixedRun,'h');await waiting(fixedRun,'review');submit(fixedRun,'review');await waiting(fixedRun,'approve')
  assert.strictEqual(detail(fixedRun.id).interactionViews.approve.returnTargetId,'review');assert.throws(()=>submit(fixedRun,'approve'),/通过|审批/)
  submit(fixedRun,'approve',{decision:'reject',conclusion:'请再次审阅依据'});await waiting(fixedRun,'review');assert.strictEqual(step(fixedRun,'h').attempt,1,'Unrelated successful ancestors are reused')
  submit(fixedRun,'review');await waiting(fixedRun,'approve');submit(fixedRun,'approve',{decision:'approve'});await wait(()=>detail(fixedRun.id).status==='succeeded','approval completed')

  // Existing definitions keep their configured compulsory conclusion and read checks.
  const legacy=service.save(chain([{id:'h',type:'human',humanModes:['approval','read']}],'旧人工配置')),legacyRun=service.run({id:legacy.id})
  await waiting(legacyRun,'h');assert.throws(()=>submit(legacyRun,'h',{decision:'approve',reviewed:true}),/结论/);assert.throws(()=>submit(legacyRun,'h',{decision:'approve',conclusion:'确认'}),/审阅/)
  submit(legacyRun,'h',{decision:'approve',conclusion:'旧约束仍保留',reviewed:true});await wait(()=>detail(legacyRun.id).status==='succeeded','legacy completed')

  // A business return never silently replays an already executed external write.
  endpoint=http.createServer((request,response)=>{let body='';request.on('data',c=>body+=c);request.on('end',()=>{requests++;response.end('接口执行记录 '+requests+' '+body)})});await new Promise(resolve=>endpoint.listen(0,'127.0.0.1',resolve))
  const external=service.save(chain([{id:'h',type:'human',interaction:interaction()},{id:'write',type:'rest',rest:{url:'http://127.0.0.1:'+endpoint.address().port+'/write',method:'POST'}},{id:'review',type:'human',interaction:interaction('review')}],'外部操作核查')),externalRun=service.run({id:external.id})
  await waiting(externalRun,'h');submit(externalRun,'h');await waiting(externalRun,'review');assert.strictEqual(requests,1)
  submit(externalRun,'review',{decision:'reject',conclusion:'修改后重新核查外部操作'});await waiting(externalRun,'h');assert.strictEqual(requests,1)
  submit(externalRun,'h');await wait(()=>detail(externalRun.id).status==='paused','external replay checkpoint');assert.strictEqual(requests,1);assert.throws(()=>service.resume({id:externalRun.id}),/核查|确认|外部/)
  await host.dispose();host=null;await start();assert.strictEqual(detail(externalRun.id).status,'paused');assert.throws(()=>service.resume({id:externalRun.id}),/核查|确认|外部/)
  service.resume({id:externalRun.id,confirmExternal:true});await waiting(externalRun,'review');assert.strictEqual(requests,2)
  submit(externalRun,'review',{decision:'reject',conclusion:'再次修改，前次核查不能重复使用'});await waiting(externalRun,'h');submit(externalRun,'h');await wait(()=>detail(externalRun.id).status==='paused','new return checkpoint');assert.strictEqual(requests,2);assert.throws(()=>service.resume({id:externalRun.id}),/核查|确认|外部/)
  service.resume({id:externalRun.id,confirmExternal:true});await waiting(externalRun,'review');submit(externalRun,'review');await wait(()=>detail(externalRun.id).status==='succeeded','external review complete');assert.strictEqual(requests,3)
  // Confirmation applies to one external node only, never a blanket consent.
  const url='http://127.0.0.1:'+endpoint.address().port+'/write'
  const two=service.save(chain([{id:'h',type:'human',interaction:interaction()},{id:'x',type:'rest',rest:{url,method:'POST'}},{id:'y',type:'rest',rest:{url,method:'POST'}},{id:'r',type:'human',interaction:interaction('review')}],'逐节点核查')),twoRun=service.run({id:two.id})
  await waiting(twoRun,'h');submit(twoRun,'h');await waiting(twoRun,'r');const count=requests
  submit(twoRun,'r',{decision:'reject',conclusion:'需要重新核查两个接口'});await waiting(twoRun,'h');submit(twoRun,'h');await wait(()=>detail(twoRun.id).status==='paused','first replay checkpoint');assert.strictEqual(requests,count);assert.strictEqual(detail(twoRun.id).replayGuard.nodeId,'x')
  service.resume({id:twoRun.id,confirmExternal:true});await wait(()=>detail(twoRun.id).status==='paused'&&detail(twoRun.id).replayGuard.nodeId==='y','second replay checkpoint');assert.strictEqual(requests,count+1);assert.throws(()=>service.resume({id:twoRun.id}),/核查|确认|外部/)
  service.resume({id:twoRun.id,confirmExternal:true});await waiting(twoRun,'r');assert.strictEqual(requests,count+2);submit(twoRun,'r');await wait(()=>detail(twoRun.id).status==='succeeded','two external completed')

  // Retrying a completed upstream human step cannot silently replay downstream writes.
  const retryFlow=service.save(chain([{id:'h',type:'human',interaction:interaction()},{id:'x',type:'rest',rest:{url,method:'POST'}},{id:'y',type:'rest',rest:{url,method:'POST'}},{id:'r',type:'human',interaction:interaction('review')}],'重试外部操作核查')),retryRun=service.run({id:retryFlow.id})
  await waiting(retryRun,'h');submit(retryRun,'h');await waiting(retryRun,'r');const beforeRetry=requests
  service.retry({id:retryRun.id,nodeId:'h'});await waiting(retryRun,'h');submit(retryRun,'h');await wait(()=>detail(retryRun.id).status==='paused','upstream retry first external checkpoint');assert.strictEqual(requests,beforeRetry);assert.strictEqual(detail(retryRun.id).replayGuard.nodeId,'x')
  service.resume({id:retryRun.id,confirmExternal:true});await wait(()=>detail(retryRun.id).status==='paused'&&detail(retryRun.id).replayGuard.nodeId==='y','upstream retry second external checkpoint');assert.strictEqual(requests,beforeRetry+1)
  service.resume({id:retryRun.id,confirmExternal:true});await waiting(retryRun,'r');assert.strictEqual(requests,beforeRetry+2)
  // Explicit retry consent covers the selected external node only, not its descendants.
  service.retry({id:retryRun.id,nodeId:'x',confirmExternal:true});await wait(()=>detail(retryRun.id).status==='paused'&&detail(retryRun.id).replayGuard.nodeId==='y','selected retry does not authorize downstream');assert.strictEqual(requests,beforeRetry+3)
  assert.throws(()=>service.resume({id:retryRun.id}),/核查|确认|外部/);service.resume({id:retryRun.id,confirmExternal:true});await waiting(retryRun,'r');submit(retryRun,'r');await wait(()=>detail(retryRun.id).status==='succeeded','explicit retry finished');assert.strictEqual(requests,beforeRetry+4)

  // A narrower second return must retain outstanding replay checks on another branch.
  const branch=service.save({name:'分支二次退回核查',version:2,nodes:[
   {id:'s',type:'start'},{id:'h0',type:'human',interaction:interaction()},
   {id:'x',type:'rest',rest:{url,method:'POST'}},{id:'h1',type:'human',interaction:interaction()},{id:'r1',type:'human',interaction:interaction('review','h1')},{id:'end1',type:'end'},
   {id:'u',type:'template'},{id:'v',type:'template'},{id:'y',type:'rest',rest:{url,method:'POST'}},{id:'r2',type:'human',interaction:interaction('review','h0')},{id:'end2',type:'end'}
  ],edges:[{from:'s',to:'h0'},{from:'h0',to:'x'},{from:'x',to:'h1'},{from:'h1',to:'r1'},{from:'r1',to:'end1'},{from:'h0',to:'u'},{from:'u',to:'v'},{from:'v',to:'y'},{from:'y',to:'r2'},{from:'r2',to:'end2'}]}),branchRun=service.run({id:branch.id})
  await waiting(branchRun,'h0');submit(branchRun,'h0');await waiting(branchRun,'h1');submit(branchRun,'h1');await waiting(branchRun,'r1');submit(branchRun,'r1');await waiting(branchRun,'r2');const branchRequests=requests
  submit(branchRun,'r2',{decision:'reject',conclusion:'两条分支均需更新'});await waiting(branchRun,'h0');assert.deepStrictEqual(detail(branchRun.id).externalConfirm,['x','y'])
  submit(branchRun,'h0');await wait(()=>detail(branchRun.id).status==='paused'&&detail(branchRun.id).replayGuard.nodeId==='x','branch x checkpoint');service.resume({id:branchRun.id,confirmExternal:true});await waiting(branchRun,'h1');submit(branchRun,'h1');await waiting(branchRun,'r1');assert.strictEqual(requests,branchRequests+1);assert.deepStrictEqual(detail(branchRun.id).externalConfirm,['y'])
  submit(branchRun,'r1',{decision:'reject',conclusion:'仅修改当前分支的办理内容'});await waiting(branchRun,'h1');assert.deepStrictEqual(detail(branchRun.id).externalConfirm,['y'],'A narrower return cannot discard a sibling branch checkpoint')
  submit(branchRun,'h1');await waiting(branchRun,'r1');submit(branchRun,'r1');await wait(()=>detail(branchRun.id).status==='paused'&&detail(branchRun.id).replayGuard.nodeId==='y','sibling branch checkpoint survives');assert.strictEqual(requests,branchRequests+1)
  service.resume({id:branchRun.id,confirmExternal:true});await waiting(branchRun,'r2');submit(branchRun,'r2');await wait(()=>detail(branchRun.id).status==='succeeded','branched return finished');assert.strictEqual(requests,branchRequests+2)

  // Reject does not require filling the approval form; returned uploads can be reused.
  const uploads=service.save(chain([{id:'h',type:'human',interaction:interaction(),humanModes:['upload'],inputSchema:findingSchema},{id:'r',type:'human',interaction:interaction('approve'),inputSchema:findingSchema}],'退回表单附件')),uploadRun=service.run({id:uploads.id})
  await waiting(uploadRun,'h');submit(uploadRun,'h',{values:{finding:'已填写'},files:[{name:'依据.md',data:Buffer.from('依据原文').toString('base64')}]});await waiting(uploadRun,'r');const savedFile=step(uploadRun,'h').files[0]
  submit(uploadRun,'r',{decision:'reject',conclusion:'补充表单'});await waiting(uploadRun,'h');assert.deepStrictEqual(step(uploadRun,'h').partialData,{finding:'已填写'});assert.strictEqual(step(uploadRun,'h').returnFiles[0].ref,savedFile.ref)
  assert.throws(()=>submit(uploadRun,'h',{values:{finding:'更正'},reuseFiles:['other/task/0']}),/附件/)
  submit(uploadRun,'h',{values:{finding:'已更正'},reuseFiles:[savedFile.ref]});await waiting(uploadRun,'r');assert.strictEqual(step(uploadRun,'h').files[0].ref,savedFile.ref);submit(uploadRun,'r',{decision:'approve',values:{finding:'同意'}});await wait(()=>detail(uploadRun.id).status==='succeeded','reused upload completed')
  console.log('Workflow interaction: handle/review/approval presets, minimal submission, Schema validation, durable real returns, explicit targets, instance isolation, attempt/artifact history, legacy requirements and external-side-effect replay checkpoints passed')
 }finally{if(host)await host.dispose();if(endpoint)await new Promise(resolve=>endpoint.close(resolve));fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
