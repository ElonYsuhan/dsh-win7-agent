'use strict'
const http=require('http'),https=require('https')
// No redirects or retry: a response failure must never repeat an uncertain write.
function requestText({url,method,body,signal}){
 return new Promise((resolve,reject)=>{
  let done=false,request,timer
  const finish=(error,text)=>{if(done)return;done=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error){if(request)request.destroy();reject(error)}else resolve(text)}
  const abort=()=>finish(Error('接口调用已取消'))
  if(signal.aborted){reject(Error('接口调用已取消'));return}
  signal.addEventListener('abort',abort,{once:true})
  try{
   const target=new URL(url);if(!['http:','https:'].includes(target.protocol)||target.username||target.password)throw Error('REST 接口地址无效')
   const headers={accept:'application/json, text/plain'}
   if(body){headers['content-type']='application/json';headers['content-length']=Buffer.byteLength(body)}
   request=(target.protocol==='https:'?https:http).request(target,{method,headers},response=>{
    let size=0;const chunks=[]
    response.on('error',e=>finish(e));response.on('aborted',()=>finish(Error('接口响应被中断')))
    response.on('data',chunk=>{size+=chunk.length;if(size>128*1024){finish(Error('接口响应超过128KB'));response.destroy()}else chunks.push(chunk)})
    response.on('end',()=>{const status=response.statusCode||0;if(status<200||status>=300){finish(Error('接口返回 HTTP '+status+'，未自动重试'));return}finish(null,Buffer.concat(chunks).toString('utf8'))})
   })
   request.on('error',e=>finish(Error('接口请求失败：'+e.code)))
   timer=setTimeout(()=>finish(Error('接口请求超过30秒，未自动重试')),30000)
   request.end(body||undefined)
  }catch(error){finish(error)}
 })
}
module.exports={requestText}
