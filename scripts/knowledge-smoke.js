'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os')
const {Knowledge}=require('../src/main/knowledge/service'),{Repository,sql}=require('../src/main/knowledge/repository'),{PluginHost}=require('../src/main/plugins/plugin-host'),{Settings}=require('../src/main/agent/settings')
const http=require('http'),{Agent}=require('../src/main/agent/agent')
const {createWord,createSheet}=require('../src/main/mcp/documents/ooxml'),{writeZip}=require('../src/main/mcp/documents/zip')
const sleep=ms=>new Promise(r=>setTimeout(r,ms))
async function wait(fn){for(let i=0;i<300;i++){if(await fn())return;await sleep(30)}throw Error('KNOWLEDGE_TEST_TIMEOUT')}
async function main(){const home=fs.mkdtempSync(path.join(os.tmpdir(),'知识库-')),scope=path.join(home,'项目'),settings=new Settings(home);fs.mkdirSync(scope);settings.update({workspacePath:scope,permissionMode:'readonly'});let kb=new Knowledge(home),host
 try{
  await kb.ready();const repo=kb.repo;assert.strictEqual((await repo.query('SELECT sqlite_version() AS version;'))[0].version,'3.54.0');assert.strictEqual((await repo.query('PRAGMA foreign_keys;'))[0].foreign_keys,'1')
  const conflict=new Repository(home);await assert.rejects(conflict.open(),/OWNER_LOCKED/)
  const id=(await kb.create({name:'研发资料'})).id
  const imported=await kb.importBuffer({baseId:id,name:'规范.md'},Buffer.from('# 存储规范\n知识库采用 SQLite 数据库。\n更新失败保留旧版本。\n'))
  await wait(async()=> (await kb.list()).jobs.find(j=>j.id===imported.id).phase==='ready')
  assert.strictEqual((await kb.search({query:'数据库'},scope)).items.length,0)
  const manual=await kb.searchBase({baseId:id,query:'数据库'});assert(manual.items.length);assert((await kb.sourceBase({baseId:id,id:manual.items[0].sourceId})).text.includes('SQLite'));const emptyBase=(await kb.create({name:'空资料库'})).id;await assert.rejects(kb.sourceBase({baseId:emptyBase,id:manual.items[0].sourceId}),/UNAVAILABLE/)
  await kb.bind({id,scopes:[scope,'/second-project']});assert((await kb.search({query:'数据库'},'/second-project')).items.length);assert.strictEqual((await kb.list()).bases.find(b=>b.id===id).scopes.length,2);await kb.bind({id,scopes:[scope]});assert.strictEqual((await kb.search({query:'数据库'},'/second-project')).items.length,0)
  await assert.rejects(kb.tree({baseId:id,root:'/not-linked'}),/NOT_LINKED/);const tree=await kb.tree({baseId:id,root:scope});assert(Array.isArray(tree.items));await assert.rejects(kb.projectPreview({baseId:id,root:scope,path:home}),/OUTSIDE/);
  await kb.bind({id,scope});const found=await kb.search({query:'数据库'},scope);assert(found.items.length);const source=found.items[0].sourceId;assert((await kb.source({id:source},scope)).text.includes('SQLite'))
  assert.strictEqual((await kb.search({query:'数据库'},'/other')).items.length,0);await assert.rejects(kb.source({id:source},'/other'),/UNAVAILABLE/)
  const broken=await kb.importBuffer({baseId:id,documentId:imported.documentId,name:'损坏.docx'},Buffer.from('bad zip'))
  await wait(async()=> (await kb.list()).jobs.find(j=>j.id===broken.id).phase==='failed');assert((await kb.search({query:'数据库'},scope)).items.length)
  await assert.rejects(kb.importBuffer({baseId:id,name:'a.pdf'},Buffer.from('x')),/UNSUPPORTED/)
  const word=await kb.importBuffer({baseId:id,name:'报告.docx'},writeZip(createWord({paragraphs:[{text:'离线检索与来源定位'}]})))
  const sheet=await kb.importBuffer({baseId:id,name:'预算.xlsx'},writeZip(createSheet({sheets:[{name:'预算',cells:[{cell:'A1',value:'年度预算'},{cell:'B1',value:123}]}]})))
  await wait(async()=>{const s=await kb.list();return [word.id,sheet.id].every(id=>s.jobs.find(j=>j.id===id).phase==='ready')})
  assert((await kb.search({query:'年度预算'},scope)).items.some(i=>i.locator.cell==='A1'));assert((await kb.search({query:'离线检索'},scope)).items.length)
  const cancelled=await kb.importBuffer({baseId:id,name:'取消.txt'},Buffer.from('此资料不应发布'));await kb.cancel({id:cancelled.id});assert.strictEqual((await kb.list()).jobs.find(j=>j.id===cancelled.id).phase,'cancelled')
  await kb.repo.query("UPDATE bases SET scope='/legacy-project' WHERE id='"+emptyBase+"';PRAGMA user_version=1;");
  await kb.close();kb=new Knowledge(home);await kb.ready();assert((await kb.list()).bases.find(b=>b.id===emptyBase).scopes.includes('/legacy-project'));assert.strictEqual(Number((await kb.repo.query('PRAGMA user_version;'))[0].user_version),3);assert((await kb.search({query:'数据库'},scope)).items.length)
  await kb.close();host=new PluginHost({workspaceRoot:scope,settings});await host.ready();const k=host.get('knowledge');assert((await host.executeTool('knowledge_search',{query:'数据库'},{workspaceRoot:scope,settings:settings.data})).includes('SQLite'))
  let calls=0,returnedSource='';const model=http.createServer((request,response)=>{let body='';request.on('data',c=>body+=c);request.on('end',()=>{const value=JSON.parse(body);calls++;let delta;if(calls===1)delta={tool_calls:[{index:0,id:'search_knowledge',type:'function',function:{name:'knowledge_search',arguments:JSON.stringify({query:'数据库'})}}]};else{const result=JSON.parse(value.messages.find(m=>m.role==='tool').content);returnedSource=result.items[0].sourceId;delta={content:'资料使用 SQLite。[来源:'+returnedSource+']'}}response.writeHead(200,{'content-type':'text/event-stream'});response.end('data: '+JSON.stringify({choices:[{delta,finish_reason:calls===1?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')})});await new Promise(r=>model.listen(0,'127.0.0.1',r));settings.update({baseURL:'http://127.0.0.1:'+model.address().port+'/v1',apiKey:'test',model:'mock'});const agent=new Agent(settings,()=>{},async()=>true,path.join(home,'sessions'),host);agent.workspaceRoot=scope
  try{await agent.run('搜索资料说明数据库');assert.strictEqual(calls,2);assert(JSON.parse(fs.readFileSync(path.join(home,'sessions','last-session.json'),'utf8')).messages.some(m=>m.role==='assistant'&&String(m.content).includes('[来源:'+returnedSource+']')));assert(fs.existsSync(path.join(home,'sessions','last-session.json')))}finally{await agent.dispose();await new Promise(r=>model.close(r))}
  await k.bind({id,scope:''});assert.strictEqual((await k.search({query:'数据库'},scope)).items.length,0);await assert.rejects(k.source({id:source},scope),/UNAVAILABLE/)
  await k.bind({id,scope});await k.remove({id:imported.documentId});assert.strictEqual((await k.search({query:'数据库'},scope)).items.length,0);await assert.rejects(k.source({id:source},scope),/UNAVAILABLE/)
  const hostile="x');DROP TABLE bases;--";assert.strictEqual((await k.repo.query('SELECT '+sql(hostile)+' AS value;'))[0].value,hostile)
  await assert.rejects(k.repo.query("BEGIN IMMEDIATE;INSERT INTO bases VALUES('rollback','x','',0);INSERT INTO absent VALUES(1);COMMIT;"));assert.strictEqual((await k.repo.query("SELECT * FROM bases WHERE id='rollback';")).length,0)
  console.log('Knowledge: SQLite transactions/rollback, ownership, UTF-8 paths, import, Chinese FTS, DOCX/XLSX, version retention, restart, Cordis tools, revocation/deletion passed')
 }finally{if(host)await host.dispose();else await kb.close();fs.rmSync(home,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exit(1)})
