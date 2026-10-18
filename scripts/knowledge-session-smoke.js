'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),{Knowledge}=require('../src/main/knowledge/service')
async function main(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'kb-sessions-'));let kb=new Knowledge(home);try{
 const a=(await kb.create({name:'A'})).id,b=(await kb.create({name:'B'})).id
 const one=await kb.bindSession({sessionId:'session_one',baseId:a,title:'会话一'}),two=await kb.bindSession({sessionId:'session_two',baseId:a,title:'会话二'}),three=await kb.bindSession({sessionId:'session_three',baseId:b,title:'会话三'})
 fs.writeFileSync(path.join(one.workspaceRoot,'same.md'),'one');fs.writeFileSync(path.join(two.workspaceRoot,'same.md'),'two');fs.writeFileSync(path.join(three.workspaceRoot,'same.md'),'three')
 await assert.rejects(kb.bindSession({sessionId:'session_one',baseId:b}),/ALREADY_BOUND/);await assert.rejects(kb.bindSession({sessionId:'session_conflict',baseId:b,projectId:'project'}),/CONFLICT/)
 assert.strictEqual((await kb.sessionTree({baseId:a,sessionId:'session_one'})).items.length,1)
 await assert.rejects(kb.sessionTree({baseId:b,sessionId:'session_one'}),/NOT_LINKED/)
 await assert.rejects(kb.sessionPreview({baseId:a,sessionId:'session_one',path:path.join(two.workspaceRoot,'same.md')}),/OUTSIDE/)
 const material=await kb.importBuffer({baseId:a,name:'独立资料.md'},Buffer.from('不能删除的资料'));for(let i=0;i<100;i++){if((await kb.list()).jobs.find(j=>j.id===material.id).phase==='ready')break;await new Promise(r=>setTimeout(r,20))}
 const found=await kb.searchSession({query:'不能删除'},one.workspaceRoot);assert(found.items.length);assert.strictEqual((await kb.searchSession({query:'不能删除'},three.workspaceRoot)).items.length,0);assert((await kb.sourceSession({id:found.items[0].sourceId},one.workspaceRoot)).text.includes('不能删除'));
 await kb.close();kb=new Knowledge(home);assert.strictEqual((await kb.sessionContext('session_two')).base_id,a)
 const {AgentPool}=require('../src/main/agent/agent-pool');let seen='';const worker={workspaceRoot:'',run:async function(){seen=this.workspaceRoot},dispose:async()=>{}};const settings={data:{workspacePath:home},update:()=>{}};const host={get:name=>name==='knowledge'?kb:name==='agents'?{create:()=>worker}:null};const pool=new AgentPool({settings,sessionRoot:path.join(home,'sessions'),pluginHost:host});await pool.run('session_one','test');assert.strictEqual(seen,one.workspaceRoot);pool.setWorkspace(home);assert.strictEqual(worker.workspaceRoot,one.workspaceRoot);
 await kb.deleteSession({sessionId:'session_one'});await kb.deleteSession({sessionId:'session_one'});assert(!fs.existsSync(one.workspaceRoot));assert.strictEqual(fs.readFileSync(path.join(two.workspaceRoot,'same.md'),'utf8'),'two');assert.strictEqual(fs.readFileSync(path.join(three.workspaceRoot,'same.md'),'utf8'),'three')
 assert((await kb.list()).documents.some(d=>d.id===material.documentId));assert(!(await kb.list()).sessions.some(s=>s.id==='session_one'));await assert.rejects(kb.sessionContext('session_one'),/DELETED/);await assert.rejects(kb.bindSession({sessionId:'session_one',baseId:a}),/ALREADY_BOUND/);await assert.rejects(kb.deleteSession({sessionId:'../session_two'}),/INVALID/)
 console.log('Knowledge sessions: durable associations, mutually exclusive binding, owned workspaces, same-name file isolation, scoped preview, idempotent exact-session deletion and material retention passed')
 }finally{await kb.close();fs.rmSync(home,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exit(1)})
