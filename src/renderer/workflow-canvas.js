'use strict'
;(function(){
 // Adapt the pinned upstream library without changing vendor code. Own the RAF
 // and remove listeners with the exact callbacks AND capture flags used at bind.
 function create(element,graph){
  element.classList.remove('lgraphcanvas')
  const canvas=new LGraphCanvas(element,graph,{skip_render:true})
  element.tabIndex=0
  // The application owns the standard wheel event; avoid legacy double zoom.
  element.removeEventListener('mousewheel',canvas._mousewheel_callback,false)
  element.removeEventListener('DOMMouseScroll',canvas._mousewheel_callback,false)
  // A selected group moves together; the upstream click handler otherwise
  // reduces it to one node before starting the drag.
  const selectNode=canvas.processNodeSelected
  canvas.processNodeSelected=function(node,event){
   if(node.is_selected&&Object.keys(this.selected_nodes).length>1&&!(event&&(event.shiftKey||event.ctrlKey||event.metaKey)))return
   return selectNode.call(this,node,event)
  }
  const deselectNode=canvas.deselectNode
  canvas.deselectNode=function(node){deselectNode.call(this,node);delete this.selected_nodes[node.id];if(this.onSelectionChange)this.onSelectionChange(this.selected_nodes)}
  let frame=null,disposed=false
  canvas.startRendering=function(){
   if(disposed||this.is_rendering)return
   this.is_rendering=true
   const tick=()=>{frame=null;if(disposed||!this.is_rendering)return;if(!this.pause_rendering&&!document.hidden)this.draw();if(!disposed&&this.is_rendering)frame=requestAnimationFrame(tick)}
   frame=requestAnimationFrame(tick)
  }
  canvas.stopRendering=function(){this.is_rendering=false;if(frame!==null){cancelAnimationFrame(frame);frame=null}}
  canvas.dispose=function(){
   if(disposed)return;disposed=true;this.stopRendering()
   const el=this.canvas,doc=el.ownerDocument,pointer=LiteGraph.pointerevents_method
   for(const [target,event,callback,capture] of [
    [el,pointer+'down',this._mousedown_callback,true],
    [el,pointer+'up',this._mouseup_callback,true],
    [el,pointer+'move',this._mousemove_callback,false],
    [doc,pointer+'move',this._mousemove_callback,true],
    [doc,pointer+'up',this._mouseup_callback,true],
    [el,'mousewheel',this._mousewheel_callback,false],
    [el,'DOMMouseScroll',this._mousewheel_callback,false],
    [el,'keydown',this._key_callback,true],
    [doc,'keyup',this._key_callback,true],
    [el,'contextmenu',this._doNothing,false],
    [el,'dragover',this._doNothing,false],
    [el,'dragend',this._doNothing,false],
    [el,'drop',this._ondrop_callback,false],
    [el,'dragenter',this._doReturnTrue,false]
   ])if(callback){target.removeEventListener(event,callback,capture);for(const kind of ['down','up','move'])if(event===pointer+kind)target.removeEventListener(kind,callback,capture)}
   this._events_binded=false
   if(this.graph)this.graph.detachCanvas(this)
   if(el.data===this)delete el.data
   if(LGraphCanvas.active_canvas===this)LGraphCanvas.active_canvas=null
   if(this.bgcanvas){this.bgcanvas.width=0;this.bgcanvas.height=0}
   this.graph=null;this.bgctx=null;this.bgcanvas=null;this.ctx=null;this.canvas=null;this.ds.element=null
   this.selected_nodes={};this.visible_nodes=[];this.node_dragged=null;this.connecting_node=null
  }
  return canvas
 }
 window.workflowCanvasLifecycle={create}
})()
