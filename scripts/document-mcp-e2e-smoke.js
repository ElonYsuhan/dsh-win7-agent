'use strict'
// Real renderer -> HTTP/SSE -> selected Cordis loop -> registry -> stdio MCP.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{spawn}=require('child_process')
const {BrowserDriver}=require('../src/main/agent/browser-driver')
const {readZip}=require('../src/main/mcp/documents/zip')
const root=path.resolve(__dirname,'..'),sleep=ms=>new Promise(r=>setTimeout(r,ms));let count=0
function ok(label,value){assert(value,label);count++;console.log('PASS '+label)}
async function wait(fn,label){for(let i=0;i<200;i++){try{if(await fn())return}catch(_){}await sleep(100)}throw Error('Timeout '+label)}
function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port))})}
function request(method,url,value){return new Promise((resolve,reject)=>{const req=http.request(url,{method,headers:{'content-type':'application/json'}},res=>{let body='';res.on('data',c=>body+=c);res.on('end',()=>{try{resolve(JSON.parse(body))}catch(e){reject(e)}})});req.on('error',reject);if(value)req.write(JSON.stringify(value));req.end()})}
async function main(){
 const temp=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'documents-ui-'))),home=path.join(temp,'home'),workspace=path.join(temp,'workspace');fs.mkdirSync(home);fs.mkdirSync(workspace)
 let calls=0,logs='',child;const driver=new BrowserDriver()
 const model=http.createServer((req,res)=>{let body='';req.on('data',c=>body+=c);req.on('end',()=>{try{
  const value=JSON.parse(body);calls++
  const tools=value.messages.filter(m=>m.role==='tool');let delta,finish
  if(tools.length>=2){delta={content:'文档已创建：验收报告.docx、验收账目.xlsx。'};finish='stop'}
  else{const excel=tools.length===1,name=excel?'mcp__documents__xlsx_create':'mcp__documents__docx_create',args=excel?{output:'验收账目.xlsx',sheets:[{name:'账目',cells:[{cell:'A1',value:'收入'},{cell:'B1',value:123}]}]}:{output:'验收报告.docx',paragraphs:[{text:'离线文档验收',heading:1},{text:'通过真实 MCP 创建'}]};assert(value.tools.some(t=>t.function.name===name));delta={tool_calls:[{index:0,id:'document_'+tools.length,type:'function',function:{name,arguments:JSON.stringify(args)}}]};finish='tool_calls'}
  res.writeHead(200,{'content-type':'text/event-stream'});res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:finish}]})+'\n\ndata: [DONE]\n\n')
 }catch(e){res.writeHead(500);res.end(JSON.stringify({error:{message:e.message}}))}})})
 try{
  const mp=await listen(model),probe=http.createServer(),port=await listen(probe);await new Promise(r=>probe.close(r));const base='http://127.0.0.1:'+port
  fs.writeFileSync(path.join(home,'settings.json'),JSON.stringify({workspacePath:workspace,baseURL:'http://127.0.0.1:'+mp+'/v1',model:'local-test',apiKey:'local',permissionMode:'workspace'}))
  child=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,AGENT_HOME:home,HOST:'127.0.0.1',PORT:String(port),PORT_MAX_ATTEMPTS:'0'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',c=>logs+=c);child.stderr.on('data',c=>logs+=c)
  await wait(async()=>Boolean((await request('GET',base+'/api/health')).ok),'service')
  const binary=path.join(root,'node_modules/electron/dist',fs.readFileSync(path.join(root,'node_modules/electron/path.txt'),'utf8').trim());await driver.launch(base,{electronPath:binary,noSandbox:process.env.SMOKE_NO_SANDBOX==='1'})
  await wait(()=>driver.evaluate('typeof state!=="undefined" && state.settings && document.getElementById("serviceConnection").textContent==="服务已连接"'),'renderer')
  await driver.cdp.send('Runtime.enable');driver.cdp.on('Runtime.exceptionThrown',e=>console.error('UI_ERROR '+JSON.stringify(e)));await driver.click('#openCustomize');await driver.click('#capTabConnectors');await wait(()=>driver.evaluate('document.getElementById("mcpList").textContent.includes("文档工具")'),'builtin card')
  ok('连接器默认显示内置中英文文档服务及六个工具',await driver.evaluate('document.getElementById("mcpList").textContent.includes("Document Tools")&&document.querySelectorAll("#mcpList .plugin-tool-chip").length===6'))
  ok('内置服务按需启动且不能编辑删除',await driver.evaluate('document.getElementById("mcpList").textContent.includes("离线可用")&&document.querySelectorAll("#mcpList .mcp-icon-button").length===0'))
  ok('工具列表默认折叠且卡片紧凑',await driver.evaluate('!document.querySelector(".mcp-tool-details").open&&document.querySelector(".mcp-server").getBoundingClientRect().height<115'))
  if(process.env.MCP_LAYOUT_SCREENSHOTS)fs.writeFileSync(path.join(os.tmpdir(),'mcp-overview.png'),Buffer.from(await driver.screenshot(),'base64'))
  await driver.click('#mcpAdd')
  if(process.env.MCP_LAYOUT_SCREENSHOTS)fs.writeFileSync(path.join(os.tmpdir(),'mcp-editor-stdio.png'),Buffer.from(await driver.screenshot(),'base64'))
  ok('弹窗独立于 inert 背景且默认只显示 STDIO',await driver.evaluate('document.getElementById("mcpDialog").parentNode===document.body&&document.getElementById("app").inert&&getComputedStyle(document.getElementById("mcpHttpFields")).display==="none"&&getComputedStyle(document.getElementById("mcpStdioFields")).display!=="none"'))
  ok('短窗口固定底部操作可见',await driver.evaluate('(()=>{const form=document.getElementById("mcpForm").getBoundingClientRect(),save=document.getElementById("mcpSave").getBoundingClientRect();return save.bottom<=form.bottom&&save.bottom<innerHeight&&getComputedStyle(document.querySelector(".mcp-form-body")).overflowY==="auto"})()'))
  await driver.click('[data-mcp-transport="http"]')
  ok('HTTP 类型可切换且明确选中',await driver.evaluate('document.querySelector("[data-mcp-transport=http]").classList.contains("is-on")&&document.getElementById("mcpStdioFields").hidden&&!document.getElementById("mcpHttpFields").hidden'))
  await driver.keypress('ArrowLeft')
  ok('传输类型支持方向键切换',await driver.evaluate('document.querySelector("[data-mcp-transport=stdio]").getAttribute("aria-checked")==="true"'))
  await driver.click('#mcpPermission + .select-trigger');await driver.keypress('Home');await driver.keypress('Enter')
  ok('统一下拉选择同步原始 select 值',await driver.evaluate('document.getElementById("mcpPermission").value==="read"&&document.querySelector("#mcpPermission + button").textContent.includes("只读")'))
  await driver.click('#mcpPermission + .select-trigger');await driver.keypress('Escape')
  ok('Escape 先关闭下拉而不是整个弹窗',await driver.evaluate('!document.getElementById("mcpDialog").classList.contains("hidden")&&document.getElementById("mcpPermission").nextElementSibling.getAttribute("aria-expanded")==="false"'))
  await driver.evaluate('document.getElementById("mcpName").value="row-test";document.getElementById("mcpCommand").value="node";document.querySelector("#mcpArgs input").value="/a path/server.js";document.getElementById("mcpEnabled").checked=false;true')
  await driver.click('[data-mcp-add="mcpArgs"]')
  await driver.evaluate('document.querySelectorAll("#mcpArgs input")[1].value=" argument with spaces ";document.querySelector("#mcpStdioFields details").open=true;document.querySelectorAll("#mcpEnv input")[0].value="DEMO";document.querySelectorAll("#mcpEnv input")[1].value="literal value";document.querySelector("#mcpEnvPass input").value="HOME";true')
  await driver.click('#mcpSave');await wait(()=>driver.evaluate('document.getElementById("mcpDialog").classList.contains("hidden")'),'save stdio rows')
  const configured=(await request('GET',base+'/api/state')).settings.mcpServers.find(s=>s.name==='row-test')
  ok('逐行参数保留空格，环境变量与传递配置真实保存',configured.args[0]==='/a path/server.js'&&configured.args[1]===' argument with spaces '&&configured.env.DEMO==='literal value'&&configured.envPass[0]==='HOME')
  await driver.click('#mcpAdd');await driver.click('[data-mcp-transport="http"]')
  await driver.evaluate('document.getElementById("mcpName").value="http-row-test";document.getElementById("mcpUrl").value="http://127.0.0.1:12345/mcp";document.getElementById("mcpEnabled").checked=false;document.querySelector("#mcpHttpFields details").open=true;document.querySelectorAll("#mcpHeaders input")[0].value="X-Demo";document.querySelectorAll("#mcpHeaders input")[1].value="demo";document.querySelectorAll("#mcpHeaderEnv input")[0].value="X-Token";document.querySelectorAll("#mcpHeaderEnv input")[1].value="DEMO_TOKEN";document.getElementById("mcpBearerEnv").value="MCP_TOKEN";true')
  await driver.click('#mcpSave');await wait(()=>driver.evaluate('document.getElementById("mcpDialog").classList.contains("hidden")'),'save HTTP rows')
  const httpConfig=(await request('GET',base+'/api/state')).settings.mcpServers.find(s=>s.name==='http-row-test')
  ok('HTTP 逐行请求头与环境变量引用真实保存',httpConfig.headers['X-Demo']==='demo'&&httpConfig.headerEnv['X-Token']==='DEMO_TOKEN'&&httpConfig.bearerTokenEnv==='MCP_TOKEN')
  await driver.click('#mcpAdd');await driver.evaluate('document.getElementById("mcpSave").focus();true');await driver.keypress('Tab')
  ok('弹窗 Tab 焦点不会逃出背景',await driver.evaluate('document.activeElement.id==="mcpCloseEditor"'))
  await driver.keypress('Escape')
  ok('关闭弹窗恢复触发按钮焦点',await driver.evaluate('document.activeElement.id==="mcpAdd"&&!document.getElementById("app").inert'))
  await driver.click('#mcpList [role="switch"]');await wait(async()=> (await request('GET',base+'/api/state')).settings.disabledBuiltinMcp.includes('documents'),'disable setting')
  await wait(()=>driver.evaluate('document.querySelector("#mcpList [role=switch]").getAttribute("aria-checked")==="false"'),'disabled UI')
  ok('内置服务停用同步工具注册',!(await request('GET',base+'/api/mcp')).servers.find(s=>s.builtin).enabled)
  await driver.click('#mcpList [role="switch"]');await wait(()=>driver.evaluate('document.querySelector("#mcpList [role=switch]").getAttribute("aria-checked")==="true"'),'enabled')
  await driver.click('#closeCapabilities');await driver.input('#input','创建一份 Word 报告和 Excel 账目');await driver.click('#send')
  await wait(()=>driver.evaluate('Boolean(currentSession() && currentSession().messages.some(m=>m.role==="assistant"&&String(m.content||"").includes("文档已创建")) && !currentRunning())'),'document loop')
  ok('模型通过主循环连续调用真实文档 MCP',calls>=3&&fs.existsSync(path.join(workspace,'验收报告.docx'))&&fs.existsSync(path.join(workspace,'验收账目.xlsx')))
  ok('Word 和 Excel 是有效 ZIP OOXML',readZip(fs.readFileSync(path.join(workspace,'验收报告.docx'))).has('word/document.xml')&&readZip(fs.readFileSync(path.join(workspace,'验收账目.xlsx'))).has('xl/workbook.xml'))
  ok('工具调用与结果进入会话事实',await driver.evaluate('currentSession().messages.filter(m=>m.role==="tool").length===2&&currentSession().messages.some(m=>m.tool_calls&&m.tool_calls.some(t=>t.function.name==="mcp__documents__docx_create"))'))
  await driver.open(base);await wait(()=>driver.evaluate('typeof state!=="undefined" && currentSession() && currentSession().messages.some(m=>m.role==="tool")'),'reopen')
  ok('重新打开后保留文档工具结果',await driver.evaluate('currentSession().messages.filter(m=>m.role==="tool").length===2'))
  console.log('Document MCP browser: '+count+' checks passed')
 }catch(e){console.error(logs.slice(-2000));console.error('calls='+calls);try{console.error(await driver.evaluate('JSON.stringify({initError:document.getElementById("messagesInner").textContent,mcpHtml:document.getElementById("mcpList").innerHTML,mcpNotice:document.getElementById("mcpNotice").textContent,dialogParent:document.getElementById("mcpDialog").parentElement.id,session:currentSession(),running:currentRunning(),input:document.getElementById("input").value,sendDisabled:document.getElementById("send").disabled})'))}catch(_){}throw e}finally{await driver.close();if(child){child.kill('SIGTERM');await wait(()=>child.exitCode!==null||child.signalCode!==null,'stop')}await new Promise(r=>model.close(r));fs.rmSync(temp,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
