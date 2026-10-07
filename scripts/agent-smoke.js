'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const { Agent } = require('../src/main/agent/agent')

async function main() {
  let calls = 0
  const bodies = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString() })
    request.on('end', () => {
      calls += 1
      try { bodies.push(JSON.parse(body)) } catch (error) { bodies.push(null) }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (calls === 1) {
        const first = {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_1',
                type: 'function',
                function: {
                  name: 'write_file',
                  arguments: JSON.stringify({ path: 'agent.txt', content: 'hello from agent' })
                }
              }]
            }
          }]
        }
        response.write('data: ' + JSON.stringify(first) + '\n\n')
        response.write('data: [DONE]\n\n')
      } else if (calls === 3) {
        /* 第二轮：让模型去取内置技能全文（内置 Markdown 技能通道） */
        const skillCall = {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call_2',
                type: 'function',
                function: {
                  name: 'load_skill',
                  arguments: JSON.stringify({ name: 'library' })
                }
              }]
            }
          }]
        }
        response.write('data: ' + JSON.stringify(skillCall) + '\n\n')
        response.write('data: [DONE]\n\n')
      } else {
        const second = { choices: [{ delta: { content: 'done' } }] }
        response.write('data: ' + JSON.stringify(second) + '\n\n')
        response.write('data: [DONE]\n\n')
      }
      response.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-agent-loop-'))
  const settings = {
    data: {
      baseURL: 'http://127.0.0.1:' + port + '/v1',
      apiKey: 'test',
      model: 'mock',
      temperature: 0,
      maxIterations: 5,
      approveWrites: false,
      approveCommands: false
    },
    update: () => undefined
  }
  const events = []
  const agent = new Agent(settings, (event) => events.push(event), async () => true, path.join(root, 'sessions'))
  agent.workspaceRoot = root
  await agent.run('create a file')
  /* 第二轮：验证内置技能通道 —— 系统提示里有清单、工具表里有 load_skill、结果真的回来了 */
  await agent.run('load the library skill')
  /* 第三轮：只发图片不写字（用户报过报错）—— 请求里必须只有图片段，不能塞空 text 段，
     严格一点的模型服务见到 {"type":"text","text":""} 会直接判 400。 */
  const imageOnlyUrl = 'data:image/png;base64,iVBORw0KGgo='
  await agent.run('', undefined, [imageOnlyUrl])
  server.close()
  const content = fs.readFileSync(path.join(root, 'agent.txt'), 'utf8')
  console.log('file content:', content)
  console.log('events:', events.map((event) => event.type).join(','))

  const firstBody = bodies[0] || { messages: [], tools: [] }
  const systemText = (firstBody.messages || [])
    .filter((message) => message && message.role === 'system')
    .map((message) => String(message.content || ''))
    .join('\n')
  const toolNames = (firstBody.tools || []).map((tool) => tool && tool.function ? tool.function.name : '')
  console.log('llm calls:', bodies.length, '| system chars:', systemText.length, '| tools:', toolNames.join(','))

  if (content !== 'hello from agent') throw new Error('unexpected file content')
  if (events.some((event) => event.type === 'error')) throw new Error('agent emitted an error')
  if (not(systemText.indexOf('Bundled skills') !== -1 && systemText.indexOf('01-app-builtin/library') !== -1)) {
    throw new Error('builtin skill index missing from system prompt sent to the model')
  }
  if (not(toolNames.includes('load_skill')) || not(toolNames.includes('search_skills'))) {
    throw new Error('skill tools not exposed to the model: ' + toolNames.join(','))
  }
  const skillResult = bodies
    .filter(Boolean)
    .map((body) => (body.messages || []).filter((message) => message && message.role === 'tool'))
    .reduce((all, list) => all.concat(list), [])
    .map((message) => String(message.content || ''))
    .filter((text) => text.indexOf('skill=01-app-builtin/library') !== -1)
  if (skillResult.length === 0) throw new Error('load_skill result never reached the model')
  console.log('skill tool result chars:', skillResult[0].length)

  /* 只发图片那次请求的 user content */
  const imageBody = bodies[bodies.length - 1] || { messages: [] }
  const imageUsers = (imageBody.messages || []).filter((message) => message && message.role === 'user')
  const lastUser = imageUsers[imageUsers.length - 1] || {}
  const imageParts = Array.isArray(lastUser.content) ? lastUser.content : []
  const imageCount = imageParts.filter((part) => part && part.type === 'image_url').length
  const emptyText = imageParts.some((part) => part && part.type === 'text' && String(part.text || '') === '')
  console.log('image-only user parts:', imageParts.map((part) => (part ? part.type : '?')).join(',') || '(none)')
  if (imageCount !== 1) throw new Error('image-only request lost the image part: ' + imageCount)
  if (emptyText) throw new Error('empty text part leaked into the image-only request')
  fs.rmSync(root, { recursive: true, force: true })
}

const not = (value) => value ? false : true

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
