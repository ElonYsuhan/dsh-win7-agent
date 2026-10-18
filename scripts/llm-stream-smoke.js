'use strict'

/**
 * 流式解码守卫：中文（以及任何多字节字符）不能变成 U+FFFD 黑菱形。
 *
 * 复现原理：Node 的 http 响应默认给 Buffer。代码里如果直接 `chunk.toString('utf8')`，
 * 一个 3 字节的汉字被 TCP 切成 [2 字节][1 字节] 时，会被解成两个 U+FFFD（两个黑菱形）。
 * 这里的假服务端**故意**把每个汉字拆成两次 write()，稳定复现这个 bug。
 *
 * 覆盖两条路径：OpenAI 兼容的 SSE（/v1/chat/completions）与 Ollama 原生 NDJSON（/api/chat）。
 */

const http = require('http')
const { requestChat } = require('../src/main/agent/llm.js')

const not = (value) => value ? false : true
let pass = 0
let fail = 0

function check(name, ok, extra) {
  if (ok) {
    pass += 1
    console.log('PASS  ' + name + (extra === undefined ? '' : '  [' + String(extra).slice(0, 120) + ']'))
  } else {
    fail += 1
    console.log('FAIL  ' + name + (extra === undefined ? '' : '  [' + String(extra).slice(0, 160) + ']'))
  }
}

const REPLY = '我看过了工作区里的本地轨道配置，先确认一下。'
const COMMAND_OUT = '命令输出：中文不该变成黑菱形。'

/* 把字符串按字节切开：每个多字节字符的前 n-1 字节一次写，剩下的另一次写。 */
function splitBytes(text) {
  const buf = Buffer.from(text, 'utf8')
  const out = []
  for (let i = 0; i < buf.length;) {
    const byte = buf[i]
    let size = 1
    if (byte >= 0xf0) size = 4
    else if (byte >= 0xe0) size = 3
    else if (byte >= 0xc0) size = 2
    // 故意切在字符中间：前 size-1 字节一次，余下再一次
    if (size > 1 && i + size - 1 < buf.length) {
      out.push(buf.slice(i, i + size - 1))
      out.push(buf.slice(i + size - 1, i + size))
      i += size
    } else {
      out.push(buf.slice(i, i + size))
      i += size
    }
  }
  return out
}

function startServer(mode) {
  return new Promise((resolve) => {
    const server = http.createServer((request, response) => {
      request.on('data', () => {})
      request.on('end', () => {
        response.writeHead(200, {
          'content-type': mode === 'ollama' ? 'application/x-ndjson' : 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive'
        })
        if (mode === 'ollama') {
          const payload = JSON.stringify({ message: { role: 'assistant', content: REPLY }, done: true }) + '\n'
          for (const piece of splitBytes(payload)) response.write(piece)
          response.end()
          return
        }
        const payload = 'data: ' + JSON.stringify({ choices: [{ delta: { content: REPLY } }] }) + '\n\n'
          + 'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n'
          + 'data: [DONE]\n\n'
        for (const piece of splitBytes(payload)) response.write(piece)
        response.end()
      })
    })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function runCase(mode, baseURL) {
  const { server, port } = await startServer(mode)
  try {
    let content = ''
    const result = await requestChat({
      settings: { baseURL: baseURL(port), model: 'mock', temperature: 0 },
      messages: [{ role: 'user', content: 'hi' }]
    })
    content = result.content || ''
    const bad = content.indexOf('\uFFFD')
    check(mode + '：多字节汉字被 TCP 切断也不产生 U+FFFD',
      bad === -1 && content === REPLY,
      bad === -1 ? 'ok=' + content : 'U+FFFD@' + bad + ' got=' + JSON.stringify(content))
  } catch (error) {
    check(mode + '：多字节汉字被 TCP 切断也不产生 U+FFFD', false, 'error: ' + error.message)
  } finally {
    server.close()
  }
}

/* 命令输出那条链路同样中招：子进程 stdout 默认是 Buffer，chunk 边界切开中文就是黑菱形。
   这里直接 spawn 一个「把每个汉字拆成两次 write」的小程序，走我们自己的解码。 */
function spawnChunkedCommand() {
  const { spawn } = require('child_process')
  const pieces = splitBytes(COMMAND_OUT)
  const script = 'const p=' + JSON.stringify(pieces.map((b) => b.toString('base64')))
    + ';for(const b of p){process.stdout.write(Buffer.from(b,"base64"))}'
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.setEncoding('utf8')
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk })
    child.on('exit', () => resolve(out))
  })
}

async function streamLifecycleCase(mode,large){
  let closed=false,interval=null
  const server=http.createServer((request,response)=>{request.resume();request.on('end',()=>{
    response.writeHead(200,{'content-type':mode==='ollama'?'application/x-ndjson':'text/event-stream'})
    response.on('close',()=>{closed=true;if(interval)clearInterval(interval)})
    if(large){const chunk='x'.repeat(65536);let count=0;const pump=()=>{while(!closed&&count++<600){if(!response.write(chunk)){response.once('drain',pump);return}}if(!closed)response.end()};pump();return}
    response.write(mode==='ollama'?JSON.stringify({message:{content:'done'},done:true})+'\n':'data: '+JSON.stringify({choices:[{delta:{content:'done'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
    interval=setInterval(()=>{if(!closed)response.write('data: '+JSON.stringify({choices:[{delta:{content:'unexpected'}}]})+'\n\n')},20)
  })})
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  try{
    let error=null,result
    try{result=await requestChat({settings:{baseURL:'http://127.0.0.1:'+server.address().port+(mode==='ollama'?'/11434':'/v1'),model:'mock'},messages:[{role:'user',content:'memory'}]})}catch(e){error=e}
    for(let i=0;i<50&&!closed;i++)await new Promise(r=>setTimeout(r,10))
    check(large?'异常大响应及时拒绝并断开连接':mode+'结束标记后主动断开，忽略后续数据',closed&&(large?error&&/LLM_RESPONSE_TOO_LARGE/.test(error.message):!error&&result.content==='done'))
  }finally{if(interval)clearInterval(interval);await new Promise(r=>server.close(r))}
}

async function main() {
  console.log('llm stream smoke, node ' + process.version)
  console.log('---')
  await runCase('openai', (port) => 'http://127.0.0.1:' + port + '/v1')
  /* isOllamaSettings 认URL 里带 11434；origin 取的是 host:port，所以路径里挂个 11434
     就能让它走 Ollama 原生分支，同时请求仍落到下面这个假服务端上。 */
  await runCase('ollama', (port) => 'http://127.0.0.1:' + port + '/11434')
  await streamLifecycleCase('openai',false)
  await streamLifecycleCase('ollama',false)
  await streamLifecycleCase('openai',true)
  const cmdOut = await spawnChunkedCommand()
  check('命令输出：中文被 chunk 切断也不产生 U+FFFD',
    cmdOut.indexOf('\uFFFD') === -1 && cmdOut === COMMAND_OUT,
    cmdOut.indexOf('\uFFFD') === -1 ? 'ok' : 'got=' + JSON.stringify(cmdOut))
  console.log('---')
  console.log('llm stream smoke: ' + pass + '/' + (pass + fail) + ' checks passed, node ' + process.version)
  if (fail > 0) process.exit(1)
}

main().catch((error) => {
  console.error('llm stream smoke: CRASHED ' + ((error && error.stack) || error))
  process.exit(1)
})