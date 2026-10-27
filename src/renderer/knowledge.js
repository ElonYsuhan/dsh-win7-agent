'use strict'
;(function () {
  const $ = id => document.getElementById(id), page = $('knowledgePage')
  if (!page) return
  let snapshot = { bases: [], documents: [], jobs: [] }, selected = '', editingBase = ''
  let detail = false, bindingBase = '', previewId = '', fileMatches = null, fileSearchTimer = null, fileSearchToken = 0
  let busy = false, again = false, pending = false, sourceToken = 0, searchToken = 0, priorFocus = null
  const groupStates = new Map()
  let previewUrl = null, selectedFile = ''
  let uploading=false, stopUploads=false, uploadBaseName='', uploads=[],  uploadedCount=0
  const views = new Map()
  function disposeView(state){for(const tab of state.tabs)if(tab.url)URL.revokeObjectURL(tab.url);state.tabs=[]}
  function view() {
    if(!views.has(selected))views.set(selected,{tabs:[],active:''})
    const current=views.get(selected);views.delete(selected);views.set(selected,current)
    while(views.size>4){const oldest=views.keys().next().value;disposeView(views.get(oldest));views.delete(oldest)}
    return current
  }
  function trimPreviewMemory(){
    let bytes=[...views.values()].reduce((sum,state)=>sum+state.tabs.reduce((n,t)=>n+(t.memoryBytes||0),0),0)
    for(const [base,state] of views){
      for(const tab of state.tabs.slice()){
        if(bytes<=32*1024*1024)return
        if(base===selected&&tab.target===state.active)continue
        state.tabs=state.tabs.filter(t=>t!==tab);bytes-=tab.memoryBytes||0;if(tab.url)URL.revokeObjectURL(tab.url)
        if(state.active===tab.target)state.active=state.tabs.length?state.tabs[state.tabs.length-1].target:''
      }
    }
  }
  function renderPreviewTabs() {
    const host=$('knowledgeSharedPreview'),current=view();host.classList.add('knowledge-code-preview');host.dataset.base=selected;
    let bar=$('knowledgeTabs'),body=$('knowledgePreviewBody');if(!bar){bar=el('div',undefined,'panel-tabs');bar.id='knowledgeTabs';bar.setAttribute('role','tablist');bar.setAttribute('aria-label','知识库文件');body=el('div',undefined,'panel-preview');body.id='knowledgePreviewBody';host.prepend(bar);host.append(body)}
    bar.textContent='';body.textContent='';body.classList.remove('is-fit');
    for(const tab of current.tabs){const group=el('div',undefined,'panel-tab'+(tab.target===current.active?' active':''));const button=action(tab.value.title,()=>{current.active=tab.target;selectedFile=tab.target;renderPreviewTabs();render()});button.setAttribute('role','tab');button.setAttribute('aria-selected',String(tab.target===current.active));const close=action('×',()=>{current.tabs=current.tabs.filter(t=>t!==tab);if(tab.url)URL.revokeObjectURL(tab.url);if(current.active===tab.target)current.active=current.tabs.length?current.tabs[current.tabs.length-1].target:'';selectedFile=current.active;renderPreviewTabs();render()});close.setAttribute('aria-label','关闭 '+tab.value.title);group.append(button,close);bar.append(group)}
    const active=current.tabs.find(t=>t.target===current.active);if(active){window.filePreview.render(body,active.value);if(active.value.download&&active.value.url){const download=action('下载原文件',()=>{const link=el('a');link.href=active.value.url;link.download=active.value.title;document.body.append(link);link.click();link.remove()});download.className='knowledge-download';body.append(download)}selectedFile=active.target}else body.textContent='选择左侧文件以预览资料'
  }
  const treeCache = new Map(), treePending = new Set()
  function fileGroup(key, title) {
    const stateKey = selected + ':' + key, group = el('details', undefined, 'knowledge-file-group')
    group.open = groupStates.get(stateKey) !== false
    const summary = el('summary', title); summary.dataset.knowledgeControl = stateKey + ':group'; group.append(summary)
    summary.addEventListener('click', () => groupStates.set(stateKey, !group.open))
    group.addEventListener('toggle', () => { if (group.isConnected) groupStates.set(stateKey, group.open) })
    return group
  }
  function projectFolder(root, target, name, sessionId) {
    const key = selected + ':' + (sessionId||'project') + ':' + root + ':' + target, baseId = selected
    const folder = fileGroup('path:' + target, name); folder.classList.add('knowledge-project-folder')
    folder.open = groupStates.get(selected + ':path:' + target) === true
    const children = el('div', undefined, 'knowledge-tree-children'); folder.append(children)
    const load = () => {
      if (!folder.open) return
      if (!treeCache.has(key)) {
        children.textContent = '正在加载…'
        if (!treePending.has(key)) { treePending.add(key); api(sessionId?'session-tree':'tree', {baseId,root,path:target,sessionId}).then(result => {treeCache.set(key,result);while(treeCache.size>64)treeCache.delete(treeCache.keys().next().value);if(baseId===selected)render()}).catch(e => {treeCache.set(key,{error:e.message});if(baseId===selected)render()}).finally(()=>treePending.delete(key)) }
        return
      }
      children.textContent = ''; const result = treeCache.get(key)
      if (result.error) { children.append(el('p', result.error, 'muted')); return }
      for (const item of result.items) {
        if (item.directory) children.append(projectFolder(root,item.path,item.name,sessionId))
        else { const button = action(item.name, async () => {
          const token = ++sourceToken, box = $('knowledgeSource'); box.textContent = '正在读取…'
          try { const value = await api(sessionId?'session-preview':'project-preview',{baseId,root,path:item.path,sessionId});if(token===sourceToken&&baseId===selected&&!page.classList.contains('hidden')){await sharedFile(value,item.path)} } catch(e){if(token===sourceToken)notice(e.message)}
        },key+':'+item.name);button.className='knowledge-tree-file'+(selectedFile===item.path?' selected':'');button.setAttribute('aria-pressed',String(selectedFile===item.path));children.append(button) }
      }
      if (result.truncated) children.append(el('p','该目录仅显示前 2000 项','muted'))
      if (!result.items.length) children.append(el('p','空目录','muted'))
    }
    folder.addEventListener('toggle',()=>{if(folder.isConnected)load()});load();return folder
  }
  async function sharedFile(value,target) {
    const current=view(),ext=value.title.split('.').pop().toLowerCase();let text=value.text||'',url=''
    if(typeof value.bytes==='string'){const bytes=Uint8Array.from(atob(value.bytes),c=>c.charCodeAt(0));if(['text','markdown'].includes(value.kind))text=window.filePanel.decodeBytes(bytes).text;if(value.download||!['text','markdown'].includes(value.kind))url=URL.createObjectURL(new Blob([bytes],{type:value.mime||'application/octet-stream'}))}
    const kind=value.kind==='office'?'text':value.kind==='text'&&!['txt','log','csv'].includes(ext)?'code':value.kind
    const old=current.tabs.find(t=>t.target===target);if(old){if(old.url)URL.revokeObjectURL(old.url);current.tabs=current.tabs.filter(t=>t!==old)}
    const stored={...value,text,url,kind,ext,name:value.title};delete stored.bytes
    const memoryBytes=(typeof value.bytes==='string'?Math.floor(value.bytes.length*3/4):0)+text.length*2
    current.tabs.push({target,url,memoryBytes,value:stored});while(current.tabs.length>12){const tab=current.tabs.shift();if(tab.url)URL.revokeObjectURL(tab.url)}
    current.active=target;selectedFile=target;trimPreviewMemory();renderPreviewTabs();render()
  }
  const labels = { queued: '等待处理', parsing: '正在解析', indexing: '正在建立索引', ready: '可检索', failed: '处理失败', cancelled: '已取消', interrupted: '已中断' }
  const api = (action, data) => window.dsh.knowledgeRequest(action, data)
  function el(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n }
  function location(value) { return [value.heading, value.line ? '第 ' + value.line + ' 行' : '', value.paragraph !== undefined ? '第 ' + (value.paragraph + 1) + ' 段' : '', value.sheet ? value.sheet + ' · ' + value.cell : '', value.formulaCached ? '公式缓存值' : ''].filter(Boolean).join(' · ') }
  function notice(message) { $('knowledgeNotice').textContent = message || '' }
  function action(text, fn, key) {
    const b = el('button', text); b.type = 'button'; if (key) b.dataset.knowledgeControl = key
    b.addEventListener('click', () => {
      if (b.disabled) return
      b.disabled = true
      Promise.resolve().then(fn).catch(e => notice(e.message)).finally(() => { b.disabled = false })
    })
    return b
  }
  function clearResults() { sourceToken++; searchToken++; $('knowledgeResults').textContent = ''; $('knowledgeSource').classList.remove('hidden'); $('knowledgeSource').textContent = '选择左侧文件以预览资料'; $('knowledgeSearch').disabled = false }
  function choose(id) { detail = true; selected = id; previewId = ''; fileMatches = null; $('knowledgeFileQuery').value = ''; fileSearchToken++; clearResults(); render(); if ($('knowledgeQuery').value.trim()) search() }
  function hide() {  if(previewUrl){URL.revokeObjectURL(previewUrl);previewUrl=null}; sourceToken++; searchToken++; page.classList.add('hidden'); $('app').classList.remove('knowledge-open'); $('openLibrary').removeAttribute('aria-current') }
  function open() {
    if(window.workflowUI)window.workflowUI.hide()
    treeCache.clear()
    page.classList.remove('hidden'); $('app').classList.remove('capabilities-open'); $('app').classList.add('knowledge-open')
    $('contentFrame').classList.add('hidden'); $('capabilityCenter').classList.add('hidden'); $('openCustomize').removeAttribute('aria-current'); $('openLibrary').setAttribute('aria-current', 'page'); refresh()
  }
  async function refresh() {
    if (page.classList.contains('hidden')) return
    if (busy) { again = true; return }
    busy = true
    try {
      const next = await api('list')
      const signature = data => JSON.stringify([data.currentScope, data.bases.map(b => [b.id, b.scopes]), data.documents.map(d => [d.id, d.active])])
      const changed = signature(next) !== signature(snapshot)
      if (changed) clearResults()
      snapshot = next
      const liveBases=new Set(snapshot.bases.map(b=>b.id));for(const [baseId,state] of views)if(!liveBases.has(baseId)){disposeView(state);views.delete(baseId)}
      const liveSessions=new Set((snapshot.sessions||[]).map(s=>s.id));let previewChanged=false
      for(const [baseId,viewState] of views){const removed=viewState.tabs.filter(t=>t.value.sessionId&&!liveSessions.has(t.value.sessionId));if(removed.length){for(const tab of removed)if(tab.url)URL.revokeObjectURL(tab.url);viewState.tabs=viewState.tabs.filter(t=>!removed.includes(t));if(!viewState.tabs.some(t=>t.target===viewState.active))viewState.active=viewState.tabs.length?viewState.tabs[viewState.tabs.length-1].target:'';if(baseId===selected)previewChanged=true}}
      if(previewChanged&&detail)renderPreviewTabs()
      if (!snapshot.bases.some(b => b.id === selected)) selected = snapshot.bases[0] ? snapshot.bases[0].id : ''
      render(); notice(snapshot.error || '')
      if (changed && $('knowledgeQuery').value.trim() && selected) search()
    } catch (e) { notice('知识库暂不可用：' + e.message) }
    finally { busy = false; if (again) { again = false; refresh() } }
  }
  function render() {
    selectedFile = view().active
    const focused = document.activeElement && document.activeElement.dataset.knowledgeControl
    if (!snapshot.bases.some(b => b.id === selected)) detail = false
    page.classList.toggle('knowledge-detail-open', detail)
    if (detail && $('knowledgeSharedPreview').dataset.base !== selected) renderPreviewTabs()
    const currentBase = snapshot.bases.find(b => b.id === selected)
    $('knowledgeTitle').textContent = detail && currentBase ? currentBase.name : '知识库'
    $('knowledgeDetail').classList.toggle('hidden', !detail)
    $('knowledgeOverview').classList.toggle('hidden', !detail)
    const bases = $('knowledgeBases'); bases.textContent = ''
    for (const base of snapshot.bases) {
      const active = selected === base.id, card = el('article', undefined, 'knowledge-card' + (active ? ' selected' : ''))
      card.dataset.baseId = base.id
      const title = action(base.name, () => choose(base.id), base.id + ':select'); title.className = 'knowledge-base-title'; title.setAttribute('aria-pressed', String(active))
      const heading = el('div', undefined, 'knowledge-card-heading'); heading.append(title)
      card.append(heading, el('p', (Number(base.ready) || 0) + ' / ' + base.total + ' 份资料可检索', 'muted'))
      card.addEventListener('click', event => { if (!event.target.closest('button')) choose(base.id) })
      const controls = el('div', undefined, 'knowledge-card-actions')
      const count = (base.scopes || []).length
      const toggle = action(count ? '关联项目 · ' + count : '关联项目', () => openBinding(base), base.id + ':bind')
      toggle.title = count ? (base.scopes || []).join('\n') : '选择可以检索此知识库的项目，可多选'
      controls.append(toggle, action('重命名', () => openCreate(base), base.id + ':rename'), action('删除', async () => {
        if (!await window.appDialogs.confirm('删除知识库“' + base.name + '”及其资料？它们将停止参与检索。')) return
        await api('remove-base', { id: base.id }); await refresh()
      }, base.id + ':delete'))
      card.append(controls); bases.append(card)
    }
    if (!snapshot.bases.length) bases.append(el('p', '新建一个知识库，再添加资料。', 'capability-empty'))
    const base = snapshot.bases.find(b => b.id === selected)
    $('knowledgeImport').disabled = !base || uploading; $('knowledgeImport').setAttribute('aria-busy',String(uploading));renderUploads(); $('knowledgeSearch').disabled = !base
    $('knowledgeQuery').placeholder = base ? '搜索「' + base.name + '」中的资料' : '请先新建知识库'
    $('knowledgeDocumentsTitle').textContent = base ? base.name + ' · 资料' : '资料'
    const linkedProjects = base ? (snapshot.projects || []).filter(p => (p.folders || []).some(scope => (base.scopes || []).includes(scope))) : []
    $('knowledgeProjectSummary').textContent = base && base.scopes.length ? '关联项目：' + (linkedProjects.length ? linkedProjects.map(p => p.name).join('、') : base.scopes.join('、')) : '尚未关联项目；关联后 Agent 可检索此库'
    $('knowledgeProjectSummary').title = base ? base.scopes.join('\n') : ''
    const docs = $('knowledgeDocuments'); docs.textContent = ''
    const projectGroup = fileGroup('projects', '项目文件')
    if (base) for (const root of base.scopes) { const project = linkedProjects.find(p => p.folders.includes(root)); projectGroup.append(projectFolder(root,root,project ? project.name : root)) }; if (!base || !base.scopes.length) projectGroup.append(el('p','尚未关联项目','muted')); docs.append(projectGroup)
    const imported = fileGroup('other', '资料库'); docs.append(imported)
    const sessionGroup = fileGroup('sessions','会话文件');docs.append(sessionGroup)
    const sessionFiles = (snapshot.sessions || []).filter(session => session.base_id === selected)
    for (const session of sessionFiles) sessionGroup.append(projectFolder(session.workspaceRoot,session.workspaceRoot,session.title+' · '+session.id.slice(-6),session.id))
    if(!sessionFiles.length)sessionGroup.append(el('p','暂无关联此知识库的会话文件','muted'))
    const query = $('knowledgeFileQuery').value.trim().toLowerCase()
    const visible = snapshot.documents.filter(d => d.base_id === selected && (!query || d.name.toLowerCase().includes(query) || (fileMatches && fileMatches.has(d.id))))
    const group = imported
    for (const doc of visible) {
      const row = el('article', undefined, 'knowledge-document' + (selectedFile.includes('/'+doc.id+'/') ? ' selected' : '')), main = el('div')
      row.dataset.documentId = doc.id
      row.addEventListener('click', event => { if (!event.target.closest('button')) previewDocument(doc) })
      const preview = action(doc.name, () => previewDocument(doc), doc.id + ':preview'); preview.className = 'knowledge-document-title'; preview.setAttribute('aria-pressed', String(previewId === doc.id))
      main.append(preview)
      if (doc.phase === 'ready' && !Number(doc.chunk_count) && !doc.error) main.append(el('p','已保存原件 · 未建立文本索引','muted'))
      if (doc.phase !== 'ready') main.append(el('p', (labels[doc.phase] || '未处理') + (doc.active ? ' · 旧版本仍可用' : ''), 'muted'))
      if (doc.error) main.append(el('p', doc.error, 'muted'))
      row.append(main)
      const job = snapshot.jobs.find(j => j.doc_id === doc.id)
      if (job && ['queued', 'parsing', 'indexing'].includes(job.phase)) row.append(action('取消处理', async () => { await api('cancel', { id: job.id }); await refresh() }, doc.id + ':cancel'))
      const remove = action('×', async () => {
        if (!await window.appDialogs.confirm('删除“' + doc.name + '”？此资料将立即停止参与检索，原始上传文件不受影响。')) return
        await api('delete', { id: doc.id }); if (previewId === doc.id) { previewId = ''; clearResults() }; await refresh()
      }, doc.id + ':delete'); remove.className = 'knowledge-file-delete'; remove.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/></svg>'; remove.title = '删除资料'; remove.setAttribute('aria-label', '删除资料：' + doc.name); row.append(remove); group.append(row)
    }
    if (!visible.length) group.append(el('p', query ? '没有匹配的资料' : '暂无资料', 'knowledge-empty'))
    $('libraryCount').textContent = String(snapshot.bases.length)
    if (focused) { const target = Array.from(page.querySelectorAll('[data-knowledge-control]')).find(n => n.dataset.knowledgeControl === focused); if (target) target.focus({ preventScroll: true }) }
  }
  async function source(id, baseId) {
    const token = ++sourceToken; detail = true; open(); render()
    const box = $('knowledgeSource'); box.classList.remove('hidden'); box.textContent = '正在读取来源…'
    try {
      const value = await api('source', baseId ? { id, baseId } : { id, sessionId: typeof currentSession === 'function' && currentSession() ? currentSession().id : '' })
      if (token !== sourceToken || page.classList.contains('hidden')) return
      await sharedFile({title:value.title,kind:'text',text:value.text},'knowledge-source://'+id+'/'+value.title)
    } catch (e) { if (token === sourceToken && !page.classList.contains('hidden')) box.textContent = '来源不可用：' + e.message }
  }
  async function search() {
    const baseId = selected, base = snapshot.bases.find(b => b.id === baseId), query = $('knowledgeQuery').value.trim()
    if (!base) { notice('请先选择知识库'); return }
    const output = $('knowledgeResults'), token = ++searchToken
    if (!query) { output.textContent = '请输入要搜索的关键词。'; $('knowledgeQuery').focus(); return }
    $('knowledgeSearch').disabled = true; output.textContent = '正在搜索「' + base.name + '」…'
    try {
      const value = await api('search', { query, baseId })
      if (token !== searchToken || baseId !== selected || page.classList.contains('hidden')) return
      output.textContent = ''; output.append(el('h2', base.name + ' · 搜索结果（' + value.items.length + '）'))
      if (!value.items.length) output.append(el('p', Number(base.ready) ? '未找到匹配内容，请尝试其他关键词。' : '当前知识库尚无可检索资料，请先添加资料并等待处理完成。', 'knowledge-empty'))
      for (const item of value.items) {
        const card = el('article', undefined, 'knowledge-result')
        card.append(action(item.title, () => source(item.sourceId, item.baseId)), el('p', item.text), el('p', location(item.locator), 'muted')); output.append(card)
      }
    } catch (e) { if (token === searchToken) output.textContent = '搜索失败：' + e.message }
    finally { if (token === searchToken) $('knowledgeSearch').disabled = false }
  }
  async function previewDocument(doc) {
    previewId = doc.id; render()
    const token = ++sourceToken, baseId = selected, box = $('knowledgeSource')
    box.classList.remove('hidden'); box.textContent = '正在加载资料预览…'
    try {
      const value = await api('file', { id: doc.id, baseId })
      if (token !== sourceToken || baseId !== selected || page.classList.contains('hidden')) return
      await sharedFile(value,'knowledge://'+baseId+'/'+doc.id+'/'+doc.name)
    } catch (e) { if (token === sourceToken) box.textContent = '暂时无法预览：' + e.message }
  }
  function openBinding(base) {
    openCreate(base); bindingBase = base.id
    $('knowledgeDialogTitle').textContent = '关联项目'; $('knowledgeName').required = false
    $('knowledgeName').classList.add('hidden'); $('knowledgeName').previousElementSibling.classList.add('hidden')
    const choices = $('knowledgeProjectChoices'); choices.classList.remove('hidden'); choices.textContent = ''
    const projects = (snapshot.projects || []).map(p => ({ name: p.name, paths: p.folders || [] }))
    const known = new Set(projects.reduce((all, p) => all.concat(p.paths), []))
    for (const scope of base.scopes || []) if (!known.has(scope)) projects.push({ name: scope, paths: [scope] })
    if (snapshot.currentScope && !known.has(snapshot.currentScope) && !(base.scopes || []).includes(snapshot.currentScope)) projects.push({ name: '当前工作区', paths: [snapshot.currentScope] })
    choices.append(el('p', '选择可使用此知识库的项目，支持多选。', 'muted'))
    for (const project of projects) {
      const label = el('label', undefined, 'knowledge-project-option'), input = el('input')
      input.type = 'checkbox'; input.dataset.scopes = JSON.stringify(project.paths)
      input.checked = project.paths.some(scope => (base.scopes || []).includes(scope))
      label.append(input, el('span', project.name || project.paths[0])); label.title = project.paths.join('\n'); choices.append(label)
    }
    if (!projects.length) choices.append(el('p', '请先创建项目或选择工作区。'))
    ;(choices.querySelector('input') || $('knowledgeSave')).focus()
  }
  function openCreate(base) {
    bindingBase = ''; $('knowledgeProjectChoices').classList.add('hidden')
    $('knowledgeName').classList.remove('hidden'); $('knowledgeName').previousElementSibling.classList.remove('hidden'); $('knowledgeName').required = true

    priorFocus = document.activeElement; editingBase = base ? base.id : ''
    $('knowledgeDialogTitle').textContent = base ? '重命名知识库' : '新建知识库'; $('knowledgeSave').textContent = base ? '保存' : '创建'
    $('knowledgeFormError').textContent = ''; $('knowledgeName').removeAttribute('aria-invalid'); $('knowledgeName').value = base ? base.name : ''
    $('knowledgeDialog').classList.remove('hidden'); $('app').inert = true; $('knowledgeName').focus()
  }
  function closeCreate() {
    if (pending) return
    $('knowledgeDialog').classList.add('hidden'); $('app').inert = false
    ;(priorFocus && priorFocus.isConnected ? priorFocus : $('knowledgeNew')).focus()
  }
  const systemOpen = action('↗',()=>{const target=view().active;if(target&&!target.includes('://'))return window.dsh.openPath(target)});systemOpen.title='使用系统程序打开';systemOpen.setAttribute('aria-label','使用系统程序打开');systemOpen.className='knowledge-system-open';$('knowledgeSharedPreview').append(systemOpen)
  document.body.appendChild($('knowledgeDialog'))
  $('openLibrary').addEventListener('click', open)
  $('knowledgeClose').addEventListener('click', () => { hide(); $('contentFrame').classList.remove('hidden'); $('app').classList.remove('capabilities-open'); $('openLibrary').focus() })
  $('knowledgeFileQuery').addEventListener('input', () => {
    clearTimeout(fileSearchTimer); const token = ++fileSearchToken, baseId = selected, query = $('knowledgeFileQuery').value.trim()
    fileMatches = null; render(); $('knowledgeFileStatus').textContent = query ? '正在搜索内容…' : ''
    if (!query) return
    fileSearchTimer = setTimeout(async () => {
      try { const result = await api('search', { query, baseId }); if (token !== fileSearchToken || baseId !== selected) return
        fileMatches = new Set(result.items.map(item => item.documentId)); render(); $('knowledgeFileStatus').textContent = '已按文件名和内容筛选'
      } catch (e) { if (token === fileSearchToken) $('knowledgeFileStatus').textContent = '内容搜索失败：' + e.message }
    }, 250)
  })
  $('knowledgeOverview').addEventListener('click', () => { detail = false; clearResults(); render() })
  $('knowledgeNew').addEventListener('click', () => openCreate())
  for (const id of ['knowledgeCancelCreate', 'knowledgeCloseCreate']) $(id).addEventListener('click', closeCreate)
  $('knowledgeDialog').addEventListener('click', event => { if (event.target === $('knowledgeDialog')) closeCreate() })
  $('knowledgeDialog').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeCreate() }
    if (event.key === 'Enter' && event.isComposing) event.preventDefault()
    if (event.key === 'Tab') {
      const items = Array.from($('knowledgeDialog').querySelectorAll('button,input')).filter(n => !n.disabled && n.getClientRects().length), first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
  })
  $('knowledgeCreate').addEventListener('submit', async event => {
    event.preventDefault(); if (pending) return
    pending = true; $('knowledgeSave').disabled = true; $('knowledgeFormError').textContent = ''
    try {
      if (bindingBase) {
        const scopes = Array.from($('knowledgeProjectChoices').querySelectorAll('input:checked')).reduce((all, input) => all.concat(JSON.parse(input.dataset.scopes)), [])
        await api('bind', { id: bindingBase, scopes }); pending = false; closeCreate(); await refresh(); return
      }
      const value = await api(editingBase ? 'rename' : 'create', { id: editingBase, name: $('knowledgeName').value })
      selected = editingBase || value.id; clearResults(); pending = false; closeCreate(); await refresh()
    } catch (e) { $('knowledgeFormError').textContent = e.message; $('knowledgeName').setAttribute('aria-invalid', 'true') }
    finally { pending = false; $('knowledgeSave').disabled = false }
  })
  function renderUploads(){
    const progress=$('knowledgeUploadProgress'),results=$('knowledgeUploadResults'),items=$('knowledgeUploadItems'),cancel=$('knowledgeUploadCancel')
    cancel.hidden=!uploading;cancel.disabled=stopUploads
    if(!uploads.length){progress.textContent='';results.hidden=true;return}
    const failed=uploads.filter(item=>item.status==='failed').length,skipped=uploads.filter(item=>item.status==='skipped').length
    progress.textContent=(uploading?'正在导入':'导入结束')+'「'+uploadBaseName+'」：'+uploadedCount+'/'+uploads.length+' 个已上传'+(failed?'，'+failed+' 个上传失败':'')+(skipped?'，'+skipped+' 个未上传':'')+(uploading?'；'+(uploads.find(item=>item.status==='uploading')||{}).name:'')
    results.hidden=false;items.textContent=''
    const docs=new Map(snapshot.documents.map(doc=>[doc.id,doc]))
    for(const item of uploads){const doc=docs.get(item.documentId),row=el('li');row.dataset.status=item.status
      let text=item.status==='uploading'?'正在上传':item.status==='failed'?'导入异常：'+item.error:item.status==='skipped'?'已停止，未上传':item.status==='waiting'?'等待上传':'已上传，等待处理'
      if(item.status==='uploaded'&&doc)text=doc.phase==='ready'?(Number(doc.chunk_count)?'已建立文本索引':'已保存原件，未建立文本索引'):(labels[doc.phase]||'等待处理')+(doc.error?'：'+doc.error:'')
      row.textContent=item.name+' · '+text;items.append(row)
    }
  }
  async function uploadFiles(source){
    const files=Array.from(source||[]);if(!files.length)return
    if(uploading){notice('正在导入资料，请等待本批完成');return}if(!selected){notice('请先选择知识库');return}
    const baseId=selected;uploadBaseName=(snapshot.bases.find(base=>base.id===baseId)||{}).name||'资料';uploading=true;stopUploads=false;uploadedCount=0;uploads=files.map(file=>({name:file.name,status:'waiting'}));render()
    try{for(let index=0;index<files.length;index++){
      const file=files[index],item=uploads[index]
      if(stopUploads){item.status='skipped';renderUploads();continue}
      item.status='uploading';renderUploads()
      try{
        const limit=snapshot.limits&&snapshot.limits.fileBytes||8*1024*1024;if(file.size>limit)throw Error('单份资料不能超过 '+Math.round(limit/1024/1024)+' MB')
        const bytes=new Uint8Array(await file.arrayBuffer());let imported
        for(let attempt=0;attempt<120;attempt++){
          if(stopUploads)break
          try{imported=await window.dsh.knowledgeUpload({baseId,name:file.name},bytes);break}catch(error){if(!String(error.message).includes('KNOWLEDGE_QUEUE_FULL'))throw error;if(attempt===119)throw Error('处理队列繁忙，请稍后重试');await new Promise(resolve=>setTimeout(resolve,500))}
        }
        if(imported){item.status='uploaded';item.documentId=imported.documentId;uploadedCount++}else item.status='skipped'
      }catch(error){item.status='failed';item.error=error.message||'导入失败'}
      renderUploads();await refresh().catch(error=>notice('文件已上传，但列表刷新失败：'+error.message))
    }}finally{uploading=false;$('knowledgeFile').value='';render();notice('已上传 '+uploadedCount+' 个文件，处理状态见本次导入结果')}
  }
  $('knowledgeImport').addEventListener('click',()=>{if(!uploading)$('knowledgeFile').click()})
  $('knowledgeFile').addEventListener('change',()=>uploadFiles($('knowledgeFile').files).catch(error=>notice(error.message)))
  $('knowledgeUploadCancel').addEventListener('click',()=>{stopUploads=true;renderUploads()})
  const uploadPane=$('knowledgeFilePane')
  for(const type of ['dragenter','dragover'])uploadPane.addEventListener(type,event=>{if(!Array.from(event.dataTransfer.types||[]).includes('Files'))return;event.preventDefault();if(!uploading)uploadPane.classList.add('is-dragging')})
  uploadPane.addEventListener('dragleave',event=>{if(!uploadPane.contains(event.relatedTarget))uploadPane.classList.remove('is-dragging')})
  uploadPane.addEventListener('drop',event=>{if(!event.dataTransfer.files.length)return;event.preventDefault();event.stopPropagation();uploadPane.classList.remove('is-dragging');uploadFiles(event.dataTransfer.files).catch(error=>notice(error.message))})
  $('knowledgeSearchForm').addEventListener('submit', event => { event.preventDefault(); search() })
  $('knowledgeQuery').addEventListener('keydown', event => { if (event.key === 'Enter' && event.isComposing) event.preventDefault() })
  document.addEventListener('click', event => { const b = event.target.closest('[data-knowledge-source]'); if (b) source(b.dataset.knowledgeSource) })
  page.addEventListener('keydown', event => { if (event.key === 'Escape') $('knowledgeClose').click() })
  const timer = setInterval(() => { if (!document.hidden) refresh() }, 2000)
  window.addEventListener('beforeunload', () => clearInterval(timer), { once: true })
  window.knowledgeUI = { hide, open, refresh, source }
})()
