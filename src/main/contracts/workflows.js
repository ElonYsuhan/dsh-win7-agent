'use strict'
const Schema=require('./workflow-schema'),Agent=require('./workflow-agent'),Artifacts=require('./workflow-artifacts'),Processing=require('./workflow-processing'),Interaction=require('./workflow-interaction')
const TYPES=Object.freeze([
 {type:'start',name:'开始',description:'定义流程起点与初始输入'},
 {type:'human',name:'人工处理',description:'上传、判断、审阅与审批'},
 {type:'ai',name:'AI 处理',description:'调用当前配置的内网模型'},
 {type:'agent',name:'Agent 处理',description:'受限的多步工具执行，不在节点内等待人工'},
 {type:'tool',name:'工具调用',description:'固定调用一个已授权工具，不使用模型'},
 {type:'rest',name:'REST 接口',description:'调用 HTTP/HTTPS 外部接口，无自动重试'},
 {type:'evaluate',name:'AI 评估',description:'按指定标准使用 AI 分析依据、结论与风险'},
 {type:'template',name:'文本整理',description:'兼容已有流程的文本模板',legacy:true},
 {type:'end',name:'结束',description:'汇总并保存本次实例的最终结果'},
 {type:'input',name:'文本输入',description:'兼容已有流程',legacy:true},
 {type:'output',name:'保存结果',description:'兼容已有流程',legacy:true}
])
function id(value){if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(value))throw Error('WORKFLOW_ID_INVALID');return value}
const HUMAN_MODES=['review','upload','approval','read']
function humanModes(n){return Interaction.modes(n)}
function ports(value,fallback){
 const list=value===undefined?fallback:value
 if(!Array.isArray(list)||list.length>32)throw Error('每侧端口最多32个')
 const result=list.map(p=>{const name=typeof p==='string'?p:p&&p.name;if(p&&typeof p==='object'&&p.type!==undefined&&p.type!=='text')throw Error('当前端口仅支持文本类型');if(typeof name!=='string'||!name.trim()||name.trim().length>40)throw Error('端口名称需要1～40字');return {name:name.trim(),type:'text'}})
 if(new Set(result.map(p=>p.name)).size!==result.length)throw Error('同侧端口名称不能重复')
 return result
}
function validate(raw,types=TYPES){
 if(!raw||typeof raw!=='object'||(raw.version!==undefined&&![1,2].includes(raw.version)))throw Error('WORKFLOW_INVALID')
 if(raw.editor!==undefined&&!['steps','canvas'].includes(raw.editor))throw Error('流程编辑模式无效');
 if(JSON.stringify(raw).length>512000)throw Error('流程定义超过512000字');
 const name=String(raw.name||'').trim();if(!name||name.length>120)throw Error('请输入流程名称（最多120字）')
 if(!Array.isArray(raw.nodes)||!raw.nodes.length||raw.nodes.length>100||!Array.isArray(raw.edges)||raw.edges.length>300)throw Error('流程需要1～100个节点，连线最多300条')
 const seen=new Set(),nodes=raw.nodes.map(n=>{
  const key=id(n.id);if(seen.has(key)||typeof n.type!=='string'||!/^[a-z][a-z0-9_.-]{0,79}$/.test(n.type)||(types&&!types.some(t=>t.type===n.type)))throw Error('节点重复或类型不支持');seen.add(key)
  if(n.processing!==undefined&&n.type!=='human')throw Error('处理内容仅用于人工节点');
  if(n.interaction!==undefined&&n.type!=='human')throw Error('交互类型仅用于人工节点');
  const text=String(n.text||'');if(text.length>16000)throw Error('节点参数超过16000字')
  const modes=humanModes(n);if(!modes.length||modes.some(m=>!HUMAN_MODES.includes(m))||new Set(modes).size!==modes.length)throw Error('请选择有效的人工处理方式')
  const inputs=ports(n.inputs,['input','start'].includes(n.type)?[]:['输入1','输入2']),outputs=ports(n.outputs,['output','end'].includes(n.type)?[]:['文本'])
  if(['input','start'].includes(n.type)&&inputs.length||['output','end'].includes(n.type)&&outputs.length)throw Error('输入节点不能添加输入，保存结果节点不能添加输出')
  const rest={url:String(n.rest&&n.rest.url||'').trim(),method:String(n.rest&&n.rest.method||'GET')}
  if(n.type==='rest'){
   let url;try{url=new URL(rest.url)}catch(_){throw Error('请填写有效的 REST 接口地址')}
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||rest.url.length>2000)throw Error('REST 仅支持不含凭据的 HTTP/HTTPS 地址')
   if(!['GET','POST','PUT','PATCH','DELETE'].includes(rest.method))throw Error('REST 请求方法无效')
  }
  const tool=n.tool||{name:'',arguments:{},permission:'readonly'};if(n.type==='tool'&&(!tool||typeof tool.name!=='string'||!/^[-A-Za-z0-9_]{1,80}$/.test(tool.name)||!tool.arguments||typeof tool.arguments!=='object'||Array.isArray(tool.arguments)||JSON.stringify(tool.arguments).length>16000||!['readonly','workspace'].includes(tool.permission||'readonly')))throw Error('请配置工具名称、JSON 参数和权限');
  const inputSchema=Schema.schema(n.inputSchema),outputSchema=Schema.schema(n.outputSchema),skills=Agent.strings(n.skills||[],4),agent=Agent.configuration(n.agent);if(inputSchema&&inputSchema.type!=='object')throw Error('节点输入 Schema 根类型必须为 object');const bindings=n.bindings||{};if(!bindings||typeof bindings!=='object'||Array.isArray(bindings)||Object.keys(bindings).length>24)throw Error('输入映射无效');for(const [field,b]of Object.entries(bindings))if(!Schema.safe(field)||!b||typeof b!=='object'||typeof b.nodeId!=='string'||b.path!==undefined&&typeof b.path!=='string'||String(b.path||'').length>200||b.path&&b.path.split('.').some(k=>!Schema.safe(k)))throw Error('输入字段映射无效');
  return {interaction:n.type==='human'?Interaction.configuration(n.interaction):undefined,processing:n.type==='human'&&n.processing!==undefined?Processing.view({...n,inputSchema}):undefined,deliverable:['end','output'].includes(n.type)?Artifacts.declaration(n.deliverable):undefined,tool:{name:String(tool.name||''),arguments:tool.arguments||{},permission:tool.permission||'readonly'},inputSchema,outputSchema,bindings:JSON.parse(JSON.stringify(bindings)),skills,agent,id:key,type:n.type,rest,title:String(n.title||((types||TYPES).find(t=>t.type===n.type)||{name:n.type}).name).slice(0,120),text,description:String(n.description||'').slice(0,2000),humanKind:modes[0],humanModes:modes,inputs,outputs,size:Array.isArray(n.size)?[Math.min(520,Math.max(200,Number(n.size[0])||280)),Math.min(360,Math.max(36,Number(n.size[1])||66))]:undefined,pos:Array.isArray(n.pos)?n.pos.slice(0,2).map(v=>Number.isFinite(v)?v:0):[0,0]}
 })
 if(nodes.reduce((sum,n)=>sum+n.text.length+(n.processing?JSON.stringify(n.processing).length:0),0)>128000)throw Error('流程参数总量超过128000字')
 const edges=raw.edges.map(e=>{
  const from=nodes.find(n=>n.id===e.from),to=nodes.find(n=>n.id===e.to),slot=e.slot===undefined?0:e.slot,outputSlot=e.outputSlot===undefined?0:e.outputSlot
  if(!from||!to||from===to)throw Error('连线引用无效节点')
  if(!Number.isInteger(slot)||slot<0||slot>=to.inputs.length||!Number.isInteger(outputSlot)||outputSlot<0||outputSlot>=from.outputs.length)throw Error('连线端口无效')
  return {from:e.from,to:e.to,slot,outputSlot}
 })
 for(const n of nodes)if(['output','end'].includes(n.type)&&!edges.some(e=>e.to===n.id))throw Error('保存结果节点需要上游输入')
 if(new Set(edges.map(e=>e.to+':'+e.slot)).size!==edges.length)throw Error('同一输入端口不能连接多条连线')
 for(const n of nodes)for(const file of n.deliverable&&n.deliverable.files||[]){const source=nodes.find(source=>source.id===file.nodeId&&source.id!==n.id);if(!source)throw Error('产物引用的来源节点不存在');if(TYPES.some(t=>t.type===source.type)&&!['agent','tool','human'].includes(source.type))throw Error('文件产物需来自 Agent、工具、人工附件或文件节点扩展；单次 AI 节点请使用文本交付')};
 for(const n of nodes)for(const binding of Object.values(n.bindings))if(!nodes.some(source=>source.id===binding.nodeId)||binding.nodeId===n.id)throw Error('输入映射引用无效节点');
 return {version:raw.version===2||nodes.some(n=>['agent','tool'].includes(n.type)||n.inputSchema||n.outputSchema||n.processing||n.interaction)?2:1,editor:raw.editor==='steps'?'steps':'canvas',id:raw.id?id(raw.id):'',name,nodes,edges}
}
function submission(raw,requireConclusion=true){
 id(raw.id);id(raw.nodeId);id(raw.taskId)
 const conclusion=String(raw.conclusion||'').trim();if(requireConclusion&&!conclusion||conclusion.length>16000)throw Error('请填写处理结论（最多16000字）')
 const files=raw.files||[];if(!Array.isArray(files)||files.length>3)throw Error('最多提交3个文件')
 let size=0
 for(const file of files){if(!file||typeof file.name!=='string'||!file.name.trim()||file.name.length>200||/[\\/\x00-\x1f]/.test(file.name)||typeof file.data!=='string'||file.data.length%4!==0||/[^A-Za-z0-9+/=]/.test(file.data))throw Error('文件格式无效');size+=file.data.length*3/4-(file.data.endsWith('==')?2:file.data.endsWith('=')?1:0)}
 if(size>512*1024)throw Error('本次附件总大小不能超过512KB')
 if(raw.decision&&!['confirm','approve','reject'].includes(raw.decision))throw Error('处理结论类型无效')
 return {conclusion,decision:raw.decision||'confirm',files}
}
module.exports={TYPES,id,validate,submission,humanModes}
