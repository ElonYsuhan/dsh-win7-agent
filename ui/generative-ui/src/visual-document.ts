// The model supplies untrusted static markup. The iframe is sandboxed without
// scripts or same-origin access; this sanitizer and the document CSP add
// defence in depth and prevent external resource or navigation requests.
const BLOCKED = new Set([
  'script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet',
  'link', 'base', 'meta', 'form', 'input', 'button', 'textarea', 'select',
  'option', 'optgroup', 'video', 'audio', 'source', 'track', 'template',
  'foreignobject', 'animate', 'animatetransform', 'set', 'a', 'area'
])
const DROP_ATTRIBUTES = new Set([
  'srcdoc', 'formaction', 'action', 'method', 'target', 'ping', 'poster',
  'data', 'codebase', 'archive', 'srcset', 'http-equiv'
])
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'src'])
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
function cleanStyle(value: string): string {
  return value.replace(/@import[\s\S]*?;/gi, '').replace(/expression\s*\(/gi, '').replace(/javascript\s*:/gi, '')
}
function safeUrl(value: string): boolean {
  const target = value.trim()
  return target.startsWith('#') || /^data:image\//i.test(target)
}
export function buildVisualDocument(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const styles: string[] = []
  for (const style of Array.from(doc.querySelectorAll('style'))) {
    styles.push(cleanStyle(style.textContent || ''))
    style.remove()
  }
  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    if (BLOCKED.has(element.tagName.toLowerCase())) { element.remove(); continue }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || DROP_ATTRIBUTES.has(name)) { element.removeAttribute(attribute.name); continue }
      if (URL_ATTRIBUTES.has(name) && !safeUrl(attribute.value)) { element.removeAttribute(attribute.name); continue }
      if (name === 'style') element.setAttribute(attribute.name, cleanStyle(attribute.value))
    }
  }
  const css = styles.join('\n')
  return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '"><style>'
    + 'html,body{margin:0;padding:0;background:#fff;color:#1f2328;font:14px/1.4 system-ui,sans-serif;}*,*::before,*::after{box-sizing:border-box}img,svg{display:block;max-width:100%;}'
    + '</style><style>' + css + '</style></head><body>' + doc.body.innerHTML + '</body></html>'
}
