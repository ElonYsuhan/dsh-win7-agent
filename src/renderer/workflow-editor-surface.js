'use strict';
// Keep node text in browser typography; graph geometry remains on the canvas.
window.workflowEditorSurface={
 attach(canvas){
  const host=canvas.canvas.parentElement;host.querySelectorAll('.workflow-node-text-layer').forEach(n=>n.remove())
  const layer=document.createElement('div');layer.className='workflow-node-text-layer';layer.setAttribute('aria-hidden','true');host.append(layer)
  const labels=new Map(),draw=canvas.draw,dispose=canvas.dispose
  canvas.canvas._workflowLabels={layer,labels}
  canvas.draw=function(){if(this.dirty_canvas||this.dirty_bgcanvas||arguments[0]||arguments[1]){for(const label of labels.values())label.hidden=true}return draw.apply(this,arguments)}
  canvas.dispose=function(){layer.remove();delete this.canvas._workflowLabels;labels.clear();return dispose.apply(this,arguments)}
 },
 text(ctx,node,line,text,x,y){
  const surface=ctx.canvas._workflowLabels;if(!surface){ctx.fillText(text,x,y);return}
  const key=node.id+':'+line;let label=surface.labels.get(key)
  if(!label){label=document.createElement('span');surface.labels.set(key,label);surface.layer.append(label)}
  const matrix=ctx.getTransform(),font=ctx.font.match(/([\d.]+)px/),size=Number(font&&font[1]||14),scale=Math.abs(matrix.a)
  label.hidden=false;label.textContent=text;label.style.left=(matrix.a*x+matrix.c*y+matrix.e)+'px';label.style.top=(matrix.b*x+matrix.d*y+matrix.f-size*scale)+'px';label.style.font=ctx.font.replace(/[\d.]+px/,(size*scale)+'px');label.style.lineHeight='1';label.style.color=ctx.fillStyle
 }
}

document.addEventListener('DOMContentLoaded',()=>{
 const body=document.querySelector('.workflow-editor-body'),panel=document.querySelector('.workflow-parameters');if(!body||!panel)return
 const handle=document.createElement('button');handle.type='button';handle.className='workflow-panel-resizer';handle.setAttribute('aria-label','调整属性面板宽度');handle.setAttribute('aria-description','使用左右方向键调整宽度');body.append(handle)
 const bar=document.createElement('div');bar.className='workflow-panel-dragbar';const title=document.createElement('span');title.textContent='属性面板';bar.append(title)
 const make=(label,path,action)=>{const b=document.createElement('button');b.type='button';b.title=label;b.setAttribute('aria-label',label);b.innerHTML='<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6"><path d="'+path+'"/></svg>';b.addEventListener('click',action);bar.append(b);return b}
 const dock=()=>{panel.classList.remove('is-floating');panel.style.removeProperty('left');panel.style.removeProperty('top');panel.style.removeProperty('width');panel.style.removeProperty('height');resize()}
 const close=make('关闭浮动并归位','M5 5l14 14M19 5L5 19',dock);close.className='workflow-panel-float-close';panel.prepend(bar)
 const grip=document.createElement('button');grip.type='button';grip.className='workflow-panel-grip';grip.setAttribute('aria-label','调整属性面板大小');panel.append(grip)
 const resize=()=>window.dispatchEvent(new Event('resize'))
 const setWidth=value=>{const width=Math.max(220,Math.min(value,Math.max(220,body.clientWidth-320)));body.style.setProperty('--workflow-properties-width',width+'px');resize()}
 const MIN_W=220,MIN_H=160,EDGE=8,TOP_EDGE=56
 let clamping=false
 // 浮动面板用像素存 position:fixed 坐标。窗口缩小后旧的 left/top 会落在视口外，
 // 表现为「拖出来的面板消失了」，所以每次尺寸变化都要把它夹回可视区。
 const clamp=()=>{if(clamping||!panel.classList.contains('is-floating'))return;const width=Math.max(MIN_W,Math.min(panel.offsetWidth,innerWidth-EDGE*2)),height=Math.max(MIN_H,Math.min(panel.offsetHeight,innerHeight-TOP_EDGE-EDGE)),left=Number.parseFloat(panel.style.left),top=Number.parseFloat(panel.style.top);panel.style.width=width+'px';panel.style.height=height+'px';panel.style.left=Math.max(EDGE,Math.min(Number.isFinite(left)?left:EDGE,innerWidth-width-EDGE))+'px';panel.style.top=Math.max(TOP_EDGE,Math.min(Number.isFinite(top)?top:TOP_EDGE,innerHeight-height-EDGE))+'px';clamping=true;resize();clamping=false}
 window.addEventListener('resize',clamp)
 handle.addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();setWidth(panel.offsetWidth+(e.key==='ArrowLeft'?16:-16))}})
 let gesture=null,frame=0
 const stop=()=>{gesture=null;if(frame)cancelAnimationFrame(frame);frame=0;resize()}
 const start=(e,kind)=>{if(e.button!==0||(kind==='move'&&e.target.closest('button')))return;e.preventDefault();const rect=panel.getBoundingClientRect();gesture={kind,x:e.clientX,y:e.clientY,rect};e.currentTarget.setPointerCapture(e.pointerId)}
 handle.addEventListener('pointerdown',e=>start(e,'width'));bar.addEventListener('pointerdown',e=>start(e,'move'));grip.addEventListener('pointerdown',e=>start(e,'size'))
 for(const target of [handle,bar,grip]){target.addEventListener('pointermove',e=>{if(!gesture)return;const x=e.clientX,y=e.clientY;if(frame)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{frame=0;if(!gesture)return;const g=gesture;if(g.kind==='width'){setWidth(g.rect.width+g.x-x);return}if(g.kind==='size'){panel.style.width=Math.max(MIN_W,g.rect.width+x-g.x)+'px';panel.style.height=Math.max(MIN_H,g.rect.height+y-g.y)+'px';clamp();return}panel.classList.add('is-floating');panel.style.width=Math.min(g.rect.width,innerWidth-EDGE*2)+'px';panel.style.height=Math.min(g.rect.height,innerHeight-96)+'px';panel.style.left=(g.rect.left+x-g.x)+'px';panel.style.top=(g.rect.top+y-g.y)+'px';clamp()})});for(const event of ['pointerup','pointercancel','lostpointercapture'])target.addEventListener(event,stop)}
 window.addEventListener('blur',stop);document.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){stop();dock()}})
 document.getElementById('panelToggle').addEventListener('click',e=>{if(panel.classList.contains('is-floating')&&!document.getElementById('workflowEditor').classList.contains('hidden')){e.preventDefault();e.stopImmediatePropagation();dock()}},true)
 new MutationObserver(()=>{if(document.getElementById('workflowEditor').classList.contains('hidden'))dock()}).observe(document.getElementById('workflowEditor'),{attributes:true,attributeFilter:['class']})
})
