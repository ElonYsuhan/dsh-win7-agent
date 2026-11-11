'use strict'

/**
 * 上下文占用分布估算（第二阶段）
 *
 * 供应商不回各部分占用，只能本地估算，因此结果整体 method='estimated'，
 * 与 provider 真实 token 严格分区存放，不混入真实统计。
 *
 * 分桶口径：
 *   systemTokens         —— role='system' 的消息（含插件拼接的系统提示）
 *   toolDefinitionTokens —— tools 数组 JSON 序列化后的估算 token
 *   conversationTokens  —— user / assistant / tool 消息
 *   memoryTokens         —— 独立可识别的记忆段（识别不了则 0，不猜）
 *   imageTokens          —— 图片段按 base64 长度折算（不保存图片数据本身）
 *
 * 隐私：只读长度，不缓存内容；调用方传入的 messages 不被本模块持有。
 */

const { estimateTextTokens, estimateContentTokens } = require('../agent/context-compressor')
const { DATA_CLASS } = require('./schema')

const not = (value) => value ? false : true

/** 图片段估算：base64 每 ~4 字符约 3 字节，视觉 token 粗略按 字节/4 计。
 *  这是粗估，仅用于展示占比，不能用于计费。 */
function estimateImagePartTokens(part) {
  if (not(part) || typeof part !== 'object') return 0
  let chars = 0
  if (typeof part.image_url === 'string') chars = part.image_url.length
  else if (part.image_url && typeof part.image_url.url === 'string') chars = part.image_url.url.length
  else if (typeof part.dataUrl === 'string') chars = part.dataUrl.length
  else if (typeof part.base64 === 'string') chars = part.base64.length
  if (chars === 0) return 0
  return Math.max(1, Math.floor((chars * 3) / 4 / 4))
}

function contentImageTokens(content) {
  if (not(content) || !Array.isArray(content)) return 0
  let total = 0
  for (const part of content) {
    if (part && (part.type === 'image' || part.type === 'image_url')) total += estimateImagePartTokens(part)
  }
  return total
}

/**
 * 计算一次请求的上下文分布。
 * @param {Array} messages  已组装的请求消息（buildRequestMessages 的产物）
 * @param {Array} tools     下发给模型的工具定义
 * @returns {object} 分布快照，method 恒为 'estimated'
 */
function measureContext(messages, tools) {
  const list = Array.isArray(messages) ? messages : []
  const toolList = Array.isArray(tools) ? tools : []

  let systemTokens = 0
  let conversationTokens = 0
  let imageTokens = 0
  let memoryTokens = 0

  for (const message of list) {
    if (not(message) || typeof message !== 'object') continue
    const base = estimateContentTokens(message.content)
    imageTokens += contentImageTokens(message.content)
    if (message.role === 'system') {
      /* 记忆段识别：本 Runtime 的记忆是拼进 systemContent 的一段，
         没有独立标记时无法可靠切分，按 0 计并在 notes 说明，不猜。 */
      systemTokens += base
    } else {
      conversationTokens += base
    }
  }

  const toolDefinitionTokens = toolList.length > 0
    ? estimateTextTokens(JSON.stringify(toolList))
    : 0

  const totalTokens = systemTokens + toolDefinitionTokens + conversationTokens + memoryTokens + imageTokens

  return {
    method: DATA_CLASS.ESTIMATED,
    totalTokens: totalTokens,
    systemTokens: systemTokens,
    toolDefinitionTokens: toolDefinitionTokens,
    conversationTokens: conversationTokens,
    memoryTokens: memoryTokens,
    imageTokens: imageTokens,
    messageCount: list.length,
    toolCount: toolList.length,
    /* 诚实声明：记忆段未独立标记，故 memoryTokens 恒 0，其内容已计入 systemTokens */
    notes: 'memoryTokens=0: 长期记忆拼入 system 段，无独立标记可切分'
  }
}

module.exports = { measureContext, estimateImagePartTokens }
