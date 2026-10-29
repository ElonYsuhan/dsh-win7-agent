'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto')
const {PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings'),{pack,inspect}=require('../src/main/extensions/archive')
const skillId='01-app-builtin/workflow-process-designer',directory=path.resolve('src/main/agent/md-skills',skillId),example=require('../src/main/agent/md-skills/01-app-builtin/workflow-process-designer/references/approval-example.json')
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function wait(fn,label){for(let i=0;i<300;i++){if(fn())return;await sleep(10)}throw Error('Process skill timeout: '+label)}
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-process-skill-'));let host
 try{
  const provenance=JSON.parse(fs.readFileSync(path.join(directory,'provenance.json')))
  assert.strictEqual(provenance.upstream.repository,'https://github.com/camunda/skills');assert(/^[a-f0-9]{40}$/.test(provenance.upstream.commit));assert.strictEqual(provenance.upstream.license,'Apache-2.0')
  assert.strictEqual(crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'LICENSE.txt'))).digest('hex'),provenance.upstream.licenseSha256)
  const bundle=path.join(home,'workflow-process-designer.skill.pgk');pack(directory,bundle);const checked=inspect(fs.readFileSync(bundle));assert.strictEqual(checked.manifest.type,'skill');assert(checked.files.has('references/approval-example.json'));assert(checked.files.has('LICENSE.txt'));assert(checked.files.has('NOTICE.txt'))
  const settings=new Settings(home);host=new PluginHost({workspaceRoot:home,settings});await host.ready()
  const library=host.get('skillLibrary'),guide=library.read(skillId);assert(guide.ok&&!guide.truncated);assert(guide.text.length<14000)
  for(const match of guide.text.matchAll(/\]\((references\/[^)]+)\)/g))assert(library.read(skillId,match[1]).ok,'Offline reference '+match[1])
  const tools=host.get('tools'),context={settings:{permissionMode:'workspace'},signal:new AbortController().signal}
  const catalog=JSON.parse(await tools.execute('workflow_catalog',{},context));assert.strictEqual(catalog.designGuide.id,skillId);assert(catalog.designGuide.available);assert(catalog.designGuide.text.includes('OMG BPMN 2.0.2'))
  const draft=JSON.parse(await tools.execute('workflow_create_draft',{definition:JSON.stringify(example)},context)).workflowDraft,service=host.get('workflows'),run=service.run({id:draft.id})
  const detail=()=>service.detail({id:run.id}),step=id=>detail().steps.find(value=>value.id===id),waiting=async id=>{await wait(()=>detail().status==='waiting'&&step(id).status==='waiting',id);return step(id)}
  const submit=(id,values={})=>service.submit({id:run.id,nodeId:id,taskId:step(id).taskId,...values})
  await waiting('application');submit('application',{values:{request:'初次申请'}})
  const oldCheck=(await waiting('material_check')).taskId;submit('material_check',{decision:'reject',conclusion:'缺少依据，请申请人补正'})
  await waiting('application');assert.strictEqual(step('application').attempt,2);assert.strictEqual(step('application').partialData.request,'初次申请')
  assert.throws(()=>service.submit({id:run.id,nodeId:'material_check',taskId:oldCheck,decision:'reject',conclusion:'重复操作'}),/过期|处理/)
  submit('application',{values:{request:'第二版补充依据'}});await waiting('material_check');submit('material_check')
  await waiting('approval');assert.strictEqual(detail().interactionViews.approval.returnTargetId,'application','Approval goes to the applicant, not simply the previous reviewer')
  submit('approval',{decision:'reject',conclusion:'审批依据仍需修改，重新提交'})
  await waiting('application');assert.strictEqual(step('application').attempt,3);assert.strictEqual(step('material_check').status,'pending');assert.strictEqual(step('approval').status,'pending')
  submit('application',{values:{request:'第三版：已补全审批依据'}});await waiting('material_check');submit('material_check');await waiting('approval');submit('approval',{decision:'approve'})
  await wait(()=>detail().status==='succeeded','approved deliverable');assert(detail().artifacts.length>0);assert.strictEqual(service.list().workflows.length,1);assert.strictEqual(service.list().runs.length,1)
  const current=JSON.parse(await tools.execute('workflow_read_draft',{workflowId:draft.id},context)).workflowDraft
  await tools.execute('workflow_update_draft',{workflowId:current.id,revision:current.revision,definition:JSON.stringify({...current,description:current.description+' 补充角色说明。'})},context)
  assert.strictEqual(service.list().workflows.length,1);assert.strictEqual(detail().workflow.revision,current.revision,'A draft revision cannot mutate an existing instance')
  settings.update({disabledSkills:[skillId]});const disabled=JSON.parse(await tools.execute('workflow_catalog',{},context));assert.strictEqual(disabled.designGuide.available,false);assert(!disabled.designGuide.text)
  console.log('Process design Skill passed: licensed pinned provenance, offline package/references, Cordis catalog injection/disable, real material rejection + approval rejection + resubmission, old task refusal, final deliverable and same-ID draft revision')
 }finally{if(host)await host.dispose();fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
