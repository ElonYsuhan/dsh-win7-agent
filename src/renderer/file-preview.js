'use strict'
// Shared rendering only: callers own tabs, selection, IO, cancellation and editing.
;(function(){
 function render(host,value){
  const kind=value.kind
  if(kind==='markdown'&&window.renderMarkdown){const node=document.createElement('div');node.className='preview-markdown';node.innerHTML=window.renderMarkdown(value.text||'');if(window.highlightAll)window.highlightAll(node);host.append(node);return}
  if(['code','text','office'].includes(kind)){const pre=document.createElement('pre'),code=document.createElement('code');pre.className=kind==='code'?'preview-code':'preview-text';if(kind==='code'&&window.highlightCode)code.innerHTML=window.highlightCode(value.text||'',value.ext||'');else code.textContent=value.text||'';pre.append(code);host.append(pre);return}
  if(['image','pdf','audio','video'].includes(kind)){const node=document.createElement(kind==='image'?'img':kind==='pdf'?'iframe':kind);node.className=kind==='image'?'preview-image':kind==='pdf'?'preview-pdf':'preview-media';if(kind==='image')node.alt=value.name||'';if(kind==='pdf')node.title=value.name||'';if(kind==='audio'||kind==='video')node.controls=true;node.src=value.url;host.append(node);if(kind==='pdf')host.classList.add('is-fit');return}
  const note=document.createElement('p');note.textContent=value.notice||'此格式暂不支持内嵌预览，请使用系统程序打开';host.append(note)
 }
 window.filePreview={render}
})()
