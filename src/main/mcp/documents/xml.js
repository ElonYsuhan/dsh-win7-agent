'use strict'

// Small non-resolving XML reader with source offsets. Untouched markup is retained.
// DTD/entities are forbidden. No XPath, external resource fetch or XML execution.
function escape(value) {
  const text = String(value)
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/.test(text)) throw new Error('INVALID_XML_CHARACTER')
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}
function decode(value) {
  if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(value)) throw new Error('UNSUPPORTED_XML_ENTITY')
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, key) => {
    const known = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
    if (known[key]) return known[key]
    const n = key[1] === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1))
    if (!(n === 9 || n === 10 || n === 13 || n >= 32 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) && n !== 0xfffe && n !== 0xffff)) throw new Error('INVALID_XML_CHARACTER')
    return String.fromCodePoint(n)
  })
}
function parse(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 16 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('UNSUPPORTED_XML')
  const root = { children: [], text: '' }, stack = [root]
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>|[^<]+/g
  let match, pos = 0, count = 0
  while ((match = tokens.exec(xml))) {
    if (match.index !== pos) throw new Error('INVALID_XML')
    const raw = match[0], parent = stack[stack.length - 1]; pos = tokens.lastIndex
    if (++count > 300000 || stack.length > 128) throw new Error('XML_COMPLEXITY_LIMIT')
    if (raw.startsWith('<!--') || raw.startsWith('<?')) continue
    if (raw.startsWith('<![CDATA[')) { parent.text += raw.slice(9, -3); continue }
    if (!raw.startsWith('<')) { parent.text += decode(raw); continue }
    if (raw.startsWith('</')) {
      const name = raw.slice(2, -1).trim(), node = stack.pop()
      if (stack.length === 0 || name !== node.name) throw new Error('INVALID_XML_CLOSE')
      node.closeStart = match.index; node.end = pos; continue
    }
    const tag = /^<([A-Za-z_][\w:.-]*)([\s\S]*?)(\/?)>$/.exec(raw)
    if (!tag) throw new Error('INVALID_XML_TAG')
    const attrs = Object.create(null); let rest = tag[2]
    while (rest.trim()) {
      const attr = /^\s+([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(rest)
      if (!attr || Object.prototype.hasOwnProperty.call(attrs, attr[1])) throw new Error('INVALID_XML_ATTRIBUTE')
      attrs[attr[1]] = decode(attr[2] === undefined ? attr[3] : attr[2]); rest = rest.slice(attr[0].length)
    }
    const ns = Object.assign(Object.create(null), parent.ns || {})
    for (const [key, value] of Object.entries(attrs)) if (key === 'xmlns') ns[''] = value; else if (key.startsWith('xmlns:')) ns[key.slice(6)] = value
    const parts = tag[1].split(':'), node = { name: tag[1], local: parts[parts.length - 1], uri: ns[parts.length === 2 ? parts[0] : ''] || '', ns, attrs, children: [], text: '', start: match.index, openEnd: pos, closeStart: pos, end: pos, selfClosing: !!tag[3] }
    parent.children.push(node); if (!tag[3]) stack.push(node)
  }
  if (pos !== xml.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) throw new Error('INVALID_XML_DOCUMENT')
  return root.children[0]
}
function descendants(node, local, uri) { const out = []; function walk(n) { for (const c of n.children) { if (c.local === local && (!uri || c.uri === uri)) out.push(c); walk(c) } } walk(node); return out }
function children(node, local) { return node.children.filter(c => c.local === local && c.uri === node.uri) }
function child(node, local) { return children(node, local)[0] }
function text(node) { return node ? node.text + node.children.map(text).join('') : '' }
function patch(xml, changes) { let last = xml.length; for (const c of changes.slice().sort((a,b) => b.start-a.start)) { if (c.end > last || c.start < 0) throw new Error('OVERLAPPING_XML_EDITS'); xml = xml.slice(0,c.start)+c.text+xml.slice(c.end); last=c.start } return xml }
module.exports = { escape, decode, parse, descendants, children, child, text, patch }
