'use strict'
// Deliberately bounded JSON Schema subset, shared by model results and forms.
const own=(o,k)=>Object.prototype.hasOwnProperty.call(o,k),object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)
const safe=k=>typeof k==='string'&&/^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k)&&!['constructor','prototype','__proto__'].includes(k)
function schema(raw,depth=0){
 if(raw===undefined||raw===null)return null
 if(!object(raw)||depth>4||!['object','array','string','number','integer','boolean'].includes(raw.type))throw Error('Schema 类型无效或嵌套超过4层')
 const allowed=['type','title','description','properties','required','additionalProperties','items','enum','minLength','maxLength','minimum','maximum','minItems','maxItems']
 if(Object.keys(raw).some(k=>!allowed.includes(k)))throw Error('Schema 包含暂不支持的关键字')
 const out={type:raw.type};for(const key of ['title','description'])if(raw[key]!==undefined){if(typeof raw[key]!=='string'||raw[key].length>500)throw Error('Schema 文案过长');out[key]=raw[key]}
 if(raw.enum!==undefined){if(!Array.isArray(raw.enum)||!raw.enum.length||raw.enum.length>32||raw.enum.some(v=>!['string','number','boolean'].includes(typeof v)||String(v).length>200))throw Error('Schema 枚举无效');out.enum=raw.enum.slice()}
 for(const key of ['minLength','maxLength','minItems','maxItems','minimum','maximum'])if(raw[key]!==undefined){if(!Number.isFinite(raw[key])||(!['minimum','maximum'].includes(key)&&(!Number.isInteger(raw[key])||raw[key]<0||raw[key]>(key.includes('Items')?100:16000))))throw Error('Schema 范围无效');out[key]=raw[key]}
 if(raw.type==='object'){if(raw.properties!==undefined&&!object(raw.properties))throw Error('Schema properties 无效');const props=raw.properties||{};if(Object.keys(props).length>24||Object.keys(props).some(k=>!safe(k)))throw Error('表单最多24个字段，字段名使用英文标识');if(Object.values(props).some(v=>!object(v)))throw Error('Schema 字段定义必须为对象');out.properties=Object.fromEntries(Object.entries(props).map(([k,v])=>[k,schema(v,depth+1)]));out.required=raw.required||[];if(!Array.isArray(out.required)||out.required.some(k=>!own(props,k))||new Set(out.required).size!==out.required.length)throw Error('Schema required 无效');if(raw.additionalProperties!==undefined&&typeof raw.additionalProperties!=='boolean')throw Error('Schema additionalProperties 仅支持布尔值');out.additionalProperties=raw.additionalProperties===true}
 if(raw.type==='array'){if(!raw.items)throw Error('数组需要定义 items');out.items=schema(raw.items,depth+1);if(out.maxItems===undefined)out.maxItems=100}
 return out
}
function validate(value,s,path='数据',depth=0){
 if(!s)return value
 if(depth>5)throw Error(path+' 嵌套过深')
 const fail=m=>{throw Error(path+'：'+m)}
 if(s.type==='object'){if(!object(value))fail('需要对象');for(const key of s.required||[])if(!own(value,key))fail('缺少 '+key);for(const [key,v]of Object.entries(value)){if(!own(s.properties||{},key)){if(!s.additionalProperties)fail('未声明字段 '+key)}else validate(v,s.properties[key],path+'.'+key,depth+1)}}
 else if(s.type==='array'){if(!Array.isArray(value))fail('需要数组');if(value.length<(s.minItems||0)||value.length>(s.maxItems===undefined?100:s.maxItems))fail('数组长度不符合要求');value.forEach((v,i)=>validate(v,s.items,path+'['+i+']',depth+1))}
 else if(s.type==='string'){if(typeof value!=='string')fail('需要文本');if(value.length<(s.minLength||0)||value.length>(s.maxLength===undefined?16000:s.maxLength))fail('文本长度不符合要求')}
 else if(s.type==='boolean'){if(typeof value!=='boolean')fail('需要布尔值')}
 else if(typeof value!=='number'||!Number.isFinite(value)||s.type==='integer'&&!Number.isInteger(value))fail('需要有效数字')
 if(s.minimum!==undefined&&value<s.minimum||s.maximum!==undefined&&value>s.maximum)fail('数值超出范围')
 if(s.enum&&!s.enum.includes(value))fail('不在允许选项中')
 if(JSON.stringify(value).length>64000)fail('结构化数据超过64000字')
 return value
}
function parse(text,s){if(!s)return null;const source=String(text).trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,'');let data;try{data=JSON.parse(source)}catch(_){throw Error('节点未返回有效 JSON，原始输出已保留，请检查后重试')}return validate(data,s,'节点输出')}
function pathValue(value,path){if(!path)return value;const keys=path.split('.');if(keys.length>5||keys.some(k=>!safe(k)))throw Error('字段映射路径无效');let out=value;for(const key of keys){if(!object(out)||!own(out,key))throw Error('上游结果缺少字段 '+path);out=out[key]}return out}
module.exports={schema,validate,parse,pathValue,safe}
