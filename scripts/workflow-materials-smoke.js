'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),{PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings'),C=require('../src/main/contracts/workflows'),M=require('../src/main/contracts/workflow-materials'),P=require('../src/main/flow/workflow-policy')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(30)}throw Error('MATERIAL_TEST_TIMEOUT')}
async function main(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-materials-'));let host;try{
 host=new PluginHost({workspaceRoot:home,settings:new Settings(home)});host.loadBuiltins();await host.ready();const workflows=host.get('workflows'),knowledge=host.get('knowledge'),nodes=host.get('workflowNodes')
 const base=await knowledge.create({name:'执行资料'}),job=await knowledge.importBuffer({baseId:base.id,name:'数据.md'},Buffer.from('知识库原文一：任务资料ABC'))
 await wait(async()=>(await knowledge.list()).documents.some(d=>d.id===job.documentId&&d.active))
 const linked=await workflows.importMaterial({source:'knowledge',baseId:base.id,documentId:job.documentId}),binary=Buffer.from([0,255,1,20,128]),local=await workflows.importMaterial({source:'local',name:'依据.bin',data:binary.toString('base64')})
 assert.strictEqual(linked.source.type,'knowledge');assert.strictEqual(linked.source.baseId,base.id)
 const empty={name:'资料测试',nodes:[{id:'start',type:'start',text:'执行目标'},{id:'probe',type:'material_probe'},{id:'end',type:'end'}],edges:[{from:'start',to:'probe'},{from:'probe',to:'end'}],materials:[linked,local]}
 const seen=[];const unregister=nodes.register({type:'material_probe',name:'资料验证'},async request=>{seen.push(request);return '资料已接收：'+request.input})
 const flow=workflows.save(empty);assert.strictEqual(flow.materials.length,2);assert.throws(()=>C.validate({...empty,materials:[{...local,name:'../escape'}]},nodes.definitions));assert.throws(()=>M.list([local,local]));assert.throws(()=>workflows.save({...empty,id:undefined,materials:[{...local,hash:'f'.repeat(64)}]}),/校验/)
 await knowledge.importBuffer({baseId:base.id,documentId:job.documentId,name:'数据.md'},Buffer.from('知识库原文二：新版本不改变流程快照'))
 await wait(async()=>(await knowledge.list()).documents.find(d=>d.id===job.documentId).active!==linked.source.versionId)
 await knowledge.removeBase({id:base.id});const run=workflows.run({id:flow.id});await wait(()=>workflows.detail({id:run.id}).status==='succeeded');const detail=workflows.detail({id:run.id})
 assert(detail.steps[0].output.includes('知识库原文一'));assert(!detail.steps[0].output.includes('知识库原文二'));assert.strictEqual(seen[0].files.length,2)
 const refs=P.inputFiles(detail.workflow,detail.steps,'probe',detail.materials);assert.strictEqual(refs.length,2)
 const {Repository}=require('../src/main/workflows/repository'),repository=new Repository(home),workdir=repository.workspace(run.id,'probe',1,'input',refs)
 assert.deepStrictEqual(fs.readFileSync(path.join(workdir,'attachment-1.bin')),binary)
 const toolFlow=workflows.save({name:'工具读取资料原件',materials:[linked],nodes:[{id:'s',type:'start'},{id:'read',type:'tool',tool:{name:'read_file',arguments:{path:'attachment-0.md'},permission:'readonly'}},{id:'e',type:'end'}],edges:[{from:'s',to:'read'},{from:'read',to:'e'}]});const toolRun=workflows.run({id:toolFlow.id,confirmed:true});await wait(()=>workflows.detail({id:toolRun.id}).status==='succeeded');assert(workflows.detail({id:toolRun.id}).steps[1].output.includes('知识库原文一'),'Real tool reads snapshotted original from the instance workspace')
 const changed=workflows.save({...flow,materials:[]});assert.strictEqual(changed.materials.length,0);assert.strictEqual(workflows.detail({id:run.id}).materials.length,2)
 await unregister();await host.dispose();host=null
 host=new PluginHost({workspaceRoot:home,settings:new Settings(home)});host.loadBuiltins();await host.ready();assert.strictEqual(host.get('workflows').detail({id:run.id}).materials[0].source.versionId,linked.source.versionId)
 host.get('workflowNodes').register({type:'material_probe',name:'资料验证'},async()=> 'ok');const blob=path.join(home,'workflows','materials',local.id);fs.writeFileSync(blob,'corrupt');assert.throws(()=>host.get('workflows').save({...changed,materials:[local]}),/校验/)
 console.log('Workflow materials: validated handles, real knowledge version snapshot, deleted-source survival, binary fidelity, pure propagation, immutable run facts, removal, restart and tamper rejection passed')
 }finally{if(host)await host.dispose();fs.rmSync(home,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exitCode=1})
