'use strict'
const {LIMITS}=require('../src/main/contracts/knowledge')
async function handleKnowledgeApi(request,response,url,options){
 if(!url.pathname.startsWith('/api/knowledge'))return false
 const {knowledge,json,readBody,workspace}=options
 try{
  const route=url.pathname.slice('/api/knowledge'.length)
  let result
  if(route===''&&request.method==='GET')result={...await knowledge.list(),currentScope:workspace(),projects:options.projects?options.projects():[]}
  else if(route==='/import'&&request.method==='POST'){
   const bytes=await new Promise((resolve,reject)=>{let size=0;const parts=[];request.on('data',chunk=>{size+=chunk.length;if(size>LIMITS.fileBytes){reject(Error('KNOWLEDGE_FILE_LIMIT'));request.destroy();return}parts.push(chunk)});request.once('end',()=>resolve(Buffer.concat(parts)));request.once('error',reject)})
   result=await knowledge.importBuffer({baseId:url.searchParams.get('baseId'),name:url.searchParams.get('name'),documentId:url.searchParams.get('documentId')},bytes)
  }else if(request.method==='POST'){
   const data=await readBody(request)
   if(route==='/create')result=await knowledge.create({name:data.name,scope:''})
   else if(route==='/rename')result=await knowledge.rename(data)
   else if(route==='/remove-base')result=await knowledge.removeBase(data)
   else if(route==='/bind')result=await knowledge.bind(data.scopes!==undefined?{id:data.id,scopes:data.scopes}:{id:data.id,scope:data.enabled?workspace():''})
   else if(route==='/bind-session'||route==='/delete-session'){if(options.isRunning&&options.isRunning(data.sessionId))throw Error('SESSION_BUSY');result=route==='/bind-session'?await knowledge.bindSession(data):await knowledge.deleteSession(data)}
   else if(route==='/session-tree')result=await knowledge.sessionTree(data)
   else if(route==='/session-preview')result=await knowledge.sessionPreview(data)
   else if(route==='/tree')result=await knowledge.tree(data)
   else if(route==='/project-preview')result=await knowledge.projectPreview(data)
   else if(route==='/preview')result=await knowledge.preview(data)
   else if(route==='/delete')result=await knowledge.remove(data)
   else if(route==='/cancel')result=await knowledge.cancel(data)
   else if(route==='/search')result=data.baseId?await knowledge.searchBase(data):await knowledge.search(data,workspace())
   else if(route==='/source'){const linked=data.sessionId?await knowledge.sessionContext(data.sessionId):null;result=data.baseId?await knowledge.sourceBase(data):await knowledge.sourceSession(data,linked?linked.workspaceRoot:workspace())}
   else throw Error('KNOWLEDGE_ROUTE_INVALID')
  }else throw Error('KNOWLEDGE_ROUTE_INVALID')
  json(response,200,result)
 }catch(error){json(response,400,{error:error.message})}
 return true
}
module.exports={handleKnowledgeApi}
