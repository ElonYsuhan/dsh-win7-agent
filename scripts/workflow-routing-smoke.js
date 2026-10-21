'use strict'
const assert=require('assert'),Routing=require('../src/renderer/workflow-link-routing')
const rect=(id,left,top,width=120,height=80)=>({id,left,top,right:left+width,bottom:top+height})
function verify(rects,options){
 const points=Routing.create(rects).route(options);assert(points&&points.length>1,'A clear path must be found');assert.deepStrictEqual(points[0],Array.from(options.start));assert.deepStrictEqual(points[points.length-1],Array.from(options.end))
 for(let i=1;i<points.length;i++){
  assert(points[i-1][0]===points[i][0]||points[i-1][1]===points[i][1],'Segments are orthogonal')
  for(const r of rects){if(i===1&&r.id===options.source||i===points.length-1&&r.id===options.target)continue;assert(!Routing.hits(points[i-1],points[i],r),'No segment crosses card '+r.id)}
 }
 return points
}
const start=rect('s',0,0),end=rect('e',480,0),block=rect('b',220,-50,120,180),options={start:[110,40],end:[490,40],source:'s',target:'e'}
let points=verify([start,end,block],options);assert(points.some(p=>p[1]<block.top||p[1]>block.bottom),'Route detours above or below the obstacle')
assert.deepStrictEqual(points,verify([start,end,block],options),'Routing is deterministic')
const moved=verify([start,end,{...block,top:200,bottom:380}],options);assert(Routing.length(moved)<Routing.length(points),'Moving the obstacle clears the shorter route')
verify([start,end,block],{start:[590,60],end:[10,60],source:'e',target:'s'})
verify([start,rect('e',0,320),rect('b',-50,140,220,80)],{start:[60,80],end:[60,320],source:'s',target:'e',startDirection:'down',endDirection:'up'})
verify([start,rect('e',135,0)],{start:[110,30],end:[145,30],source:'s',target:'e'})
const maze=[start,rect('e',1000,0),rect('a',180,-60,70,230),rect('b',310,60,70,270),rect('c',440,-90,70,240),rect('d',570,70,70,260),rect('f',700,-80,70,200)]
verify(maze,{start:[110,40],end:[1010,40],source:'s',target:'e'})
assert.strictEqual(Routing.create([start,end,rect('cover',70,0,100,80)]).route(options),null,'A covered port does not fall back to crossing cards')
// Multiple slots and branches must keep their own endpoints.
for(let i=0;i<5;i++)verify([start,end,block],{...options,start:[110,12+i*12],end:[490,12+i*12]})
const many=Array.from({length:100},(_,i)=>rect(String(i),i%10*200,Math.floor(i/10)*160)),router=Routing.create(many),began=Date.now()
for(let i=0;i<90;i++){if(i%10===9)continue;const from=many[i],to=many[i+1];assert(router.route({start:[from.right-10,from.top+30],end:[to.left+10,to.top+30],source:from.id,target:to.id}))}
assert(Date.now()-began<4000,'100-card graph routing remains bounded');console.log('Workflow routing: clear orthogonal detours, backward/vertical/multiple-slot edges, live geometry, narrow gaps, maze, overlap refusal and bounded 100-card layout passed')
