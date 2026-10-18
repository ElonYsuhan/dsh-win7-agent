'use strict'

;(function (root) {
  const escape = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  function outcome(text) {
    const value = String(text || '')
    if (/^(ABORTED|CANCELLED)/i.test(value)) return 'cancelled'
    if (/^(ERROR|DENIED|DISABLED):/i.test(value) || /exitCode\s*[=:]\s*(-?[1-9]\d*|null)/i.test(value)) return 'failed'
    return 'completed'
  }
  function lineDiff(before, after) {
    const a = String(before).split('\n'), b = String(after).split('\n')
    let start = 0, end = 0
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1
    while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end += 1
    const head = a.slice(Math.max(0, start - 2), start).map((line) => ' ' + line)
    const removed = a.slice(start, a.length - end).map((line) => '-' + line)
    const added = b.slice(start, b.length - end).map((line) => '+' + line)
    const tail = a.slice(a.length - end, a.length - end + 2).map((line) => ' ' + line)
    return ['@@ 原文 ' + (start + 1) + '，修改后 ' + (start + 1) + ' @@'].concat(head, removed, added, tail).join('\n')
  }
  function estimatedTokens(messages) {
    let total=0
    for(const message of messages||[]){
      if(message.role==='system')continue
      const content=typeof message.content==='string'?message.content:Array.isArray(message.content)?message.content.filter(p=>p.type==='text').map(p=>p.text||'').join(''):''
      const text=content+(message.tool_calls?JSON.stringify(message.tool_calls):'')
      let cjk=0,ascii=0,other=0
      for(const ch of text){if(/[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\uAC00-\uD7AF]/.test(ch))cjk++;else if(ch.charCodeAt(0)<128)ascii++;else other++}
      total+=4+Math.ceil(cjk+ascii/4+other/2)
    }
    return total
  }
  function flowSvg(source) {
    if (!/^\s*(flowchart|graph)\s+(TB|TD|LR|RL|BT)\b/.test(source)) throw new Error('该图形语法暂不支持预览，源码已保留')
    const nodes = new Map(), edges = []
    const declarations = /\b([A-Za-z_]\w*)\s*(?:\["([^"]*)"\]|\[([^\]]*)\]|\("([^"]*)"\)|\(([^)]*)\)|\{([^}]*)\})/g
    for (const line of source.split('\n')) {
      if (/^\s*(subgraph|end|style|class|click|%%)/.test(line)) continue
      let m
      while ((m = declarations.exec(line))) nodes.set(m[1], (m[2] || m[3] || m[4] || m[5] || m[6] || m[1]).replace(/<br\s*\/?>/g, '\n'))
      const normalized = line.replace(/\b([A-Za-z_]\w*)\s*(\[[^\]]*\]|\([^)]*\)|\{[^}]*\})/g, '$1')
      if (/\s--\s+/.test(normalized)) throw new Error('该连接语法暂不支持预览，源码已保留')
      const links = /\b([A-Za-z_]\w*)\s*(<-->|-->|-\.->|==>)(?:\|([^|]*)\|)?\s*([A-Za-z_]\w*)/g
      while ((m = links.exec(normalized))) {
        edges.push([m[1], m[4], m[3] || ''])
        if (m[2] === '<-->') edges.push([m[4], m[1], ''])
        if (!nodes.has(m[1])) nodes.set(m[1], m[1])
        if (!nodes.has(m[4])) nodes.set(m[4], m[4])
        links.lastIndex -= m[4].length
      }
    }
    if (/[&]/.test(source.replace(/&(?:amp|lt|gt|quot);/g,''))) throw new Error('组合节点语法暂不支持预览，源码已保留')
    if (!nodes.size || nodes.size > 40) throw new Error('图形过大或语法无法识别，请查看源码')
    const ids = Array.from(nodes.keys()), height = ids.length * 100 + 30
    const paths = edges.map(([a,b,label]) => {
      const y1 = ids.indexOf(a) * 100 + 70, y2 = ids.indexOf(b) * 100 + 30
      return '<path d="M320 ' + y1 + ' C500 ' + y1 + ' 500 ' + y2 + ' 320 ' + y2 + '" fill="none" stroke="#777" marker-end="url(#arrow)"/><text x="440" y="' + ((y1+y2)/2) + '" font-size="11">' + escape(label) + '</text>'
    }).join('')
    const boxes = ids.map((id,i) => '<g><rect x="30" y="' + (i*100+20) + '" width="290" height="60" rx="10" fill="#f4f4f4" stroke="#888"/><text x="45" y="' + (i*100+44) + '" font-size="13">' + nodes.get(id).split('\n').slice(0,3).map((line,j) => '<tspan x="45" dy="' + (j ? 16 : 0) + '">' + escape(line) + '</tspan>').join('') + '</text></g>').join('')
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 580 ' + height + '" role="img" aria-label="流程图"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8" fill="#777"/></marker></defs><g fill="#222" font-family="sans-serif">' + paths + boxes + '</g></svg>'
  }
  const api = { outcome, lineDiff, flowSvg, estimatedTokens }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (!root || !root.document) return
  const doc = root.document
  const el = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text != null) node.textContent = text; return node }
  const button = (text, handler) => { const b = el('button', '', text); b.type='button'; b.addEventListener('click', handler); return b }
  let host = null
  function notify(text) { if (host) host.status(text) }
  async function copy(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(text)
      else {
        const previous=doc.activeElement,area=el('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';doc.body.appendChild(area);area.select()
        const copied=doc.execCommand('copy');area.remove();if(previous)previous.focus();if(!copied)throw new Error('COPY_FAILED')
      }
      notify('已复制')
    } catch(error){notify('复制失败，请手动选择文本')}
  }
  function download(text, name, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime })), a = el('a')
    a.href = url; a.download = name; doc.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  function safeSvg(text) {
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml')
    if (parsed.querySelector('parsererror') || parsed.documentElement.localName !== 'svg') throw new Error('SVG 格式无效')
    const tags = new Set(['svg','g','rect','circle','ellipse','line','path','polyline','polygon','text','tspan','defs','marker','title','desc'])
    const attrs = new Set(['xmlns','viewBox','width','height','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','d','points','fill','stroke','stroke-width','font-size','font-family','font-weight','text-anchor','transform','dy','dx','id','marker-end','markerWidth','markerHeight','refX','refY','orient','role','aria-label'])
    for (const node of [parsed.documentElement].concat(Array.from(parsed.documentElement.querySelectorAll('*')))) {
      if (!tags.has(node.localName)) { node.remove(); continue }
      for (const attr of Array.from(node.attributes)) {
        if (!attrs.has(attr.name) || /(?:https?:|javascript:|data:|url\((?!#[\w-]+\)))/i.test(attr.value)) node.removeAttribute(attr.name)
      }
    }
    return parsed.documentElement
  }
  function enlarge(svg) {
    const overlay = el('div','artifact-overlay'), card = el('section','artifact-viewer')
    overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-label','图形预览')
    const previous = doc.activeElement, close = button('关闭预览', () => { overlay.remove(); if (previous) previous.focus() })
    card.appendChild(close); card.appendChild(svg.cloneNode(true)); overlay.appendChild(card); doc.body.appendChild(overlay); close.focus()
    overlay.addEventListener('click', e => { if (e.target === overlay) close.click() })
    overlay.addEventListener('keydown', e => { if(e.key==='Escape'){e.stopPropagation();close.click()} if(e.key==='Tab'){e.preventDefault();close.focus()} })
  }
  api.artifacts = function (body) {
    for (const code of body.querySelectorAll('code[data-lang]')) {
      const language = code.getAttribute('data-lang')
      if (!['mermaid','svg','diff'].includes(language) || code.dataset.artifactReady) continue
      code.dataset.artifactReady = '1'
      const source = code.textContent, block = code.parentElement, card = el('section','artifact-card')
      const actions = el('div','artifact-actions')
      actions.appendChild(el('strong','',language==='diff'?'文件变更':language==='mermaid'?'流程图 · 简化布局':'图形产物'))
      actions.appendChild(button('复制源码',()=>copy(source)))
      card.appendChild(actions)
      try {
        if (language === 'diff') {
          const pre = el('pre','artifact-diff')
          for (const line of source.split('\n')) pre.appendChild(el('div',line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':'',line))
          card.appendChild(pre)
        } else {
          const svg = safeSvg(language==='mermaid'?flowSvg(source):source)
          const preview = el('div','artifact-preview'); preview.appendChild(doc.importNode(svg,true));card.appendChild(preview)
          actions.appendChild(button('放大',()=>enlarge(svg)))
          actions.appendChild(button('导出 SVG',()=>download(new XMLSerializer().serializeToString(svg),'agent-diagram.svg','image/svg+xml')))
        }
        const details = el('details'), summary=el('summary','','查看源码');details.appendChild(summary)
        block.parentNode.insertBefore(card,block); details.appendChild(block);card.appendChild(details)
      } catch(error) { card.appendChild(el('p','muted',error.message)); block.parentNode.insertBefore(card,block) }
    }
  }
  api.diffPreview = function(step,name,args,result) {
    if (!step || !['write_file','edit_file'].includes(name) || outcome(result)!=='completed') return
    const detail = el('details','file-change'), summary=el('summary','','文件变更 · '+(args.path||'文件'))
    detail.appendChild(summary)
    const pre=el('pre','artifact-diff')
    const text=name==='edit_file'?lineDiff(args.oldText||'',args.newText||''):String(args.content||'').split('\n').map(line=>'+'+line).join('\n')
    detail.appendChild(el('p','muted',name==='edit_file'?'本次精确替换片段；完整文件可在文件面板查看。':'本次写入内容；旧文件内容未知，不显示伪造的删除差异。'))
    for(const line of text.split('\n'))pre.appendChild(el('div',line.startsWith('+')?'diff-add':line.startsWith('-')?'diff-remove':'',line))
    detail.appendChild(pre)
    if (root.filePanel) detail.appendChild(button('打开文件',()=>root.filePanel.openFile(args.path)))
    step.appendChild(detail)
  }
  api.sessionBadge = function(session, running) {
    const status=running?'running':(session.lastExecution&&session.lastExecution.status)||'idle'
    const labels={running:'运行中',completed:'已完成',cancelled:'已停止',failed:'出错',timed_out:'超时',blocked:'受阻',exhausted:'达到上限',interrupted:'已中断',idle:'未运行'}
    const badge=el('span','session-state state-'+status);badge.title=labels[status]||status;badge.setAttribute('aria-label',badge.title);return badge
  }
  api.context = function(session,settings) {
    const node=doc.getElementById('contextUsage');if(!node)return
    const used=estimatedTokens((session&&session.messages)||[]), limit=Number(settings&&settings.contextWindowTokens)||0
    node.textContent='≈ '+(used/1000).toFixed(1)+'k'+(limit?' / '+Math.round(limit/1000)+'k':' tokens')
    node.title='会话内容粗略估算，不含系统提示词、工具定义与图片成本；不是模型计费数据。'
  }
  /* 空状态的建议按**当前工作区里实际有什么**来出（用户 2026-10-17：「这几个是你写死的还是？
     到时候是内网。你能根据现状推荐有用的吗」）。
     先给一句通用兜底，拿到目录清单后再替换成贴合项目的三条。 */
  const FALLBACK_SUGGESTIONS=['看看当前目录里有什么','帮我定位并修复一个报错','检查这个项目的 Win7 兼容性']
  async function suggestions(){
    const out=[]
    let entries=[]
    try{
      const settings=(typeof state!=='undefined'&&state.settings)||{}
      const projects=settings.projects||[]
      const current=(projects.find(p=>p.id===settings.currentProjectId)||projects[0]||{})
      const folders=current.folders||[]
      if(folders.length===0)return FALLBACK_SUGGESTIONS.slice()
      const data=await root.dsh.fsTree(folders[0],1)
      entries=(data.entries||[]).map(e=>String(e.name||''))
    }catch(_){return FALLBACK_SUGGESTIONS.slice()}
    const has=name=>entries.some(e=>e===name||e.startsWith(name))
    if(has('package.json'))out.push('这个项目依赖了什么，怎么构建和跑起来？')
    if(has('src')||has('app')||has('source'))out.push('介绍一下源码目录里的主要模块')
    if(has('docs')||has('doc')||has('README.md'))out.push('把这些文档汇总成一篇说明')
    if(has('.git'))out.push('看看仓库里有哪些未提交的改动')
    if(has('Dockerfile')||has('docker-compose.yml'))out.push('这个项目的容器是怎么起的')
    if(!has('package.json')&&entries.length===0)return FALLBACK_SUGGESTIONS.slice()
    out.push('帮我定位并修复一个报错')
    out.push('检查这个项目的 Win7 兼容性')
    return out.slice(0,3)
  }
  api.empty = function(container) {
    const box=el('section','chat-empty');box.appendChild(el('h2','','从一个具体任务开始'))
    box.appendChild(el('p','muted','选择项目后，描述目标；执行步骤和产物会显示在对话中。'))
    const list=el('div','chat-empty-actions')
    const fill=items=>{list.textContent='';for(const text of items)list.appendChild(button(text,()=>{host.setInput(text);doc.getElementById('input').focus()}))}
    fill(FALLBACK_SUGGESTIONS);box.appendChild(list);container.appendChild(box)
    suggestions().then(fill).catch(()=>{})
  }
  function composerMenu() {
    const modal=el('div','artifact-overlay'), card=el('section','quick-menu');modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');modal.setAttribute('aria-label','输入辅助')
    let restore=doc.activeElement
    const close=()=>{modal.remove();if(restore)restore.focus()}
    const add=(text,fn)=>card.appendChild(button(text,()=>{close();fn()}))
    add('引用文件 @',()=>filePicker())
    add('添加图片附件',()=>{const input=el('input');input.type='file';input.accept='image/*';input.multiple=true;input.addEventListener('change',async()=>{for(const file of Array.from(input.files||[])){if(file.size>16*1024*1024){notify('图片超过 16MB');continue}const reader=new FileReader();reader.onload=()=>host.attach(reader.result);reader.readAsDataURL(file)}});input.click()})
    add('新建普通会话',()=>host.association())
    add('新建关联项目的会话',()=>host.association('project'))
    add('新建关联知识库的会话',()=>host.association('knowledge'))
    add('选择工作目录',()=>host.workspace())
    for(const [command,text] of [['/analyze','分析当前仓库结构，指出主要模块'],['/fix','定位以下报错并提出修复：'],['/review','检查当前代码的问题，给出具体文件和验证建议']])add(command+' · '+text,()=>{host.setInput(text);doc.getElementById('input').focus()})
    add('关闭',()=>{})
    modal.appendChild(card);doc.body.appendChild(modal);card.querySelector('button').focus()
    modal.addEventListener('click',e=>{if(e.target===modal)close()})
    modal.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close()}if(e.key==='Tab'){const all=Array.from(card.querySelectorAll('button'));const i=all.indexOf(doc.activeElement);if(e.shiftKey&&i===0){e.preventDefault();all[all.length-1].focus()}else if(!e.shiftKey&&i===all.length-1){e.preventDefault();all[0].focus()}}})
  }
  async function filePicker() {
    if(!root.dsh||typeof root.dsh.fsRoots!=='function'){notify('当前宿主不支持文件引用');return}
    const overlay=el('div','artifact-overlay'),card=el('section','quick-menu'),list=el('div','reference-list'),search=el('input');search.placeholder='筛选当前目录';search.setAttribute('aria-label','筛选文件')
    overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','选择引用文件')
    const previous=doc.activeElement,close=()=>{overlay.remove();if(previous)previous.focus()}
    card.appendChild(button('返回项目根目录',()=>load('')));card.appendChild(search);card.appendChild(list);card.appendChild(button('关闭',close));overlay.appendChild(card);doc.body.appendChild(overlay);search.focus()
    let items=[]
    const render=()=>{list.textContent='';for(const item of items.filter(x=>x.name.toLowerCase().includes(search.value.toLowerCase())))list.appendChild(button((item.dir?'目录 · ':'文件 · ')+item.name,()=>{if(item.dir)load(item.path);else{const current=host.input().replace(/@\s*$/,'');host.setInput(current+' @'+JSON.stringify(item.path)+' ');close()}}))}
    async function load(target){try{list.textContent='正在读取…';search.value='';const data=target?await root.dsh.fsTree(target,1):await root.dsh.fsRoots();items=target?(data.entries||[]):(data.roots||[]).map(x=>({name:x.name||x.path,path:x.path,dir:true}));render()}catch(error){list.textContent=error.message}}
    search.addEventListener('input',render);overlay.addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();close()}if(e.key==='Tab'){const all=Array.from(card.querySelectorAll('button,input'));const i=all.indexOf(doc.activeElement);if(e.shiftKey&&i===0){e.preventDefault();all[all.length-1].focus()}else if(!e.shiftKey&&i===all.length-1){e.preventDefault();all[0].focus()}}});overlay.addEventListener('click',e=>{if(e.target===overlay)close()});await load('')
  }
  api.connection=function(connected,message){
    const status=doc.getElementById('serviceConnection'),alert=doc.getElementById('connectionAlert'),retry=doc.getElementById('statusRetry')
    if(status){status.textContent=connected?'服务已连接':'服务连接异常';status.setAttribute('data-connection',connected?'ok':'error')}
    if(alert){alert.textContent=connected?'':(message||'服务连接失败，请重试连接或查看诊断。');alert.classList.toggle('hidden',connected)}
    if(retry)retry.classList.toggle('hidden',connected)
  }
  api.runState=function(running){
    const box=doc.getElementById('taskPlan');if(!box)return
    box.classList.toggle('plan-paused',!running)
    for(const item of box.querySelectorAll('[data-plan-status="in_progress"]')){const label=item.querySelector('.plan-status');if(label)label.textContent=running?'进行中':'未完成'}
  }
  api.planResult=function(result){
    if(!String(result).startsWith('[agent-plan:v1]'))return false
    try{
      const data=JSON.parse(String(result).slice('[agent-plan:v1]'.length)),box=doc.getElementById('taskPlan')
      if(!box||!Array.isArray(data.steps)||data.steps.length>12)return false
      box.textContent='';box.classList.remove('hidden')
      const title=el('summary','','计划'),details=el('details');details.open=true;details.appendChild(title)
      const list=el('ol')
      const labels={pending:'待执行',in_progress:'进行中',completed:'已完成',blocked:'受阻'}
      for(const step of data.steps){const row=el('li','plan-item');row.setAttribute('data-plan-status',step.status);row.appendChild(el('span','plan-status',labels[step.status]||'状态未知'));row.appendChild(el('span','',String(step.title||'')));list.appendChild(row)}
      details.appendChild(list);box.appendChild(details);api.positionPlan();return true
    }catch(error){return false}
  }
  api.positionPlan=function(){
    const box=doc.getElementById('taskPlan'),container=doc.getElementById('messagesInner');if(!box||!container||box.classList.contains('hidden'))return
    const users=container.querySelectorAll('.bubble-group');const last=users[users.length-1]
    const before=last?last.nextSibling:container.firstChild
    if(before!==box)container.insertBefore(box,before)
  }
  api.clearPlan=function(){const box=doc.getElementById('taskPlan');if(box){box.textContent='';box.classList.add('hidden')}}
  api.planFromMessages=function(messages){
    let lastUser=-1,lastPlan=-1
    for(let i=0;i<messages.length;i++){if(messages[i].role==='user')lastUser=i;if(messages[i].role==='tool'&&typeof messages[i].content==='string'&&messages[i].content.startsWith('[agent-plan:v1]'))lastPlan=i}
    if(lastPlan===-1||lastPlan<lastUser)api.clearPlan();else api.planResult(messages[lastPlan].content)
  }
  api.menu=composerMenu
  let initialized=false
  api.init=function(callbacks){host=callbacks;if(initialized)return;initialized=true;const input=doc.getElementById('input');input.addEventListener('input',e=>{if(e.isComposing)return;const text=host.input();if(text==='/'||text==='@'){if(text==='@')filePicker();else composerMenu()}});doc.getElementById('statusRetry').addEventListener('click',()=>host.retry());doc.getElementById('statusLogs').addEventListener('click',()=>host.logs())}
  root.agentUI=api
})(typeof window==='undefined'?null:window)
