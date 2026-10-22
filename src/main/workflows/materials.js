'use strict'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),C=require('../contracts/workflow-materials')
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
class Materials{
 constructor(dir){this.dir=path.join(dir,'materials')}
 directory(){fs.mkdirSync(this.dir,{recursive:true});if(fs.lstatSync(this.dir).isSymbolicLink())throw Error('流程资料目录无效')}
 digest(meta){return hash(JSON.stringify({hash:meta.hash,name:meta.name,size:meta.size,source:meta.source,text:meta.text}))}
 store({bytes,name,source,text}){
  if(!Buffer.isBuffer(bytes)||bytes.length>C.LIMITS.fileBytes)throw Error('单份流程资料不能超过8MB')
  const preview=text===undefined&&/\.(txt|md|csv|json|log|xml|yaml|yml)$/i.test(name)?bytes.toString('utf8').slice(0,16000):String(text||'').slice(0,16000)
  const raw={id:'0'.repeat(64),hash:hash(bytes),name,size:bytes.length,source},meta={...C.file(raw),text:preview};meta.id=this.digest(meta)
  this.directory();const target=path.join(this.dir,meta.id),json=target+'.json'
  if(fs.existsSync(json))return this.resolve(C.file(meta)).file
  let total=0,count=0;for(const name of fs.readdirSync(this.dir))if(/^[a-f0-9]{64}$/.test(name)){const stat=fs.lstatSync(path.join(this.dir,name));total+=stat.size;count++}
  if(count>=512||total+bytes.length>256*1024*1024)throw Error('流程资料仓库已达256MB或512份上限，请移除不再使用的资料后整理')
  try{const fd=fs.openSync(target,'wx',0o600);try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='EEXIST')throw e}
  try{const fd=fs.openSync(json,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(meta));fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}catch(e){if(e.code!=='EEXIST')throw e}
  return this.resolve(C.file(meta)).file
 }
 resolve(raw){
  const file=C.file(raw);this.directory();const target=path.join(this.dir,file.id),json=target+'.json'
  for(const name of [target,json]){const stat=fs.lstatSync(name);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>(name===json?128*1024:C.LIMITS.fileBytes))throw Error('流程资料文件无效')}
  const meta=JSON.parse(fs.readFileSync(json,'utf8'));if(this.digest(meta)!==file.id||JSON.stringify(C.file(meta))!==JSON.stringify(file))throw Error('流程资料清单校验失败')
  const bytes=fs.readFileSync(target);if(bytes.length!==file.size||hash(bytes)!==file.hash)throw Error('流程资料原件校验失败')
  return{file,text:meta.text,bytes}
 }
 validate(files){return C.list(files).map(file=>this.resolve(file).file)}
 snapshot(files,run,repositoryDir){
  C.list(files);if(!files.length)return[]
  const dir=path.join(repositoryDir,'uploads',run,'materials');fs.mkdirSync(dir,{recursive:true})
  let remaining=C.LIMITS.previewChars
  try{return files.map((raw,index)=>{const stored=this.resolve(raw),text=stored.text.slice(0,remaining);remaining-=text.length;const fd=fs.openSync(path.join(dir,String(index)),'wx',0o600);try{fs.writeFileSync(fd,stored.bytes);fs.fsyncSync(fd)}finally{fs.closeSync(fd)}return{...stored.file,ref:run+'/materials/'+index,text}})}catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e}
 }
}
module.exports={Materials}
