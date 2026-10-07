'use strict'

/**
 * 纯 JS 的 CDP（Chrome DevTools Protocol）客户端 —— 自验证能力的地基。
 *
 * 为什么不用 Playwright / puppeteer / chrome-remote-interface：
 *   - Win7 上能跑的 Chromium 上限就是 108（本产品随包的 Electron 22 就是 108），
 *     Playwright/puppeteer 捆绑的新 Chromium 在 Win7 起不来；
 *   - 全内网禁联网，禁止运行时下载浏览器；
 *   - dependencies 必须为空、禁原生模块。
 * 所以驱动方式 = 起一个带 --remote-debugging-port 的本产品 Electron，走 CDP。
 * CDP 只需要 HTTP（/json/list 发现目标）+ WebSocket（收发 JSON），本文件
 * 自带一个最小 WebSocket 客户端（RFC6455：客户端帧必须掩码、处理分帧与
 * ping/pong/close），整条链路零依赖。
 */

const http = require('http')
const crypto = require('crypto')

const not = (value) => value ? false : true

const MAX_FRAME_BYTES = 64 * 1024 * 1024 /* 截图/大 DOM 的单条消息上限 */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/**
 * 最小 WebSocket 客户端（只做 CDP 需要的那部分）。
 * events: 'open' | 'message'(string) | 'close' | 'error'(Error)
 */
class MiniWebSocket {
  constructor() {
    this.handlers = {}
    this.socket = null
    this.buffer = Buffer.alloc(0)
    this.handshakeDone = false
    this.closed = false
    this.fragments = null /* {opcode, chunks:[]} 跨帧分片重组 */
    this.expectedLength = 0 /* 服务端不掩码，长度可预知，方便校验 */
  }

  on(event, handler) {
    (this.handlers[event] = this.handlers[event] || []).push(handler)
  }

  emit(event, argument) {
    for (const handler of this.handlers[event] || []) {
      try { handler(argument) } catch (error) { /* 监听器异常不上抛 */ }
    }
  }

  connect(host, port, path, timeoutMs) {
    return new Promise((resolve, reject) => {
      const key = crypto.randomBytes(16).toString('base64')
      let settled = false
      const request = http.request({
        host: host,
        port: port,
        path: path,
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': key,
          'Sec-WebSocket-Version': '13'
        }
      })
      request.setTimeout(timeoutMs || 10000, () => {
        if (settled) return
        settled = true
        request.destroy(new Error('WEBSOCKET_TIMEOUT: handshake did not finish in ' + (timeoutMs || 10000) + 'ms'))
      })
      request.on('error', (error) => {
        if (settled) return
        settled = true
        reject(error)
      })
      request.on('response', (response) => {
        if (settled) return
        settled = true
        reject(new Error('WEBSOCKET_UPGRADE_FAILED: server answered HTTP ' + response.statusCode))
      })
      request.on('upgrade', (response, socket, head) => {
        const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
        if (response.headers['sec-websocket-accept'] !== accept) {
          socket.destroy()
          if (settled) return
          settled = true
          reject(new Error('WEBSOCKET_BAD_ACCEPT'))
          return
        }
        this.socket = socket
        this.buffer = Buffer.isBuffer(head) && head.length ? head : Buffer.alloc(0)
        socket.setNoDelay(true)
        socket.on('data', (chunk) => this.receive(chunk))
        socket.on('close', () => this.finishClose())
        socket.on('error', (error) => {
          this.emit('error', error)
          this.finishClose()
        })
        socket.on('end', () => this.finishClose())
        if (settled) return
        settled = true
        resolve(this)
      })
      request.end()
    })
  }

  finishClose() {
    if (this.closed) return
    this.closed = true
    this.emit('close')
  }

  /* ---- 发送（客户端帧必须掩码）---- */
  sendText(text) {
    this.sendFrame(1, Buffer.from(String(text), 'utf8'))
  }

  sendFrame(opcode, payload) {
    if (this.closed || not(this.socket)) return
    const length = payload.length
    const mask = crypto.randomBytes(4)
    let header
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, 0x80 | length])
    } else if (length < 65536) {
      header = Buffer.alloc(4)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 126
      header.writeUInt16BE(length, 2)
    } else {
      header = Buffer.alloc(10)
      header[0] = 0x80 | opcode
      header[1] = 0x80 | 127
      header.writeUInt32BE(0, 2)
      header.writeUInt32BE(length, 6)
    }
    const masked = Buffer.alloc(length)
    for (let index = 0; index < length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4]
    }
    try {
      this.socket.write(Buffer.concat([header, mask, masked]))
    } catch (error) { /* 写失败交给 error/close 事件 */ }
  }

  /* ---- 接收 ---- */
  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    while (true) {
      const frame = this.parseFrame()
      if (not(frame)) break
      if (frame.opcode === 9) { /* ping → pong */
        this.sendFrame(10, frame.payload)
        continue
      }
      if (frame.opcode === 8) { /* close → 回一个 close 再收摊 */
        this.sendFrame(8, frame.payload.slice(0, 2))
        this.socket.end()
        this.finishClose()
        continue
      }
      if (frame.opcode === 1 || frame.opcode === 2) {
        this.fragments = { opcode: frame.opcode, chunks: [frame.payload] }
      } else if (frame.opcode === 0) {
        if (this.fragments) this.fragments.chunks.push(frame.payload)
      }
      if (frame.fin && this.fragments) {
        const whole = Buffer.concat(this.fragments.chunks)
        const opcode = this.fragments.opcode
        this.fragments = null
        if (whole.length > MAX_FRAME_BYTES) continue
        if (opcode === 1) this.emit('message', whole.toString('utf8'))
      }
    }
    if (this.buffer.length > MAX_FRAME_BYTES) {
      this.buffer = Buffer.alloc(0) /* 不可能凑出合法帧，防内存膨胀 */
    }
  }

  parseFrame() {
    const buffer = this.buffer
    if (buffer.length < 2) return null
    const fin = (buffer[0] & 0x80) ? 1 : 0
    const opcode = buffer[0] & 0x0f
    const masked = (buffer[1] & 0x80) ? 1 : 0
    let length = buffer[1] & 0x7f
    let offset = 2
    if (length === 126) {
      if (buffer.length < offset + 2) return null
      length = buffer.readUInt16BE(offset)
      offset += 2
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null
      const high = buffer.readUInt32BE(offset)
      const low = buffer.readUInt32BE(offset + 4)
      if (high > 0) throw new Error('WEBSOCKET_FRAME_TOO_LARGE')
      length = low
      offset += 8
    }
    const maskKey = masked ? buffer.slice(offset, offset + 4) : null
    if (masked) offset += 4
    if (buffer.length < offset + length) return null
    const payload = Buffer.from(buffer.slice(offset, offset + length))
    if (maskKey) {
      for (let index = 0; index < length; index += 1) {
        payload[index] = payload[index] ^ maskKey[index % 4]
      }
    }
    this.buffer = buffer.slice(offset + length)
    return { fin: fin, opcode: opcode, payload: payload }
  }

  close() {
    if (this.closed) return
    this.sendFrame(8, Buffer.from([0x03, 0xe8]))
    if (this.socket) {
      try { this.socket.end() } catch (error) { /* 已断就算了 */ }
      setTimeout(() => {
        try { this.socket.destroy() } catch (error) { /* 同上 */ }
      }, 300).unref()
    }
    this.finishClose()
  }
}

/**
 * CDP 会话：method → {id,params}，响应按 id 配对；事件按 method 分发。
 */
class CdpSession {
  constructor(websocket) {
    this.websocket = websocket
    this.nextId = 1
    this.pending = new Map() /* id → {resolve, reject, timer} */
    this.listeners = {} /* method → [handler] */
    this.websocket.on('message', (text) => this.handleMessage(text))
    this.websocket.on('close', () => this.rejectAll(new Error('CDP_DISCONNECTED')))
    this.websocket.on('error', () => this.rejectAll(new Error('CDP_DISCONNECTED')))
  }

  on(method, handler) {
    (this.listeners[method] = this.listeners[method] || []).push(handler)
  }

  handleMessage(text) {
    let message
    try {
      message = JSON.parse(text)
    } catch (error) {
      return
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id)
      if (not(pending)) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (message.error) {
        pending.reject(new Error('CDP_ERROR: ' + message.error.message + (message.error.data ? ' (' + message.error.data + ')' : '')))
      } else {
        pending.resolve(message.result || {})
      }
      return
    }
    if (message.method) {
      for (const handler of this.listeners[message.method] || []) {
        try { handler(message.params || {}) } catch (error) { /* 事件监听器异常不上抛 */ }
      }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }

  send(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (this.websocket.closed) {
        reject(new Error('CDP_DISCONNECTED'))
        return
      }
      const id = this.nextId
      this.nextId += 1
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('CDP_TIMEOUT: ' + method + ' did not answer in ' + (timeoutMs || 30000) + 'ms'))
      }, timeoutMs || 30000)
      if (timer.unref) timer.unref()
      this.pending.set(id, { resolve: resolve, reject: reject, timer: timer })
      this.websocket.sendText(JSON.stringify({ id: id, method: method, params: params || {} }))
    })
  }
}

/** GET http://host:port/<path> → 解析 JSON（/json/list 目标发现用） */
function httpGetJson(host, port, requestPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: host, port: port, path: requestPath }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => {
        text += chunk
        if (text.length > 4 * 1024 * 1024) request.destroy(new Error('HTTP_BODY_TOO_LARGE'))
      })
      response.on('end', () => {
        try {
          resolve(JSON.parse(text))
        } catch (error) {
          reject(new Error('HTTP_BAD_JSON: ' + text.slice(0, 120)))
        }
      })
    })
    request.setTimeout(timeoutMs || 5000, () => {
      request.destroy(new Error('HTTP_TIMEOUT: ' + requestPath))
    })
    request.on('error', reject)
  })
}

module.exports = {
  MiniWebSocket,
  CdpSession,
  httpGetJson,
  MAX_FRAME_BYTES
}
