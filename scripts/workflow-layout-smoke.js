'use strict'
// 智能布局的纯函数验收：分层排序、三种排布、窗口自适应、无重叠、环形依赖兜底。
const assert=require('assert'),Layout=require('../src/renderer/workflow-auto-layout')
const cards=(spec)=>spec.map(([width,height],index)=>({id:'n'+index,width,height}))
const chain=(count)=>Array.from({length:count},(_,index)=>({id:'n'+index,width:220,height:92}))
function checkNoOverlap(nodes,edges,direction,viewport){
 const result=Layout.plan({nodes,edges,direction,viewport}),entries=[...result.positions],{byId}=Layout.normalize(nodes,edges)
 for(let i=0;i<entries.length;i++)for(let j=i+1;j<entries.length;j++){
  const [leftId,left]=entries[i],[rightId,right]=entries[j],a=byId.get(leftId),b=byId.get(rightId)
  const hitX=Math.min(left[0]+a.width,right[0]+b.width)-Math.max(left[0],right[0])>.5,hitY=Math.min(left[1]+a.height,right[1]+b.height)-Math.max(left[1],right[1])>.5
  assert(!(hitX&&hitY),'Cards never overlap in '+direction)
 }
 return result
}
const diamond={nodes:cards([[220,92],[220,92],[220,92],[220,92],[220,120],[300,92],[220,92]]),
 edges:[{from:'n0',to:'n1'},{from:'n0',to:'n2'},{from:'n1',to:'n3'},{from:'n2',to:'n3'},{from:'n3',to:'n4'},{from:'n3',to:'n5'},{from:'n4',to:'n6'},{from:'n5',to:'n6'}]}
const depth=Layout.ranks(Layout.normalize(diamond.nodes,diamond.edges).list,Layout.normalize(diamond.nodes,diamond.edges).links)
assert.deepStrictEqual([...depth.values()],[0,1,1,2,3,3,4],'Longest-path ranking assigns one layer per stage')
for(const direction of ['horizontal','vertical','layered']){
 const result=checkNoOverlap(diamond.nodes,diamond.edges,direction,{width:1280,height:840})
 assert.strictEqual(result.direction,direction,'Explicit direction is honoured')
 assert.strictEqual(result.scale,1,'Explicit directions keep actual size')
 assert.deepStrictEqual([result.bounds.left,result.bounds.top],[0,0],'Layout is rebased to the origin')
 for(const edge of diamond.edges){
  const a=result.positions.get(edge.from),b=result.positions.get(edge.to)
  assert(direction==='horizontal'?b[0]>a[0]:b[1]>a[1],'Every edge advances along the '+direction+' axis')
 }
}
// 横向：同层节点纵向并排，列内按卡片中心对齐（宽度不一致时也不歪）。
const wide=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'horizontal'}),wideCards=Layout.normalize(diamond.nodes,diamond.edges).byId
const centreX=id=>wide.positions.get(id)[0]+wideCards.get(id).width/2
assert(Math.abs(centreX('n4')-centreX('n5'))<.01,'Same layer shares one column axis')
assert(Math.abs(centreX('n1')-centreX('n2'))<.01,'Narrow cards centre on the same column')
assert(wide.positions.get('n4')[1]<wide.positions.get('n5')[1],'Same layer stacks top to bottom')
assert(wide.bounds.width>wide.bounds.height,'Horizontal layout is wider than tall')
// 纵向：同层节点横向并排，行内按卡片中心对齐。
const tall=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'vertical'}),tallCards=wideCards
const centreY=id=>tall.positions.get(id)[1]+tallCards.get(id).height/2
assert(Math.abs(centreY('n1')-centreY('n2'))<.01,'Same layer shares one row axis')
assert(tall.positions.get('n1')[0]<tall.positions.get('n2')[0],'Same layer spreads left to right')
assert(tall.bounds.height>tall.bounds.width,'Vertical layout is taller than wide')
// 分层：层内超过四个节点时切成网格，而不是拉成一条长带。
const fanout=Layout.plan({nodes:Array.from({length:7},(_,index)=>({id:'f'+index,width:220,height:92})),edges:[{from:'f0',to:'f'+1},{from:'f0',to:'f2'},{from:'f0',to:'f3'},{from:'f0',to:'f4'},{from:'f0',to:'f5'},{from:'f0',to:'f6'}],direction:'layered'})
const bandX=new Set(Array.from({length:6},(_,index)=>fanout.positions.get('f'+(index+1))[0]))
assert.strictEqual(bandX.size,3,'A six-node layer wraps into three columns')
assert.strictEqual(new Set(Array.from({length:6},(_,index)=>fanout.positions.get('f'+(index+1))[1])).size,2,'A six-node layer wraps into two rows')
// 自适应：宽屏选横向，窄高屏选纵向，并给出能装下的缩放。
const wideView=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'fit',viewport:{width:1600,height:520}})
assert.strictEqual(wideView.direction,'horizontal','Wide viewport prefers horizontal flow')
const tallView=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'fit',viewport:{width:520,height:1400}})
assert.strictEqual(tallView.direction,'vertical','Tall viewport prefers vertical flow')
const longChain={nodes:chain(16),edges:Array.from({length:15},(_,index)=>({from:'n'+index,to:'n'+(index+1)}))}
const fitted=Layout.plan({...longChain,direction:'fit',viewport:{width:1280,height:840}})
assert.strictEqual(fitted.direction,'vertical','A long chain folds into the vertical direction')
assert(fitted.bounds.width*fitted.scale<=1280-70&&fitted.bounds.height*fitted.scale<=840-70,'Auto layout scales the whole graph into the window')
assert(fitted.scale>=.25&&fitted.scale<=1,'Auto layout never enlarges past 100%')
const loose=Layout.plan({nodes:chain(3),edges:[],direction:'fit',viewport:{width:1280,height:840}})
assert(loose.scale===1&&loose.positions.size===3,'Disconnected cards stay at actual size and still get placed')
// 环：不拒绝布局，环上节点接在已知最深层之后。
const cyclic=Layout.plan({nodes:chain(3),edges:[{from:'n0',to:'n1'},{from:'n1',to:'n2'},{from:'n2',to:'n1'}],direction:'horizontal'})
assert.strictEqual(cyclic.positions.size,3,'Cycles still produce a layout')
assert(cyclic.positions.get('n0')[0]<cyclic.positions.get('n1')[0]&&cyclic.positions.get('n1')[0]<cyclic.positions.get('n2')[0],'Cycle members fall back after the resolved layers')
assert(Layout.plan({nodes:[],edges:[],direction:'fit'}).bounds.width===0,'Empty graph is a no-op')
// 自环与重复边不会污染分层结果。
const messy=Layout.ranks(Layout.normalize(chain(3),[ {from:'n0',to:'n0'},{from:'n0',to:'n1'},{from:'n0',to:'n1'},{from:'n1',to:'n2'} ]).list,[{from:'n0',to:'n1'},{from:'n1',to:'n2'}])
assert.deepStrictEqual([...messy.values()],[0,1,2],'Self loops and duplicate edges are dropped')
// 交叉压制：菱形图的上层顺序稳定，不会来回抖动。
const once=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'horizontal'})
const twice=Layout.plan({nodes:diamond.nodes,edges:diamond.edges,direction:'horizontal'})
assert.deepStrictEqual([...once.positions],[...twice.positions],'Layout is deterministic')
console.log('Workflow auto layout: longest-path ranking, barycentre ordering, horizontal/vertical/layered placement, viewport-aware choice, no overlaps, cycle tolerance and deterministic output passed')
