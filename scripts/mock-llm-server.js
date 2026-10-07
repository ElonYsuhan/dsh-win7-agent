'use strict'

const http = require('http')

const not = (value) => value ? false : true
const PORT = Number(process.env.MOCK_LLM_PORT) || 11435

function sendJson(response, status, value) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  })
  response.end(body)
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => { body += chunk.toString('utf8') })
    request.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function writeSse(response, value) {
  response.write('data: ' + JSON.stringify(value) + '\n\n')
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    sendJson(response, 200, { ok: true, mock: true })
    return
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, { error: 'METHOD_NOT_ALLOWED' })
    return
  }
  let body
  try {
    body = await readBody(request)
  } catch (error) {
    sendJson(response, 400, { error: 'BAD_JSON' })
    return
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const hasToolResult = messages.some((message) => message.role === 'tool')
  const toolsEnabled = Array.isArray(body.tools) && body.tools.length > 0
  const wantsTool = toolsEnabled && not(hasToolResult)

  if (body.stream === true) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    if (wantsTool) {
      writeSse(response, {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: 'call_demo_1',
              type: 'function',
              function: {
                name: 'list_dir',
                arguments: JSON.stringify({ path: '.', depth: 1 })
              }
            }]
          },
          finish_reason: 'tool_calls'
        }]
      })
    } else {
      writeSse(response, {
        choices: [{
          delta: {
            content: '\u4f60\u597d\uff0c\u8fd9\u662f\u672c\u5730 mock \u6a21\u578b\u3002Agent \u670d\u52a1\u5df2\u7ecf\u8d77\u6765\uff0c\u5de5\u5177\u8c03\u7528\u94fe\u8def\u4e5f\u6b63\u5e38\u3002'
          },
          finish_reason: 'stop'
        }]
      })
    }
    response.write('data: [DONE]\n\n')
    response.end()
    return
  }

  if (wantsTool) {
    sendJson(response, 200, {
      choices: [{
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_demo_1',
            type: 'function',
            function: {
              name: 'list_dir',
              arguments: JSON.stringify({ path: '.', depth: 1 })
            }
          }]
        },
        finish_reason: 'tool_calls'
      }]
    })
    return
  }

  sendJson(response, 200, {
    choices: [{
      message: {
        role: 'assistant',
        content: '\u4f60\u597d\uff0c\u8fd9\u662f\u672c\u5730 mock \u6a21\u578b\u3002Agent \u670d\u52a1\u5df2\u7ecf\u8d77\u6765\uff0c\u5de5\u5177\u8c03\u7528\u94fe\u8def\u4e5f\u6b63\u5e38\u3002'
      },
      finish_reason: 'stop'
    }]
  })
})

server.listen(PORT, '127.0.0.1', () => {
  console.log('[mock-llm] listening on http://127.0.0.1:' + PORT + '/v1')
})
