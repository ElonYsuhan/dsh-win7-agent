'use strict'
const fs=require('fs'),path=require('path')
const {readZip}=require('../mcp/documents/zip'),O=require('../mcp/documents/ooxml'),X=require('../mcp/documents/xml')
const media={png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',bmp:'image/bmp',ico:'image/x-icon',svg:'image/svg+xml',pdf:'application/pdf',mp3:'audio/mpeg',wav:'audio/wav',ogg:'audio/ogg',m4a:'audio/mp4',mp4:'video/mp4',webm:'video/webm',mov:'video/quicktime'}
async function preview(target){
 const title=path.basename(target),ext=path.extname(target).slice(1).toLowerCase(),handle=await fs.promises.open(target,'r')
 let bytes,size
 try{const stat=await handle.stat();size=stat.size;if(!stat.isFile())throw Error('无法预览目录');if(size>24*1024*1024)return {title,size,kind:'unsupported',notice:'文件较大，请使用系统程序打开'};const buffer=Buffer.alloc(size+1);let offset=0;while(offset<buffer.length){const result=await handle.read(buffer,offset,buffer.length-offset,offset);if(!result.bytesRead)break;offset+=result.bytesRead}if(offset>size)throw Error('文件正在变化，请重试');bytes=buffer.subarray(0,offset)}finally{await handle.close()}
 if(media[ext])return {title,size,kind:ext==='pdf'?'pdf':media[ext].split('/')[0],mime:media[ext],bytes:bytes.toString('base64')}
 if(['docx','xlsx','pptx','odt','ods','odp'].includes(ext)){
  if(size>8*1024*1024)return {title,size,kind:'unsupported',notice:'Office 内容预览上限为 8 MB，请使用系统程序打开'}
  const files=readZip(bytes),parts=[]
  if(ext==='docx'){let start=0;do{const data=O.readWord(files,{start,limit:1000});parts.push(...data.paragraphs.map(p=>p.text));start=data.nextStart}while(start!==null&&parts.length<5000)}
  else if(ext==='xlsx'){const first=O.readSheet(files,{range:'A1:CV100'});for(const sheet of first.sheets.slice(0,10)){const data=O.readSheet(files,{sheet,range:'A1:CV100'});parts.push('工作表：'+sheet,...data.cells.filter(c=>c.value!==''&&c.value!==null).map(c=>c.cell+'  '+String(c.value)))}}
  else{const names=ext==='pptx'?Array.from(files.keys()).filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a,b)=>a.localeCompare(b,undefined,{numeric:true})):['content.xml'];for(const name of names.slice(0,100)){const raw=files.get(name);if(!raw)continue;const doc=X.parse(Buffer.isBuffer(raw)?raw.toString('utf8'):String(raw));parts.push(...X.descendants(doc,ext==='pptx'?'p':'p').map(X.text))}}
  return {title,size,kind:'office',text:parts.join('\n').slice(0,1000000),notice:ext==='xlsx'?'内容预览：前 10 个工作表 A1:CV100，公式显示缓存值':'内容预览，不保留原始排版；长文档可能截断'}
 }
 const utf16=bytes[0]===255&&bytes[1]===254||bytes[0]===254&&bytes[1]===255
 if(bytes.subarray(0,8192).includes(0)&&!utf16)return {title,size,kind:'unsupported',notice:'此格式暂不能内嵌预览，可使用系统程序打开'}
 if(size>2*1024*1024)return {title,size,kind:'unsupported',notice:'文本预览上限为 2 MB，请使用系统程序打开'}
 return {title,size,kind:ext==='md'||ext==='markdown'?'markdown':'text',bytes:bytes.toString('base64')}
}
module.exports={preview}
