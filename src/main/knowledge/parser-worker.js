'use strict'
const {parentPort,workerData}=require('worker_threads'),fs=require('fs'),{TextDecoder}=require('util')
const {readZip}=require('../mcp/documents/zip'),ooxml=require('../mcp/documents/ooxml'),{LIMITS}=require('../contracts/knowledge'),policy=require('../flow/knowledge-policy')
try{
 const bytes=fs.readFileSync(workerData.file),format=workerData.format;if(require('crypto').createHash('sha256').update(bytes).digest('hex')!==workerData.hash)throw Error('KNOWLEDGE_OBJECT_CORRUPT');let parts=[]
 if(format==='txt'||format==='md'){let text;if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);else text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(text.includes('\0'))throw Error('KNOWLEDGE_TEXT_ENCODING');let heading='';text.split(/\r?\n/).forEach((line,index)=>{if(/^#{1,6}\s/.test(line))heading=line.replace(/^#+\s*/,'');if(line.trim())parts.push({text:line,locator:{line:index+1,heading}})})}
 else{const files=readZip(bytes);if(format==='docx'){let start=0;do{const data=ooxml.readWord(files,{start,limit:1000});parts.push(...data.paragraphs.filter(p=>p.text).map(p=>({text:p.text,locator:{paragraph:p.index}})));start=data.nextStart}while(start!==null&&parts.length<LIMITS.chunks*10);if(start!==null)throw Error('KNOWLEDGE_PARAGRAPH_LIMIT')}
 else if(format==='xlsx'){
  // Explicit v1 range; never claim cells beyond this range were indexed.
  const first=ooxml.readSheet(files,{range:'A1:CV100'});for(const sheet of first.sheets.slice(0,10)){const data=ooxml.readSheet(files,{sheet,range:'A1:CV100'});parts.push(...data.cells.filter(c=>c.value!==''&&c.value!==null).map(c=>({text:String(c.value),locator:{sheet,cell:c.cell,formulaCached:!!c.formula,indexedRange:'A1:CV100'}})))}
 }}
 if(parts.reduce((n,p)=>n+p.text.length,0)>LIMITS.textChars)throw Error('KNOWLEDGE_TEXT_LIMIT');const chunks=policy.chunks(parts);if(!chunks.length)throw Error('KNOWLEDGE_NO_TEXT');parentPort.postMessage({chunks,notice:format==='xlsx'?'仅索引前 10 个工作表 A1:CV100；公式使用缓存值':format==='docx'?'正文段落及表格文字；不包含页眉、页脚和真实页码':''})
}catch(error){parentPort.postMessage({error:error.message})}
