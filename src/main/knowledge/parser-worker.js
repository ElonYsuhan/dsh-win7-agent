'use strict'
const {parentPort,workerData}=require('worker_threads'),fs=require('fs'),{TextDecoder}=require('util')
const {readZip}=require('../mcp/documents/zip'),ooxml=require('../mcp/documents/ooxml'),{LIMITS}=require('../contracts/knowledge'),policy=require('../flow/knowledge-policy')
try{
 const bytes=fs.readFileSync(workerData.file),format=workerData.format;if(require('crypto').createHash('sha256').update(bytes).digest('hex')!==workerData.hash)throw Error('KNOWLEDGE_OBJECT_CORRUPT');let parts=[]
 if(!['docx','xlsx'].includes(format)){
  const binaryFormats=['pdf','png','jpg','jpeg','gif','webp','bmp','ico','svg','zip','7z','rar','tar','gz','bz2','xz','mp3','wav','ogg','m4a','mp4','webm','mov','exe','dll','so','dylib','sqlite','db','ppt','pptx','doc','xls','odt','ods','odp','blend','glb','fbx'];
  let text;try{if(binaryFormats.includes(format))throw Error('BINARY');if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder('utf-16le',{fatal:true}).decode(bytes);else text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text))throw Error('BINARY')}catch(_){parentPort.postMessage({chunks:[],notice:'已保存原件，未建立文本索引；可预览或下载原文件'});return}
  if(text.length>LIMITS.textChars){parentPort.postMessage({chunks:[],notice:'已保存原件；文本超过索引容量，未建立全文索引'});return}
  let heading='';text.split(/\r?\n/).forEach((line,index)=>{if(/^#{1,6}\s/.test(line))heading=line.replace(/^#+\s*/,'');if(line.trim())parts.push({text:line,locator:{line:index+1,heading}})})}
 else{const files=readZip(bytes);if(format==='docx'){let start=0;do{const data=ooxml.readWord(files,{start,limit:1000});parts.push(...data.paragraphs.filter(p=>p.text).map(p=>({text:p.text,locator:{paragraph:p.index}})));start=data.nextStart}while(start!==null&&parts.length<LIMITS.chunks*10);if(start!==null)throw Error('KNOWLEDGE_PARAGRAPH_LIMIT')}
 else if(format==='xlsx'){
  // Explicit v1 range; never claim cells beyond this range were indexed.
  const first=ooxml.readSheet(files,{range:'A1:CV100'});for(const sheet of first.sheets.slice(0,10)){const data=ooxml.readSheet(files,{sheet,range:'A1:CV100'});parts.push(...data.cells.filter(c=>c.value!==''&&c.value!==null).map(c=>({text:String(c.value),locator:{sheet,cell:c.cell,formulaCached:!!c.formula,indexedRange:'A1:CV100'}})))}
 }}
 if(parts.reduce((n,p)=>n+p.text.length,0)>LIMITS.textChars){parentPort.postMessage({chunks:[],notice:'已保存原件；文本超过索引容量，未建立全文索引'});return}
 let chunks;try{chunks=policy.chunks(parts)}catch(error){if(error.message!=='KNOWLEDGE_CHUNK_LIMIT')throw error;parentPort.postMessage({chunks:[],notice:'已保存原件；文本块超过索引容量，未建立全文索引'});return}
 if(!chunks.length){parentPort.postMessage({chunks:[],notice:'已保存原件；未检测到可检索文本'});return}parentPort.postMessage({chunks,notice:format==='xlsx'?'仅索引前 10 个工作表 A1:CV100；公式使用缓存值':format==='docx'?'正文段落及表格文字；不包含页眉、页脚和真实页码':''})
}catch(error){parentPort.postMessage({error:error.message})}
