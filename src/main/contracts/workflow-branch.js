'use strict'
const OPERATORS=['eq','ne','gt','gte','lt','lte','in','not_in','contains','empty','not_empty']
const safe=value=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)&&!['__proto__','prototype','constructor'].includes(value)
function exact(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error('条件分支配置字段无效')}
function scalar(value){return value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)||typeof value==='string'&&value.length<=2000}
function label(value){if(typeof value!=='string'||!value.trim()||value.trim().length>40)throw Error('分支名称需要1～40字');return value.trim()}
function configuration(raw){
 exact(raw,['version','cases','default']);if(raw.version!==1||!Array.isArray(raw.cases)||!raw.cases.length||raw.cases.length>8)throw Error('条件分支需要1～8条有序规则和一个默认分支')
 const ids=new Set(),names=new Set(),take=(id,name)=>{if(!safe(id)||id.length>40||ids.has(id))throw Error('分支标识无效或重复');const title=label(name);if(names.has(title))throw Error('分支名称不能重复');ids.add(id);names.add(title);return{id,name:title}}
 const cases=raw.cases.map(rule=>{exact(rule,['id','name','field','operator','value']);const entry=take(rule.id,rule.name);if(!safe(rule.field)||rule.field.length>80||!OPERATORS.includes(rule.operator))throw Error('请选择有效的条件字段和比较方式');const unary=['empty','not_empty'].includes(rule.operator);if(!unary){if(['in','not_in'].includes(rule.operator)){if(!Array.isArray(rule.value)||!rule.value.length||rule.value.length>20||rule.value.some(v=>!scalar(v)))throw Error('集合条件需要1～20个简单值')}else if(!scalar(rule.value))throw Error('条件比较值需要文本、数字、布尔或null');if(['gt','gte','lt','lte'].includes(rule.operator)&&typeof rule.value!=='number')throw Error('大小比较需要有限数字')}
 return{...entry,field:rule.field,operator:rule.operator,...(!unary?{value:JSON.parse(JSON.stringify(rule.value))}:{})}})
 exact(raw.default,['id','name']);const fallback=take(raw.default.id,raw.default.name)
 return{version:1,cases,default:fallback}
}
function routes(node){const config=configuration(node.branch);return [...config.cases,config.default].map((entry,outputSlot)=>({id:entry.id,name:entry.name,outputSlot}))}
function selection(node,raw){
 if(!raw||Object.keys(raw).some(key=>!['id','name','outputSlot','default'].includes(key)))throw Error('条件分支选择事实无效')
 const entries=routes(node),entry=entries.find(item=>item.id===raw.id&&item.outputSlot===raw.outputSlot)
 if(!entry||raw.name!==entry.name||raw.default!==(entry.outputSlot===entries.length-1))throw Error('条件分支选择与定义不匹配')
 return{...entry,default:raw.default}
}
function edgeActive(step,edge){return!!step&&step.status==='succeeded'&&(!step.route||step.route.outputSlot===(edge.outputSlot||0))}
module.exports={OPERATORS,safe,configuration,routes,selection,edgeActive}
