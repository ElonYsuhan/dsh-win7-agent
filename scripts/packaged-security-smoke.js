'use strict'
// Real shipped server; all mutations are confined to a private copied payload.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),net=require('net'),assert=require('assert'),{spawn}=require('child_process')
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function main(){
 const bundle=path.resolve(process.argv[2]),scratch=fs.mkdtempSync(path.join(os.tmpdir(),'agent-code-tamper-')),payload=path.join(scratch,'app')
 fs.cpSync(path.join(bundle,'Contents/Resources/app'),payload,{recursive:true})
 const probe=net.createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
 const child=spawn(path.join(bundle,'Contents/MacOS/Electron'),[path.join(payload,'service/index.js')],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1',AGENT_HOME:path.join(scratch,'data'),HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']})
 let log='';for(const stream of [child.stdout,child.stderr])stream.on('data',data=>{log=(log+data).slice(-2000)})
 function get(route,headers={}){return new Promise((resolve,reject)=>{const request=http.get({hostname:'127.0.0.1',port,path:route,headers},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>{text+=part});response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text}))});request.on('error',reject)})}
 try{
  let ready=false;for(let i=0;i<100;i++){try{ready=(await get('/api/health')).status===200}catch(_){}if(ready)break;if(child.exitCode!==null)throw Error(log);await pause(50)}assert(ready,log)
  const normal=await get('/licensing.js');assert.strictEqual(normal.status,200);assert.strictEqual(normal.headers['x-content-type-options'],'nosniff');assert(normal.headers['content-security-policy'].includes("frame-ancestors 'none'"))
  assert.strictEqual((await get('/api/state',{Origin:'https://untrusted.example'})).status,403)
  assert.strictEqual((await get('/api/state',{'Sec-Fetch-Site':'cross-site'})).status,403)
  assert.strictEqual((await get('/api/state',{Host:'untrusted.example'})).status,403)
  fs.appendFileSync(path.join(payload,'src/renderer/licensing.js'),'\nwindow.TAMPERED_CODE=true')
  const tampered=await get('/licensing.js');assert.strictEqual(tampered.status,503);assert(!tampered.text.includes('TAMPERED_CODE'))
  console.log('PASS real signed package: valid resources served; altered browser code never served; security headers and cross-origin/cross-site/rebound Host rejected')
 }finally{
  child.kill('SIGTERM');for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await pause(25)
  if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await pause(100)}
  fs.rmSync(scratch,{recursive:true,force:true})
 }
}
main().catch(error=>{console.error(error);process.exitCode=1})
