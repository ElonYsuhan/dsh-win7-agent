'use strict'
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),http=require('http'),assert=require('assert'),{spawn,execFileSync}=require('child_process'),{MiniWebSocket,CdpSession,httpGetJson}=require('../src/main/agent/cdp-client')
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms))
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agent-issuer-ui-')),bundle=path.resolve(process.argv[2]),server=net.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve))
 const env={...process.env};delete env.ELECTRON_RUN_AS_NODE
 const child=spawn(path.join(bundle,'Contents/MacOS/Electron'),['--user-data-dir='+path.join(dir,'data'),'--authority-dir='+path.join(dir,'keys'),'--authority-port=0','--remote-debugging-port='+port,'--remote-debugging-address=127.0.0.1'],{env,stdio:['ignore','pipe','pipe']});let ws,log=''
 for(const stream of [child.stdout,child.stderr])stream.on('data',value=>{log=(log+value).slice(-3000)})
 try{
  let target;for(let i=0;i<120;i++){try{target=(await httpGetJson('127.0.0.1',port,'/json/list',1000)).find(value=>value.type==='page'&&value.url.startsWith('http:'))}catch(_){}if(target)break;if(child.exitCode!==null)throw Error(log);await delay(100)}assert(target,log)
  ws=new MiniWebSocket();const u=new URL(target.webSocketDebuggerUrl);await ws.connect(u.hostname,Number(u.port),u.pathname);const cdp=new CdpSession(ws)
  async function evaluate(expression){const value=await cdp.send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(value.exceptionDetails)throw Error(JSON.stringify(value.exceptionDetails));return value.result.value}
  async function until(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await delay(50)}throw Error('Timeout: '+expression+' '+await evaluate("document.getElementById('message').textContent"))}
  await until("document.getElementById('loginPanel') && !document.getElementById('loginPanel').hidden")
  assert.strictEqual(await evaluate('typeof window.authority'),'undefined')
  assert.strictEqual(await evaluate("window.fetch('/api/status').then(r=>r.status)"),401)
  assert(await evaluate("document.querySelector('.authority-logo').naturalWidth>0"))
  await evaluate("document.getElementById('password').value='wrong';document.getElementById('loginForm').requestSubmit()")
  await until("document.getElementById('loginMessage').textContent.includes('错误')")
  assert(await evaluate("document.getElementById('issuerPanel').hidden"))
  const validation=path.resolve('release/validation');fs.mkdirSync(validation,{recursive:true})
  for(const theme of ['light','dark']){await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});await delay(100);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(validation,'authority-login-'+theme+'.png'),Buffer.from(shot.data,'base64'))}
  await evaluate("document.getElementById('password').value='admin123';document.getElementById('loginForm').requestSubmit()")
  await until("!document.getElementById('issuerPanel').hidden && document.getElementById('identity').textContent==='尚未创建签发密钥'")
  await evaluate("document.getElementById('init').click()")
  await until("document.getElementById('identity').textContent.startsWith('签发方：')")
  assert(fs.existsSync(path.join(dir,'keys/private.pem')))
  const address=await evaluate("document.querySelector('#network a')?.href")
  assert(address,'Detected LAN addresses are clickable links')
  assert(await evaluate("Array.from(document.querySelectorAll('#network a')).every(a=>a.target==='_blank'&&a.rel.includes('noopener'))"))
  const previousClipboard=execFileSync('pbpaste')
  await evaluate("document.querySelector('#network button').focus();document.querySelector('#network button').click()")
  await until("document.getElementById('message').textContent.startsWith('已复制内网地址：')")
  try { assert.strictEqual(execFileSync('pbpaste',{encoding:'utf8'}),address.replace(/\/$/,'')) } finally { execFileSync('pbcopy',{input:previousClipboard}) }
  for(const theme of ['light','dark']){await cdp.send('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:theme}]});await delay(100);const shot=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(validation,'authority-network-'+theme+'.png'),Buffer.from(shot.data,'base64'))}

  const fixture={version:1,product:'dsh-agent',deviceDigest:'abcdef123'+'0'.repeat(55),platform:'win32',arch:'x64',name:'隔离验收电脑'}
  await evaluate("document.getElementById('request').value="+JSON.stringify(JSON.stringify(fixture))+";document.getElementById('request').dispatchEvent(new Event('input'));document.getElementById('customer').value='隔离验收'")
  assert(await evaluate("document.getElementById('device').textContent.includes('ABC-DEF-123')"))
  assert(!(await evaluate("document.getElementById('device').textContent.includes('abcdef123000')")))
  await evaluate("const makeURL=URL.createObjectURL;URL.createObjectURL=function(blob){blob.text().then(text=>window.__downloadText=text);return makeURL.call(URL,blob)};HTMLAnchorElement.prototype.click=function(){window.__downloadName=this.download};document.getElementById('form').requestSubmit()")
  await until('!!window.__downloadText');assert.strictEqual(await evaluate('window.__downloadName'),'Agent-ABC-DEF-123.agentlic')
  assert.strictEqual(JSON.parse(Buffer.from(JSON.parse(await evaluate('window.__downloadText')).payload,'base64')).deviceDigest,fixture.deviceDigest)
  // A separate browser client has no desktop session cookie and cannot sign.
  const remote=await new Promise((resolve,reject)=>{http.get(new URL('/api/status',target.url),res=>{res.resume();resolve(res.statusCode)}).on('error',reject)});assert.strictEqual(remote,401)
  await evaluate("document.getElementById('logout').click()")
  await until("!document.getElementById('loginPanel').hidden && document.getElementById('issuerPanel').hidden")
  assert.strictEqual(await evaluate("window.fetch('/api/status').then(r=>r.status)"),401)
  console.log('PASS protected owner issuer UI: login required in desktop/browser, wrong password, isolated key initialization, signed download/name, no signing IPC, logout denial, light/dark screenshots')
 }finally{if(ws&&ws.socket)ws.socket.destroy();child.kill('SIGTERM');for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await delay(25);if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await delay(100)}fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
