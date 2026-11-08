'use strict'

const SCOPES = Object.freeze(['user', 'project', 'session'])
const KINDS = Object.freeze(['fact', 'preference', 'profile', 'experience', 'inference'])
const STATUSES = Object.freeze(['active', 'disabled', 'superseded', 'deleted'])
const LIMITS = Object.freeze({ contentChars: 4000, keyChars: 80, scopeChars: 512, queryChars: 1000, results: 50, candidates: 200 })
const SENSITIVE = /(?:password|passwd|api[\s_-]*key|access[\s_-]*token|secret|private[\s_-]*key|密码|密钥|令牌|私钥|身份证|银行卡|信用卡|验证码)/i

function text(value, max, label, empty) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error('MEMORY_INVALID: ' + label)
  return value
}
function identifier(value, max, label) {
  if (typeof value !== 'string' || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw new Error('MEMORY_INVALID: ' + label)
  return value
}
function normalize(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, LIMITS.contentChars)
}
function terms(value) {
  const normalized = normalize(value)
  const out = normalized.match(/[a-z0-9_]+|[㐀-鿿]/g) || []
  const han = normalized.match(/[㐀-鿿]+/g) || []
  for (const part of han) for (let i = 0; i < part.length - 1; i++) out.push(part.slice(i, i + 2))
  return Array.from(new Set(out)).slice(0, 200)
}
function scope(value, scopeId) {
  if (!SCOPES.includes(value)) throw new Error('MEMORY_INVALID: scope')
  if (value !== 'user') identifier(scopeId, LIMITS.scopeChars, 'scopeId')
  return { scope: value, scopeId: value === 'user' ? '' : scopeId }
}
function input(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('MEMORY_INVALID: input')
  const allowed = ['scope', 'scopeId', 'kind', 'key', 'content', 'confidence', 'sourceType', 'sourceRef', 'quote', 'expiresAt', 'metadata']
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) throw new Error('MEMORY_INVALID: field ' + key)
  const target = scope(raw.scope || 'user', raw.scopeId || '')
  const kind = raw.kind || 'fact'
  if (!KINDS.includes(kind)) throw new Error('MEMORY_INVALID: kind')
  const content = text(raw.content, LIMITS.contentChars, 'content', false)
  if (SENSITIVE.test(content)) throw new Error('MEMORY_SENSITIVE: content is not stored automatically')
  const key = raw.key === undefined ? '' : text(raw.key, LIMITS.keyChars, 'key', true)
  const confidence = raw.confidence === undefined ? (kind === 'inference' ? 0.4 : 0.9) : Number(raw.confidence)
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('MEMORY_INVALID: confidence')
  const expiresAt = raw.expiresAt === undefined || raw.expiresAt === null ? null : Number(raw.expiresAt)
  if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new Error('MEMORY_INVALID: expiresAt')
  return {
    ...target, kind, key, content, normalized: normalize(content), confidence,
    sourceType: raw.sourceType || 'explicit', sourceRef: raw.sourceRef || '',
    quote: raw.quote === undefined ? '' : text(raw.quote, 2000, 'quote', true),
    expiresAt, metadata: raw.metadata && typeof raw.metadata === 'object' && !Array.isArray(raw.metadata) ? raw.metadata : {}
  }
}
function query(raw) {
  if (!raw || typeof raw !== 'object') return { query: '', limit: 8 }
  const value = raw.query === undefined ? '' : text(raw.query, LIMITS.queryChars, 'query', true)
  const limit = Math.max(1, Math.min(LIMITS.results, Number(raw.limit) || 8))
  return { query: value, limit }
}
function preferenceKey(content) {
  const value = normalize(content)
  if (/中文|英文|语言|chinese|english|language/.test(value)) return 'reply_language'
  if (/结论|细节|简洁|详细|回复|格式|风格|style|format/.test(value)) return 'response_style'
  if (/周报|日报|报告|文档|report|document/.test(value)) return 'report_style'
  if (/命名|代码|注释|code|naming|comment/.test(value)) return 'coding_style'
  if (/清单|步骤|流程|checklist|steps/.test(value)) return 'work_style'
  return 'preference'
}
function explicit(textValue) {
  const value = String(textValue || '').trim()
  if (!value || value.length > 4000) return []
  const found = []
  const patterns = [
    { kind: 'preference', re: /^(?:请)?记住[：:，,\s]*(?:我)?(?:更|偏)?(?:喜欢|偏好|习惯|希望)([^。！？!?]{2,500})/i },
    { kind: 'preference', re: /^我(?:更|偏)?(?:喜欢|偏好|习惯|通常|一般)([^。！？!?]{2,500})/i },
    { kind: 'preference', re: /^以后(?:请)?([^。！？!?]{2,500})/i },
    { kind: 'preference', re: /^i\s+(?:prefer|like|usually)\s+([^.!?]{2,500})/i },
    { kind: 'fact', re: /^(?:请)?记住[：:，,\s]*([^。！？!?]{2,500})/i },
    { kind: 'fact', re: /^我的([^。！？!?]{2,500})(?:是|为)([^。！？!?]{1,500})/i },
    { kind: 'fact', re: /^my\s+([^.!?]{1,120})\s+is\s+([^.!?]{1,500})/i }
  ]
  for (const item of patterns) {
    const match = item.re.exec(value)
    if (!match) continue
    const content = match[2] ? match[1] + '：' + match[2] : match[1]
    if (content.trim().length >= 2 && !SENSITIVE.test(content)) found.push({ kind: item.kind, content: content.trim() })
    if (found.length) break
  }
  return found
}
module.exports = { SCOPES, KINDS, STATUSES, LIMITS, SENSITIVE, text, identifier, normalize, terms, scope, input, query, preferenceKey, explicit }
