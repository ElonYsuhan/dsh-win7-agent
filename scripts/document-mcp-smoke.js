'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),{spawn}=require('child_process')
const {StdioClient}=require('../src/main/mcp/stdio-client')
const {PluginHost}=require('../src/main/plugins/plugin-host')
const {Settings}=require('../src/main/agent/settings')
const {TOOLS}=require('../src/main/contracts/document-tools')
const {readZip,writeZip}=require('../src/main/mcp/documents/zip')
const {serve}=require('../src/main/mcp/documents/server')
const {PassThrough}=require('stream')
let count=0
function ok(label,value){assert(value,label);count++;console.log('PASS '+label)}
async function protocol(root){
 const input=new PassThrough(),output=new PassThrough(),responses=[]
 output.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n'))responses.push(JSON.parse(line))})
 const service=serve(root,input,output)
 async function send(value){const n=responses.length,id=typeof value==='object'&&value&&!Array.isArray(value)?value.id:undefined;input.write(typeof value==='string'?value+'\n':JSON.stringify(value)+'\n');for(let i=0;i<(id===undefined?1:400);i++){if(responses.length>n)break;await new Promise(r=>setTimeout(r,5))}return responses[n]}
 ok('协议：初始化前拒绝工具发现',(await send({jsonrpc:'2.0',id:1,method:'tools/list'})).error.code===-32000)
 ok('协议：畸形 JSON 返回 parse error',(await send('{broken')).error.code===-32700)
 ok('协议：无效请求返回 invalid request',(await send([])).error.code===-32600)
 const init=await send({jsonrpc:'2.0',id:2,method:'initialize',params:{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'test',version:'1'}}})
 ok('协议：协商版本并只声明 tools',init.result.protocolVersion==='2025-06-18'&&Object.keys(init.result.capabilities).join()==='tools')
 const n=responses.length;await send({jsonrpc:'2.0',method:'notifications/initialized'});ok('协议：通知不发送响应',responses.length===n)
 ok('协议：六个工具有 schema 和 annotations',(await send({jsonrpc:'2.0',id:3,method:'tools/list'})).result.tools.every(t=>t.inputSchema&&t.annotations))
 ok('协议：未知方法与未知工具区分错误',(await send({jsonrpc:'2.0',id:4,method:'resources/list'})).error.code===-32601&&(await send({jsonrpc:'2.0',id:5,method:'tools/call',params:{name:'nope'}})).error.code===-32602)
 ok('协议：参数错误返回 -32602',(await send({jsonrpc:'2.0',id:6,method:'tools/call',params:{name:'docx_read',arguments:{}}})).error.code===-32602)
 ok('协议：文件错误是工具 isError',(await send({jsonrpc:'2.0',id:7,method:'tools/call',params:{name:'docx_read',arguments:{path:'missing.docx'}}})).result.isError)
 ok('协议：ping 可用',(await send({jsonrpc:'2.0',id:8,method:'ping'})).result)
 input.end();await service.close()
}
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'document-mcp-')),workspace=path.join(root,'workspace');fs.mkdirSync(workspace)
 const client=new StdioClient({command:process.execPath,args:[path.resolve(__dirname,'../src/main/mcp/documents/server.js'),'--root',workspace],env:{ELECTRON_RUN_AS_NODE:'1'},timeoutMs:5000},{shell:false})
 let host
 async function call(name,args){const result=await client.callTool(name,args);if(result.isError)throw new Error(result.content[0].text);return JSON.parse(result.content[0].text)}
 async function rejected(name,args,pattern){const r=await client.callTool(name,args);return r.isError&&pattern.test(r.content[0].text)}
 try{
  await protocol(workspace);await client.start()
  ok('真实 stdio 初始化发现六个工具',(await client.listTools()).length===6)
  await call('docx_create',{output:'原文.docx',paragraphs:[{text:'报告标题',heading:1},{text:'预算 & <增长> 中文 😀'}],tables:[[['项目','金额'],['收入','100']]]})
  const word=await call('docx_read',{path:'原文.docx'});ok('Word 中文、转义字符与表格读写',word.paragraphs[1].text==='预算 & <增长> 中文 😀'&&word.tables[0][1][0]==='收入')
  const before=fs.readFileSync(path.join(workspace,'原文.docx'))
  await call('docx_edit',{path:'原文.docx',output:'修订.docx',revision:word.revision,changes:[{index:1,text:'修订后的正文'},{index:5,text:'200'}]})
  const edited=await call('docx_read',{path:'修订.docx'});ok('Word 按索引编辑正文和表格，原件不变',edited.paragraphs[1].text==='修订后的正文'&&edited.tables[0][1][1]==='200'&&before.equals(fs.readFileSync(path.join(workspace,'原文.docx'))))
  ok('拒绝陈旧版本编辑',await rejected('docx_edit',{path:'原文.docx',output:'conflict.docx',revision:'stale',changes:[{index:0,text:'x'}]},/REVISION_CONFLICT/))
  ok('输出禁止覆盖现有文件',await rejected('docx_create',{output:'原文.docx',paragraphs:[{text:'overwrite'}]},/EEXIST/))
  ok('路径越界拒绝',await rejected('docx_read',{path:'../outside.docx'},/PATH_ESCAPE/))
  fs.mkdirSync(path.join(root,'outside'));fs.symlinkSync(path.join(root,'outside'),path.join(workspace,'link'),'dir')
  ok('符号链接逃逸拒绝',await rejected('docx_create',{output:'link/escape.docx',paragraphs:[{text:'x'}]},/PATH_ESCAPE/))
  await call('xlsx_create',{output:'账目.xlsx',sheets:[{name:'收入',cells:[{cell:'A1',value:'金额',bold:true},{cell:'B1',value:12.5,numberFormat:'number'},{cell:'C1',formula:'B1*2'},{cell:'A2',value:'=literal'},{cell:'B2',value:true}]},{name:'空表',cells:[]}]})
  const sheet=await call('xlsx_read',{path:'账目.xlsx',sheet:'收入',range:'A1:C3'})
  ok('Excel 工作表、数字、布尔、公式和样式',sheet.sheets.length===2&&sheet.cells.find(c=>c.cell==='B1').value===12.5&&sheet.cells.find(c=>c.cell==='C1').formula==='B1*2'&&sheet.cells.find(c=>c.cell==='A1').styleId===4&&sheet.cells.find(c=>c.cell==='A2').value==='=literal'&&sheet.cells.find(c=>c.cell==='B2').value===true)
  await call('xlsx_edit',{path:'账目.xlsx',output:'修订.xlsx',revision:sheet.revision,sheet:'收入',cells:[{cell:'B1',value:99},{cell:'D4',formula:'SUM(B1:B2)'},{cell:'A1',value:'总金额'}]})
  const excel=await call('xlsx_read',{path:'修订.xlsx',sheet:'收入',range:'A1:D5'})
  ok('Excel 修改/新增单元格并保留样式',excel.cells.find(c=>c.cell==='B1').value===99&&excel.cells.find(c=>c.cell==='A1').styleId===4&&excel.cells.find(c=>c.cell==='D4').formula==='SUM(B1:B2)')
  const external=readZip(fs.readFileSync(path.join(workspace,'账目.xlsx')))
  external.set('xl/sharedStrings.xml','<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><r><t>共享</t></r><r><t>文本</t></r></si></sst>')
  external.set('xl/worksheets/sheet1.xml','<s:worksheet xmlns:s="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><s:dimension ref="A1:B2"/><s:sheetData><s:row r="1" ht="22" customHeight="1"><s:c r="A1" t="s" s="4"><s:v>0</s:v></s:c><s:c r="B1" t="e"><s:v>#DIV/0!</s:v></s:c></s:row><s:row r="2"><s:c r="A2" t="inlineStr"><s:is><s:t>外部文本</s:t></s:is></s:c></s:row></s:sheetData></s:worksheet>')
  fs.writeFileSync(path.join(workspace,'external.xlsx'),writeZip(external))
  const imported=await call('xlsx_read',{path:'external.xlsx'})
  ok('读取外部共享富文本、替代命名空间与错误单元格',imported.cells[0].value==='共享文本'&&imported.cells[1].error==='#DIV/0!'&&imported.cells[2].value==='外部文本')
  await call('xlsx_edit',{path:'external.xlsx',output:'external-edited.xlsx',revision:imported.revision,sheet:'收入',cells:[{cell:'A1',value:'替换共享文本'},{cell:'B2',value:33}]})
  const externalEdited=await call('xlsx_read',{path:'external-edited.xlsx'})
  ok('编辑外部共享字符串单元格保留前缀、样式与行属性',externalEdited.cells[0].value==='替换共享文本'&&externalEdited.cells[0].styleId===4&&readZip(fs.readFileSync(path.join(workspace,'external-edited.xlsx'))).get('xl/worksheets/sheet1.xml').toString().includes('customHeight="1"'))
  const zip=readZip(fs.readFileSync(path.join(workspace,'账目.xlsx')));zip.set('customXml/item1.xml',Buffer.from('<retained/>'));fs.writeFileSync(path.join(workspace,'custom.xlsx'),writeZip(zip))
  const custom=await call('xlsx_read',{path:'custom.xlsx'});await call('xlsx_edit',{path:'custom.xlsx',output:'retained.xlsx',revision:custom.revision,sheet:'收入',cells:[{cell:'A1',value:'kept'}]})
  ok('未编辑的 OOXML 部件逐字节保留',readZip(fs.readFileSync(path.join(workspace,'retained.xlsx'))).get('customXml/item1.xml').toString()==='<retained/>')
  ok('范围和单元格上限',await rejected('xlsx_read',{path:'账目.xlsx',range:'A1:XFD1048576'},/RANGE_LIMIT/))
  zip.set('xl/worksheets/sheet1.xml',zip.get('xl/worksheets/sheet1.xml').toString().replace('</worksheet>','<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>'));fs.writeFileSync(path.join(workspace,'merged.xlsx'),writeZip(zip))
  const merged=await call('xlsx_read',{path:'merged.xlsx'});ok('拒绝破坏合并单元格',await rejected('xlsx_edit',{path:'merged.xlsx',output:'bad.xlsx',revision:merged.revision,sheet:'收入',cells:[{cell:'A1',value:'bad'}]},/MERGED_CELL/))
  const malicious=readZip(before);malicious.set('word/document.xml','<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x/>');fs.writeFileSync(path.join(workspace,'entity.docx'),writeZip(malicious));ok('DTD 与外部实体拒绝',await rejected('docx_read',{path:'entity.docx'},/UNSUPPORTED_XML/))
  const broken=Buffer.from(before);broken[40]^=255;fs.writeFileSync(path.join(workspace,'broken.docx'),broken);ok('损坏 ZIP 拒绝且不生成输出',await rejected('docx_read',{path:'broken.docx'},/ZIP|invalid|error|distance|code|block/i))
  const settings=new Settings(path.join(root,'home'));settings.update({workspacePath:workspace,permissionMode:'readonly'})
  host=new PluginHost({workspaceRoot:workspace,settings});await host.ready();await host.get('mcp').ready()
  const context={workspaceRoot:workspace,settings:settings.data,approve:async()=>{throw new Error('must not ask')}}
  const read=await host.executeTool('mcp__documents__docx_read',{path:'原文.docx'},context);ok('原生 Cordis 注册后经真实 MCP 读取',JSON.parse(read).paragraphs[0].text==='报告标题')
  const denied=await host.executeTool('mcp__documents__docx_create',{output:'denied.docx',paragraphs:[]},context);ok('只读权限在进程启动前阻止写入',denied.startsWith('DENIED:')&&!fs.existsSync(path.join(workspace,'denied.docx')))
  const other=path.join(root,'other');fs.mkdirSync(other);const writeContext={...context,workspaceRoot:other,settings:{permissionMode:'workspace'}}
  await host.executeTool('mcp__documents__docx_create',{output:'isolated.docx',paragraphs:[{text:'隔离'}]},writeContext)
  ok('按调用固定工作区，无共享 cwd 污染',fs.existsSync(path.join(other,'isolated.docx'))&&!fs.existsSync(path.join(workspace,'isolated.docx')))
  const controller=new AbortController();controller.abort();await assert.rejects(()=>host.executeTool('mcp__documents__docx_read',{path:'原文.docx'},{...context,signal:controller.signal}),/ABORTED/);ok('取消不会启动文件操作',true)
  settings.update({disabledBuiltinMcp:['documents']});await host.get('mcp').reload();ok('内置文档服务可停用且工具注销',!host.getToolDefinitions().some(t=>t.function.name.startsWith('mcp__documents__')))
  ok('临时文件完成后清理',!fs.readdirSync(workspace).some(n=>n.endsWith('.tmp')))
  console.log('Document MCP: '+count+' checks passed; '+process.version)
  if(process.env.DOCUMENT_MCP_FIXTURE_DIR){fs.mkdirSync(process.env.DOCUMENT_MCP_FIXTURE_DIR,{recursive:true});for(const n of ['原文.docx','修订.docx','账目.xlsx','修订.xlsx'])fs.copyFileSync(path.join(workspace,n),path.join(process.env.DOCUMENT_MCP_FIXTURE_DIR,n))}
 } finally {await client.close();if(host)await host.dispose();fs.rmSync(root,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
