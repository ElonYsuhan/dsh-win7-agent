'use strict'
// Shared UI adapter: one delegated listener covers existing and dynamic dialogs.
;(function(){
 const panels='dialog,.modal-card,.task-editor,.artifact-viewer,.quick-menu,.knowledge-create-modal'
 const positions=new WeakMap()
 let drag=null,frame=null
 function panelFor(target){
  const panel=target&&target.closest&&target.closest(panels)
  if(!panel)return null
  if(panel.matches('dialog'))return panel.open?panel:null
  const overlay=panel.closest('.modal,.task-dialog,.artifact-overlay')
  return overlay&&getComputedStyle(overlay).position==='fixed'?panel:null
 }
 function current(panel){return positions.get(panel)||{x:0,y:0}}
 function place(panel,x,y){
  const old=current(panel),rect=panel.getBoundingClientRect(),left=rect.left-old.x,top=rect.top-old.y
  // The panel may cross an edge, but a usable part of its title stays reachable.
  x=Math.max(Math.min(96,rect.width)-rect.width-left,Math.min(innerWidth-Math.min(96,rect.width)-left,x))
  y=Math.max(-top,Math.min(Math.max(0,innerHeight-36)-top,y))
  positions.set(panel,{x,y});panel.style.translate=x+'px '+y+'px'
 }
 function paint(){frame=null;if(!drag)return;if(!drag.panel.isConnected||!drag.panel.getClientRects().length){finish(false);return}place(drag.panel,drag.start.x+drag.dx,drag.start.y+drag.dy)}
 function move(event){if(!drag||event.pointerId!==drag.id)return;event.preventDefault();drag.dx=event.clientX-drag.x;drag.dy=event.clientY-drag.y;if(frame===null)frame=requestAnimationFrame(paint)}
 function finish(cancel){
  if(!drag)return
  if(frame!==null){cancelAnimationFrame(frame);frame=null;if(!cancel)paint()}
  const active=drag;if(!active)return;drag=null
  if(cancel)place(active.panel,active.start.x,active.start.y)
  if(active.handle.hasPointerCapture&&active.handle.hasPointerCapture(active.id))active.handle.releasePointerCapture(active.id)
  document.documentElement.classList.remove('dialog-dragging')
  document.removeEventListener('pointermove',move,true);document.removeEventListener('pointerup',up,true);document.removeEventListener('pointercancel',cancelDrag,true);window.removeEventListener('blur',cancelDrag)
 }
 function up(event){if(drag&&event.pointerId===drag.id)finish(false)}
 function cancelDrag(){finish(true)}
 function down(event){
  if(event.button!==0||event.isPrimary===false||drag)return
  const target=event.target,panel=panelFor(target);if(!panel||target.closest('button,input,textarea,select,a,summary,[contenteditable="true"],[role="button"]'))return
  const heading=target.closest('header,h1,h2,h3,.settings-content-head,.task-dialog-heading,[data-dialog-drag-handle]'),rect=panel.getBoundingClientRect()
  if(!(heading&&panel.contains(heading))&&!(target===panel&&event.clientY<=rect.top+28))return
  event.preventDefault();event.stopPropagation()
  const handle=document.documentElement;drag={panel,handle,id:event.pointerId,x:event.clientX,y:event.clientY,start:{...current(panel)},dx:0,dy:0}
  if(handle.setPointerCapture)handle.setPointerCapture(event.pointerId)
  document.documentElement.classList.add('dialog-dragging')
  document.addEventListener('pointermove',move,true);document.addEventListener('pointerup',up,true);document.addEventListener('pointercancel',cancelDrag,true);window.addEventListener('blur',cancelDrag)
 }
 function key(event){
  if(event.isComposing)return
  if(drag&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();finish(true);return}
  if(!event.altKey||!event.shiftKey)return
  const panel=panelFor(document.activeElement);if(!panel)return
  const delta={ArrowLeft:[-20,0],ArrowRight:[20,0],ArrowUp:[0,-20],ArrowDown:[0,20]}[event.key]
  if(!delta)return
  event.preventDefault();const old=current(panel);place(panel,old.x+delta[0],old.y+delta[1])
 }
 function resize(){finish(false);for(const panel of document.querySelectorAll(panels))if(positions.has(panel)&&panel.getClientRects().length){const old=current(panel);place(panel,old.x,old.y)}}
 function focus(event){const panel=panelFor(event.target);if(panel&&positions.has(panel)){const old=current(panel);place(panel,old.x,old.y)}}
 document.addEventListener('focusin',focus);document.addEventListener('pointerdown',down,true);document.addEventListener('keydown',key,true);window.addEventListener('resize',resize)
 window.addEventListener('beforeunload',()=>{finish(false);document.removeEventListener('focusin',focus);document.removeEventListener('pointerdown',down,true);document.removeEventListener('keydown',key,true);window.removeEventListener('resize',resize)},{once:true})
})()
