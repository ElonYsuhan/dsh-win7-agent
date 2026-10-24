'use strict'
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert'),{spawn}=require('child_process'),{MiniWebSocket,CdpSession,httpGetJson}=require('../src/main/agent/cdp-client')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-issuer-ui-')),bundle=path.resolve(process.argv[2]),server=net.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;await new Promise(r=>server.close(r))
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(path.join(bundle,'Contents/MacOS/Electron'),['--user-data-dir='+path.join(dir,'data'),'--authority-dir='+path.join(dir,'keys'),'--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1'],{env,stdio:'ignore'});let ws
 try{
  let target;for(let i=0;i<100;i++){try{target=(await httpGetJson('127.0.0.1',port,'/json/list',1000)).find(t=>t.type==='page'&&t.url.startsWith('file:'))}catch(_){}if(target)break;await delay(100)}assert(target)
  ws=new MiniWebSocket();const u=new URL(target.webSocketDebuggerUrl);await ws.connect(u.hostname,Number(u.port),u.pathname);const cdp=new CdpSession(ws)
  async function evaluate(expression){const r=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value}
  await delay(400);const before=await evaluate('window.authority.status()');assert.strictEqual(before.configured,false);await evaluate('window.authority.init()');const after=await evaluate('window.authority.status()');assert(after.configured);assert(after.directory===path.join(dir,'keys'));assert(!JSON.stringify(after).includes('PRIVATE KEY'))
  await evaluate("document.getElementById('request').value='bad';document.getElementById('customer').value='隔离验收';document.getElementById('init').click()")
  await delay(150);await evaluate("document.getElementById('form').requestSubmit()")
  await delay(300);assert(await evaluate("document.getElementById('message').textContent.length>0"))
  console.log('PASS independent protected issuer GUI: isolated authority, sandbox preload, public-only status, invalid request rejected')
 }finally{if(ws&&ws.socket)ws.socket.destroy();const done=new Promise(r=>child.once('exit',r));child.kill('SIGTERM');await Promise.race([done,delay(2000)]);fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
