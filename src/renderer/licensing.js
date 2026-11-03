'use strict'
;(function(){
 const gate=document.getElementById('licenseGate'),gateHost=document.getElementById('licenseGateContent'),settingsHost=document.getElementById('licenseSettings')
 if(!gate||!settingsHost)return
 /* 授权文件丢给框里的上传图标：原来是一个文字字符「↑」，字形跟着字体走、
    粗细和大小都不可控（用户 2026-11-02 反馈「也有点敷衍」）。改成路径图标库里现成的
    upload（箭头 + 承托盘，和全站同一套 24 视可 / 1.8 描边），图标源单一。 */
 function uploadIcon(){const box=document.createElement('span');box.className='license-upload-icon icon';box.setAttribute('aria-hidden','true');
  /* applyIcons 只在子节点里找 [data-icon]，所以 data-icon 要挂在里层 span 上，不能挂在 box 自己身上。 */
  const glyph=document.createElement('span');glyph.setAttribute('data-icon','upload');box.appendChild(glyph);if(window.applyIcons)window.applyIcons(box);return box}
 const el=(tag,text,cls)=>{const x=document.createElement(tag);if(text!==undefined)x.textContent=text;if(cls)x.className=cls;return x}
 const shortId=d=>d.slice(0,9).toUpperCase().replace(/(.{3})(.{3})(.{3})/,'$1-$2-$3')
 const panels=[],inerted=new Map();let current=null,busy=false,locked=true,observer=null,previousFocus=null,refreshing=false
 const names={licensed:'已授权',trial:'试用中',unlicensed:'未授权',expired:'授权已过期',trial_expired:'试用已结束',clock_error:'系统时间异常',storage_error:'授权状态异常',device_error:'设备身份不可用',development:'开发环境'}
 function error(message){for(const p of panels)p.error.textContent=message||''}
 const request=(action,data)=>window.dsh.licenseRequest(action,data)
 /* 顶部提示只在还有试用机会时出现，用过即撤（见 repaint）。 */
 const description=document.getElementById('licenseGateDescription')
 function mark(node){if(node.nodeType!==1||node===gate||['SCRIPT','STYLE','LINK'].includes(node.tagName))return;if(!inerted.has(node)){inerted.set(node,node.inert);node.inert=true}}
 function ensureFocus(){if(locked&&!gate.contains(document.activeElement)){const first=Array.from(gate.querySelectorAll('button:not(:disabled)')).find(n=>n.getClientRects().length);(first||gate).focus()}}
 function lock(){if(locked&&observer)return;locked=true;previousFocus=document.activeElement;gate.classList.remove('hidden');for(const n of document.body.children)mark(n);observer=new MutationObserver(records=>{for(const r of records)for(const n of r.addedNodes)mark(n)});observer.observe(document.body,{childList:true});requestAnimationFrame(()=>{const button=gate.querySelector('button:not(:disabled)');(button||gate).focus()})}
 function unlock(){locked=false;gate.classList.add('hidden');if(observer)observer.disconnect();observer=null;for(const [node,previous]of inerted){if(node.isConnected)node.inert=previous}inerted.clear();if(previousFocus&&previousFocus.isConnected&&previousFocus!==document.body)previousFocus.focus()}
 function date(value){return value===null?'长期有效':value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—'}
 function remain(seconds){const s=Math.max(0,Math.ceil(seconds)),h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60,pad=v=>String(v).padStart(2,'0');return h>0?pad(h)+':'+pad(m)+':'+pad(x):pad(m)+':'+pad(x)}
 function repaint(){
  /* 试用只有一次：用过之后顶部提示、试用按钮与试用说明都不再出现（2026-11-02 用户要求）。 */
  const used=!!current&&!current.allowed&&!current.trialAvailable
  for(const p of panels){
   p.status.textContent=current?names[current.status]||'需要授权':'正在检查授权…'
   p.status.dataset.state=current&&current.status||'loading'
   p.expiry.textContent=current?(current.expiresAt===null&&current.status!=='licensed'?'—':date(current.expiresAt)):'—'
   p.customer.textContent=current&&current.customer||'—'
   p.short.textContent=current&&current.device?'申请标识：'+shortId(current.device.deviceDigest):'正在读取申请标识…'
   p.upload.disabled=busy||!current||!current.device
   p.input.disabled=p.upload.disabled
   p.download.disabled=busy||!current||!current.device
   p.retry.disabled=busy
   p.trial.disabled=busy||!current||!current.trialAvailable
   p.trial.hidden=used||(!!current&&current.allowed)
   p.trialHelp.hidden=used||(!!current&&current.allowed)
   p.countdown.textContent=current&&current.status==='trial'?'剩余 '+remain(Math.max(0,current.expiresAt-current.serverNow)/1000):''
   p.host.setAttribute('aria-busy',String(busy))
  }
  if(description)description.hidden=used
 }
 function update(value){const was=current&&current.allowed;current=value;current.received=performance.now();if(value.allowed)unlock();else lock();repaint();if(value.error)error(value.error);if(was===false&&value.allowed){window.location.reload()}}
 async function refresh(){if(refreshing||busy)return;refreshing=true;try{update(await request('status'))}catch(e){current={status:'storage_error',allowed:false,trialAvailable:false,device:null,serverNow:Date.now()};lock();repaint();error('无法检查授权：'+e.message)}finally{refreshing=false}}
 async function act(action,data){if(busy)return;busy=true;error('');repaint();try{update(await request(action,data));if(action==='activate')error('授权已更新。')}catch(e){error(e.message||'授权操作失败')}finally{busy=false;repaint()}}
 async function importFile(file){if(!file||busy)return;if(file.size>65536){error('授权文件最大64KB，请选择签发工具生成的 .agentlic 文件。');return}try{await act('activate',{text:await file.text()})}catch(e){error('文件读取失败：'+e.message)}}
 function panel(host,full){
  const header=el('div',undefined,'license-summary'),status=el('strong','正在检查授权…','license-badge'),countdown=el('span','','license-countdown');header.append(status,countdown)
  const info=el('dl',undefined,'license-info'),expiry=el('dd','—'),customer=el('dd','—');info.append(el('dt','有效期至'),expiry,el('dt','授权客户'),customer)
  const label=el('p','导入授权文件','license-label'),input=el('input'),upload=el('button',undefined,'license-drop');input.type='file';input.accept='.agentlic,application/json';input.hidden=true;input.setAttribute('aria-label','选择软件授权文件');upload.type='button';upload.disabled=true;upload.append(uploadIcon(),el('strong','拖拽授权文件到这里，或点击上传'),el('span','支持 .agentlic 文件，最大64KB','muted'));upload.addEventListener('click',()=>input.click());input.addEventListener('change',()=>{importFile(input.files[0]);input.value=''})
  for(const type of ['dragenter','dragover'])upload.addEventListener(type,e=>{e.preventDefault();e.stopPropagation();upload.classList.add('is-dragging')});upload.addEventListener('dragleave',()=>upload.classList.remove('is-dragging'));upload.addEventListener('drop',e=>{e.preventDefault();e.stopPropagation();upload.classList.remove('is-dragging');if(e.dataTransfer.files.length!==1){error('每次请上传一个授权文件。');return}importFile(e.dataTransfer.files[0])})
  const message=el('p','','license-error');message.setAttribute('role','status');message.setAttribute('aria-live','polite');message.id=(full?'gate':'settings')+'LicenseError';upload.setAttribute('aria-describedby',message.id)
  /* 本机设备与授权申请：常驻展开，不再折叠（用户 2026-11-02 要求全部显示）。 */
  const device=el('section',undefined,'license-device'),deviceTitle=el('h3','本机设备与授权申请','license-device-title'),short=el('p','正在读取申请标识…','license-device-code')
  device.append(deviceTitle,el('p','将申请文件发给管理员，获取与本机匹配的授权文件。','muted'),short)
  /* 底部操作区：所有按钮集中到这里。取消 = 关闭软件，因此只出现在启动授权门上。 */
  const actions=el('div',undefined,'modal-actions license-actions'),cancel=full?el('button','取消','license-cancel'):null,download=el('button','导出申请文件'),retry=el('button','重新检查'),trial=el('button','试用1天','license-primary'),trialHelp=el('p','试用仅可开启一次，退出或重启不重置。','muted license-trial-help')
  for(const button of [cancel,download,retry,trial])if(button)button.type='button'
  trial.disabled=true
  retry.addEventListener('click',refresh)
  trial.addEventListener('click',()=>act('trial'))
  if(cancel)cancel.addEventListener('click',async()=>{cancel.disabled=true;try{if(window.dsh&&typeof window.dsh.quitApp==='function')await window.dsh.quitApp();window.close()}catch(e){error('无法退出程序：'+e.message);cancel.disabled=false}})
  download.addEventListener('click',async()=>{try{const value=await request('request'),url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})),a=el('a');a.href=url;a.download='Agent-'+shortId(value.deviceDigest)+'.agentreq';host.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000)}catch(e){error(e.message)}})
  if(cancel)actions.append(cancel)
  actions.append(download,retry,trial)
  /* 内容区单独滚动、按钮行常驻卡片底部：申请区常开之后卡片会变高，
     窄屏或小窗口下不能让「取消」掉到可视区外。 */
  const body=el('div',undefined,'license-body');body.append(header,info,label,upload,input,message,device)
  host.append(body,actions,trialHelp)
  panels.push({host,status,countdown,expiry,customer,short,upload,input,error:message,download,retry,trial,trialHelp})
 }
 panel(gateHost,true);panel(settingsHost,false);gate.tabIndex=-1
 window.addEventListener('keydown',event=>{if(!locked)return;if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();return}if(event.key==='Tab'){const controls=Array.from(gate.querySelectorAll('button,input,a[href]')).filter(n=>!n.disabled&&n.getClientRects().length),first=controls[0],last=controls[controls.length-1];if(!controls.length){event.preventDefault();gate.focus();return}if(event.shiftKey&&(document.activeElement===first||!gate.contains(document.activeElement))){event.preventDefault();event.stopImmediatePropagation();last.focus()}else if(!event.shiftKey&&(document.activeElement===last||!gate.contains(document.activeElement))){event.preventDefault();event.stopImmediatePropagation();first.focus()}}else if(!gate.contains(event.target)&&!((event.metaKey||event.altKey)&&['q','F4'].includes(event.key))){event.preventDefault();event.stopImmediatePropagation()}},true)
 gate.addEventListener('keydown',event=>event.stopPropagation())
 gate.addEventListener('pointerdown',event=>{if(event.target===gate)event.preventDefault()})
 document.addEventListener('focusout',()=>{if(locked)setTimeout(ensureFocus,0)},true)
 document.addEventListener('focusin',event=>{if(locked&&!gate.contains(event.target)){const first=gate.querySelector('button:not(:disabled)');(first||gate).focus()}},true)
 for(const type of ['dragover','drop'])document.addEventListener(type,event=>{if(locked&&!gateHost.contains(event.target)){event.preventDefault();event.stopImmediatePropagation()}},true)
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()})
 document.addEventListener('click',event=>{if(event.target.closest('[data-settings-tab="license"]'))refresh()})
 function boot(){lock();refresh()}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',boot,{once:true});else boot()
 const timer=setInterval(()=>{ensureFocus();if(current&&current.allowed&&current.expiresAt){const observed=current.serverNow+Math.max(0,performance.now()-current.received);for(const p of panels){const seconds=Math.ceil(Math.max(0,current.expiresAt-observed)/1000);if(current.status==='trial')p.countdown.textContent='剩余 '+String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')}if(observed>=current.expiresAt){lock();refresh()}}},500)
 const poll=setInterval(refresh,15000);window.addEventListener('beforeunload',()=>{clearInterval(timer);clearInterval(poll);if(observer)observer.disconnect()},{once:true})
 window.licensingUI={refresh,isLocked:()=>locked}
})()
