'use strict'
;(function(){
 const names={start:'wf-start',input:'wf-start',human:'wf-human',ai:'model',agent:'workflow',tool:'plugin',rest:'wf-rest',evaluate:'wf-evaluate',end:'stop',output:'stop',template:'file'}
 const cache=new Map()
 function name(type){return names[String(type||'').replace(/^workflow\//,'')]||'workflow'}
 function draw(ctx,type,x,y,size){
  const icon=name(type);let shapes=cache.get(icon)
  if(!shapes){const svg=new DOMParser().parseFromString(window.renderIcon(icon),'image/svg+xml');shapes=Array.from(svg.documentElement.children).map(n=>{const number=key=>Number(n.getAttribute(key)||0);if(n.localName==='path')return{path:new Path2D(n.getAttribute('d')||'')};if(n.localName==='circle')return{circle:[number('cx'),number('cy'),number('r')]};if(n.localName==='rect')return{rect:[number('x'),number('y'),number('width'),number('height'),number('rx')]};return null}).filter(Boolean);cache.set(icon,shapes)}
  ctx.save();ctx.translate(x,y);ctx.scale(size/24,size/24);ctx.lineWidth=1.8;ctx.lineCap='round';ctx.lineJoin='round'
  for(const shape of shapes){if(shape.path)ctx.stroke(shape.path);else{ctx.beginPath();if(shape.circle)ctx.arc(...shape.circle,0,Math.PI*2);else ctx.roundRect(...shape.rect);ctx.stroke()}}ctx.restore()
 }
 window.workflowNodeIcons={name,draw}
})()
