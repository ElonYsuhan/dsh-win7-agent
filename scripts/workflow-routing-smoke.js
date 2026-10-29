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
assert(Date.now()-began<4000,'100-card graph routing remains bounded')
// The displaced fourth card reproduces two wraps fighting over the same right-side lane.
const wrapped=[[0,100],[240,100],[480,100],[680,20],[0,260],[240,260],[480,260],[720,260],[0,420]].map(([left,top],id)=>rect(id,left,top,220,92))
const cables=wrapped.slice(1).map((b,id)=>({id,source:id,target:id+1,start:[wrapped[id].right-8,wrapped[id].top+44],end:[b.left+8,b.top+44]}))
function conflictCount(paths){
 let shared=0,crossings=0
 for(let i=0;i<paths.length;i++)for(let j=0;j<i;j++)for(let a=1;a<paths[i].length;a++)for(let b=1;b<paths[j].length;b++){
  const p=paths[i][a-1],q=paths[i][a],x=paths[j][b-1],y=paths[j][b],h=p[1]===q[1],v=x[1]===y[1],overlap=(a,b,c,d)=>Math.min(Math.max(a,b),Math.max(c,d))-Math.max(Math.min(a,b),Math.min(c,d))
  if(h===v){if(p[h?1:0]===x[h?1:0])shared+=Math.max(0,overlap(p[h?0:1],q[h?0:1],x[h?0:1],y[h?0:1]))}
  else{const horizontal=h?[p,q]:[x,y],vertical=h?[x,y]:[p,q],cx=vertical[0][0],cy=horizontal[0][1];if(cx>Math.min(horizontal[0][0],horizontal[1][0])&&cx<Math.max(horizontal[0][0],horizontal[1][0])&&cy>Math.min(vertical[0][1],vertical[1][1])&&cy<Math.max(vertical[0][1],vertical[1][1]))crossings++}
 }
 return{shared,crossings}
}
const independent=cables.map(e=>Routing.create(wrapped).route(e)),planned=Routing.create(wrapped).routeAll(cables)
assert(conflictCount(independent).shared>0,'Fixture exposes the former shared lane')
assert.deepStrictEqual(conflictCount(cables.map(e=>planned.get(e.id))),{shared:0,crossings:0},'Batch planning separates unrelated wires and negotiates away the wrap crossing')
assert.deepStrictEqual([...planned],[...Routing.create(wrapped.slice().reverse()).routeAll(cables.slice().reverse())],'Card/edge iteration order does not change lane assignments')
const movedWrapped=wrapped.map(r=>r.id===3?{...r,left:720,right:940,top:100,bottom:192}:r),movedCables=cables.map(e=>({...e,start:e.source===3?[932,144]:e.start,end:e.target===3?[728,144]:e.end}))
assert(Routing.length(Routing.create(movedWrapped).routeAll(movedCables).get(2))<Routing.length(planned.get(2)),'Moving the raised card restores a short direct connection')
for(const edge of cables){
 const points=planned.get(edge.id);verify(wrapped,edge)
 for(let i=1;i<points.length;i++)for(const r of wrapped){if(i===1&&r.id===edge.source||i===points.length-1&&r.id===edge.target)continue;assert(!Routing.hits(points[i-1],points[i],r),'Planned lane clears card '+r.id)}
 const path=Routing.commands(points,wrapped);assert.deepStrictEqual(path[0].values,edge.start);assert.deepStrictEqual(path[path.length-1].values,edge.end)
 let previous=path[0].values
 for(const cmd of path.slice(1)){
  if(cmd.type==='C')for(let step=0;step<=40;step++){const t=step/40,u=1-t,p=[0,1].map(i=>u*u*u*previous[i]+3*u*u*t*cmd.values[i]+3*u*t*t*cmd.values[i+2]+t*t*t*cmd.values[i+4]);for(const r of wrapped)assert(!(p[0]>r.left+.001&&p[0]<r.right-.001&&p[1]>r.top+.001&&p[1]<r.bottom-.001),'Bezier corner never clips a card')}
  previous=cmd.values.slice(-2)
 }
 if(points.length>2){assert(path.some(c=>c.type==='C'),'Every clear wrap has cubic Bezier corners');assert(Routing.svgPath(path).includes('C '),'SVG uses the same cubic geometry')}
 const calls=[];Routing.trace({moveTo:(...v)=>calls.push({type:'M',values:v}),lineTo:(...v)=>calls.push({type:'L',values:v}),bezierCurveTo:(...v)=>calls.push({type:'C',values:v})},path);assert.deepStrictEqual(calls,path,'Canvas and SVG consume one geometry contract')
}
const batchEdges=many.slice(1).filter((to,i)=>i%10!==9).map(to=>{const from=many[Number(to.id)-1];return{id:from.id,source:from.id,target:to.id,start:[from.right-10,from.top+30],end:[to.left+10,to.top+30]}}),batchBegan=Date.now()
assert.strictEqual([...Routing.create(many).routeAll(batchEdges).values()].filter(Boolean).length,batchEdges.length);assert(Date.now()-batchBegan<4000,'100-card batch routing remains bounded')
const dense=[]
for(let from=0;from<100;from++)for(let gap=1;gap<=3&&from+gap<100;gap++){const a=many[from],b=many[from+gap];dense.push({id:dense.length,source:a.id,target:b.id,start:[a.right-8,a.top+24],end:[b.left+8,b.top+12+gap*16]})}
const denseBegan=Date.now(),denseRoutes=Routing.create(many).routeAll(dense)
assert.strictEqual([...denseRoutes.values()].filter(Boolean).length,294,'Near-limit fanout keeps all routes');assert(Date.now()-denseBegan<3000,'Indexed cable queries and a shared search budget bound near-limit planning')
console.log('Workflow routing: obstacle avoidance, negotiated separate lanes, no wrap crossings, deterministic batch ordering, cubic Bezier clearance, shared Canvas/SVG geometry and bounded 100-card layout passed')
// Adaptive anchors face their peers instead of forcing every cable through L/R.
const card=rect('a',200,200,220,100)
for(const [peer,direction]of [[rect('b',600,200),'right'],[rect('b',-100,200),'left'],[rect('b',200,500),'down'],[rect('b',200,-100),'up']]){
 const port=Routing.portLayout(card,[{key:'o',input:false,peers:[peer]}]).get('o');assert.strictEqual(port.direction,direction);assert.strictEqual(port.color,Routing.PORT_COLORS.output);assert(port.point[0]===card.left||port.point[0]===card.right||port.point[1]===card.top||port.point[1]===card.bottom,'Ports sit exactly on the card edge')
 const target=Routing.portLayout(peer,[{key:'i',input:true,peers:[card]}]).get('i');assert.strictEqual(target.color,Routing.PORT_COLORS.input)
 const points=Routing.create([card,peer]).route({start:port.point,end:target.point,source:'a',target:'b',startDirection:port.direction,endDirection:target.direction});assert(points);assert(points.length<=4,'Facing nodes do not take an exterior lap')
}
const crowded=Routing.portLayout(card,[{key:'i0',input:true,peers:[rect('b',-100,200)]},{key:'i2',input:true,peers:[rect('c',-100,220)]},{key:'o4',input:false,peers:[rect('d',-100,240)]}]);assert.strictEqual(new Set([...crowded.values()].map(p=>p.point.join(','))).size,3,'Mixed-direction slots on one edge remain distinct')
// 同一输出端口的多条出线按 startLane 在端口外错开，否则会重叠成一条再分叉。
const hub=rect('hub',300,200,220,120),fan=[rect('f1',760,40),rect('f2',760,200),rect('f3',760,360)]
const hubRoutes=Routing.create([hub,...fan]).routeAll([
 {id:'a',source:'hub',target:'f1',start:[520,232],end:[750,80],startDirection:'right',endDirection:'left',startLane:-12},
 {id:'b',source:'hub',target:'f2',start:[520,232],end:[750,240],startDirection:'right',endDirection:'left',startLane:0},
 {id:'c',source:'hub',target:'f3',start:[520,232],end:[750,400],startDirection:'right',endDirection:'left',startLane:12}
])
const middles=[...hubRoutes.values()].map(points=>points.slice(1,-1).map(p=>p.join(',')).join(' '))
assert.strictEqual(new Set(middles).size,3,'Fan-out cables take distinct lanes out of one slot')
for(const points of hubRoutes.values())for(let i=1;i<points.length;i++)assert(points[i-1][0]===points[i][0]||points[i-1][1]===points[i][1],'Lane offsets keep every segment orthogonal')
const straight=Routing.create([hub,rect('f',760,200)]).route({start:[520,240],end:[750,240],source:'hub',target:'f',startDirection:'right',endDirection:'left'})
assert.deepStrictEqual(straight,[[520,240],[750,240]],'A single cable stays a straight line without lane offsets')

const returns={nodes:[{id:'apply',type:'human',title:'申请人',interaction:{version:1,type:'handle'}},{id:'manager',type:'human',interaction:{version:1,type:'approve',returnTo:'apply'}},{id:'finance',type:'human',interaction:{version:1,type:'approve',returnTo:'apply'}}],edges:[{from:'apply',to:'manager'},{from:'manager',to:'finance'}]}
assert.deepStrictEqual(Routing.rejectionEdges(returns).map(e=>[e.from,e.to]),[['manager','apply'],['finance','apply']],'Every rejection returns to the configured applicant, never merely the previous approver')
returns.nodes[2].interaction.returnTo='previous-human';assert.strictEqual(Routing.rejectionEdges(returns)[1].to,'apply','Default target prefers the upstream handling node just like the runtime')
returns.nodes[2].interaction.returnTo='manager';assert.strictEqual(Routing.rejectionEdges(returns)[1].to,'manager','An explicit upstream approver is honored')
assert.strictEqual(returns.edges.length,2,'Display returns do not mutate executable DAG edges')
