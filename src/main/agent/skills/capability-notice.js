'use strict'

/**
 * capability-notice —— 内置 skill
 *
 * 职责：模型把工具调用当正文打印（标记泄漏）时，
 *   1. 从正文里把调用块抢救成真实工具调用（交给 agent 正常走权限/禁用闸口）；
 *   2. 清理正文，避免原始标记污染聊天界面。
 * 下游效果：被禁插件的调用会被闸口拒绝并触发 capability:missing 弹窗，形成完整闭环。
 *
 * 已覆盖的泄漏格式（模型会轮换语法，逐家补齐）：
 *   A. DSML 风格：<|DSML|calls> <||DSML|invoke name="x"> <|DSML|parameter name="k" string="true">v<|DSML|parameter>
 *   B. XML 风格：<function_calls> <invoke name="x"> <parameter name="k">v</parameter> </invoke> </function_calls>
 */

const not = (value) => value ? false : true

/* —— A. DSML 家族（宽容版：开标签内可能夹模型输出的乱码） —— */
const DSML_CALLS_RE = /<\|DSML\|calls>([\s\S]*?)<\/\|DSML\|calls>/g
const DSML_INVOKE_RE = /<\|DSML\|[^>]*?invoke name="([^"]+)"[^>]*>([\s\S]*?)<\/\|DSML\|invoke>/g
const DSML_PARAM_RE = /<\|DSML\|[^>]*?parameter name="([^"]+)"([^>]*)>([\s\S]*?)<\|DSML\|parameter>/g

/* —— B. XML 家族 —— */
const XML_CALLS_RE = /<function_calls>([\s\S]*?)<\/function_calls>/g
const XML_INVOKE_RE = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/invoke>/g
const XML_PARAM_RE = /<parameter\s+name="([^"]+)"([^>]*)>([\s\S]*?)<\/parameter>/g

/* 触发词（agent 流式抑制也用这份清单） */
const LEAK_MARKERS = ['<|DSML|', '<function_calls>', '<invoke name=', '<parameter name=']

function hasLeakMarker(text) {
  const source = String(text || '')
  for (const marker of LEAK_MARKERS) {
    if (source.indexOf(marker) !== -1) return true
  }
  return false
}

/* 从一段 invoke 块文本里抽参数；isString 优先按标签属性，否则尝试 JSON */
function parseParams(blockBody, paramRe) {
  const args = {}
  let paramMatch
  paramRe.lastIndex = 0
  while ((paramMatch = paramRe.exec(blockBody)) !== null) {
    const key = paramMatch[1]
    if (not(key)) continue
    const isString = /string="true"/.test(paramMatch[2])
    const raw = paramMatch[3]
    if (isString) {
      args[key] = raw
    } else {
      try {
        args[key] = JSON.parse(raw)
      } catch (error) {
        args[key] = raw
      }
    }
  }
  return args
}

function collectInvokes(text, invokeRe, paramRe, family, calls) {
  let invokeMatch
  invokeRe.lastIndex = 0
  while ((invokeMatch = invokeRe.exec(text)) !== null) {
    const name = invokeMatch[1]
    if (not(name)) continue
    const args = parseParams(invokeMatch[2], paramRe)
    calls.push({
      id: 'call_' + family + '_' + Date.now().toString(36) + '_' + calls.length,
      type: 'function',
      function: { name: name, arguments: JSON.stringify(args) }
    })
  }
}

function parseLeakedCalls(text) {
  const calls = []
  let m
  /* A. DSML：calls 包裹或不包裹都收 */
  DSML_CALLS_RE.lastIndex = 0
  const dsmlBodies = []
  while ((m = DSML_CALLS_RE.exec(text)) !== null) dsmlBodies.push(m[1])
  const dsmlRest = dsmlBodies.length > 0 ? dsmlBodies.join('\n') : text
  collectInvokes(dsmlRest, DSML_INVOKE_RE, DSML_PARAM_RE, 'dsml', calls)
  /* B. XML：同上 */
  XML_CALLS_RE.lastIndex = 0
  const xmlBodies = []
  while ((m = XML_CALLS_RE.exec(text)) !== null) xmlBodies.push(m[1])
  const xmlRest = xmlBodies.length > 0 ? xmlBodies.join('\n') : text
  collectInvokes(xmlRest, XML_INVOKE_RE, XML_PARAM_RE, 'xml', calls)
  return calls
}

function stripLeakedBlocks(text) {
  return String(text || '')
    .replace(/<\|DSML\|calls>[\s\S]*?(<\/\|DSML\|calls>|$)/g, '')
    .replace(/<function_calls>[\s\S]*?(<\/function_calls>|$)/g, '')
    .replace(/<invoke\s+name="[^"]*"[^>]*>[\s\S]*?(<\/invoke>|$)/g, '')
    .replace(/^.*<\|DSML\|.*$/gm, '')
    .replace(/^.*<(\/?)(function_calls|invoke|parameter)\b.*$/gm, '')
    .replace(/<\|DSML\|[^>]*>/g, '')
    .replace(/<\/?(invoke|parameter)\b[^>]*>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

module.exports = {
  name: 'capability-notice',
  description: '抢救泄漏在正文里的工具调用（DSML/XML 两种家族），使其走正常闸口（禁用插件时触发弹窗提示）',
  hasLeakMarker,
  apply(ctx) {
    ctx.onAssistantContent((text) => {
      const source = String(text || '')
      if (not(hasLeakMarker(source))) return { text: source, recoveredCalls: [] }
      const recoveredCalls = parseLeakedCalls(source)
      const cleaned = stripLeakedBlocks(source)
      return { text: cleaned, recoveredCalls: recoveredCalls }
    })
  }
}
