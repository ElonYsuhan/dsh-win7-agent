'use strict'
// Pure, bounded orthogonal routing. No graph mutation, DOM or vendor patches.
;(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.workflowLinkRouting=api})(typeof window==='object'?window:globalThis,function(){
 // Display geometry only: port identity and graph slots never change.
 const PORT_COLORS=Object.freeze({input:'#16a36b',output:'#3b82f6'})
 function portLayout(card,ports){
  const cx=(card.left+card.right)/2,cy=(card.top+card.bottom)/2,w=card.right-card.left,h=card.bottom-card.top
  const planned=ports.map(port=>{
   let side=port.input?'left':'right'
   if(port.peers&&port.peers.length){let x=0,y=0,pw=0,ph=0;for(const peer of port.peers){x+=(peer.left+peer.right)/2;y+=(peer.top+peer.bottom)/2;pw+=peer.right-peer.left;ph+=peer.bottom-peer.top}const n=port.peers.length,dx=x/n-cx,dy=y/n-cy;side=Math.abs(dx)/Math.max(1,(w+pw/n)/2)>=Math.abs(dy)/Math.max(1,(h+ph/n)/2)?(dx>=0?'right':'left'):(dy>=0?'down':'up')}
   return{...port,side}
  })
  const result=new Map()
  for(const side of ['left','right','up','down']){const group=planned.filter(p=>p.side===side);group.forEach((port,index)=>{const t=(index+1)/(group.length+1),vertical=side==='left'||side==='right';result.set(port.key,{direction:side,point:vertical?[side==='left'?card.left+8:card.right-8,card.top+h*t]:[card.left+w*t,side==='up'?card.top:card.bottom],color:port.input?PORT_COLORS.input:PORT_COLORS.output})})}
  return result
 }
 const EPS=.001
 const same=(a,b)=>Math.abs(a[0]-b[0])<EPS&&Math.abs(a[1]-b[1])<EPS
 function hits(a,b,r){
  if(Math.abs(a[0]-b[0])<EPS)return a[0]>r.left+EPS&&a[0]<r.right-EPS&&Math.max(a[1],b[1])>r.top+EPS&&Math.min(a[1],b[1])<r.bottom-EPS
  if(Math.abs(a[1]-b[1])<EPS)return a[1]>r.top+EPS&&a[1]<r.bottom-EPS&&Math.max(a[0],b[0])>r.left+EPS&&Math.min(a[0],b[0])<r.right-EPS
  return true
 }
 function simplify(points){const out=[];for(const p of points){if(out.length&&same(p,out[out.length-1]))continue;while(out.length>1){const a=out[out.length-2],b=out[out.length-1];if((a[0]===b[0]&&b[0]===p[0]&&(b[1]-a[1])*(p[1]-b[1])>=0)||(a[1]===b[1]&&b[1]===p[1]&&(b[0]-a[0])*(p[0]-b[0])>=0))out.pop();else break}out.push([p[0],p[1]])}return out}
 const length=points=>points.slice(1).reduce((sum,p,i)=>sum+Math.abs(p[0]-points[i][0])+Math.abs(p[1]-points[i][1]),0)
 function pointAt(points,t){let remaining=length(points)*t;for(let i=1;i<points.length;i++){const a=points[i-1],b=points[i],n=Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1]);if(remaining<=n&&n)return[a[0]+(b[0]-a[0])*remaining/n,a[1]+(b[1]-a[1])*remaining/n];remaining-=n}return points[points.length-1]||[0,0]}
 const overlap=(a,b,c,d)=>Math.min(Math.max(a,b),Math.max(c,d))-Math.max(Math.min(a,b),Math.min(c,d))
 function segmentIndex(segments){return{horizontal:segments.filter(s=>Math.abs(s.a[1]-s.b[1])<EPS).sort((a,b)=>a.a[1]-b.a[1]),vertical:segments.filter(s=>Math.abs(s.a[0]-s.b[0])<EPS).sort((a,b)=>a.a[0]-b.a[0])}}
 function lowerBound(list,value,axis){let lo=0,hi=list.length;while(lo<hi){const mid=(lo+hi)>>>1;if(list[mid].a[axis]<value)lo=mid+1;else hi=mid}return lo}
 function segmentCost(a,b,index,options){
  const horizontal=Math.abs(a[1]-b[1])<EPS;let cost=0
  const h=horizontal,axis=h?1:0,parallel=h?index.horizontal:index.vertical,cross=h?index.vertical:index.horizontal
  for(let i=lowerBound(parallel,a[axis]-10,axis);i<parallel.length&&parallel[i].a[axis]<=a[axis]+10;i++){
    const s=parallel[i]
    const distance=Math.abs(a[h?1:0]-s.a[h?1:0]),common=overlap(a[h?0:1],b[h?0:1],s.a[h?0:1],s.b[h?0:1])
    if(distance>=10||common<=EPS)continue
    // A shared port may have a common lead; unrelated cables never share a lane for free.
    if(s.first&&same(options.start,s.start)||s.last&&same(options.end,s.end))continue
    cost+=(10-distance)*common*2+80
  }
  for(let i=lowerBound(cross,Math.min(a[1-axis],b[1-axis])-EPS,1-axis);i<cross.length&&cross[i].a[1-axis]<=Math.max(a[1-axis],b[1-axis])+EPS;i++){
    const s=cross[i]
    const x=horizontal?s.a[0]:a[0],y=horizontal?a[1]:s.a[1]
    if(x>Math.min(a[0],b[0])-EPS&&x<Math.max(a[0],b[0])+EPS&&y>Math.min(a[1],b[1])-EPS&&y<Math.max(a[1],b[1])+EPS&&x>Math.min(s.a[0],s.b[0])-EPS&&x<Math.max(s.a[0],s.b[0])+EPS&&y>Math.min(s.a[1],s.b[1])-EPS&&y<Math.max(s.a[1],s.b[1])+EPS){
     if(same([x,y],options.start)&&same(options.start,s.start)||same([x,y],options.end)&&same(options.end,s.end))continue
     cost+=1000
    }
  }
  return cost
 }
 function search(start,end,rects,reserved,options){
  const occupied=segmentIndex(reserved)
  const clear=(a,b)=>!rects.some(r=>hits(a,b,r)),outward=(a,b,v)=>!v||(b[0]-a[0])*v[0]+(b[1]-a[1])*v[1]>=-EPS
  const valid=points=>{const p=simplify(points);return p.slice(1).every((b,i)=>(Math.abs(p[i][0]-b[0])<EPS||Math.abs(p[i][1]-b[1])<EPS)&&clear(p[i],b))&&(p.length<2||outward(p[0],p[1],options.startVector)&&outward(p[p.length-1],p[p.length-2],options.endVector))}
  const penalty=points=>points.slice(1).reduce((sum,p,i)=>sum+segmentCost(points[i],p,occupied,options),0),score=points=>length(points)+Math.max(0,points.length-2)*18+penalty(points)
  const mx=(start[0]+end[0])/2,my=(start[1]+end[1])/2
  const candidates=[[start,end],[start,[end[0],start[1]],end],[start,[start[0],end[1]],end],[start,[mx,start[1]],[mx,end[1]],end],[start,[start[0],my],[end[0],my],end]]
  // Most workflows need only one clear channel; avoid allocating a search grid.
  for(const r of rects){for(const y of [r.top,r.bottom])candidates.push([start,[start[0],y],[end[0],y],end]);for(const x of [r.left,r.right])candidates.push([start,[x,start[1]],[x,end[1]],end])}
  const channels=axis=>[...new Set(reserved.filter(s=>Math.abs(s.a[axis]-s.b[axis])<EPS).flatMap(s=>[s.a[axis]-10,s.a[axis]+10]))].sort((a,b)=>Math.abs(a-(axis?my:mx))-Math.abs(b-(axis?my:mx))||a-b).slice(0,32)
  const laneX=channels(0),laneY=channels(1)
  for(const x of laneX)candidates.push([start,[x,start[1]],[x,end[1]],end])
  for(const y of laneY)candidates.push([start,[start[0],y],[end[0],y],end])
  candidates.sort((a,b)=>length(a)+a.length*18-length(b)-b.length*18)
  let best=null,bestScore=Infinity
  for(const points of candidates){if(length(points)>bestScore)continue;if(!valid(points))continue;const p=simplify(points),value=score(p);if(value<bestScore){best=p;bestScore=value}if(!reserved.length||penalty(p)===0)return p}
  const xs=[...new Set([start[0],end[0],...rects.flatMap(r=>[r.left,r.right]),...laneX])].sort((a,b)=>a-b),ys=[...new Set([start[1],end[1],...rects.flatMap(r=>[r.top,r.bottom]),...laneY])].sort((a,b)=>a-b),w=xs.length
  const initial=(ys.indexOf(start[1])*w+xs.indexOf(start[0]))*3,goal=ys.indexOf(end[1])*w+xs.indexOf(end[0]),cost=new Map([[initial,0]]),parent=new Map(),heap=[],checked=new Map()
  const push=item=>{heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].f<=item.f)break;heap[i]=heap[p];i=p}heap[i]=item}
  const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].f<heap[c].f)c++;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c}heap[i]=last}return top}
  const point=id=>[xs[Math.floor(id/3)%w],ys[Math.floor(Math.floor(id/3)/w)]]
  push({id:initial,g:0,f:0});let expanded=0
  while(heap.length&&expanded++<12000&&(!options.budget||options.budget.remaining>0)){
   if(options.budget)options.budget.remaining--
   const current=pop();if(current.g!==cost.get(current.id))continue
   const cell=Math.floor(current.id/3),ix=cell%w,iy=Math.floor(cell/w),a=point(current.id)
   if(cell===goal){const points=[a];let id=current.id;while(parent.has(id)){id=parent.get(id);points.push(point(id))}const p=simplify(points.reverse());return valid(p)&&score(p)<bestScore?p:best}
   for(const [x,y,dir]of [[ix-1,iy,1],[ix+1,iy,1],[ix,iy-1,2],[ix,iy+1,2]]){
    if(x<0||x>=w||y<0||y>=ys.length)continue
    const nextCell=y*w+x,key=cell<nextCell?cell+':'+nextCell:nextCell+':'+cell,b=[xs[x],ys[y]]
    if(cell===Math.floor(initial/3)&&!outward(a,b,options.startVector)||nextCell===goal&&!outward(b,a,options.endVector))continue
    let free=checked.get(key);if(free===undefined){free=clear(a,b);checked.set(key,free)}if(!free)continue
    const id=nextCell*3+dir,g=current.g+Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+(current.id%3&&current.id%3!==dir?18:0)+segmentCost(a,b,occupied,options)
    if(g>=(cost.get(id)===undefined?Infinity:cost.get(id)))continue
    cost.set(id,g);parent.set(id,current.id);push({id,g,f:g+Math.abs(end[0]-b[0])+Math.abs(end[1]-b[1])})
   }
  }
  return best // Never fall back to a line through an obstacle.
 }
 function create(rectangles){
  const rects=rectangles.slice(0,100).map(r=>({...r})).sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0),byId=new Map(rects.map(r=>[r.id,r])),inflated=new Map()
  const vector=direction=>({left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]})[direction]||[1,0]
  function escape(point,id,direction,padding){const r=byId.get(id),v=vector(direction);if(!r)return[point[0]+v[0]*padding,point[1]+v[1]*padding];return v[0]?[v[0]>0?r.right+padding:r.left-padding,point[1]]:[point[0],v[1]>0?r.bottom+padding:r.top-padding]}
  function route({start,end,source,target,startDirection='right',endDirection='left'},reserved=[],budget=null){
   for(const padding of [12,4,1]){
    if(!inflated.has(padding))inflated.set(padding,rects.map(r=>({...r,left:r.left-padding,right:r.right+padding,top:r.top-padding,bottom:r.bottom+padding})))
    const obstacles=inflated.get(padding),a=escape(start,source,startDirection,padding),b=escape(end,target,endDirection,padding)
    if(obstacles.some(r=>r.id!==source&&hits(start,a,r)||r.id!==target&&hits(b,end,r)))continue
    const points=search(a,b,obstacles,reserved,{start,end,startVector:vector(startDirection),endVector:vector(endDirection),budget});if(points)return simplify([start,...points,end])
   }
   return null
  }
  return{route,routeAll(edges){
   const reserved=[],result=new Map(),budget={remaining:24000},key=e=>String(e.id),ordered=edges.slice().sort((a,b)=>length([a.start,a.end])-length([b.start,b.end])||(key(a)<key(b)?-1:key(a)>key(b)?1:0))
   const segments=(edge,points)=>points?points.slice(1).map((b,i)=>({id:edge.id,a:points[i],b,start:edge.start,end:edge.end,first:i===0,last:i===points.length-2})):[]
   for(const edge of ordered){const points=route(edge,reserved,budget);result.set(edge.id,points);reserved.push(...segments(edge,points))}
   // A later wrap can expose a cheaper lane for an earlier edge. Negotiate only
   // congested paths, with a hard retry bound; clear local links take no extra searches.
   let retries=0
   for(let pass=0;pass<2&&retries<64;pass++)for(const edge of ordered){
    const current=result.get(edge.id);if(!current||retries>=64)continue
    const others=reserved.filter(s=>s.id!==edge.id),occupied=segmentIndex(others),penalty=p=>p.slice(1).reduce((sum,b,i)=>sum+segmentCost(p[i],b,occupied,edge),0),conflict=penalty(current)
    if(!conflict||budget.remaining<=0)continue
    retries++;const points=route(edge,others,budget),score=p=>length(p)+Math.max(0,p.length-2)*18+penalty(p)
    if(points&&score(points)<score(current)-EPS){result.set(edge.id,points);for(let i=reserved.length-1;i>=0;i--)if(reserved[i].id===edge.id)reserved.splice(i,1);reserved.push(...segments(edge,points))}
   }
   return result
  }}
 }
 // Cubic quarter turns stay inside a checked control hull, including in narrow corridors.
 function commands(points,rectangles=[],radius=12){
  if(!points||!points.length)return[]
  const out=[{type:'M',values:points[0].slice()}],k=.5522847498307936
  for(let i=1;i<points.length-1;i++){
   const a=points[i-1],b=points[i],c=points[i+1],incoming=Math.hypot(b[0]-a[0],b[1]-a[1]),outgoing=Math.hypot(c[0]-b[0],c[1]-b[1]);let r=Math.min(radius,incoming/2,outgoing/2),entry,exit
   if(!incoming||!outgoing)continue
   if(Math.abs((b[0]-a[0])*(c[1]-b[1])-(b[1]-a[1])*(c[0]-b[0]))<EPS){out.push({type:'L',values:b.slice()});continue}
   while(r>=.5){entry=[b[0]+(a[0]-b[0])*r/incoming,b[1]+(a[1]-b[1])*r/incoming];exit=[b[0]+(c[0]-b[0])*r/outgoing,b[1]+(c[1]-b[1])*r/outgoing];const hull={left:Math.min(entry[0],b[0],exit[0]),right:Math.max(entry[0],b[0],exit[0]),top:Math.min(entry[1],b[1],exit[1]),bottom:Math.max(entry[1],b[1],exit[1])};if(!rectangles.some(rect=>Math.min(hull.right,rect.right)-Math.max(hull.left,rect.left)>EPS&&Math.min(hull.bottom,rect.bottom)-Math.max(hull.top,rect.top)>EPS))break;r/=2}
   if(r<.5){out.push({type:'L',values:b.slice()});continue}
   out.push({type:'L',values:entry},{type:'C',values:[entry[0]+(b[0]-entry[0])*k,entry[1]+(b[1]-entry[1])*k,exit[0]+(b[0]-exit[0])*k,exit[1]+(b[1]-exit[1])*k,...exit]})
  }
  if(points.length>1)out.push({type:'L',values:points[points.length-1].slice()})
  return out
 }
 function trace(ctx,path){for(const cmd of path)if(cmd.type==='M')ctx.moveTo(...cmd.values);else if(cmd.type==='C')ctx.bezierCurveTo(...cmd.values);else ctx.lineTo(...cmd.values)}
 const svgPath=path=>path.map(cmd=>cmd.type+' '+cmd.values.join(' ')).join(' ')
 return{create,hits,pointAt,length,commands,trace,svgPath,portLayout,PORT_COLORS}
})
