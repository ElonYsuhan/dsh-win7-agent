'use strict'
// Pure, bounded orthogonal routing. No graph mutation, DOM or vendor patches.
;(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.workflowLinkRouting=api})(typeof window==='object'?window:globalThis,function(){
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
 function search(start,end,rects){
  const clear=(a,b)=>!rects.some(r=>hits(a,b,r)),valid=points=>points.slice(1).every((p,i)=>(Math.abs(points[i][0]-p[0])<EPS||Math.abs(points[i][1]-p[1])<EPS)&&clear(points[i],p))
  const mx=(start[0]+end[0])/2,my=(start[1]+end[1])/2
  const candidates=[[start,end],[start,[end[0],start[1]],end],[start,[start[0],end[1]],end],[start,[mx,start[1]],[mx,end[1]],end],[start,[start[0],my],[end[0],my],end]]
  // Most workflows need only one clear channel; avoid allocating a search grid.
  for(const r of rects){for(const y of [r.top,r.bottom])candidates.push([start,[start[0],y],[end[0],y],end]);for(const x of [r.left,r.right])candidates.push([start,[x,start[1]],[x,end[1]],end])}
  candidates.sort((a,b)=>length(a)+a.length*12-length(b)-b.length*12)
  for(const points of candidates)if(valid(points))return simplify(points)
  const xs=[...new Set([start[0],end[0],...rects.flatMap(r=>[r.left,r.right])])].sort((a,b)=>a-b),ys=[...new Set([start[1],end[1],...rects.flatMap(r=>[r.top,r.bottom])])].sort((a,b)=>a-b),w=xs.length
  const initial=(ys.indexOf(start[1])*w+xs.indexOf(start[0]))*3,goal=ys.indexOf(end[1])*w+xs.indexOf(end[0]),cost=new Map([[initial,0]]),parent=new Map(),heap=[],checked=new Map()
  const push=item=>{heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].f<=item.f)break;heap[i]=heap[p];i=p}heap[i]=item}
  const pop=()=>{const top=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].f<heap[c].f)c++;if(heap[c].f>=last.f)break;heap[i]=heap[c];i=c}heap[i]=last}return top}
  const point=id=>[xs[Math.floor(id/3)%w],ys[Math.floor(Math.floor(id/3)/w)]]
  push({id:initial,g:0,f:0});let expanded=0
  while(heap.length&&expanded++<12000){
   const current=pop();if(current.g!==cost.get(current.id))continue
   const cell=Math.floor(current.id/3),ix=cell%w,iy=Math.floor(cell/w),a=point(current.id)
   if(cell===goal){const points=[a];let id=current.id;while(parent.has(id)){id=parent.get(id);points.push(point(id))}return simplify(points.reverse())}
   for(const [x,y,dir]of [[ix-1,iy,1],[ix+1,iy,1],[ix,iy-1,2],[ix,iy+1,2]]){
    if(x<0||x>=w||y<0||y>=ys.length)continue
    const nextCell=y*w+x,key=cell<nextCell?cell+':'+nextCell:nextCell+':'+cell,b=[xs[x],ys[y]]
    let free=checked.get(key);if(free===undefined){free=clear(a,b);checked.set(key,free)}if(!free)continue
    const id=nextCell*3+dir,g=current.g+Math.abs(a[0]-b[0])+Math.abs(a[1]-b[1])+(current.id%3&&current.id%3!==dir?18:0)
    if(g>=(cost.get(id)===undefined?Infinity:cost.get(id)))continue
    cost.set(id,g);parent.set(id,current.id);push({id,g,f:g+Math.abs(end[0]-b[0])+Math.abs(end[1]-b[1])})
   }
  }
  return null // Never fall back to a line through an obstacle.
 }
 function create(rectangles){
  const rects=rectangles.slice(0,100).map(r=>({...r})).sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0),byId=new Map(rects.map(r=>[r.id,r])),inflated=new Map()
  const vector=direction=>({left:[-1,0],right:[1,0],up:[0,-1],down:[0,1]})[direction]||[1,0]
  function escape(point,id,direction,padding){const r=byId.get(id),v=vector(direction);if(!r)return[point[0]+v[0]*padding,point[1]+v[1]*padding];return v[0]?[v[0]>0?r.right+padding:r.left-padding,point[1]]:[point[0],v[1]>0?r.bottom+padding:r.top-padding]}
  return{route({start,end,source,target,startDirection='right',endDirection='left'}){
   for(const padding of [12,4,1]){
    if(!inflated.has(padding))inflated.set(padding,rects.map(r=>({...r,left:r.left-padding,right:r.right+padding,top:r.top-padding,bottom:r.bottom+padding})))
    const obstacles=inflated.get(padding),a=escape(start,source,startDirection,padding),b=escape(end,target,endDirection,padding)
    if(obstacles.some(r=>r.id!==source&&hits(start,a,r)||r.id!==target&&hits(b,end,r)))continue
    const points=search(a,b,obstacles);if(points)return simplify([start,...points,end])
   }
   return null
  }}
 }
 return{create,hits,pointAt,length}
})
