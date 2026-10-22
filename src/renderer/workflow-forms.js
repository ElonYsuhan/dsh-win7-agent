'use strict'
;(function(){
 const element=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e}
 function field(schema,value,required,labelText,fieldKey){
  const label=element('label',labelText||schema.title||'字段');label.className='workflow-schema-field'
  let control,read
  if(schema.type==='object'){
   const entries=Object.entries(schema.properties||{});if(entries.length===1){const[key,child]=entries[0],title=labelText||schema.title||'表单';if(title===(child.title||key)){const row=field(child,value&&value[key],(schema.required||[]).includes(key),child.title||key,fieldKey?fieldKey+'.'+key:key);return{element:row.element,read:()=>{const value=row.read();return value===undefined?{}:{[key]:value}}}}}
   const group=element('fieldset'),legend=element('legend',labelText||schema.title||'表单');group.append(legend);const readers={}
   for(const [key,child]of Object.entries(schema.properties||{})){const row=field(child,value&&value[key],(schema.required||[]).includes(key),child.title||key,fieldKey?fieldKey+'.'+key:key);group.append(row.element);readers[key]=row.read}
   return{element:group,read:()=>{const data={};for(const [key,get]of Object.entries(readers)){const v=get();if(v!==undefined)data[key]=v}return data}}
  }
  if(schema.enum){control=element('select');if(!required){const empty=element('option','请选择');empty.value='';control.append(empty)}for(const option of schema.enum){const e=element('option',String(option));e.value=JSON.stringify(option);control.append(e)}if(value!==undefined)control.value=JSON.stringify(value);read=()=>control.value===''?undefined:JSON.parse(control.value)}
  else if(schema.type==='boolean'){control=element('select');for(const [v,t]of [['','请选择'],['true','是'],['false','否']]){const e=element('option',t);e.value=v;control.append(e)}if(value!==undefined)control.value=String(value);read=()=>control.value===''?undefined:control.value==='true'}
  else if(schema.type==='array'){control=element('textarea');control.rows=3;control.placeholder='填写 JSON 数组，例如 ["事项一","事项二"]';if(value!==undefined)control.value=JSON.stringify(value,null,2);read=()=>control.value.trim()?JSON.parse(control.value):required?[]:undefined}
  else if(['number','integer'].includes(schema.type)){control=element('input');control.type='number';control.step=schema.type==='integer'?'1':'any';if(schema.minimum!==undefined)control.min=schema.minimum;if(schema.maximum!==undefined)control.max=schema.maximum;if(value!==undefined)control.value=value;read=()=>control.value===''?undefined:Number(control.value)}
  else{control=element('textarea');control.rows=(schema.maxLength||16000)<=200?2:4;control.maxLength=schema.maxLength||16000;if(schema.minLength!==undefined)control.minLength=schema.minLength;if(value!==undefined)control.value=value;read=()=>!required&&!control.value?undefined:control.value}
  if(fieldKey)control.dataset.schemaField=fieldKey
  control.required=required;label.append(control);if(schema.description){const hint=element('small',schema.description);hint.className='muted';label.append(hint)}
  return{element:label,read}
 }
 window.workflowForms={render(host,schema,value,title){const result=field(schema,value,true,title||schema.title||'处理表单');host.append(result.element);return result.read}}
})()
