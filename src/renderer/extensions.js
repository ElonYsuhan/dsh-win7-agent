'use strict'
;(function(){
 const byId=id=>document.getElementById(id),names={skill:'技能',mcp:'MCP',plugin:'插件'}
 let packages=[],busy=false,ready=false
 const notice=text=>{byId('capabilityNotice').textContent=text}
 function button(text,handler){const b=document.createElement('button');b.type='button';b.textContent=text;b.addEventListener('click',handler);return b}
 function render(){
  for(const [type,id] of Object.entries({skill:'installedSkills',mcp:'installedMcp',plugin:'installedPlugins'})){
   const box=byId(id);box.textContent=''
   const query=type==='skill'?(byId('skillSearch').value||'').trim().toLowerCase():''
   for(const item of packages.filter(p=>p.type===type&&(!query||(p.name+' '+p.id+' '+p.description).toLowerCase().includes(query)))){
    const card=document.createElement('article');card.className='extension-card extension-card-'+type;card.dataset.extensionId=item.id
    const heading=document.createElement('div'),info=document.createElement('div'),title=document.createElement('strong'),meta=document.createElement('p'),description=document.createElement('p');heading.className='extension-card-heading';info.className='extension-card-body';title.className='extension-title'
    title.textContent=item.name;meta.className='muted';meta.textContent=item.id+' · v'+item.version+' · '+(item.active?'已启用':item.enabled?'启用异常':'已停用');description.textContent=item.description;description.title=item.description;description.className='extension-description';info.append(meta,description)
    const actions=document.createElement('div');actions.className='extension-actions'
    const toggle=button(item.enabled?'停用':'启用',()=>operate(()=>window.dsh.extensionRequest('enable',{id:item.id,enabled:!item.enabled}),'已'+(item.enabled?'停用':'启用')+'：'+item.name));toggle.className='plugin-switch'+(item.enabled?' on':'');toggle.textContent='';toggle.setAttribute('role','switch');toggle.setAttribute('aria-checked',String(item.enabled));toggle.title=item.enabled?'停用':'启用';const knob=document.createElement('span');knob.className='plugin-switch-knob';knob.setAttribute('aria-hidden','true');toggle.append(knob);toggle.disabled=busy;toggle.setAttribute('aria-label',(item.enabled?'停用':'启用')+names[type]+' '+item.name)
    const remove=button('卸载',async()=>{if(await window.appDialogs.confirm('卸载「'+item.name+'」？历史会话与工作流记录将保留。'))await operate(()=>window.dsh.extensionRequest('remove',{id:item.id}),'已卸载：'+item.name)});remove.className='mcp-icon-button extension-remove';remove.textContent='';remove.setAttribute('aria-label','卸载'+names[type]+' '+item.name);const icon=document.createElement('span');icon.className='icon';icon.setAttribute('aria-hidden','true');icon.innerHTML=window.renderIcon('trash');remove.append(icon);remove.disabled=busy||item.enabled;remove.title=item.enabled?'请先停用再卸载':'卸载扩展包';actions.append(remove,toggle);heading.append(title,actions);card.append(heading,info)
    if(item.error){const error=document.createElement('p');error.className='extension-error';error.textContent=item.error;card.append(error)}
    box.append(card)
   }
  }
  byId('extensionInstall').disabled=busy
 }
 async function refresh(){if(!window.dsh||!window.dsh.extensionRequest)return;const value=await window.dsh.extensionRequest('list');packages=value.packages||[];render();if(typeof renderPlugins==='function')renderPlugins();if(typeof renderSkills==='function')renderSkills()}
 async function sync(){const next=await window.dsh.getState();if(typeof renderSkills==='function')renderSkills(next.skills);if(typeof renderPlugins==='function')renderPlugins(next.plugins,next.tools);if(typeof renderMcp==='function')renderMcp(next.mcp)}
 async function operate(action,message){if(busy)return;const focus=document.activeElement,card=focus&&focus.closest('.extension-card'),focusId=card&&card.dataset.extensionId,focusIndex=card?Array.from(card.querySelectorAll('button')).indexOf(focus):0;busy=true;render();try{await action();await refresh();await sync();notice(message)}catch(e){notice(e.message);try{await refresh()}catch(_){}}finally{busy=false;render();const card=Array.from(document.querySelectorAll('.extension-card')).find(c=>c.dataset.extensionId===focusId),target=card&&card.querySelectorAll('button')[focusIndex];(target&&!target.disabled?target:byId('extensionInstall')).focus()}}
 async function install(file){if(busy||!file)return;if(!/\.(skill\.pgk|mcp\.pgk|plugin\.pgk|agentpkg|zip)$/i.test(file.name)){notice('请选择 .skill.pgk、.mcp.pgk 或 .plugin.pgk 离线扩展包');return}if(file.size>8*1024*1024){notice('离线扩展包不能超过8MB');return}busy=true;render();let token
  try{notice('正在检查离线扩展包…');const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(Error('读取扩展包失败'));reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.readAsDataURL(file)});const preview=await window.dsh.extensionRequest('inspect',{data,filename:file.name});token=preview.token;const m=preview.manifest
   const text=[names[m.type]+'：'+m.displayName,m.publisher+'.'+m.name+' · v'+m.version,m.description,preview.installedVersion?'当前版本：'+preview.installedVersion+'，升级前请先停用。':'安装后默认停用，可在对应栏目启用。',m.type==='plugin'?'启用后插件代码在本机运行，请确认来源可信。':m.type==='mcp'?'MCP 权限：'+m.mcp.permission+(m.mcp.url?'；服务：'+m.mcp.url:'；使用随包 Node 离线运行。'):'技能正文和附带资料按需加载，不会自动执行脚本。'].join('\n\n')
   if(await window.appDialogs.confirm(text)){await window.dsh.extensionRequest('install',{token});notice('已安装「'+m.displayName+'」，请到'+names[m.type]+'栏目启用。');token=null;await refresh();await sync()}else notice('已取消安装')
  }catch(e){notice(e.message)}finally{if(token)try{await window.dsh.extensionRequest('discard',{token})}catch(_){}busy=false;byId('extensionFile').value='';render();byId('extensionInstall').focus()}
 }
 function init(){if(ready)return;ready=true;byId('extensionInstall').addEventListener('click',()=>byId('extensionFile').click());byId('extensionFile').addEventListener('change',event=>install(event.target.files[0]));byId('skillSearch').addEventListener('input',render)
  const center=byId('capabilityCenter');center.addEventListener('dragover',event=>{if(!Array.from(event.dataTransfer.types).includes('Files'))return;event.preventDefault();event.dataTransfer.dropEffect='copy';center.classList.add('extension-drag-over')});center.addEventListener('dragleave',event=>{if(!center.contains(event.relatedTarget))center.classList.remove('extension-drag-over')});center.addEventListener('drop',event=>{event.preventDefault();event.stopPropagation();center.classList.remove('extension-drag-over');const files=event.dataTransfer.files;if(files.length!==1){notice('请一次安装一个离线扩展包');return}install(files[0])});byId('openCustomize').addEventListener('click',()=>refresh().catch(e=>notice(e.message)));refresh().catch(e=>notice(e.message))
 }
 window.extensionUI={refresh,install,isManagedPlugin:name=>packages.some(p=>p.type==='plugin'&&p.id===name),packageCount:type=>packages.filter(p=>p.type===type).length}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init()
})()
