'use strict'

;(function () {
  const not = (value) => value ? false : true


function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const LINK_PROTOCOL = /^https?:\/\//i
const IMAGE_PROTOCOL = /^(https?:\/\/|data:image\/|\/api\/assets\/)/i
const TRAILING_PUNCT = /[.,;:!?)\]}'"]+$/

/* 单趟替换：优先匹配 [文本](url)，否则匹配裸 URL。
   注意此时文本已被 escapeHtml，属性里的 & 已是 &amp;，浏览器会正常解码。 */
function renderLink(match, label, url) {
  const href = label !== undefined ? url : match
  if (not(LINK_PROTOCOL.test(href))) return match
  const text = label !== undefined ? label : match
  /* 裸 URL 去掉句尾标点，标点留在链接外 */
  if (label === undefined) {
    const trimmed = href.replace(TRAILING_PUNCT, '')
    const tail = href.slice(trimmed.length)
    return '<a href="' + trimmed + '" target="_blank" rel="noreferrer">' + trimmed + '</a>' + tail
  }
  return '<a href="' + href + '" target="_blank" rel="noreferrer">' + text + '</a>'
}

function renderInline(text) {
  const images = []
  const staged = String(text || '').replace(/!\[([^\]]*)\]\(([^\s)]+)\)/gi, (match, label, url) => {
    if (not(IMAGE_PROTOCOL.test(url))) return match
    const token = '@@DSH_IMAGE_' + images.length + '@@'
    images.push('<img class="md-image" src="' + url + '" alt="' + label + '" loading="lazy">')
    return token
  })
  let rendered = staged
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\bhttps?:\/\/[^\s<>"'`]+/gi, renderLink)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
  for (let index = 0; index < images.length; index += 1) {
    rendered = rendered.replace('@@DSH_IMAGE_' + index + '@@', images[index])
  }
  return rendered
}

function closeLists(state, output) {
  if (state.ul) {
    output.push('</ul>')
    state.ul = false
  }
  if (state.ol) {
    output.push('</ol>')
    state.ol = false
  }
}

function closeTable(state, output) {
  if (state.table) {
    output.push('</tbody></table>')
    state.table = false
  }
}

function closeAll(state, output) {
  closeLists(state, output)
  closeTable(state, output)
}

/* 表格：整行以 | 开头并以 | 结尾 */
function isTableRow(line) {
  return /^\s*\|.*\|\s*$/.test(line)
}

/* 分隔行：| --- | :---: | 这种，每个格子只含冒号和连字符 */
function isSepRow(line) {
  if (not(isTableRow(line))) return false
  const cells = splitRow(line)
  if (cells.length === 0) return false
  for (const cell of cells) {
    if (not(/^:?-+:?$/.test(cell))) return false
  }
  return true
}

function splitRow(line) {
  let text = line.trim()
  if (text.charAt(0) === '|') text = text.slice(1)
  if (text.charAt(text.length - 1) === '|') text = text.slice(0, -1)
  return text.split('|').map((cell) => cell.trim())
}

function renderMarkdown(input) {
  const escaped = escapeHtml(input)
  const lines = escaped.split('\n')
  const output = []
  const state = { ul: false, ol: false, code: false, table: false }
  const codeLines = []
  /* 围栏语言（```js）—— 挂在 <code data-lang> 上，交给 highlight.js 的 highlightAll 认。
     不挂语言也能高亮，只是会回退成 js 那套规则。 */
  let codeLang = ''

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed.startsWith('```')) {
      closeAll(state, output)
      if (state.code) {
        const attr = codeLang ? ' data-lang="' + codeLang + '"' : ''
        output.push('<pre><code' + attr + '>' + codeLines.join('\n') + '</code></pre>')
        codeLines.length = 0
        state.code = false
        codeLang = ''
      } else {
        state.code = true
        codeLang = trimmed.slice(3).trim().split(/\s+/)[0].replace(/[^\w#+.-]/g, '')
      }
      continue
    }
    if (state.code) {
      codeLines.push(line)
      continue
    }
    /* 表头：当前行是表格行且下一行是分隔行 */
    if (isTableRow(trimmed) && i + 1 < lines.length && isSepRow(lines[i + 1])) {
      closeAll(state, output)
      const head = splitRow(line)
      output.push('<table><thead><tr>' + head.map((cell) => '<th>' + renderInline(cell) + '</th>').join('') + '</tr></thead><tbody>')
      state.table = true
      i++ /* 跳过分隔行 */
      continue
    }
    if (state.table) {
      if (isTableRow(trimmed)) {
        output.push('<tr>' + splitRow(line).map((cell) => '<td>' + renderInline(cell) + '</td>').join('') + '</tr>')
      } else {
        closeTable(state, output)
        output.push('<div class="md-p">' + renderInline(line) + '</div>')
      }
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      closeAll(state, output)
      const level = heading[1].length
      output.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>')
      continue
    }
    const unordered = line.match(/^[-*]\s+(.*)$/)
    if (unordered) {
      if (not(state.ul)) {
        closeAll(state, output)
        output.push('<ul>')
        state.ul = true
      }
      output.push('<li>' + renderInline(unordered[1]) + '</li>')
      continue
    }
    const ordered = line.match(/^\d+\.\s+(.*)$/)
    if (ordered) {
      if (not(state.ol)) {
        closeAll(state, output)
        output.push('<ol>')
        state.ol = true
      }
      output.push('<li>' + renderInline(ordered[1]) + '</li>')
      continue
    }
    if (trimmed === '') {
      closeAll(state, output)
      output.push('<div class="md-gap"></div>')
      continue
    }
    closeAll(state, output)
    output.push('<div class="md-p">' + renderInline(line) + '</div>')
  }
  if (state.code) {
    output.push('<pre><code>' + codeLines.join('\n') + '</code></pre>')
  }
  closeAll(state, output)
  return output.join('')
}

  window.renderMarkdown = renderMarkdown
})()
