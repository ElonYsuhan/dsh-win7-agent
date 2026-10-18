'use strict'
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),{preview}=require('../src/main/knowledge/file-preview'),{writeZip}=require('../src/main/mcp/documents/zip'),O=require('../src/main/mcp/documents/ooxml')
async function main(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'file-preview-'));try{
 async function test(name,bytes,kind,text){const file=path.join(dir,name);fs.writeFileSync(file,bytes);const value=await preview(file);assert.strictEqual(value.kind,kind,name);if(text)assert(value.text.includes(text));return value}
 await test('a.docx',writeZip(O.createWord({paragraphs:[{text:'办公文档'}]})),'office','办公文档')
 await test('a.pptx',writeZip(new Map([['ppt/slides/slide1.xml','<p:sld xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>幻灯片内容</a:t></a:r></a:p></p:sld>']])),'office','幻灯片内容')
 await test('a.odt',writeZip(new Map([['content.xml','<office xmlns:t="t"><t:p>开放文档</t:p></office>']])),'office','开放文档')
 for(const [name,kind] of [['a.png','image'],['a.pdf','pdf'],['a.mp3','audio'],['a.mp4','video'],['a.md','markdown'],['a.ts','text']])await test(name,Buffer.from('test'),kind)
 await test('a.exe',Buffer.from([77,90,0,0]),'unsupported')
 const big=path.join(dir,'big.mp4');fs.writeFileSync(big,'');fs.truncateSync(big,25*1024*1024);assert.strictEqual((await preview(big)).kind,'unsupported')
 console.log('File preview: Office/OpenDocument extraction, media routing, code/Markdown, binary and size fallbacks passed')
 }finally{fs.rmSync(dir,{recursive:true,force:true})}}
main().catch(e=>{console.error(e);process.exit(1)})
