'use strict'
// 智能布局：分层排序 + 重心法减少交叉 + 三种排布（横向 / 纵向 / 分层带）+ 视口自适应。
// 纯函数：只吃几何，不碰 DOM 与图结构；调用方负责把 id 映射回 node.pos。
;(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.workflowAutoLayout=api})(typeof window==='object'?window:globalThis,function(){
 // 坐标系与 LiteGraph 对齐：一个节点的外框是 [x, y, w, h]，x/y 取标题栏上沿。
 const DIRECTIONS=Object.freeze(['horizontal','vertical','layered','fit'])
 const LABELS=Object.freeze({horizontal:'横向排列',vertical:'纵向排列',layered:'分层排列',fit:'自适应窗口'})
 const NOTES=Object.freeze({horizontal:'从左到右推进，同层上下并排',vertical:'从上到下推进，同层左右并排',layered:'按层分成竖带，层内多行排布',fit:'按当前窗口比例自动挑最合适的一种'})
 const GAP=Object.freeze({rank:72,node:32,band:104})
 function normalize(nodes,edges){
  const list=[],byId=new Map()
  for(const item of nodes||[]){
   if(!item||item.id===undefined||item.id===null||byId.has(item.id))continue
   const value={id:item.id,width:Math.max(80,Number(item.width)||220),height:Math.max(40,Number(item.height)||92)}
   list.push(value);byId.set(value.id,value)
  }
  const links=[],seen=new Set()
  for(const edge of edges||[]){
   if(!edge)continue
   const from=edge.from,to=edge.to
   if(from===to||!byId.has(from)||!byId.has(to))continue
   const key=String(from)+'\u0000'+String(to)
   if(seen.has(key))continue
   seen.add(key);links.push({from,to})
  }
  return{list,byId,links}
 }
 // 最长路径分层。环上的节点接在已知最深层之后，保证布局永远能给出结果。
 function ranks(list,links){
  const out=new Map(),incoming=new Map(),depth=new Map()
  for(const item of list){out.set(item.id,[]);incoming.set(item.id,0);depth.set(item.id,0)}
  for(const link of links){out.get(link.from).push(link.to);incoming.set(link.to,incoming.get(link.to)+1)}
  const queue=list.filter(item=>incoming.get(item.id)===0).map(item=>item.id),settled=new Set()
  while(queue.length){
   const id=queue.shift();settled.add(id)
   for(const next of out.get(id)){
    depth.set(next,Math.max(depth.get(next),depth.get(id)+1))
    incoming.set(next,incoming.get(next)-1)
    if(incoming.get(next)===0)queue.push(next)
   }
  }
  if(settled.size<list.length){
   let base=1
   for(const value of depth.values())base=Math.max(base,value+1)
   let offset=0
   for(const item of list)if(!settled.has(item.id))depth.set(item.id,base+offset++)
  }
  return depth
 }
 function buildLayers(list,depth){
  const layers=[]
  for(const item of list){
   const index=depth.get(item.id)||0
   while(layers.length<=index)layers.push([])
   layers[index].push(item.id)
  }
  return layers
 }
 // 重心法（barycentre）：相邻层之间反复按对端平均位置排序，压低交叉数量。
 function orderLayers(layers,links){
  const above=new Map(),below=new Map()
  const push=(map,key,value)=>{const list=map.get(key);if(list)list.push(value);else map.set(key,[value])}
  for(const link of links){push(below,link.from,link.to);push(above,link.to,link.from)}
  const slot=new Map()
  const indexLayer=layer=>layer.forEach((id,position)=>slot.set(id,position))
  layers.forEach(indexLayer)
  const barycentre=(id,map)=>{
   const peers=map.get(id)
   if(!peers||!peers.length)return slot.get(id)||0
   let sum=0
   for(const peer of peers)sum+=slot.get(peer)||0
   return sum/peers.length
  }
  for(let pass=0;pass<4;pass++){
   const downward=pass%2===0
   const sequence=downward?layers:layers.slice().reverse()
   for(const layer of sequence){
    const keyed=layer.map((id,position)=>({id,position,value:barycentre(id,downward?above:below)}))
    keyed.sort((a,b)=>a.value-b.value||a.position-b.position)
    layer.splice(0,layer.length,...keyed.map(entry=>entry.id))
    indexLayer(layer)
   }
  }
  return layers
 }
 function place(layers,byId,gap,direction){
  const positions=new Map(),gapRank=gap.rank,gapNode=gap.node,gapBand=gap.band
  const items=layer=>layer.map(id=>byId.get(id)).filter(Boolean)
  if(direction==='vertical'){
   const rows=layers.map(layer=>{
    const cards=items(layer),width=cards.reduce((sum,card)=>sum+card.width,0)+Math.max(0,cards.length-1)*gapNode,height=cards.reduce((max,card)=>Math.max(max,card.height),0)
    return{cards,width,height}
   })
   const total=rows.reduce((max,row)=>Math.max(max,row.width),0)
   let y=0
   for(const row of rows){
    let x=(total-row.width)/2
    for(const card of row.cards){positions.set(card.id,[x,y+(row.height-card.height)/2]);x+=card.width+gapNode}
    y+=row.height+gapRank
   }
   return positions
  }
  if(direction==='layered'){
   // 每条横带 = 一层；带内超过两个节点就折成方阵，避免一层把画布拉成一条长带。
   // 带与带之间留更大空隙，看上去是一段一段的流程阶段。
   const bands=layers.map(layer=>{
    const cards=items(layer),maxWidth=cards.reduce((max,card)=>Math.max(max,card.width),0),maxHeight=cards.reduce((max,card)=>Math.max(max,card.height),0)
    const columns=cards.length<=2?Math.max(1,cards.length):Math.min(3,Math.ceil(Math.sqrt(cards.length))),rows=Math.ceil(cards.length/Math.max(1,columns))
    return{cards,maxWidth,maxHeight,columns,rows,width:columns*maxWidth+Math.max(0,columns-1)*gapNode,height:rows*maxHeight+Math.max(0,rows-1)*gapNode}
   })
   const widest=bands.reduce((max,band)=>Math.max(max,band.width),0)
   let y=0
   for(const band of bands){
    const left=(widest-band.width)/2
    band.cards.forEach((card,index)=>{
     const row=Math.floor(index/band.columns),column=index%band.columns
     positions.set(card.id,[left+column*(band.maxWidth+gapNode)+(band.maxWidth-card.width)/2,y+row*(band.maxHeight+gapNode)+(band.maxHeight-card.height)/2])
    })
    y+=band.height+gapBand
   }
   return positions
  }
  const columns=layers.map(layer=>{
   const cards=items(layer),width=cards.reduce((max,card)=>Math.max(max,card.width),0),height=cards.reduce((sum,card)=>sum+card.height,0)+Math.max(0,cards.length-1)*gapNode
   return{cards,width,height}
  })
  const total=columns.reduce((max,column)=>Math.max(max,column.height),0)
  let x=0
  for(const column of columns){
   let y=(total-column.height)/2
   for(const card of column.cards){positions.set(card.id,[x+(column.width-card.width)/2,y]);y+=card.height+gapNode}
   x+=column.width+gapRank
  }
  return positions
 }
 function boundsOf(positions,byId){
  let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity
  for(const [id,point]of positions){
   const card=byId.get(id)
   if(!card)continue
   left=Math.min(left,point[0]);top=Math.min(top,point[1]);right=Math.max(right,point[0]+card.width);bottom=Math.max(bottom,point[1]+card.height)
  }
  if(!Number.isFinite(left))return{left:0,top:0,right:0,bottom:0,width:0,height:0}
  return{left,top,right,bottom,width:right-left,height:bottom-top}
 }
 // 归一化到 (0,0) 起点：调用方只需加自己的页边距即可写回 node.pos。
 function rebase(positions,byId){
  const bounds=boundsOf(positions,byId),moved=new Map()
  for(const [id,point]of positions)moved.set(id,[point[0]-bounds.left,point[1]-bounds.top])
  return{positions:moved,bounds:{left:0,top:0,right:bounds.width,bottom:bounds.height,width:bounds.width,height:bounds.height}}
 }
 function plan({nodes,edges,direction='fit',viewport,gap}={}){
  const {list,byId,links}=normalize(nodes,edges)
  if(!list.length)return{positions:new Map(),bounds:{left:0,top:0,right:0,bottom:0,width:0,height:0},direction:'horizontal',scale:1}
  const merged={...GAP,...(gap||{})},layers=orderLayers(buildLayers(list,ranks(list,links)),links)
  const build=which=>rebase(place(layers,byId,merged,which),byId)
  if(direction!=='fit')return{...build(DIRECTIONS.includes(direction)?direction:'horizontal'),direction:DIRECTIONS.includes(direction)?direction:'horizontal',scale:1}
  const width=viewport&&Number(viewport.width)>0?Number(viewport.width):0,height=viewport&&Number(viewport.height)>0?Number(viewport.height):0
  const usableWidth=width?Math.max(160,width-72):0,usableHeight=height?Math.max(160,height-72):0
  const viewportRatio=width&&height?width/height:1.6
  const options=['horizontal','vertical','layered'].map(which=>{
   const result=build(which)
   // 需要缩到多小才放得下：能 100% 显示的方向优先，其次才是长宽比贴合。
   const fitScale=usableWidth&&usableHeight?Math.min(1,usableWidth/Math.max(1,result.bounds.width),usableHeight/Math.max(1,result.bounds.height)):1
   const ratio=(result.bounds.width/Math.max(1,result.bounds.height))/Math.max(.05,viewportRatio)
   const distortion=Math.abs(Math.log(Math.max(.05,ratio)))
   return{...result,which,fitScale,score:fitScale*4-distortion}
  })
  options.sort((a,b)=>b.score-a.score||a.bounds.width-b.bounds.width)
  const best=options[0]
  return{positions:best.positions,bounds:best.bounds,direction:best.which,scale:best.fitScale}
 }
 return{plan,ranks,orderLayers,buildLayers,normalize,boundsOf,DIRECTIONS,LABELS,NOTES,GAP}
})
