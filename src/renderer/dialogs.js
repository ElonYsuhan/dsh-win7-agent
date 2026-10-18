'use strict'
// Common keyboard behavior; each dialog keeps its own submit/cancel semantics.
;(function(){
 function prepare(){let index=0;for(const modal of document.querySelectorAll('.modal:not(#approvalModal),.task-dialog')){modal.setAttribute('role','dialog');modal.setAttribute('aria-modal','true');const title=modal.querySelector('h2');if(title){if(!title.id)title.id='app-dialog-title-'+(++index);modal.setAttribute('aria-labelledby',title.id)}}}
 if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',prepare,{once:true});else prepare()
 document.addEventListener('keydown',event=>{
  if(event.key!=='Tab')return
  const dialogs=Array.from(document.querySelectorAll('.modal,.task-dialog,.artifact-overlay')).filter(node=>!node.classList.contains('hidden')&&node.getClientRects().length)
  const active=dialogs.find(node=>node.contains(document.activeElement))||dialogs[dialogs.length-1];if(!active)return
  const items=Array.from(active.querySelectorAll('button,input,select,textarea,a[href],[tabindex="0"]')).filter(node=>!node.disabled&&node.getClientRects().length)
  if(!items.length)return
  const first=items[0],last=items[items.length-1]
  if(event.shiftKey&&(document.activeElement===first||!active.contains(document.activeElement))){event.preventDefault();event.stopPropagation();last.focus()}
  else if(!event.shiftKey&&(document.activeElement===last||!active.contains(document.activeElement))){event.preventDefault();event.stopPropagation();first.focus()}
 },true)
})()
