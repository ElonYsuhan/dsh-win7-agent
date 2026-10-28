'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),http=require('http')
const {BrowserDriver}=require('../src/main/agent/browser-driver')
const root=path.resolve(__dirname,'..')
async function main(){
 const driver=new BrowserDriver(),server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><html><head></head><body></body></html>')})
 try{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  await driver.launch('http://127.0.0.1:'+server.address().port,{electronPath:path.join(root,'node_modules/electron/dist/electron.exe'),width:1200,height:800})
  const source=fs.readFileSync(path.join(root,'src/renderer/workflows.js'),'utf8'),css=fs.readFileSync(path.join(root,'src/renderer/style.css'),'utf8')
  const functions=source.slice(source.indexOf(' function flowCardEntries('),source.indexOf(' function renderRuns('))
  await driver.evaluate(`(()=>{
   const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);
   document.body.innerHTML='<main id="workflowPage" style="padding:24px"><input id="workflowSearch" hidden><div id="workflowCards" class="workflow-grid"></div></main>';
   const data={workflows:[{id:'old',name:'软件定制项目全生命周期流程（旧名称保持兼容）',revision:1},{id:'idle',name:'资料分析生成报告',revision:2}],runs:[{workflowId:'old',status:'succeeded',createdAt:2},{workflowId:'old',status:'running',createdAt:1}]};
   const $=id=>document.getElementById(id),node=(tag,text,cls)=>{const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el};
   const glyph=()=>{const icon=document.createElementNS('http://www.w3.org/2000/svg','svg');icon.innerHTML='<path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor"/>';icon.setAttribute('viewBox','0 0 24 24');return icon};
   const button=(text,fn,title)=>{const el=node('button',text);el.title=title;el.setAttribute('aria-label',title);el.onclick=fn;return el};
   const notice=()=>{},view=()=>{},renderRuns=()=>{},edit=()=>{};let filter='';
   ${functions}
   window.cardTestData=data;window.renderTestCards=renderFlows;renderFlows();return true;
  })()`)
  const output=path.join(root,'release/validation');fs.mkdirSync(output,{recursive:true})
  for(const theme of ['light','dark']){
   await driver.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)};true`)
   for(const width of [1100,320]){
    const result=await driver.evaluate(`(()=>{const grid=document.getElementById('workflowCards');grid.style.width='${width}px';window.renderTestCards();return {overflow:grid.scrollWidth-grid.clientWidth,removed:!!grid.querySelector('.workflow-card-steps,.workflow-card-meta,.workflow-status-pill'),buttons:Array.from(grid.querySelectorAll('[data-workflow-action=instances]')).map(b=>({text:b.textContent,active:b.classList.contains('is-active'),label:b.getAttribute('aria-label'),color:getComputedStyle(b).color})),cards:Array.from(grid.children).map(c=>({height:c.clientHeight,overflow:c.scrollWidth-c.clientWidth}))}})()`)
    assert(!result.removed,'Cards omit previews, counts, timestamps and status pills')
    assert(result.overflow<=1&&result.cards.every(c=>c.overflow<=1),'Cards fit narrow windows')
    assert(result.buttons.every(b=>b.text==='实例'),'Instances always has visible text')
    assert(result.buttons[0].active&&!result.buttons[1].active,'An older active run keeps Instances highlighted')
    assert(result.buttons[0].label.includes('正在执行')&&result.buttons[0].color!==result.buttons[1].color,'Activity has visual and accessible cues')
   }
   for(const status of ['pending','queued','running','waiting','paused','succeeded','failed','cancelled','interrupted']){
    const active=await driver.evaluate(`window.cardTestData.runs[1].status=${JSON.stringify(status)};window.renderTestCards();document.querySelector('[data-workflow-action=instances]').classList.contains('is-active')`)
    assert.strictEqual(active,['pending','queued','running','waiting','paused'].includes(status),'Activity follows actual state '+status)
   }
   await driver.evaluate("document.getElementById('workflowCards').style.width='100%';window.cardTestData.runs[1].status='running';window.renderTestCards();true")
   await driver.evaluate('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))',{awaitPromise:true})
   fs.writeFileSync(path.join(output,'workflow-card-layout-'+theme+'.png'),Buffer.from(await driver.screenshot(),'base64'))
  }
  console.log('Workflow cards passed: compact layout; no status/preview/meta; labelled instances; all active/terminal states; narrow width; light/dark')
 }finally{await driver.close();await new Promise(resolve=>server.close(resolve))}
}
main().catch(error=>{console.error(error);process.exitCode=1})
