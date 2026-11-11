'use strict'

/**
 * dsh.token-meter — 离线插件包（.plugin.pgk）
 *
 * 能力边界（如实声明，不夸大）：
 *   1. 本插件挂在 Cordis 的 `llm:request` waterfall 上，能看到**真实发出去的请求体**
 *      （系统提示词 + 全部历史 + 全部工具定义 + max_tokens），因此输入侧估算比
 *      渲染层那份「只算可见消息」的估算更接近真实 prompt。
 *   2. 本插件**看不到模型返回的 usage**：宿主 agent/llm.js 的 requestChat 只
 *      resolve { content, toolCalls }，SSE 里的 usage 帧没有被解析。所以本插件
 *      所有数字都是 `estimate`，不是计费数据，绝不冒充 provider 实测值。
 *   3. 本插件**不能注入前端 UI**（包规范明确：前端不加载包内 HTML/JS）。
 *      页脚 SVG 环 / 明细弹层需要宿主 renderer 改动，不在本包能力内；
 *      本包改为由工具返回 SVG，交给 render_ui 的 visual 组件渲染。
 *
 * 零生产依赖、零网络、零运行时下载；仅使用 Node 16.17.1 已有 API。
 */

// ---------------------------------------------------------------- 纯函数层

var CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\uAC00-\uD7AF]/
var IMAGE_TOKENS = 1000
var MAX_LEDGER = 200

function estimateText(value) {
  var text = String(value == null ? '' : value)
  if (text.length === 0) return 0
  var cjk = 0, ascii = 0, other = 0
  for (var i = 0; i < text.length; i += 1) {
    var code = text.charCodeAt(i)
    if (CJK_RE.test(text.charAt(i))) cjk += 1
    else if (code < 128) ascii += 1
    else other += 1
  }
  return Math.ceil(cjk + ascii / 4 + other / 2)
}

function estimateContent(content) {
  if (content == null) return 0
  if (typeof content === 'string') return estimateText(content)
  if (Array.isArray(content)) {
    var total = 0
    for (var i = 0; i < content.length; i += 1) {
      var part = content[i]
      if (!part || typeof part !== 'object') { total += estimateText(String(part)); continue }
      if (part.type === 'text' || part.type === 'input_text') total += estimateText(part.text)
      else if (part.type === 'image' || part.type === 'image_url' || part.type === 'input_image') total += IMAGE_TOKENS
      else total += estimateText(JSON.stringify(part).slice(0, 20000))
    }
    return total
  }
  return estimateText(JSON.stringify(content).slice(0, 20000))
}

function estimateMessage(message) {
  if (!message || typeof message !== 'object') return 0
  var total = 4 + estimateContent(message.content)
  if (Array.isArray(message.tool_calls)) {
    for (var i = 0; i < message.tool_calls.length; i += 1) {
      var call = message.tool_calls[i] || {}
      var fn = call.function || {}
      total += 8 + estimateText(fn.name) + estimateText(fn.arguments)
    }
  }
  return total
}

// 与宿主 context-compressor 同口径：基 3 + 每条消息 + 全部工具定义
function estimatePrompt(messages, tools) {
  var total = 3
  var list = Array.isArray(messages) ? messages : []
  for (var i = 0; i < list.length; i += 1) total += estimateMessage(list[i])
  var defs = Array.isArray(tools) ? tools : []
  for (var j = 0; j < defs.length; j += 1) {
    var fn = (defs[j] && defs[j].function) || {}
    total += 8 + estimateText(fn.name) + estimateText(fn.description) + estimateText(JSON.stringify(fn.parameters || {}))
  }
  return total
}

// 十分位定点，避免 99.7% 被四舍五入显示成 100%
function percentTenths(numerator, denominator) {
  var n = Number(numerator) || 0
  var d = Number(denominator) || 0
  if (d <= 0 || n < 0) return null
  return Math.min(1000, Math.floor((n * 1000) / d))
}

function formatPercent(tenths) {
  if (tenths === null || tenths === undefined) return '—'
  return (tenths / 10).toFixed(1) + '%'
}

function formatTokens(value) {
  var n = Number(value) || 0
  if (Math.abs(n) < 1000) return String(n)
  if (Math.abs(n) < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

function escapeXml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  })
}

/** 14px 页脚规格环：r=5.5、stroke=2、dasharray = C×pct/100、rotate(-90 7 7) */
function ringSvg(tenths, size) {
  var px = Number(size) || 14
  var c = 2 * Math.PI * 5.5
  var pct = tenths === null || tenths === undefined ? 0 : tenths / 10
  var dash = Math.max(0, Math.min(c, (c * pct) / 100))
  var color = tenths === null ? '#8a8f98' : pct >= 900 ? '#e5484d' : pct >= 750 ? '#f5a524' : '#30a46c'
  return '<svg viewBox="0 0 14 14" width="' + px + '" height="' + px + '">' +
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="#3a4048" stroke-width="2"/>' +
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="' + color + '" stroke-width="2" stroke-linecap="round"' +
    ' stroke-dasharray="' + dash.toFixed(3) + ' ' + (c - dash).toFixed(3) + '" transform="rotate(-90 7 7)"/>' +
    '</svg>'
}

/** 三段堆叠条：段宽 = 总宽 × 该项 / 三项和 */
function stackedBar(parts, width, height) {
  var w = Number(width) || 240
  var h = Number(height) || 10
  var total = 0
  for (var i = 0; i < parts.length; i += 1) total += Math.max(0, Number(parts[i].value) || 0)
  var x = 0
  var rects = ''
  for (var j = 0; j < parts.length; j += 1) {
    var value = Math.max(0, Number(parts[j].value) || 0)
    var seg = total > 0 ? (w * value) / total : 0
    if (seg > 0) {
      rects += '<rect x="' + x.toFixed(2) + '" y="0" width="' + seg.toFixed(2) + '" height="' + h +
        '" fill="' + parts[j].color + '"></rect>'
      x += seg
    }
  }
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '">' +
    '<rect x="0" y="0" width="' + w + '" height="' + h + '" rx="' + (h / 2) + '" fill="#2a2f36"></rect>' +
    rects + '</svg>'
}

function reportSvg(s) {
  var rows = [
    { label: '输入', value: s.lastPromptTokens, color: '#5b8def' },
    { label: '输出', value: s.completionTokens, color: '#30a46c' },
    { label: '预留', value: s.reservedTokens, color: '#a06cd5' }
  ]
  var legend = ''
  var swatch = ['#5b8def', '#30a46c', '#a06cd5']
  var labels = ['输入（本次请求）', '输出（含思考另计）', '预留 max_tokens']
  var values = [s.lastPromptTokens, s.completionTokens, s.reservedTokens]
  for (var i = 0; i < 3; i += 1) {
    var y = 118 + i * 20
    legend += '<rect x="104" y="' + (y - 9) + '" width="10" height="10" rx="2" fill="' + swatch[i] + '"></rect>' +
      '<text x="122" y="' + y + '" fill="#c8ced6" font-size="11">' + escapeXml(labels[i]) + '</text>' +
      '<text x="400" y="' + y + '" fill="#e8ebef" font-size="11" text-anchor="end">' + escapeXml(formatTokens(values[i])) + '</text>'
  }
  return '<svg viewBox="0 0 420 200" width="420" height="200" xmlns="http://www.w3.org/2000/svg"' +
    ' font-family="Segoe UI, Microsoft YaHei, sans-serif">' +
    '<rect x="0" y="0" width="420" height="200" rx="12" fill="#1c1f24" stroke="#2e343c"></rect>' +
    '<g transform="translate(22,30)">' + ringSvg(s.occupancyTenths, 64) + '</g>' +
    '<text x="104" y="46" fill="#e8ebef" font-size="16" font-weight="600">上下文占用 ' + escapeXml(formatPercent(s.occupancyTenths)) + '</text>' +
    '<text x="104" y="68" fill="#9aa3ae" font-size="11">' +
      escapeXml(formatTokens(s.lastPromptTokens)) + ' / ' +
      (s.contextWindow > 0 ? escapeXml(formatTokens(s.contextWindow)) : '未设置窗口') +
      ' · 估算值，非计费数据</text>' +
    '<g transform="translate(104,84)">' + stackedBar(rows, 296, 12) + '</g>' +
    legend +
    '<text x="22" y="186" fill="#8a929c" font-size="10">' +
      '请求 ' + s.requests + ' 次（失败 ' + s.failedRequests + '） · 思考 ' + escapeXml(formatTokens(s.thinkingTokens)) +
      ' · 单次最大输入 ' + escapeXml(formatTokens(s.maxPromptTokens)) +
      ' · 未解析到 provider usage</text>' +
    '</svg>'
}

// ---------------------------------------------------------------- 插件本体

module.exports = {
  name: 'dsh.token-meter',
  version: '1.0.0',
  description: '统计每次模型请求的 token 估算与上下文占用，提供报表工具与 SVG 可视化。',
  cordis: true,
  inject: ['tools'],

  apply: function (ctx) {
    var startedAt = new Date().toISOString()
    var ledger = []
    var totals = {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      thinkingTokens: 0,
      reservedTokens: 0,
      failedRequests: 0,
      maxPromptTokens: 0
    }

    function record(entry) {
      ledger.push(entry)
      if (ledger.length > MAX_LEDGER) ledger.shift()
      totals.requests += 1
      totals.promptTokens += entry.promptTokens
      totals.completionTokens += entry.completionTokens
      totals.thinkingTokens += entry.thinkingTokens
      totals.reservedTokens += entry.reservedTokens
      if (entry.failed) totals.failedRequests += 1
      if (entry.promptTokens > totals.maxPromptTokens) totals.maxPromptTokens = entry.promptTokens
      try { ctx.emit('token:usage', entry) } catch (error) { /* 订阅者失败不影响主链路 */ }
    }

    // 单一事实源：窗口取「被观测到的那次请求自身」的 contextWindowTokens，
    // 不读 agentConfig，避免插件内出现第二个口径。
    // 没有请求 / 该请求未带窗口 → occupancy 为 null，界面显示「—」而不是 0%。
    function summary() {
      var last = ledger.length ? ledger[ledger.length - 1] : null
      var contextWindow = last ? last.contextWindow : 0
      return {
        startedAt: startedAt,
        requests: totals.requests,
        failedRequests: totals.failedRequests,
        promptTokens: totals.promptTokens,
        completionTokens: totals.completionTokens,
        thinkingTokens: totals.thinkingTokens,
        reservedTokens: totals.reservedTokens,
        maxPromptTokens: totals.maxPromptTokens,
        lastPromptTokens: last ? last.promptTokens : 0,
        contextWindow: contextWindow,
        occupancyTenths: percentTenths(last ? last.promptTokens : 0, contextWindow),
        source: 'estimate'
      }
    }

    // 挂在真实请求出口：能看到系统提示词 + 全部历史 + 全部工具定义。
    ctx.effect(function () {
      return ctx.on('llm:request', function (request, next) {
        var started = Date.now()
        var outTokens = 0
        var thinkTokens = 0
        var original = request && typeof request.onDelta === 'function' ? request.onDelta : null
        if (request) {
          request.onDelta = function (delta) {
            try {
              if (delta && delta.type === 'content') outTokens += estimateText(delta.text)
              else if (delta && delta.type === 'thinking') thinkTokens += estimateText(delta.text)
            } catch (error) { /* 计量绝不干扰流式转发 */ }
            if (original) return original(delta)
            return undefined
          }
        }
        var settle = function (failed) {
          try {
            var settings = (request && request.settings) || {}
            record({
              at: new Date().toISOString(),
              model: String(settings.model || ''),
              promptTokens: estimatePrompt(request && request.messages, request && request.tools),
              completionTokens: outTokens,
              thinkingTokens: thinkTokens,
              reservedTokens: Math.max(0, Number(request && request.maxTokens) || Number(settings.maxTokens) || 0),
              contextWindow: Math.max(0, Number(settings.contextWindowTokens) || 0),
              tools: Array.isArray(request && request.tools) ? request.tools.length : 0,
              messages: Array.isArray(request && request.messages) ? request.messages.length : 0,
              latencyMs: Date.now() - started,
              failed: failed === true,
              source: 'estimate'
            })
          } catch (error) { /* 计量失败不能改变请求结果 */ }
        }
        try {
          var result = next()
          if (result && typeof result.then === 'function') {
            return result.then(
              function (value) { settle(false); return value },
              function (error) { settle(true); throw error }
            )
          }
          settle(false)
          return result
        } catch (error) {
          settle(true)
          throw error
        }
      })
    })

    ctx.effect(function () {
      return ctx.tools.register({
        name: 'token_meter_report',
        plugin: 'dsh.token-meter',
        permission: 'read',
        description: '查询本会话的 token 用量估算与上下文占用（估算值，非计费数据）。format 可选 text/json/svg。',
        parameters: {
          type: 'object',
          properties: {
            format: { type: 'string', enum: ['text', 'json', 'svg'], description: '输出格式，默认 text。' },
            recent: { type: 'integer', minimum: 0, maximum: 50, description: '附带最近 N 次请求明细，默认 0。' }
          }
        },
        execute: async function (args) {
          var format = (args && args.format) || 'text'
          var recent = Math.max(0, Math.min(50, Number(args && args.recent) || 0))
          var view = summary()
          if (format === 'svg') return reportSvg(view)
          if (format === 'json') return JSON.stringify({ summary: view, recent: ledger.slice(-recent) }, null, 2)
          var lines = [
            'token 用量（估算，非计费数据）',
            '  上下文占用：' + formatPercent(view.occupancyTenths) +
              '（最近一次请求 ' + formatTokens(view.lastPromptTokens) +
              (view.contextWindow > 0 ? ' / 窗口 ' + formatTokens(view.contextWindow) : ' / 未设置窗口') + '）',
            '  累计请求：' + view.requests + ' 次（失败 ' + view.failedRequests + '）',
            '  输入估算：' + formatTokens(view.promptTokens),
            '  输出估算：' + formatTokens(view.completionTokens) +
              '（含思考 ' + formatTokens(view.thinkingTokens) + '）',
            '  预留 max_tokens：' + formatTokens(view.reservedTokens),
            '  单次最大输入：' + formatTokens(view.maxPromptTokens),
            '  说明：宿主未解析模型返回的 usage 字段，缓存命中与实际计费无法给出。'
          ]
          if (recent > 0) {
            var tail = ledger.slice(-recent)
            lines.push('  最近 ' + tail.length + ' 次：')
            for (var i = 0; i < tail.length; i += 1) {
              var item = tail[i]
              lines.push('    ' + item.at + '  输入 ' + formatTokens(item.promptTokens) +
                '  输出 ' + formatTokens(item.completionTokens) +
                '  工具 ' + item.tools + '  ' + (item.failed ? '失败' : 'ok') +
                '  ' + item.latencyMs + 'ms  ' + item.model)
            }
          }
          return lines.join('\n')
        }
      })
    })

    ctx.effect(function () {
      return ctx.tools.register({
        name: 'token_meter_reset',
        plugin: 'dsh.token-meter',
        permission: 'read',
        description: '清空 token-meter 插件自身的统计（只清本插件内存，不动会话、文件与工作流）。',
        parameters: { type: 'object', properties: {} },
        execute: async function () {
          ledger.length = 0
          totals.requests = 0
          totals.promptTokens = 0
          totals.completionTokens = 0
          totals.thinkingTokens = 0
          totals.reservedTokens = 0
          totals.failedRequests = 0
          totals.maxPromptTokens = 0
          return 'token-meter 统计已清空'
        }
      })
    })
  }
}

// 纯函数导出，仅供测试与后续宿主复用。扩展加载器只读 name/version/apply，
// 多余属性无副作用（plugin-host.use 只取 name/apply/setup/cordis/inject）。
module.exports._internals = {
  estimateText: estimateText,
  estimateContent: estimateContent,
  estimateMessage: estimateMessage,
  estimatePrompt: estimatePrompt,
  percentTenths: percentTenths,
  formatPercent: formatPercent,
  formatTokens: formatTokens,
  ringSvg: ringSvg,
  stackedBar: stackedBar,
  reportSvg: reportSvg
}
