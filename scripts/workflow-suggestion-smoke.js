'use strict'
/* 流程匹配推荐：内置判断技能、流程清单索引、只读推荐工具与其副作用边界。 */
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os')
const {PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings')
const library=require('../src/main/agent/md-skills')
const skillId='01-app-builtin/workflow-suggestion'
async function main(){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'agent-workflow-suggest-'));let host
 try{
  const guide=library.read(skillId)
  assert(guide.ok&&!guide.truncated,'Bundled workflow-suggestion skill must be readable')
  assert(guide.text.includes('workflow_suggest')&&guide.text.includes('workflow_catalog'),'Skill teaches the matching gates and the tools to use')
  assert(guide.text.includes('四道关'),'Skill states the four-way fit check')
  assert(library.systemPromptBlock().includes(skillId),'Skill index must advertise the suggestion skill to the model')

  const settings=new Settings(home);host=new PluginHost({workspaceRoot:home,settings});await host.ready()
  const tools=host.get('tools'),service=host.get('workflows'),context={settings:{permissionMode:'workspace'},signal:new AbortController().signal}
  const definition={name:'周报汇总',description:'收集本周进展并生成周报',nodes:[{id:'s',type:'start',text:'本周进展'},{id:'h',type:'human',title:'整理素材',interaction:{version:1,type:'handle',returnTo:'previous-human'}},{id:'e',type:'end',deliverable:{format:'markdown',name:'周报'}}],edges:[{from:'s',to:'h'},{from:'h',to:'e'}]}
  const draft=JSON.parse(await tools.execute('workflow_create_draft',{definition:JSON.stringify(definition)},context)).workflowDraft

  const catalog=JSON.parse(await tools.execute('workflow_catalog',{},context))
  const listed=catalog.workflows.find(workflow=>workflow.id===draft.id)
  assert(listed,'Catalog exposes saved workflows for matching')
  assert.strictEqual(listed.name,'周报汇总')
  assert.strictEqual(listed.humanSteps,1,'Catalog reports human checkpoints so approvals can be matched')
  assert.deepStrictEqual(listed.steps,['整理素材'],'Catalog reports step titles')

  const result=JSON.parse(await tools.execute('workflow_suggest',{workflowId:draft.id,reason:'覆盖整理素材与出稿两步',matches:['goal','steps','deliverable']},context))
  assert.strictEqual(result.suggestion.workflowId,draft.id)
  assert.strictEqual(result.suggestion.name,'周报汇总')
  assert.deepStrictEqual(result.suggestion.matches,['goal','steps','deliverable'])
  await assert.rejects(()=>tools.execute('workflow_suggest',{workflowId:draft.id,reason:'覆盖',matches:['goal','猜测']},context),/enum/,'Unknown match keys are rejected by the tool contract')
  assert.strictEqual(service.list().runs.length,0,'A suggestion never starts a workflow run')
  assert.strictEqual(service.list().workflows.length,1,'A suggestion never mutates workflow definitions')

  await assert.rejects(()=>tools.execute('workflow_suggest',{workflowId:'missing',reason:'名称相似'},context),/流程不存在/)
  await assert.rejects(()=>tools.execute('workflow_suggest',{workflowId:draft.id,reason:'   '},context),/匹配依据/)
  await assert.rejects(()=>tools.execute('workflow_suggest',{workflowId:draft.id},context),/reason|required|缺少|必需|invalid/i)

  const denied=await tools.execute('workflow_suggest',{workflowId:draft.id,reason:'无人值守'},{settings:{unattended:{tools:[],skillIds:[]}},signal:context.signal})
  assert(String(denied).indexOf('DENIED')===0,'Unattended tasks cannot present suggestions')
  console.log('Workflow suggestion passed: bundled matching skill, catalog workflow index with human checkpoints, read-only suggestion tool, dropped unknown match keys, guarded inputs and no execution side effects')
 }finally{if(host)await host.dispose();fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
