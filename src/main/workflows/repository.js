'use strict'
const fs=require('fs'),path=require('path'),S=require('../state/workflow-state'),C=require('../contracts/workflows')
class Repository{
 constructor(home){this.dir=path.join(home,'workflows');this.runs=new Map();this.details=new Map();this.detailBytes=0;this.definitions=[];this.opened=false}
 open(){if(this.opened)return;fs.mkdirSync(this.dir,{recursive:true});this.lock=path.join(this.dir,'owner.json');try{this.fd=fs.openSync(this.lock,'wx')}catch(e){if(e.code!=='EEXIST')throw e;let owner;try{owner=JSON.parse(fs.readFileSync(this.lock,'utf8'));process.kill(owner.pid,0)}catch(error){if(error.code==='ESRCH'){fs.unlinkSync(this.lock);return this.open()}throw Error('WORKFLOW_STORAGE_LOCKED')}throw Error('WORKFLOW_STORAGE_LOCKED')}
 try{fs.writeFileSync(this.fd,JSON.stringify({pid:process.pid}));this.opened=true;const file=path.join(this.dir,'definitions.json');let saved={version:1,workflows:[]};if(fs.existsSync(file)){try{saved=JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){saved=JSON.parse(fs.readFileSync(file+'.bak','utf8'))}}if(saved.version!==1||!Array.isArray(saved.workflows))throw Error('WORKFLOW_STORAGE_VERSION');this.definitions=saved.workflows.map(w=>({...C.validate(w,null),revision:Number(w.revision)||1}));fs.mkdirSync(path.join(this.dir,'runs'),{recursive:true});for(const name of fs.readdirSync(path.join(this.dir,'runs'))){if(!/^[a-zA-Z0-9_-]+\.jsonl$/.test(name))continue;const state=this.readRun(name.slice(0,-6),true);if(state)this.runs.set(state.id,this.index(state))}for(const run of this.runs.values())if(['pending','running'].includes(run.status))this.append(run.id,{type:'finished',status:'interrupted',error:'服务重启，未自动重放执行'})}catch(e){this.close();throw e}}
 save(){const file=path.join(this.dir,'definitions.json'),tmp=file+'.tmp',data=JSON.stringify({version:1,workflows:this.definitions});if(fs.existsSync(file))fs.copyFileSync(file,file+'.bak');const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,data);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file)}
 append(id,event){C.id(id);const prior=this.getRun(id),fact={...event,version:1,sequence:prior?prior.sequence+1:1,at:Date.now()},state=S.reduce(prior,fact),fd=fs.openSync(path.join(this.dir,'runs',id+'.jsonl'),'a');try{fs.writeSync(fd,JSON.stringify(fact)+'\n');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}this.dropDetail(id);this.runs.set(id,this.index(state));return state}
 index(state){
  if(['pending','running'].includes(state.status))return state
  const {id,workflowId,name,revision,status,sequence,createdAt,startedAt,endedAt,error}=state
  return {id,workflowId,name,revision,status,sequence,createdAt,startedAt,endedAt,error,steps:state.steps.map(({id,title,status,startedAt,endedAt})=>({id,title,status,startedAt,endedAt}))}
 }
 readRun(id,repair){
  const file=path.join(this.dir,'runs',C.id(id)+'.jsonl'),bytes=fs.readFileSync(file),end=bytes.lastIndexOf(10)+1
  if(repair&&end!==bytes.length)fs.truncateSync(file,end)
  let state
  for(const line of bytes.subarray(0,end).toString('utf8').split('\n').filter(Boolean))state=S.reduce(state,JSON.parse(line))
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
   const bytes=Buffer.from(file.data,'base64'),key=String(index),target=path.join(dir,key)
   const fd=fs.openSync(target,'w');try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}
   const text=/\.(txt|md|json|csv|log|xml|yaml|yml)$/i.test(file.name)?bytes.toString('utf8').slice(0,16000):''
   return {name:file.name,size:bytes.length,ref:run+'/'+task+'/'+key,text}
  })
 }
 artifactFile(run,node){return path.join(this.dir,'artifacts',C.id(run),C.id(node)+'.txt')}
 artifact(run,node,text){const file=this.artifactFile(run,node),dir=path.dirname(file),tmp=file+'.tmp';fs.mkdirSync(dir,{recursive:true});const fd=fs.openSync(tmp,'w');try{fs.writeFileSync(fd,text,'utf8');fs.fsyncSync(fd)}finally{fs.closeSync(fd)}fs.renameSync(tmp,file);return node+'.txt'}
 close(){if(!this.opened)return;this.opened=false;fs.closeSync(this.fd);fs.unlinkSync(this.lock);this.details.clear();this.detailBytes=0;this.runs.clear()}
}
module.exports={Repository}
