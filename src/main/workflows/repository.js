'use strict'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),Artifacts=require('../contracts/workflow-artifacts'),S=require('../state/workflow-state'),C=require('../contracts/workflows')
const {visitJsonLines}=require('../persistence/jsonl')
class Repository{
 constructor(home){this.dir=path.join(home,'workflows');this.materials=new(require('./materials').Materials)(this.dir);this.runs=new Map();this.details=new Map();this.detailBytes=0;this.definitions=[];this.opened=false}
 open(){if(this.opened)return;fs.mkdirSync(this.dir,{recursive:true});this.lock=path.join(this.dir,'owner.json');try{this.fd=fs.openSync(this.lock,'wx')}catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(fs.readFileSync(this.lock,'utf8'));process.kill(owner.pid,0)}catch(error){if(error.code==='ESRCH'){fs.unlinkSync(this.lock);return this.open()}throw Error('WORKFLOW_STORAGE_LOCKED')}throw Error('WORKFLOW_STORAGE_LOCKED')}
 try{fs.writeFileSync(this.fd,JSON.stringify({pid:process.pid}));this.opened=true;const file=path.join(this.dir,'definitions.json');let saved={version:1,workflows:[]};if(fs.existsSync(file)){try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){saved=JSON.parse(fs.readFileSync(file+'.bak','utf8'))}}if(saved.version!==1||!Array.isArray(saved.workflows))throw Error('WORKFLOW_STORAGE_VERSION');this.definitions=saved.workflows.map(w=>({...C.validate(w,null),revision:Number(w.revision)||1}));fs.mkdirSync(path.join(this.dir,'runs'),{recursive:true});for(const name of fs.readdirSync(path.join(this.dir,'runs'))){if(!/^[a-zA-Z0-9_-]+\.jsonl$/.test(name))continue;const state=this.readRun(name.slice(0,-6),true);if(state)this.runs.set(state.id,this.index(state))}for(const run of this.runs.values())if(['pending','running'].includes(run.status))this.append(run.id,{type:'finished',status:'interrupted',error:'服务重启，未自动重放执行'})}catch(e){this.close();throw e}}
 save(){const file=path.join(this.dir,'definitions.json'),tmp=file+'.tmp',data=JSON.stringify({version:1,workflows:this.definitions});if(fs.existsSync(file))fs.copyFileSync(file,file+'.bak');const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
 append(id,event){C.id(id);const prior=this.getRun(id),fact={...event,version:1,sequence:prior?prior.sequence+1:1,at:Date.now()},state=S.reduce(prior,fact),fd=fs.openSync(path.join(this.dir,'runs',id+'.jsonl'),'a');try{fs.writeSync(fd,JSON.stringify(fact)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}this.dropDetail(id);this.runs.set(id,this.index(state));return state}
 index(state){
  if(['pending','running'].includes(state.status))return state
  const {id,workflowId,name,revision,status,sequence,createdAt,startedAt,endedAt,error,trigger}=state
  return {id,workflowId,name,revision,status,sequence,createdAt,startedAt,endedAt,error,...(trigger?{trigger}:{}),deliveryCount:Artifacts.deliverables(state).filter(a=>a.status!=='skipped').length,artifactCount:Artifacts.current(state).length||state.steps.filter(s=>s.artifact).length,steps:state.steps.map(({id,title,status,startedAt,endedAt})=>({id,title,status,startedAt,endedAt}))}
 }
 readRun(id,repair){
  const file=path.join(this.dir,'runs',C.id(id)+'.jsonl')
  let state
  visitJsonLines(file,repair,event=>{state=S.reduce(state,event)})
  return state
 }
 dropDetail(id){const old=this.details.get(id);if(old){this.detailBytes-=old.bytes;this.details.delete(id)}}
 getRun(id){
  const indexed=this.runs.get(id);if(!indexed||indexed.workflow)return indexed
  const cached=this.details.get(id);if(cached){this.details.delete(id);this.details.set(id,cached);return cached.state}
  const state=this.readRun(id,false),bytes=JSON.stringify(state).length*2
  if(bytes<=8*1024*1024){while(this.details.size&&(this.detailBytes+bytes>8*1024*1024||this.details.size>=8))this.dropDetail(this.details.keys().next().value);this.details.set(id,{state,bytes});this.detailBytes+=bytes}
  return state
 }
 upload(run,task,files){
  C.id(run);C.id(task)
  const dir=path.join(this.dir,'uploads',run,task);fs.mkdirSync(dir,{recursive:true})
  return files.map((file,index)=>{
   const bytes=Buffer.from(file.data,'base64'),key=String(index),target=path.join(dir,key);if(bytes.toString('base64')!==file.data)throw Error('附件编码无效')
   const fd=fs.openSync(target,'w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
   const text=/\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name)?bytes.toString('utf8').slice(0,16000):''
   return {name:file.name,size:bytes.length,ref:run+'/'+task+'/'+key,text}
  })
 }
 artifactFile(run,node,attempt=1){return path.join(this.dir,'artifacts',C.id(run),C.id(node)+(attempt>1?'-attempt-'+attempt:'')+'.txt')}
 workspace(run,node,attempt,input,files=[]){if(!Array.isArray(files)||files.length>360)throw Error('附件数量超过流程上限');const dir=path.join(this.dir,'agent-workspaces',C.id(run),C.id(node),String(attempt));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'input.txt'),input+'\n\n附件清单：\n'+files.map((file,index)=>'attachment-'+index+path.extname(file.name)+' ← '+file.name).join('\n'),'utf8');for(const [index,file]of files.entries()){if(typeof file.ref!=='string'||!file.ref.startsWith(run+'/')||!new RegExp('^[A-Za-z0-9_-]+/[A-Za-z0-9_-]+/[0-9]+$').test(file.ref))throw Error('附件引用不属于当前实例');const source=path.join(this.dir,'uploads',file.ref),target=path.join(dir,'attachment-'+index+path.extname(file.name));fs.copyFileSync(source,target)}return dir}
 artifact(run,node,text,attempt=1){const file=this.artifactFile(run,node,attempt),dir=path.dirname(file),tmp=file+'.tmp';fs.mkdirSync(dir,{recursive:true});const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);return path.basename(file)}
 drafts(run,workflow){
  const dir=path.join(this.dir,'drafts',C.id(run));fs.mkdirSync(dir,{recursive:true})
  if(fs.realpathSync(dir)!==path.join(fs.realpathSync(this.dir),'drafts',run))throw Error('产物草稿路径无效')
  return Artifacts.planned(workflow).map(item=>{const id=crypto.createHash('sha256').update(run+':draft:'+item.nodeId+':'+item.index).digest('hex').slice(0,32);if(item.status==='planned')return{...item,id};const file=id+'.'+item.format,target=path.join(dir,file);let fd
   try{fd=fs.openSync(target,'wx');fs.writeFileSync(fd,item.format==='json'?'{}':'','utf8');fs.fsyncSync(fd)}catch(e){if(e.code!=='EEXIST')throw e}finally{if(fd!==undefined)fs.closeSync(fd)}
   if(fs.realpathSync(target)!==path.join(fs.realpathSync(dir),file)||!fs.statSync(target).isFile()||fs.statSync(target).size>1024*1024)throw Error('产物草稿文件无效')
   const bytes=fs.readFileSync(target);if(bytes.toString('utf8')!==(item.format==='json'?'{}':''))throw Error('初始草稿内容无效');return{...item,id,file,size:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')}
  })
 }
 // Files are copied into an instance-owned immutable attempt directory before facts publish them.
 deliveries(run,node,text,attempt){
  const spec=Artifacts.declaration(node.deliverable),items=[],sources=[]
  if(spec.format==='files')for(const file of spec.files){
   const step=run.steps.find(s=>s.id===file.nodeId);if(!step||step.status!=='succeeded')throw Error('产物来源节点尚未完成：'+file.nodeId)
   const uploaded=(step.files||[]).find(f=>f.name===file.path),ref=uploaded&&uploaded.ref
   if(ref&&(typeof ref!=='string'||!ref.startsWith(run.id+'/')||!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[0-9]+$/.test(ref)))throw Error('产物附件不属于当前实例')
   const root=uploaded?path.join(this.dir,'uploads',C.id(run.id)):path.join(this.dir,'agent-workspaces',C.id(run.id),C.id(step.id),String(step.attempt||1))
   const ownedRoot=path.join(fs.realpathSync(this.dir),path.relative(this.dir,root));if(fs.realpathSync(root)!==ownedRoot)throw Error('产物文件超出节点工作目录');
   const source=uploaded?path.join(this.dir,'uploads',ref):path.join(root,...file.path.split('/')),relative=path.relative(fs.realpathSync(root),fs.realpathSync(source)),stat=fs.statSync(source)
   if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||!stat.isFile())throw Error('产物文件超出节点工作目录')
   if(stat.size>64*1024*1024)throw Error('单个产物不能超过64MB');sources.push({source,name:uploaded?uploaded.name:path.basename(source),sourceNodeId:file.nodeId,size:stat.size})
  }
  if(sources.reduce((n,f)=>n+f.size,0)+Artifacts.current(run).reduce((n,a)=>n+(a.size||0),0)>256*1024*1024)throw Error('本次交付不能超过256MB')
  const dir=path.join(this.dir,'artifacts',C.id(run.id));fs.mkdirSync(dir,{recursive:true})
  if(spec.format!=='files'){
   let content=text;if(spec.field){const value=require('../contracts/workflow-schema').pathValue(JSON.parse(text),spec.field);if(value===undefined)throw Error('缺少最终产物字段：'+spec.field);content=typeof value==='string'?value:JSON.stringify(value)}if(spec.format==='json'){try{content=JSON.stringify(JSON.parse(content),null,2)}catch(_){throw Error('JSON 交付内容不是有效 JSON')}}
   if(!content.trim())content='# '+run.name+' 执行结果\n\n'+run.steps.filter(s=>s.status==='succeeded').map(s=>'## '+s.title+'\n'+(s.output||s.conclusion||'该步骤已完成')).join('\n\n')
   const ext={text:'.txt',markdown:'.md',json:'.json'}[spec.format],name=Artifacts.filename(node)
   // Keep legacy .txt locations readable by old clients.
   const file=spec.format==='text'?this.artifactFile(run.id,node.id,attempt):path.join(dir,node.id+'-attempt-'+attempt+ext)
   const temp=file+'.tmp',fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,content);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file)
   sources.push({source:file,name,size:fs.statSync(file).size,stored:true})
  }
  for(const [index,source]of sources.entries()){
   const key=node.id+'-attempt-'+attempt+'-file-'+index,name=source.name
   const file=source.stored?source.source:path.join(dir,crypto.createHash('sha256').update(key).digest('hex').slice(0,32)+path.extname(name)),temp=file+'.tmp'
   if(!source.stored){fs.copyFileSync(source.source,temp);const fd=fs.openSync(temp,'r+');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(temp,file)}
   if(fs.statSync(file).size>64*1024*1024)throw Error('单个产物不能超过64MB');const hash=crypto.createHash('sha256'),fd=fs.openSync(file,'r'),buffer=Buffer.alloc(64*1024);let size=0,count
   try{while((count=fs.readSync(fd,buffer,0,buffer.length,null))){hash.update(buffer.subarray(0,count));size+=count;if(size>64*1024*1024)throw Error('单个产物不能超过64MB')}}finally{fs.closeSync(fd)}
   if(size!==source.size)throw Error('产物生成期间文件发生变化，请重试')
   items.push({id:crypto.createHash('sha256').update(run.id+':'+key).digest('hex').slice(0,32),name,size,sha256:hash.digest('hex'),file:path.basename(file),sourceNodeId:source.sourceNodeId||node.id,format:path.extname(name).slice(1).toLowerCase()||'file',createdAt:Date.now()})
  }
  return items
 }
 artifactEntry(run,key){
  C.id(key);let item=Artifacts.current(run).find(a=>a.id===key),draft=false;if(!item){item=(run.plannedArtifacts||[]).find(a=>a.id===key);draft=!!item;if(item&&item.status==='planned')throw Error('该交付文件尚未生成')}
  if(!item){const step=run.steps.find(s=>s.artifact&&s.id===key);if(step)item={id:step.id,name:step.artifact,file:path.basename(this.artifactFile(run.id,step.id,step.attempt||1)),nodeId:step.id,attempt:step.attempt||1}}
  if(!item)throw Error('产物不存在或不属于当前实例')
  const area=draft?'drafts':'artifacts',root=path.join(this.dir,area,C.id(run.id)),target=path.join(root,item.file),relative=path.relative(fs.realpathSync(root),fs.realpathSync(target))
  if(fs.realpathSync(root)!==path.join(fs.realpathSync(this.dir),area,run.id))throw Error('产物路径无效')
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('产物路径无效')
  return {item:{...item,status:draft?'draft':'delivered'},target}
 }
 readArtifact(run,key,offset=0){
  if(!Number.isInteger(offset)||offset<0)throw Error('产物读取位置无效')
  const {item,target}=this.artifactEntry(run,key),fd=fs.openSync(target,'r')
  try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>64*1024*1024||offset>stat.size)throw Error('产物大小或读取位置无效');const bytes=Buffer.alloc(Math.min(256*1024,stat.size-offset));const length=fs.readSync(fd,bytes,0,bytes.length,offset);return {name:item.name,size:stat.size,offset,next:offset+length,bytes:bytes.subarray(0,length).toString('base64')}}finally{fs.closeSync(fd)}
 }
 close(){if(!this.opened)return;this.opened=false;fs.closeSync(this.fd);fs.unlinkSync(this.lock);this.details.clear();this.detailBytes=0;this.runs.clear()}
}
module.exports={Repository}
