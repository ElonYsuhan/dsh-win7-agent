'use strict'
const text=(title,maxLength=16000)=>({type:'string',title,minLength:1,maxLength})
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false})
function report(){
 const nodes=[
  {id:'start',type:'start',title:'开始',text:'按步骤分析资料、确认大纲并形成报告。'},
  {id:'materials',type:'human',title:'资料与任务',interaction:{version:1,type:'handle'},processing:{version:1,blocks:[{type:'instructions'},{type:'form'},{type:'attachments'}]},humanModes:['review'],text:'填写目标和原始资料，可附加文件。确认资料来源后提交。',inputSchema:object({goal:text('任务目标',2000),sources:text('资料内容')}),outputSchema:object({goal:text('任务目标',2000),sources:text('资料内容')})},
  {id:'analysis',type:'agent',title:'资料分析',text:'阅读 input.txt 中的任务和资料，梳理可验证的事实、来源、缺失信息与风险。只分析，不编造。资料足够时返回 {"outcome":"completed","result":{"analysis":"分析内容"}}；资料不足必须人工补充时返回 {"outcome":"needs_human","reason":"需要补充的内容","partial":"已有分析"}。',inputSchema:object({goal:text('任务目标',2000),sources:text('资料内容')}),bindings:{goal:{nodeId:'materials',path:'goal'},sources:{nodeId:'materials',path:'sources'}},outputSchema:object({analysis:text('资料分析')}),agent:{tools:['read_file'],maxSteps:6,maxRequests:6,maxToolCalls:6,timeoutMs:120000}},
  {id:'outline',type:'ai',title:'大纲生成',text:'基于资料分析形成报告大纲。保留资料依据，列出待确认事项。',outputSchema:object({outline:text('报告大纲')})},
  {id:'confirmation',type:'human',title:'人工确认大纲',interaction:{version:1,type:'approve'},bindings:{outline:{nodeId:'outline',path:'outline'}},humanModes:['review','approval','read'],text:'查看上游资料分析与大纲，填写确认后的大纲。通过后进入正文；驳回时说明原因，退回资料与任务环节补充修改。',inputSchema:object({outline:text('确认后的大纲')}),outputSchema:object({outline:text('确认后的大纲')})},
  {id:'body',type:'ai',title:'正文编写',text:'根据已由人工确认的大纲生成报告正文。保留依据，不确定事项单独说明。',inputSchema:object({outline:text('已确认大纲'),analysis:text('资料分析')}),bindings:{outline:{nodeId:'confirmation',path:'outline'},analysis:{nodeId:'analysis',path:'analysis'}},outputSchema:object({report:text('报告正文')})},
  {id:'evaluation',type:'evaluate',title:'报告评估',inputSchema:object({report:text('报告正文'),analysis:text('资料分析')}),bindings:{report:{nodeId:'body',path:'report'},analysis:{nodeId:'analysis',path:'analysis'}},text:'检查事实依据、完整性、逻辑和可操作性。verdict 为 pass、revise 或 fail。明确列出问题及修改建议。',outputSchema:object({verdict:{type:'string',title:'结论',enum:['pass','revise','fail']},summary:text('评估说明'),issues:{type:'array',title:'问题清单',items:{type:'string',maxLength:2000},maxItems:20}})},
  {id:'end',type:'end',title:'结束交付',deliverable:{format:'markdown',name:'分析报告',field:'report'},text:'',bindings:{report:{nodeId:'body',path:'report'},evaluation:{nodeId:'evaluation',path:''}}}
 ].map((n,i)=>({...n,pos:[40+(i%4)*240,80+Math.floor(i/4)*160]}))
 return{version:2,editor:'steps',name:'资料分析与报告编写',nodes,edges:nodes.slice(1).map((n,i)=>({from:nodes[i].id,to:n.id,slot:0,outputSlot:0}))}
}
module.exports={catalog:[{id:'report',name:'资料分析 → 大纲 → 人工确认 → 正文 → 评估'}],create:id=>{if(id!=='report')throw Error('步骤模板不存在');return report()}}
