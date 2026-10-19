'use strict'
const readline=require('readline')
readline.createInterface({input:process.stdin}).on('line',line=>{
 let request;try{request=JSON.parse(line)}catch(_){return}
 if(request.id===undefined)return
 let result,error
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'example-local-echo',version:'1.0.0'}}
 else if(request.method==='tools/list')result={tools:[{name:'echo',description:'返回文本，验证离线 MCP。',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}
 else if(request.method==='tools/call'&&request.params.name==='echo')result={content:[{type:'text',text:String(request.params.arguments.text||'')}]}
 else error={code:-32601,message:'Method not found'}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,...(error?{error}:{result})})+'\n')
})
