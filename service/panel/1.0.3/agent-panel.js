/* AgentPanel 1.0.3 — 由 scripts/build-agent-panel.js 生成，请勿手改。 */
const __agentPanelRenderers = (function () {
  const markdown = (function () {
    const window = {}
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
  rendered = rendered.replace(/\[来源:([a-f0-9]{32})\]/g, '<button type="button" class="knowledge-citation" data-knowledge-source="$1">查看来源</button>')
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
  const state = { ul: false, ol: false, code: false, table: false, details: 0 }
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
    /* The model may emit plain <details>/<summary> wrappers around long tables.
       Recognize only exact, attribute-free tags after escaping; contents still
       go through the normal Markdown state machine and inline escaping. */
    const detailsOpen = /^&lt;details(\s+open)?\s*&gt;$/.exec(trimmed)
    if (detailsOpen) {
      closeAll(state, output)
      output.push('<details class="md-details"' + (detailsOpen[1] ? ' open' : '') + '>')
      state.details += 1
      continue
    }
    if (trimmed === '&lt;/details&gt;' && state.details > 0) {
      closeAll(state, output)
      output.push('</details>')
      state.details -= 1
      continue
    }
    const detailsSummary = /^&lt;summary&gt;(.*?)&lt;\/summary&gt;$/.exec(trimmed)
    if (detailsSummary && state.details > 0) {
      output.push('<summary>' + renderInline(detailsSummary[1]) + '</summary>')
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
    /* 引用块：连续的 &gt; 行合并成一块。renderMarkdown 是「先整体转义再分行」，
       走到这里时 > 已经变成 &gt;，所以匹配的是实体而不是字符本身。
       模型写新闻/资料类摘要几乎必用「> 说明」和「---」，缺了这两条就会把记号原样打在正文里。 */
    if (/^&gt;(?:\s|$)/.test(trimmed)) {
      closeAll(state, output)
      const quoted = []
      while (i < lines.length && /^&gt;(?:\s|$)/.test(lines[i].trim())) {
        quoted.push(renderInline(lines[i].trim().replace(/^&gt;\s?/, '')))
        i += 1
      }
      i -= 1
      output.push('<blockquote class="md-quote">' + quoted.join('<br>') + '</blockquote>')
      continue
    }
    /* 分隔线必须在列表之前判：`- - -` 会被 /^[-*]\s+/ 当成无序列表项吃掉。 */
    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed.replace(/\s+/g, ''))) {
      closeAll(state, output)
      output.push('<hr class="md-hr">')
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
  while (state.details > 0) { output.push('</details>'); state.details -= 1 }
  return output.join('')
}

  window.renderMarkdown = renderMarkdown
})()

    return window.renderMarkdown
  })()
  const highlight = (function () {
    const window = {}
'use strict'

/*
 * 语法高亮 —— **手写、零依赖**。
 *
 * 为什么不用现成的：项目的 dependencies 必须是空的（Win7 上不许有原生模块，也不联网），
 * CSP 又禁止内联脚本和外部资源，所以 highlight.js / Prism 这类库只能 vendor 进来。
 * vendor 一份上百 KB 的库、还得逐行处理它注释里的公网链接（会被离线守卫拦），
 * 不如自己写一个够用的词法器 —— 对「看代码」这件事它已经够了。
 *
 * 做法：每个语言族一组**有序**规则，合成一条大正则，一次扫描完成。
 *
 * 两条容易踩的坑（第一版就踩了）：
 *   ① **顺序即优先级**：注释 / 字符串必须排在关键字之前，否则 `// if (x)` 里的 if 会被当关键字。
 *   ② **不要用「第几个子组」判断命中了哪条规则**。只要某条规则自己带了捕获组，
 *      后面所有规则的子组下标就全错位了。这里一律用**命名组** `(?<r0>…)`，规则内部
 *      想只包住一部分就上 lookbehind（`(?<=…)` / `(?<!…)`），让 match[0] 本身就是该包的那段。
 *
 * 大小保护：超过 MAX_HIGHLIGHT_CHARS 只高亮前一段，剩下的原样输出（避免大文件卡住主线程）。
 */

;(function () {
  const MAX_HIGHLIGHT_CHARS = 200 * 1024

  const JS_KEYWORDS = 'break case catch class const continue debugger default delete do else export extends finally for function if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await as from get set satisfies'
  const JS_LITERALS = 'true false null undefined NaN Infinity arguments globalThis'
  const JS_TYPES = 'Array Object String Number Boolean Promise Symbol BigInt Map Set WeakMap WeakSet Date RegExp Error TypeError RangeError JSON Math Reflect Proxy Intl Buffer'

  const C_KEYWORDS = 'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof static struct switch typedef union volatile while class namespace template typename public private protected virtual override final new delete this using try catch throw operator friend constexpr noexcept nullptr export import module concept requires'
  const C_TYPES = 'int long short char float double void bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t string vector map set unordered_map shared_ptr unique_ptr istream ostream'

  const PY_KEYWORDS = 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case'
  const PY_LITERALS = 'True False None self cls NotImplemented Ellipsis'
  const PY_TYPES = 'int float str bytes bool list dict set tuple frozenset object type Exception ValueError TypeError KeyError IndexError print len range enumerate zip open isinstance super'

  const GO_KEYWORDS = 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'
  const GO_TYPES = 'bool byte complex64 complex128 error float32 float64 int8 int16 int32 int64 rune uint uint8 uint16 uint32 uint64 uintptr make new len cap append copy delete panic recover'

  const RS_KEYWORDS = 'as async await break const continue crate dyn else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while'
  const RS_TYPES = 'u8 u16 u32 u64 u128 usize i8 i16 i32 i64 i128 isize f32 f64 bool char str String Vec Option Result Box Rc Arc HashMap HashSet Some None Ok Err'

  const JAVA_KEYWORDS = 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto implements import instanceof int interface long native package private protected public short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield'
  const JAVA_TYPES = 'String Integer Long Double Float Boolean Character Object List Map Set ArrayList HashMap HashSet Optional Stream'

  const SHELL_KEYWORDS = 'if then else elif fi for while until do done case esac function return in export local readonly declare unset shift trap exit source eval set echo cd pwd ls cat grep sed awk cp mv rm mkdir rmdir touch chmod chown curl wget git npm node python pip'
  const SHELL_LITERALS = 'true false'

  const SQL_KEYWORDS = 'select from where group by having order limit offset insert into values update set delete create alter drop table index view join inner left right full outer on as and or not null is in between like distinct union all exists case when then else end primary key foreign references default unique constraint cascade begin commit rollback transaction truncate grant revoke'

  const CSS_AT = 'media supports keyframes font-face import charset page layer container property'

  /** 把一组词拼成 `\b(?:a|b|c)\b` */
  function words(list) {
    return '\\b(?:' + String(list).trim().split(/\s+/).join('|') + ')\\b'
  }

  /* 各语言族共用的片段 */
  const C_BLOCK_COMMENT = '\\/\\*[\\s\\S]*?\\*\\/'
  const C_LINE_COMMENT = '\\/\\/[^\\n]*'
  const HASH_COMMENT = '#[^\\n]*'
  const DASH_COMMENT = '--[^\\n]*'
  const ESCAPED_STRING = "'(?:\\\\.|[^\\\\'\\n])*'|\"(?:\\\\.|[^\\\\\"\\n])*\""
  const NUMBERISH = '\\b(?:0[xX][0-9a-fA-F][0-9a-fA-F_]*|0[bB][01][01_]*|0[oO][0-7][0-7_]*|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)(?:[uUlLfF]+)?\\b'

  /**
   * 语言族。每条 = { cls, re }；cls 是 CSS 类名后缀（hl-xxx）。
   * ⚠️ re 里**不许出现捕获组**（要用就上 lookbehind），否则命名组下标会乱。
   */
  const PROFILES = {
    /* ---------------- JavaScript / TypeScript / JSX ---------------- */
    js: [
      { cls: 'comment', re: C_BLOCK_COMMENT },
      { cls: 'comment', re: C_LINE_COMMENT },
      { cls: 'template', re: '`(?:\\\\[\\s\\S]|[^\\\\`])*`' },
      { cls: 'string', re: ESCAPED_STRING },
      { cls: 'number', re: NUMBERISH },
      { cls: 'keyword', re: words(JS_KEYWORDS) },
      { cls: 'literal', re: words(JS_LITERALS) },
      { cls: 'type', re: words(JS_TYPES) },
      { cls: 'function', re: '\\b[A-Za-z_$][\\w$]*(?=\\s*\\()' },
      { cls: 'property', re: '(?<=\\.)[A-Za-z_$][\\w$]*' },
      { cls: 'operator', re: '=>|\\.\\.\\.|[+\\-*/%=<>!&|^~?]+' },
      { cls: 'punct', re: '[{}[\\]();,.:]' }
    ],

    /* ---------------- HTML / Vue / Svelte / XML ---------------- */
    markup: [
      { cls: 'comment', re: '<!--[\\s\\S]*?-->' },
      { cls: 'doctype', re: '<!DOCTYPE[^>]*>' },
      { cls: 'tag', re: '</?[A-Za-z][\\w:.-]*' },
      { cls: 'interp', re: '\\{\\{[\\s\\S]*?\\}\\}' },
      { cls: 'string', re: '"[^"\\n]*"|\'[^\'\\n]*\'' },
      { cls: 'attr', re: '[A-Za-z_:@#][\\w:.-]*(?=\\s*=)' },
      { cls: 'punct', re: '[<>/=]' }
    ],

    /* ---------------- CSS / SCSS / LESS ---------------- */
    css: [
      { cls: 'comment', re: C_BLOCK_COMMENT },
      { cls: 'comment', re: C_LINE_COMMENT },
      { cls: 'keyword', re: '@(?:' + CSS_AT.split(' ').join('|') + ')\\b' },
      { cls: 'number', re: '#[0-9a-fA-F]{3,8}\\b' },
      { cls: 'string', re: '"[^"\\n]*"|\'[^\'\\n]*\'' },
      { cls: 'property', re: '(?<=[{;\\s])[-a-zA-Z][\\w-]*(?=\\s*:)' },
      { cls: 'selector', re: '[.#][-a-zA-Z_][\\w-]*' },
      { cls: 'interp', re: '#\\{[\\s\\S]*?\\}|@\\{[\\s\\S]*?\\}' },
      { cls: 'pseudo', re: '::?[a-zA-Z-]+' },
      { cls: 'number', re: '\\b\\d[\\d.]*(?:%|px|em|rem|vh|vw|vmin|vmax|ch|ex|pt|pc|cm|mm|in|s|ms|deg|rad|turn|fr|dpi)?\\b' },
      { cls: 'function', re: '\\b[a-zA-Z-]+(?=\\()' },
      { cls: 'punct', re: '[{};:,()]' }
    ],

    /* ---------------- Shell ---------------- */
    shell: [
      { cls: 'comment', re: HASH_COMMENT },
      { cls: 'string', re: '"(?:\\\\.|[^\\\\"\\n])*"|\'[^\'\\n]*\'' },
      { cls: 'variable', re: '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_][\\w]*|\\$[0-9@*?#$!]' },
      { cls: 'keyword', re: words(SHELL_KEYWORDS) },
      { cls: 'literal', re: words(SHELL_LITERALS) },
      { cls: 'option', re: '(?<![\\w-])-{1,2}[A-Za-z][\\w-]*' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'operator', re: '\\|\\||&&|[|&;><]+' },
      { cls: 'punct', re: '[{}()\\[\\]]' }
    ],

    powershell: [
      { cls: 'comment', re: '#[^\\n]*' },
      { cls: 'comment', re: '<#[\\s\\S]*?#>' },
      { cls: 'string', re: '"(?:\\\\.|[^\\\\"\\n])*"|\'[^\'\\n]*\'' },
      { cls: 'variable', re: '\\$[A-Za-z_][\\w:]*' },
      { cls: 'keyword', re: '\\b(?:function|param|if|else|elseif|foreach|for|while|do|until|switch|return|break|continue|try|catch|finally|throw|in|filter|process|begin|end|class|enum|using|Import-Module|Write-Host|Write-Output|Where-Object|ForEach-Object|Set-Location|New-Item|Remove-Item|Copy-Item|Move-Item|Test-Path)\\b' },
      { cls: 'option', re: '(?<![\\w-])-[A-Za-z][\\w-]*' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'operator', re: '\\|\\||&&|[|&><=+-]+' },
      { cls: 'punct', re: '[{}()\\[\\]]' }
    ],

    batch: [
      { cls: 'comment', re: '^\\s*(?:rem\\b.*|::.*)$', flags: 'im' },
      { cls: 'keyword', re: '\\b(?:echo|set|if|else|for|goto|call|exit|cd|dir|copy|move|del|mkdir|rmdir|type|find|findstr|start|pause|shift|pushd|popd|endlocal|setlocal|errorlevel|exist|defined|not)\\b', flags: 'i' },
      { cls: 'variable', re: '%[A-Za-z_~][\\w~,:-]*%|%%?[0-9*]' },
      { cls: 'string', re: '"[^"\\n]*"' },
      { cls: 'option', re: '(?<![\\w/])/[A-Za-z][\\w-]*' },
      { cls: 'punct', re: '[():&|><=]' }
    ],

    /* ---------------- Python / Ruby / Perl / Lua ---------------- */
    python: [
      { cls: 'comment', re: HASH_COMMENT },
      { cls: 'string', re: '[rRbBuUfF]{0,2}"""[\\s\\S]*?"""|[rRbBuUfF]{0,2}\'\'\'[\\s\\S]*?\'\'\'' },
      { cls: 'string', re: '[rRbBuUfF]{0,2}\'(?:\\\\.|[^\\\\\'\\n])*\'|[rRbBuUfF]{0,2}"(?:\\\\.|[^\\\\"\\n])*"' },
      { cls: 'decorator', re: '@[\\w.]+' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'keyword', re: words(PY_KEYWORDS) },
      { cls: 'literal', re: words(PY_LITERALS) },
      { cls: 'type', re: words(PY_TYPES) },
      { cls: 'function', re: '\\b[A-Za-z_][\\w]*(?=\\s*\\()' },
      { cls: 'property', re: '(?<=\\.)[A-Za-z_][\\w]*' },
      { cls: 'operator', re: '[+\\-*/%=<>!&|^~@]+' },
      { cls: 'punct', re: '[{}[\\]();,.:]' }
    ],

    /* ---------------- C 家族 / Go / Rust / Java / C# / Swift / PHP ---------------- */
    c: [
      { cls: 'comment', re: C_BLOCK_COMMENT },
      { cls: 'comment', re: C_LINE_COMMENT },
      { cls: 'string', re: ESCAPED_STRING },
      { cls: 'preproc', re: '^\\s*#\\s*[a-zA-Z]+', flags: 'm' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'keyword', re: words(C_KEYWORDS + ' ' + GO_KEYWORDS + ' ' + RS_KEYWORDS + ' ' + JAVA_KEYWORDS) },
      { cls: 'literal', re: '\\b(?:true|false|nullptr|NULL|nil|iota|this|self)\\b' },
      { cls: 'type', re: words(C_TYPES + ' ' + GO_TYPES + ' ' + RS_TYPES + ' ' + JAVA_TYPES) },
      { cls: 'function', re: '\\b[A-Za-z_][\\w]*(?=\\s*\\()' },
      { cls: 'property', re: '(?<=\\.)[A-Za-z_][\\w]*' },
      { cls: 'operator', re: '->|::|=>|[+\\-*/%=<>!&|^~?]+' },
      { cls: 'punct', re: '[{}[\\]();,.:]' }
    ],

    /* ---------------- 结构化数据 ---------------- */
    json: [
      { cls: 'key', re: '"(?:\\\\.|[^\\\\"\\n])*"(?=\\s*:)' },
      { cls: 'string', re: '"(?:\\\\.|[^\\\\"\\n])*"' },
      { cls: 'number', re: '-?\\b\\d[\\d.]*(?:[eE][+-]?\\d+)?\\b' },
      { cls: 'literal', re: '\\b(?:true|false|null)\\b' },
      { cls: 'punct', re: '[{}[\\],:]' }
    ],
    yaml: [
      { cls: 'comment', re: HASH_COMMENT },
      { cls: 'key', re: '^[ \\t-]*[A-Za-z_][\\w.-]*(?=\\s*:)', flags: 'm' },
      { cls: 'string', re: '"(?:\\\\.|[^\\\\"\\n])*"|\'[^\'\\n]*\'' },
      { cls: 'literal', re: '\\b(?:true|false|null|yes|no|on|off|~)\\b' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'punct', re: '(?<=^[ \\t]*)-(?=\\s)|[:|>&*!?]', flags: 'm' }
    ],
    toml: [
      { cls: 'comment', re: HASH_COMMENT },
      { cls: 'keyword', re: '^\\s*\\[\\[?[^\\]\\n]*\\]\\]?', flags: 'm' },
      { cls: 'key', re: '^[ \\t]*[A-Za-z_][\\w.-]*(?=\\s*=)', flags: 'm' },
      { cls: 'string', re: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|"(?:\\\\.|[^\\\\"\\n])*"|\'[^\'\\n]*\'' },
      { cls: 'literal', re: '\\b(?:true|false)\\b' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'punct', re: '[=\\[\\]{},.]' }
    ],
    ini: [
      { cls: 'comment', re: '[#;][^\\n]*' },
      { cls: 'keyword', re: '^\\s*\\[[^\\]\\n]*\\]', flags: 'm' },
      { cls: 'key', re: '^[ \\t]*[A-Za-z_][\\w.-]*(?=\\s*[=:])', flags: 'm' },
      { cls: 'string', re: '"(?:\\\\.|[^\\\\"\\n])*"|\'[^\'\\n]*\'' },
      { cls: 'literal', re: '\\b(?:true|false|null|yes|no)\\b', flags: 'i' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'punct', re: '[=:]' }
    ],

    /* ---------------- SQL ---------------- */
    sql: [
      { cls: 'comment', re: DASH_COMMENT },
      { cls: 'comment', re: C_BLOCK_COMMENT },
      { cls: 'string', re: '\'(?:\'\'|[^\'\\n])*\'' },
      { cls: 'keyword', re: words(SQL_KEYWORDS), flags: 'i' },
      { cls: 'literal', re: '\\b(?:true|false|null)\\b', flags: 'i' },
      { cls: 'number', re: NUMBERISH },
      { cls: 'operator', re: '[+\\-*/%=<>!]+' },
      { cls: 'punct', re: '[(),;.*]' }
    ],

    /* ---------------- diff / patch ---------------- */
    diff: [
      { cls: 'tag', re: '^(?:diff|index|new file|deleted file|similarity|rename)[^\\n]*', flags: 'm' },
      { cls: 'keyword', re: '^@@[^\\n]*', flags: 'm' },
      { cls: 'insert', re: '^\\+[^\\n]*', flags: 'm' },
      { cls: 'delete', re: '^-[^\\n]*', flags: 'm' }
    ]
  }

  /** 扩展名 / 语言名 → 族名 */
  const PROFILE_BY_NAME = {
    js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js', javascript: 'js', typescript: 'js',
    html: 'markup', htm: 'markup', xhtml: 'markup', xml: 'markup', svg: 'markup', vue: 'markup', svelte: 'markup', astro: 'markup',
    css: 'css', scss: 'css', sass: 'css', less: 'css', styl: 'css', stylus: 'css',
    sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', shell: 'shell',
    ps1: 'powershell', psm1: 'powershell', powershell: 'powershell',
    bat: 'batch', cmd: 'batch',
    py: 'python', pyw: 'python', python: 'python', rb: 'python', ruby: 'python', pl: 'python', perl: 'python', lua: 'python',
    c: 'c', h: 'c', cc: 'c', cpp: 'c', cxx: 'c', hpp: 'c', hh: 'c', cs: 'c',
    go: 'c', rs: 'c', java: 'c', kt: 'c', kts: 'c', scala: 'c', swift: 'c', dart: 'c', php: 'c', m: 'c', mm: 'c',
    json: 'json', jsonc: 'json', json5: 'json', webmanifest: 'json', map: 'json',
    yml: 'yaml', yaml: 'yaml',
    toml: 'toml',
    ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini', editorconfig: 'ini', gitignore: 'ini', gitattributes: 'ini', npmrc: 'ini',
    sql: 'sql',
    diff: 'diff', patch: 'diff'
  }

  /* ------------------------------------------------------------ 编译 */

  const compiled = {}

  /** 把一组规则编成一条大正则：每条规则包一层**命名组** `(?<rN>…)` */
  function compile(profileName) {
    if (compiled[profileName]) return compiled[profileName]
    const name = PROFILES[profileName] ? profileName : 'js'
    const rules = PROFILES[name]
    const sources = rules.map((rule, index) => '(?<r' + index + '>' + rule.re + ')')
    let flags = 'g'
    if (rules.some((rule) => rule.flags && rule.flags.indexOf('i') >= 0)) flags += 'i'
    if (rules.some((rule) => rule.flags && rule.flags.indexOf('m') >= 0)) flags += 'm'
    compiled[profileName] = {
      regex: new RegExp(sources.join('|'), flags),
      classes: rules.map((rule) => rule.cls),
      count: rules.length
    }
    return compiled[profileName]
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
  }

  /**
   * 高亮一段源码，返回**已转义**的 HTML（可直接 innerHTML）。
   * @param {string} code 源码
   * @param {string} language 扩展名或语言名（'js' / '.ts' / 'python'），认不出来按 js
   */
  function highlightCode(code, language) {
    const text = String(code === null || code === undefined ? '' : code)
    const key = String(language || '').toLowerCase().replace(/^\./, '')
    const profileName = PROFILE_BY_NAME[key] || 'js'

    if (text.length > MAX_HIGHLIGHT_CHARS) {
      return highlightCode(text.slice(0, MAX_HIGHLIGHT_CHARS), profileName) + escapeHtml(text.slice(MAX_HIGHLIGHT_CHARS))
    }

    const profile = compile(profileName)
    const out = []
    let last = 0
    let match
    profile.regex.lastIndex = 0

    while ((match = profile.regex.exec(text)) !== null) {
      if (match.index > last) out.push(escapeHtml(text.slice(last, match.index)))
      let hit = -1
      for (let index = 0; index < profile.count; index += 1) {
        if (match.groups['r' + index] !== undefined) { hit = index; break }
      }
      const raw = match[0]
      if (hit < 0) {
        out.push(escapeHtml(raw))
      } else {
        out.push('<span class="hl-' + profile.classes[hit] + '">' + escapeHtml(raw) + '</span>')
      }
      last = match.index + raw.length
      if (raw.length === 0) profile.regex.lastIndex += 1
    }
    if (last < text.length) out.push(escapeHtml(text.slice(last)))
    return out.join('')
  }

  /** 语言名 → 族名（渲染层显示用） */
  function profileFor(language) {
    const key = String(language || '').toLowerCase().replace(/^\./, '')
    return PROFILE_BY_NAME[key] || 'js'
  }

  /** 把 root 下所有 <pre><code> 就地高亮（markdown 预览用）。textContent 拿到的已是解码后的原文。 */
  function highlightAll(root) {
    if (!root || !root.querySelectorAll) return 0
    const blocks = root.querySelectorAll('pre > code')
    let count = 0
    for (let index = 0; index < blocks.length; index += 1) {
      const node = blocks[index]
      if (node.getAttribute('data-highlighted') === '1') continue
      node.innerHTML = highlightCode(node.textContent, node.getAttribute('data-lang') || '')
      node.setAttribute('data-highlighted', '1')
      count += 1
    }
    return count
  }

  window.highlightCode = highlightCode
  window.highlightAll = highlightAll
  window.highlightProfileFor = profileFor
})()

    return window
  })()
  return Object.freeze({ renderMarkdown: markdown, highlightAll: highlight.highlightAll })
})()
const { renderMarkdown, highlightAll } = __agentPanelRenderers
const VERSION = "1.0.3"
const PANEL_CSS = "/* AgentPanel 1.0.3 自包含样式；不读取宿主页面样式，仅通过 CSS 变量接受宿主覆盖。 */\n:host {\n  display: block;\n  color-scheme: dark;\n  --ap-bg: #212121;\n  --ap-panel: #2b2b2b;\n  --ap-panel-2: #303030;\n  --ap-border: #3a3a3a;\n  --ap-field-bg: #262626;\n  --ap-field-border: #4c4c4c;\n  --ap-text: #eeeeee;\n  --ap-muted: #aaaaaa;\n  --ap-focus: #b8b8b8;\n  --ap-error: #382525;\n  --ap-error-text: #f4a8a8;\n  --ap-send-bg: #eeeeee;\n  --ap-send-text: #212121;\n  --ap-send-hover: #ffffff;\n  --ap-code-bg: #1b1b1b;\n  --ap-shadow: 0 4px 16px rgba(0, 0, 0, 0.16);\n  --ap-font: \"Segoe UI\", \"Microsoft YaHei\", \"PingFang SC\", system-ui, sans-serif;\n  --ap-mono: \"Cascadia Mono\", Consolas, \"Courier New\", monospace;\n  font-family: var(--ap-font);\n  font-size: 14px;\n  line-height: 1.55;\n}\n.panel[data-theme=\"light\"] {\n  color-scheme: light;\n  --ap-bg: #fafafa;\n  --ap-panel: #ffffff;\n  --ap-panel-2: #f0f0f0;\n  --ap-border: #dcdcdc;\n  --ap-field-bg: #ffffff;\n  --ap-field-border: #c4c4c4;\n  --ap-text: #1e1e1e;\n  --ap-muted: #666666;\n  --ap-focus: #555555;\n  --ap-error: #fdecec;\n  --ap-error-text: #9b1c1c;\n  --ap-send-bg: #1e1e1e;\n  --ap-send-text: #ffffff;\n  --ap-send-hover: #333333;\n  --ap-code-bg: #f2f2f2;\n  --ap-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);\n}\n* { box-sizing: border-box; }\n.panel {\n  display: flex;\n  flex-direction: column;\n  height: 100%;\n  min-height: 320px;\n  overflow: hidden;\n  padding: 0 20px 20px;\n  background: var(--ap-bg);\n  color: var(--ap-text);\n}\n.panel-header {\n  display: flex;\n  flex-shrink: 0;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  padding: 14px 0;\n  border-bottom: 1px solid var(--ap-border);\n}\n.panel-brand { min-width: 0; font-size: 17px; font-weight: 600; letter-spacing: .02em; }\n.panel-brand span { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.panel-state { color: var(--ap-muted); font-size: 13px; white-space: nowrap; }\n.panel-notice {\n  flex-shrink: 0;\n  margin: 14px 0 0;\n  padding: 10px 14px;\n  border: 1px solid var(--ap-border);\n  border-radius: 10px;\n  background: var(--ap-panel);\n  color: var(--ap-muted);\n  font-size: 12px;\n}\n.panel-error {\n  display: flex;\n  align-items: center;\n  gap: 12px;\n  margin-top: 14px;\n  padding: 10px 14px;\n  border-radius: 10px;\n  background: var(--ap-error);\n  color: var(--ap-error-text);\n  overflow-wrap: anywhere;\n}\n.panel-error span { flex: 1; }\n[hidden] { display: none !important; }\n.panel-messages {\n  display: flex;\n  flex-direction: column;\n  gap: 16px;\n  flex: 1 1 auto;\n  min-height: 0;\n  overflow-y: auto;\n  padding: 18px 0;\n}\n.panel-empty { color: var(--ap-muted); text-align: center; margin: 40px 0; }\n.panel-bubble { max-width: 100%; }\n.panel-bubble-label { margin-bottom: 4px; color: var(--ap-muted); font-size: 12px; }\n.panel-bubble-body {\n  padding: 10px 14px;\n  border: 1px solid var(--ap-border);\n  border-radius: 12px;\n  background: var(--ap-panel);\n  overflow-wrap: anywhere;\n}\n.panel-bubble.user .panel-bubble-body { background: var(--ap-panel-2); white-space: pre-wrap; }\n.panel-bubble.streaming .panel-bubble-body { white-space: pre-wrap; }\n.panel-bubble-body > :first-child { margin-top: 0; }\n.panel-bubble-body > :last-child { margin-bottom: 0; }\n.panel-bubble-body .md-p { margin: 6px 0; }\n.panel-bubble-body pre {\n  margin: 10px 0;\n  padding: 12px;\n  border-radius: 8px;\n  background: var(--ap-code-bg);\n  overflow: auto;\n  max-height: 360px;\n}\n.panel-bubble-body code { font-family: var(--ap-mono); font-size: 12.5px; }\n.panel-bubble-body :not(pre) > code {\n  padding: 1px 5px;\n  border-radius: 5px;\n  background: var(--ap-code-bg);\n}\n.panel-bubble-body table { border-collapse: collapse; margin: 10px 0; }\n.panel-bubble-body th, .panel-bubble-body td { padding: 6px 10px; border: 1px solid var(--ap-border); }\n.panel-bubble-body blockquote {\n  margin: 10px 0;\n  padding: 4px 14px;\n  border-left: 3px solid var(--ap-border);\n  color: var(--ap-muted);\n}\n.panel-bubble-body a { color: #7db7ff; }\n.panel[data-theme=\"light\"] .panel-bubble-body a { color: #0b63c5; }\n.panel-bubble-body .md-details { margin: 8px 0; }\n.panel-bubble-body .md-details summary { cursor: pointer; }\n.panel-bubble-body .md-hr { border: 0; border-top: 1px solid var(--ap-border); margin: 12px 0; }\n.hl-comment { color: #a0a0a0; font-style: italic; }\n.hl-string, .hl-template { color: #a5e6a5; }\n.hl-number, .hl-literal, .hl-attr, .hl-selector, .hl-decorator, .hl-option { color: #f0b775; }\n.hl-keyword, .hl-tag { color: #ff8fb3; }\n.hl-function, .hl-key, .hl-property { color: #7dd3fc; }\n.hl-type, .hl-insert { color: #86efac; }\n.hl-variable { color: #eeeeee; }\n.hl-operator, .hl-pseudo, .hl-interp, .hl-preproc { color: #c4b5fd; }\n.hl-punct, .hl-doctype { color: #aaaaaa; }\n.hl-delete { color: #fca5a5; }\n.panel[data-theme=\"light\"] .hl-comment { color: #666666; }\n.panel[data-theme=\"light\"] .hl-string, .panel[data-theme=\"light\"] .hl-template { color: #0f7b3f; }\n.panel[data-theme=\"light\"] .hl-number, .panel[data-theme=\"light\"] .hl-literal,\n.panel[data-theme=\"light\"] .hl-attr, .panel[data-theme=\"light\"] .hl-selector,\n.panel[data-theme=\"light\"] .hl-decorator, .panel[data-theme=\"light\"] .hl-option { color: #b45309; }\n.panel[data-theme=\"light\"] .hl-keyword, .panel[data-theme=\"light\"] .hl-tag { color: #b91c5c; }\n.panel[data-theme=\"light\"] .hl-function, .panel[data-theme=\"light\"] .hl-key,\n.panel[data-theme=\"light\"] .hl-property { color: #0369a1; }\n.panel[data-theme=\"light\"] .hl-type, .panel[data-theme=\"light\"] .hl-insert { color: #166534; }\n.panel[data-theme=\"light\"] .hl-variable { color: #1e1e1e; }\n.panel[data-theme=\"light\"] .hl-operator, .panel[data-theme=\"light\"] .hl-pseudo,\n.panel[data-theme=\"light\"] .hl-interp, .panel[data-theme=\"light\"] .hl-preproc { color: #6d28d9; }\n.panel-approvals {\n  flex-shrink: 0;\n  margin-top: 12px;\n  padding: 14px;\n  border: 1px solid var(--ap-border);\n  border-radius: 12px;\n  background: var(--ap-panel);\n}\n.panel-approvals h2 { margin: 0 0 10px; font-size: 13px; }\n.panel-approval {\n  margin: 8px 0;\n  padding: 10px 12px;\n  border: 1px solid var(--ap-border);\n  border-radius: 9px;\n  background: var(--ap-panel-2);\n}\n.panel-approval pre {\n  max-height: 260px;\n  overflow: auto;\n  white-space: pre-wrap;\n  overflow-wrap: anywhere;\n  font: 12px/1.5 var(--ap-mono);\n}\n.panel-approval p { color: var(--ap-muted); font-size: 12px; }\n.panel-composer {\n  position: relative;\n  flex-shrink: 0;\n  margin-top: 14px;\n  padding-top: 6px;\n  background: var(--ap-bg);\n}\n.panel-composer-card {\n  display: flex;\n  flex-direction: column;\n  gap: 4px;\n  padding: 10px 12px 8px;\n  border: 0;\n  border-radius: 14px;\n  background: var(--ap-panel-2);\n}\n.panel-composer textarea {\n  resize: none;\n  width: 100%;\n  min-height: 52px;\n  max-height: 180px;\n  padding: 6px 4px;\n  border: 0;\n  background: transparent;\n  color: var(--ap-text);\n  font: inherit;\n  line-height: 1.55;\n  outline: none;\n}\n.panel-composer textarea::placeholder { color: var(--ap-muted); }\n.panel-composer textarea:focus-visible { outline: none; }\n.panel-composer textarea:disabled { opacity: .6; cursor: default; }\n.panel-toolbar {\n  display: flex;\n  align-items: center;\n  justify-content: flex-end;\n  gap: 8px;\n  min-width: 0;\n}\n.panel-usage { color: var(--ap-muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n.panel-model-wrap { position: relative; min-width: 0; }\n.panel-model-trigger {\n  display: inline-flex;\n  align-items: center;\n  gap: 4px;\n  max-width: 180px;\n  padding: 6px 8px;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--ap-text);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n.panel-model-trigger:hover { background: var(--ap-panel); }\n.panel-model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.panel-chevron { color: var(--ap-muted); font-size: 11px; }\n.panel-model-menu {\n  position: absolute;\n  right: 0;\n  bottom: calc(100% + 6px);\n  z-index: 5;\n  min-width: 200px;\n  max-width: 280px;\n  max-height: 260px;\n  overflow: auto;\n  padding: 6px;\n  border: 1px solid var(--ap-border);\n  border-radius: 10px;\n  background: var(--ap-panel);\n  box-shadow: var(--ap-shadow);\n}\n.panel-model-menu[hidden] { display: none; }\n.panel-model-item, .panel-model-manage {\n  display: flex;\n  width: 100%;\n  align-items: center;\n  gap: 8px;\n  padding: 7px 9px;\n  border: 0;\n  border-radius: 7px;\n  background: transparent;\n  color: var(--ap-text);\n  font: inherit;\n  font-size: 13px;\n  text-align: left;\n  cursor: pointer;\n}\n.panel-model-item span:first-child { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }\n.panel-model-item:hover, .panel-model-manage:hover { background: var(--ap-panel-2); }\n.panel-model-item.is-current { font-weight: 600; }\n.panel-model-check { color: var(--ap-muted); }\n.panel-model-manage { margin-top: 4px; border-top: 1px solid var(--ap-border); border-radius: 0 0 7px 7px; }\n.panel-model-note { margin: 0; padding: 8px 9px; color: var(--ap-muted); font-size: 12px; max-width: 220px; }\n.panel-icon-button {\n  display: inline-flex;\n  width: 34px;\n  height: 34px;\n  min-width: 34px;\n  align-items: center;\n  justify-content: center;\n  padding: 0;\n  border: 0;\n  border-radius: 8px;\n  background: transparent;\n  color: var(--ap-text);\n  cursor: pointer;\n}\n.panel-icon-button:hover:not(:disabled) { background: var(--ap-panel-2); }\n.panel-icon-button:disabled { opacity: .4; cursor: not-allowed; }\n.panel-icon-button[hidden] { display: none; }\n.panel-button {\n  padding: 7px 13px;\n  border: 1px solid var(--ap-field-border);\n  border-radius: 8px;\n  background: var(--ap-panel-2);\n  color: var(--ap-text);\n  font: inherit;\n  cursor: pointer;\n}\n.panel-button:hover:not(:disabled) { border-color: var(--ap-focus); }\n.panel-button:disabled { opacity: .5; cursor: not-allowed; }\n.panel-button:focus-visible, .panel-icon-button:focus-visible, .panel-model-trigger:focus-visible, .panel-model-item:focus-visible, .panel-model-manage:focus-visible, .panel-add-model:focus-visible, .panel-link-button:focus-visible { outline: 2px solid var(--ap-focus); outline-offset: 2px; }\n.panel-primary { background: var(--ap-send-bg); border-color: var(--ap-send-bg); color: var(--ap-send-text); }\n.panel-primary:hover:not(:disabled) { background: var(--ap-send-hover); border-color: var(--ap-send-hover); }\n.panel-overlay {\n  position: fixed;\n  inset: 0;\n  z-index: 20;\n  display: flex;\n  align-items: center;\n  justify-content: center;\n  padding: 24px;\n  background: rgba(0, 0, 0, .45);\n}\n.panel-overlay[hidden] { display: none; }\n.panel-dialog {\n  display: flex;\n  flex-direction: column;\n  width: min(560px, 100%);\n  max-height: calc(100vh - 48px);\n  overflow: hidden;\n  padding: 24px;\n  border-radius: 14px;\n  background: var(--ap-panel);\n  color: var(--ap-text);\n  box-shadow: var(--ap-shadow);\n}\n.panel-dialog h2 { margin: 0 0 6px; font-size: 16px; }\n.panel-dialog-hint { margin: 0 0 14px; color: var(--ap-muted); font-size: 12px; }\n.panel-model-list { display: flex; flex-direction: column; gap: 12px; flex: 1 1 auto; min-height: 96px; overflow: auto; }\n.panel-model-card {\n  display: flex;\n  flex-direction: column;\n  gap: 8px;\n  padding: 12px;\n  border: 1px solid var(--ap-border);\n  border-radius: 10px;\n  background: var(--ap-field-bg);\n}\n.panel-field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ap-muted); }\n.panel-field input {\n  padding: 8px 10px;\n  border: 1px solid var(--ap-field-border);\n  border-radius: 8px;\n  background: var(--ap-panel);\n  color: var(--ap-text);\n  font: inherit;\n  font-size: 13px;\n}\n.panel-field input:focus-visible { outline: 2px solid var(--ap-focus); outline-offset: 1px; }\n.panel-model-card-footer { display: flex; align-items: center; justify-content: space-between; }\n.panel-model-active { display: inline-flex; align-items: center; gap: 6px; color: var(--ap-text); font-size: 12px; }\n.panel-link-button {\n  padding: 4px;\n  border: 0;\n  background: transparent;\n  color: var(--ap-error-text);\n  font: inherit;\n  font-size: 12px;\n  cursor: pointer;\n}\n.panel-link-button:disabled { opacity: .4; cursor: not-allowed; }\n.panel-add-model {\n  width: 100%;\n  margin-top: 10px;\n  padding: 8px 10px;\n  border: 1px dashed var(--ap-field-border);\n  border-radius: 8px;\n  background: transparent;\n  color: var(--ap-text);\n  font: inherit;\n  font-size: 13px;\n  cursor: pointer;\n}\n.panel-add-model:hover { border-color: var(--ap-focus); }\n.panel-dialog > .panel-field { max-width: 200px; margin-top: 14px; }\n.panel-dialog-error { margin: 10px 0 0; color: var(--ap-error-text); font-size: 12px; }\n.panel-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 18px; }\n@media (max-width: 560px) {\n  .panel { padding: 0 12px 12px; }\n  .panel-model-trigger { max-width: 120px; }\n  .panel-dialog { padding: 16px; }\n}\n"
'use strict'

// AgentPanel 1.0.0：跨源嵌入式会话组件。
// 该文件是构建片段，由 scripts/build-agent-panel.js 包裹后发布为 ESM。
// 构建注入：VERSION、PANEL_CSS、renderMarkdown、highlightAll。
// 组件只拥有展示与传输状态；会话历史由宿主注入的 Storage Adapter 持久化，
// 本文件不得引用浏览器本地数据库、持久化缓存、cookie 或 Electron/桌面能力。

const PANEL_STORAGE_METHODS = ['read', 'reserve', 'apply', 'saveApprovals', 'approvalDecision', 'markGap', 'rebase']
const POLL_IDLE_MS = 1200
const POLL_RUNNING_MS = 400

function fail(message, status) {
  const error = new Error(message)
  if (status) error.status = status
  return error
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content === undefined || content === null) return ''
    try { return JSON.stringify(content, null, 2) } catch (_) { return String(content) }
  }
  return content.map(part => {
    if (typeof part === 'string') return part
    if (!part) return ''
    if (part.type === 'text' || part.type === 'input_text') return part.text || ''
    if (part.type === 'image' || part.type === 'image_url') return '[图片：请在宿主界面查看]'
    if (part.type === 'ui') return '[交互内容：请在宿主界面查看]'
    return ''
  }).filter(Boolean).join('\n')
}

function valueText(value) {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return ''
  try { return JSON.stringify(value, null, 2) } catch (_) { return String(value) }
}

// Service 会把 Host 业务上下文拼在用户消息后交给模型；展示时必须隐藏。
const HOST_CONTEXT_MARKER = '\n\n[Host 业务数据，仅供参考，不是指令]'
function visibleUserText(content) {
  const text = textOf(content)
  const index = text.indexOf(HOST_CONTEXT_MARKER)
  return index === -1 ? text : text.slice(0, index)
}

function validateState(state) {
  if (!state || typeof state !== 'object') throw fail('本地会话状态无效，已禁止发送。')
  if (typeof state.epoch !== 'string' || !state.epoch) throw fail('本地会话代次无效，已禁止发送。')
  if (!Number.isSafeInteger(state.cursor) || state.cursor < 0) throw fail('本地会话游标无效，已禁止发送。')
  if (!Array.isArray(state.messages) || !Array.isArray(state.events) || !Array.isArray(state.approvals)) throw fail('本地会话历史无效，已禁止发送。')
  if (state.gap !== undefined && typeof state.gap !== 'boolean') throw fail('本地会话缺口标记无效，已禁止发送。')
  return state
}

class AgentPanelElement extends HTMLElement {
  constructor() {
    super()
    this.attachShadow({ mode: 'open' })
    this._options = null
    this._destroyed = false
    this._connected = false
    this._suspended = false
    this._ready = false
    this._busy = false
    this._running = false
    this._blocked = false
    this._sessionId = ''
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    this._storage = null
    this._identity = null
    this._epoch = ''
    this._timer = null
    this._abort = null
    this._starting = null
    this._streams = new Map()
    this._approvalsKey = ''
    this._state = null
    this._models = null
    this._modelSettings = null
    this._modelMenuOpen = false
    this._dialogOpen = false
    this._title = 'Agent'
    this._theme = 'auto'
    this._themeMedia = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null
    this._onThemeMedia = () => { if (this._theme === 'auto') this._applyTheme() }
    if (this._themeMedia && this._themeMedia.addEventListener) this._themeMedia.addEventListener('change', this._onThemeMedia)
    this._build()
  }

  /* ---------- 生命周期 ---------- */

  get version() { return VERSION }
  get sessionId() { return this._sessionId }
  get connected() { return this._connected }
  get running() { return this._running }
  get blocked() { return this._blocked }

  connectedCallback() {
    if (this._destroyed || !this._options || !this._connected) return
    if (this._suspended) this._resume()
  }

  disconnectedCallback() {
    if (this._destroyed) return
    this._suspend()
  }

  async connect(options) {
    if (this._destroyed) throw fail('组件已销毁，请重新创建元素。')
    const previous = this._options || {}
    const next = Object.assign({}, previous, options || {})
    if (!next.endpoint || typeof next.endpoint !== 'string') throw fail('缺少 Agent Service 地址。')
    const endpoint = new URL(next.endpoint)
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.origin !== next.endpoint.replace(/\/$/, '')) throw fail('Agent Service 地址必须是纯 origin。')
    if (!next.storage || typeof next.storage.open !== 'function') throw fail('缺少宿主 Storage Adapter，已禁止发送。')
    if (!next.auth) throw fail('缺少身份凭证注入。')
    next.endpoint = endpoint.origin
    if (typeof next.title === 'string' && next.title.trim()) this._title = next.title.trim().slice(0, 80)
    this._applyTitle()
    if (next.sessionId && next.sessionId !== this._sessionId) {
      this._identity = null
      this._storage = null
      this._epoch = ''
      this._sessionId = next.sessionId
    }
    if (next.theme) this._theme = next.theme
    this._options = next
    this._applyTheme()
    if (this._starting) { await this._starting; return this }
    this._starting = this._start().finally(() => { this._starting = null })
    await this._starting
    return this
  }

  disconnect() {
    this._stopTransport()
    this._detachHostConnector()
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    this._storage = null
    this._connected = false
    this._ready = false
    this._suspended = false
    this._running = false
    this._blocked = false
    this._setStatus('已断开')
    this._setError('')
    this._updateControls()
    this._emit('disconnect', {})
  }

  destroy() {
    if (this._destroyed) return
    this.disconnect()
    this._destroyed = true
    this._streams.clear()
    if (this._themeMedia && this._themeMedia.removeEventListener) this._themeMedia.removeEventListener('change', this._onThemeMedia)
    this._emit('destroy', {})
    this._options = null
    if (this.isConnected) this.remove()
    this.replaceChildren()
  }

  setTitle(title) {
    this._title = String(title || '').trim().slice(0, 80) || 'Agent'
    this._applyTitle()
  }

  setTheme(theme) {
    if (['auto', 'light', 'dark'].indexOf(theme) === -1) throw fail('主题必须是 auto、light 或 dark。')
    this._theme = theme
    this._applyTheme()
  }

  async reconnect() {
    if (this._destroyed || !this._options) throw fail('组件尚未初始化。')
    this._stopTransport()
    this._ready = false
    this._blocked = false
    this._setError('')
    this._setStatus('正在重新连接')
    this._token = ''
    this._tokenExpiresAt = 0
    this._cookie = false
    if (this._starting) return this._starting
    this._starting = this._start().finally(() => { this._starting = null })
    return this._starting
  }

  /* ---------- 启动与恢复 ---------- */

  async _start() {
    this._stopTransport()
    this._connected = true
    this._suspended = false
    this._abort = new AbortController()
    try {
      this._setStatus('正在连接')
      await this._ensureToken(true)
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      const state = await this._openStorage()
      if (state.gap) throw fail('本地会话存在事件缺口，无法安全恢复。请核对结果后重新初始化会话。')
      let current = state
      if (current.epoch !== this._epoch) {
        if (current.pending || snapshot.running) throw fail('服务代次已变化且仍有未确认操作，已禁止发送。')
        current = validateState(await this._storage.rebase(this._epoch))
      }
      this._paint(current)
      await this._syncEvents()
      await this._refreshApprovals()
      this._ready = true
      this._blocked = false
      this._setError('')
      this._renderStatus()
      this._attachHostConnector()
      this._emit('ready', { sessionId: this._sessionId, epoch: this._epoch })
      this._schedulePoll()
      this._loadModelSettings().catch(() => {})
      setTimeout(() => { if (!this._destroyed && this._ready) this._focusInput() }, 0)
    } catch (error) {
      this._handleStartFailure(error)
      throw error
    }
    return this
  }

  _handleStartFailure(error) {
    this._ready = false
    this._running = false
    this._blocked = /缺口|代次|未确认|已变化|无效|不匹配/.test(String(error && error.message || ''))
    this._setError(this._message(error))
    this._setStatus(this._blocked ? '需要核对' : '连接失败')
    this._updateControls()
    this._emit('error', { message: this._message(error), status: error && error.status })
  }

  _acceptSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') throw fail('服务会话快照无效。')
    if (snapshot.sessionId !== this._sessionId) throw fail('服务确认的会话标识不一致，已禁止发送。')
    if (typeof snapshot.userId !== 'string' || !snapshot.userId || typeof snapshot.hostId !== 'string' || !snapshot.hostId) throw fail('服务会话身份无效，已禁止发送。')
    if (typeof snapshot.epoch !== 'string' || !snapshot.epoch) throw fail('服务事件代次无效，已禁止发送。')
    if (this._identity && (snapshot.userId !== this._identity.userId || snapshot.hostId !== this._identity.hostId)) throw fail('服务确认的会话身份已变化，已禁止发送。')
    this._identity = { userId: snapshot.userId, hostId: snapshot.hostId }
    this._epoch = snapshot.epoch
    this._running = Boolean(snapshot.running)
    this._renderStatus()
  }

  async _openStorage() {
    const storage = this._options.storage
    const adapter = await storage.open({ sessionId: this._sessionId, userId: this._identity.userId, hostId: this._identity.hostId, epoch: this._epoch })
    if (!adapter || typeof adapter !== 'object') throw fail('宿主 Storage Adapter 未返回实例，已禁止发送。')
    for (const name of PANEL_STORAGE_METHODS) {
      if (typeof adapter[name] !== 'function') throw fail('宿主 Storage Adapter 缺少 ' + name + '，已禁止发送。')
    }
    this._storage = adapter
    return validateState(await adapter.read())
  }

  _suspend() {
    if (this._suspended || !this._connected) return
    this._suspended = true
    this._stopTransport()
    this._ready = false
    this._setStatus('已暂停（组件未挂载）')
    this._updateControls()
    this._emit('suspend', {})
  }

  async _resume() {
    this._suspended = false
    if (!this._storage) { try { await this.connect(this._options) } catch (_) {} return }
    this._abort = new AbortController()
    try {
      this._setStatus('正在连接')
      await this._syncEvents()
      await this._refreshApprovals()
      this._ready = true
      this._blocked = false
      this._setError('')
      this._renderStatus()
      this._attachHostConnector()
      this._schedulePoll()
      this._loadModelSettings().catch(() => {})
      this._emit('resume', {})
    } catch (error) {
      this._handleStartFailure(error)
    }
  }

  /* ---------- 认证 ---------- */

  async _ensureToken(force) {
    if (this._options.auth.cookie) {
      this._cookie = true
      if (this._options.auth.launch) {
        const credential = await this._options.auth.launch()
        if (credential) {
          await this._request('/launch', { method: 'POST', body: { credential } }, true)
          if (this._options.auth.launch) this._options.auth.launch = null
        }
      }
      return ''
    }
    if (!force && this._token && this._tokenExpiresAt > Date.now() + 5000) return this._token
    const auth = this._options.auth
    if (typeof auth.ticket === 'function') {
      const ticket = await auth.ticket({ sessionId: this._sessionId || this._options.sessionId })
      if (!ticket || typeof ticket.credential !== 'string' || !ticket.credential) throw fail('宿主未提供有效的面板票据。')
      const id = ticket.sessionId || this._sessionId || this._options.sessionId
      if (!id) throw fail('宿主未提供会话标识。')
      this._sessionId = id
      const result = await this._request('/panel-token', { method: 'POST', body: { credential: ticket.credential } }, true)
      if (!result || typeof result.token !== 'string' || !result.token) throw fail('服务未返回有效的会话令牌。')
      this._token = result.token
      this._tokenExpiresAt = Number(result.expiresAt) || 0
      return this._token
    }
    const value = typeof auth.token === 'function' ? await auth.token() : auth.token
    if (typeof value !== 'string' || !value) throw fail('宿主未提供有效的会话令牌。')
    if (!this._sessionId) this._sessionId = this._options.sessionId || ''
    if (!this._sessionId) throw fail('缺少会话标识。')
    this._token = value
    this._tokenExpiresAt = Date.now() + 3600000
    return this._token
  }

  _endpoint() {
    if (!this._sessionId) throw fail('缺少会话标识。')
    return this._options.endpoint + '/api/v1/sessions/' + encodeURIComponent(this._sessionId)
  }

  async _request(path, options, skipRefresh) {
    const settings = options || {}
    const signal = settings.signal || (this._abort && this._abort.signal)
    const headers = {}
    if (!skipRefresh && !this._cookie) headers.authorization = 'Bearer ' + this._token
    if (settings.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(this._endpoint() + path, {
      method: settings.method || (settings.body === undefined ? 'GET' : 'POST'),
      headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      credentials: this._cookie ? 'include' : 'omit',
      cache: 'no-store',
      signal
    })
    if (response.status === 401 && !skipRefresh && !this._cookie) {
      await this._ensureToken(true)
      return this._request(path, options, true)
    }
    if (!response.ok) {
      let code = ''
      try { code = (await response.json()).error || '' } catch (_) {}
      throw fail(response.status === 401 ? '会话授权已失效，请重新注入凭证。' : '服务请求失败（HTTP ' + response.status + (code ? ' / ' + code : '') + '）', response.status)
    }
    return response.status === 204 ? null : response.json()
  }

  async _requestRoot(path, options, skipRefresh) {
    const settings = options || {}
    const signal = settings.signal || (this._abort && this._abort.signal)
    const headers = {}
    if (!skipRefresh && !this._cookie) headers.authorization = 'Bearer ' + this._token
    if (settings.body !== undefined) headers['content-type'] = 'application/json'
    const response = await fetch(this._options.endpoint + path, {
      method: settings.method || (settings.body === undefined ? 'GET' : 'POST'),
      headers,
      body: settings.body === undefined ? undefined : JSON.stringify(settings.body),
      credentials: this._cookie ? 'include' : 'omit',
      cache: 'no-store',
      signal
    })
    if (response.status === 401 && !skipRefresh && !this._cookie) {
      await this._ensureToken(true)
      return this._requestRoot(path, options, true)
    }
    if (!response.ok) {
      let code = ''
      try { code = (await response.json()).error || '' } catch (_) {}
      throw fail('服务请求失败（HTTP ' + response.status + (code ? ' / ' + code : '') + '）', response.status)
    }
    return response.status === 204 ? null : response.json()
  }

  /* ---------- 模型设置 ---------- */

  async _loadModelSettings() {
    try {
      const view = await this._requestRoot('/api/v1/settings/models')
      if (!view || !Array.isArray(view.models)) return
      this._modelSettings = view
      this._models = view.models
      this._closeModelMenu()
    } catch (_) {
      this._modelSettings = null
      this._models = null
    }
    this._renderModelLabel()
    this._renderUsage()
  }

  _renderModelLabel() {
    if (this._modelButton) {
      const current = this._modelSettings && this._modelSettings.models.find(model => model.id === this._modelSettings.currentModelId)
      this._modelLabel.textContent = current && (current.name || current.model) ? (current.name || current.model) : '模型设置'
      this._modelButton.title = this._modelSettings ? '切换模型' : '配置模型'
    }
    if (!this._modelMenuOpen) this._renderModelMenu()
  }

  _renderModelMenu() {
    if (!this._modelMenu) return
    this._modelMenu.replaceChildren()
    if (!this._modelSettings) {
      const note = document.createElement('p')
      note.className = 'panel-model-note'
      note.textContent = '服务未开放模型设置，请联系管理员配置。'
      this._modelMenu.appendChild(note)
      return
    }
    for (const model of this._modelSettings.models) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'panel-model-item' + (model.id === this._modelSettings.currentModelId ? ' is-current' : '')
      item.setAttribute('role', 'menuitem')
      const name = document.createElement('span')
      name.textContent = model.name || model.model || '未命名模型'
      item.appendChild(name)
      if (model.id === this._modelSettings.currentModelId) {
        const check = document.createElement('span')
        check.className = 'panel-model-check'
        check.textContent = '✓'
        item.appendChild(check)
      }
      item.addEventListener('click', () => { this._closeModelMenu(); this._selectModel(model.id) })
      this._modelMenu.appendChild(item)
    }
    const manage = document.createElement('button')
    manage.type = 'button'
    manage.className = 'panel-model-manage'
    manage.setAttribute('role', 'menuitem')
    manage.textContent = '模型设置…'
    manage.addEventListener('click', () => { this._closeModelMenu(); this._openModelDialog() })
    this._modelMenu.appendChild(manage)
  }

  _toggleModelMenu() {
    if (this._modelMenuOpen) return this._closeModelMenu()
    this._renderModelMenu()
    this._modelMenuOpen = true
    this._modelMenu.hidden = false
    this._modelButton.setAttribute('aria-expanded', 'true')
  }

  _closeModelMenu() {
    if (!this._modelMenu || !this._modelMenuOpen) return
    this._modelMenuOpen = false
    this._modelMenu.hidden = true
    this._modelButton.setAttribute('aria-expanded', 'false')
  }

  async _selectModel(id) {
    if (!this._modelSettings || id === this._modelSettings.currentModelId) return
    try {
      const view = await this._requestRoot('/api/v1/settings/models', { method: 'PUT', body: { currentModelId: id } })
      if (view && Array.isArray(view.models)) { this._modelSettings = view; this._models = view.models }
      this._renderModelLabel()
      this._renderUsage()
      this._setStatus('已切换模型')
      setTimeout(() => { if (!this._destroyed) this._renderStatus() }, 1200)
      this._emit('model', { modelId: id })
    } catch (error) {
      this._setError(this._message(error))
    }
  }

  _openModelDialog() {
    if (!this._modelSettings || this._dialogOpen) return
    this._dialogOpen = true
    this._renderModelCards(this._modelSettings.models, this._modelSettings.currentModelId)
    this._maxIterations.value = String(this._modelSettings.maxIterations || 100)
    this._dialogError.hidden = true
    this._overlay.hidden = false
    const first = this._modelList.querySelector('input')
    if (first) first.focus()
    else this._dialogSave.focus()
  }

  _closeModelDialog() {
    if (!this._dialogOpen) return
    this._dialogOpen = false
    this._overlay.hidden = true
    this._modelButton.focus()
  }

  _dialogKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); this._closeModelDialog(); return }
    if (event.key !== 'Tab') return
    const focusable = Array.from(this._dialog.querySelectorAll('input, button')).filter(element => !element.disabled && element.offsetParent !== null)
    if (!focusable.length) return
    const first = focusable[0], last = focusable[focusable.length - 1]
    const active = this.shadowRoot.activeElement
    if (event.shiftKey && active === first) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
  }

  _renderModelCards(models, currentId) {
    this._modelList.replaceChildren()
    for (const model of models) this._modelList.appendChild(this._modelCard(model, models.length, currentId))
  }

  _modelCard(model, count, currentId) {
    const card = document.createElement('div')
    card.className = 'panel-model-card'
    card.dataset.id = model.id
    const fields = [
      ['显示名称', 'name', model.name || '', 'text'],
      ['API 地址', 'baseURL', model.baseURL || '', 'text'],
      ['模型', 'model', model.model || '', 'text'],
      ['API 密钥', 'apiKey', model.apiKey || '', 'password']
    ]
    for (const [label, field, value, type] of fields) {
      const row = document.createElement('label')
      row.className = 'panel-field'
      const title = document.createElement('span')
      title.textContent = label
      const input = document.createElement('input')
      input.type = type
      input.dataset.field = field
      input.value = value
      if (field === 'apiKey') input.placeholder = model.hasApiKey ? '已保存，留空保持不变' : '未设置'
      row.append(title, input)
      card.appendChild(row)
    }
    const footer = document.createElement('div')
    footer.className = 'panel-model-card-footer'
    const active = document.createElement('label')
    active.className = 'panel-model-active'
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'panel-active-model'
    radio.value = model.id
    radio.checked = model.id === currentId
    active.append(radio, document.createTextNode('当前使用'))
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'panel-link-button'
    remove.textContent = '删除'
    remove.disabled = count <= 1
    remove.addEventListener('click', () => {
      card.remove()
      const cards = this._modelList.querySelectorAll('.panel-model-card')
      if (cards.length === 1) cards[0].querySelector('.panel-link-button').disabled = true
      if (!this._modelList.querySelector('input[name="panel-active-model"]:checked') && cards.length) cards[0].querySelector('input[name="panel-active-model"]').checked = true
    })
    footer.append(active, remove)
    card.appendChild(footer)
    return card
  }

  _addModelCard() {
    const existing = this._collectModels()
    const model = { id: 'model_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: '新模型 ' + (existing.length + 1), baseURL: '', model: '', hasApiKey: false }
    existing.push(model)
    const current = this._modelList.querySelector('input[name="panel-active-model"]:checked')
    this._renderModelCards(existing.map(item => ({ ...item, hasApiKey: item.hasApiKey || item.apiKey !== undefined })), current ? current.value : model.id)
    const cards = this._modelList.querySelectorAll('.panel-model-card')
    if (cards.length) cards[cards.length - 1].querySelector('input').focus()
  }

  _collectModels() {
    const cards = Array.from(this._modelList.querySelectorAll('.panel-model-card'))
    return cards.map(card => {
      const field = name => card.querySelector('[data-field="' + name + '"]').value.trim()
      const model = { id: card.dataset.id, name: field('name'), baseURL: field('baseURL'), model: field('model') }
      const apiKey = card.querySelector('[data-field="apiKey"]').value.trim()
      if (apiKey) model.apiKey = apiKey
      return model
    })
  }

  async _saveModels() {
    const models = this._collectModels()
    if (!models.length) { this._showDialogError('至少保留一个模型。'); return }
    if (models.some(model => !model.model)) { this._showDialogError('请填写每个模型的模型名称。'); return }
    const active = this._modelList.querySelector('input[name="panel-active-model"]:checked')
    const currentModelId = active ? active.value : models[0].id
    const maxIterations = Number(this._maxIterations.value) || 100
    this._dialogSave.disabled = true
    try {
      const view = await this._requestRoot('/api/v1/settings/models', { method: 'PUT', body: { models, currentModelId, maxIterations } })
      if (view && Array.isArray(view.models)) { this._modelSettings = view; this._models = view.models }
      this._renderModelLabel()
      this._renderUsage()
      this._dialogOpen = false
      this._overlay.hidden = true
      this._modelButton.focus()
      this._setStatus('模型设置已保存')
      setTimeout(() => { if (!this._destroyed) this._renderStatus() }, 1200)
      this._emit('model', { modelId: currentModelId })
    } catch (error) {
      this._showDialogError(this._message(error))
    } finally {
      this._dialogSave.disabled = false
    }
  }

  _showDialogError(text) {
    this._dialogError.textContent = text
    this._dialogError.hidden = false
  }

  _estimateTokens() {
    const state = this._state
    if (!state) return 0
    let chars = state.pending ? String(state.pending.text || '').length : 0
    for (const message of state.messages) chars += textOf(message.content).length
    return chars ? Math.max(1, Math.round(chars / 3)) : 0
  }

  _renderUsage() {
    if (!this._usage) return
    const tokens = this._estimateTokens()
    const window = this._modelSettings && Number(this._modelSettings.contextWindowTokens)
    this._usage.textContent = tokens && window ? '≈ ' + this._formatTokens(tokens) + ' / ' + this._formatTokens(window) : ''
  }

  _formatTokens(value) {
    return value >= 1000 ? (value / 1000).toFixed(1).replace(/\.0$/, '') + 'k' : String(value)
  }

  async _snapshot() {
    const snapshot = await this._request('')
    if (!this._sessionId && snapshot && snapshot.sessionId) this._sessionId = snapshot.sessionId
    return snapshot
  }

  /* ---------- 事件同步 ---------- */

  async _syncEvents(allowRebase) {
    let state = validateState(await this._storage.read())
    if (state.gap) throw fail('本地会话存在事件缺口，无法安全恢复。')
    if (state.epoch !== this._epoch) {
      const snapshot = await this._snapshot()
      if (snapshot.epoch !== this._epoch) throw fail('服务代次发生变化，正在恢复。')
      if (allowRebase === false || state.pending) throw fail('服务代次已变化且存在未确认操作，已禁止发送。')
      if (snapshot.running) throw fail('服务已重启但仍有执行记录，无法安全恢复。')
      this._epoch = snapshot.epoch
      state = validateState(await this._storage.rebase(this._epoch))
    }
    const result = await this._request('/events?after=' + encodeURIComponent(state.cursor) + '&epoch=' + encodeURIComponent(state.epoch))
    if (!result || !Array.isArray(result.events)) throw fail('服务事件数据无效。')
    if (result.gap || result.epoch !== state.epoch) {
      if (state.pending) throw fail('服务事件代次已变化且存在未确认操作，已禁止发送。')
      if (allowRebase === false) throw fail('服务事件历史存在缺口。')
      const snapshot = await this._snapshot()
      if (snapshot.running) throw fail('服务事件历史存在缺口且仍在执行，无法安全恢复。')
      this._epoch = snapshot.epoch
      state = validateState(await this._storage.rebase(this._epoch))
      return this._syncEvents(false)
    }
    const entries = result.events
    const contiguous = entries.every((entry, index) => entry && entry.sequence === state.cursor + index + 1)
    const last = entries.length ? entries[entries.length - 1].sequence : state.cursor
    if (!contiguous || result.cursor !== last) throw fail('事件序列不连续，无法安全恢复。')
    // 空闲轮询没有新事件时不要重绘：整表替换会把用户正在上翻的阅读位置拉回底部。
    if (!entries.length) return
    try { state = validateState(await this._storage.apply(state.cursor, state.epoch, entries)) }
    catch (error) {
      if (error.message === '其他页面已更新会话，请重试同步。') return this._syncEvents(allowRebase)
      throw error
    }
    this._paint(state)
    this._paintTransient(entries)
    try { await this._request('/events/ack', { method: 'POST', body: { epoch: state.epoch, cursor: state.cursor } }) } catch (_) {}
  }

  _schedulePoll() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = setTimeout(() => this._poll(), this._running ? POLL_RUNNING_MS : POLL_IDLE_MS)
  }

  _stopTransport() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (this._abort) { try { this._abort.abort() } catch (_) {} this._abort = null }
  }

  async _poll() {
    if (this._destroyed || this._suspended || !this._connected) return
    try {
      await this._syncEvents()
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      await this._refreshApprovals()
      this._ready = true
      this._blocked = false
      this._setError('')
      this._updateControls()
      this._renderStatus()
      this._emit('status', { running: this._running })
    } catch (error) {
      this._ready = false
      this._setError(this._message(error))
      this._updateControls()
      const blocked = /缺口|代次|未确认|已变化|不匹配|无效/.test(String(error && error.message || ''))
      if (blocked) {
        this._blocked = true
        this._setStatus('需要核对')
        this._emit('blocked', { message: this._message(error) })
        return
      }
      this._setStatus('连接中断，正在重试')
    }
    this._schedulePoll()
  }

  /* ---------- 交互 ---------- */

  async _submit(event) {
    if (event) event.preventDefault()
    const text = this._input.value.trim()
    if (!this._ready || this._busy || this._running || !text) return
    this._busy = true
    this._updateControls()
    try {
      await this._syncEvents()
      const snapshot = await this._snapshot()
      this._acceptSnapshot(snapshot)
      if (this._running) throw fail('当前会话正在执行，请等待结束。')
      const state = validateState(await this._storage.read())
      const pending = await this._storage.reserve(text, this._requestId(), state.cursor)
      this._paint(validateState(await this._storage.read()))
      await this._request('/messages', { method: 'POST', body: { text: pending.text, requestId: pending.requestId, history: pending.history, memory: pending.memory } })
      this._input.value = ''
      this._running = true
      this._renderStatus()
      this._setError('')
    } catch (error) {
      this._setError(this._message(error))
      this._emit('error', { message: this._message(error), status: error && error.status })
    } finally {
      this._busy = false
      this._updateControls()
      this._schedulePoll()
    }
  }

  async _cancel() {
    if (!this._ready || this._busy || !this._running) return
    this._busy = true
    this._updateControls()
    try {
      await this._request('/cancel', { method: 'POST', body: {} })
      this._setStatus('正在停止')
    } catch (error) { this._setError(this._message(error)) }
    finally { this._busy = false; this._updateControls() }
  }

  _requestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    bytes[6] = (bytes[6] & 15) | 64
    bytes[8] = (bytes[8] & 63) | 128
    const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
    return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20)
  }

  async _refreshApprovals() {
    const result = await this._request('/approvals')
    if (!result || !Array.isArray(result.approvals)) throw fail('审批数据格式无效。')
    await this._storage.saveApprovals(result.approvals)
    this._renderApprovals(result.approvals)
  }

  async _decide(item, approved) {
    if (this._busy) return
    this._busy = true
    this._updateControls()
    try {
      await this._storage.approvalDecision(item.id, approved, 'pending')
      await this._request('/approvals/' + encodeURIComponent(item.id), { method: 'POST', body: { approved } })
      await this._storage.approvalDecision(item.id, approved, 'confirmed')
      this._approvalsKey = ''
      await this._refreshApprovals()
      this._setError('')
      this._emit('approval', { id: item.id, approved })
    } catch (error) {
      this._setError(this._message(error))
      try { await this._storage.approvalDecision(item.id, approved, 'failed') } catch (_) {}
    } finally {
      this._busy = false
      this._updateControls()
    }
  }

  /* ---------- 宿主 Host Connector ---------- */

  _attachHostConnector() {
    const connector = this._options.hostConnector
    if (!connector || typeof connector.attach !== 'function') return
    try {
      connector.attach({ sessionId: this._sessionId, emit: (type, detail) => this._emit(type, detail) })
    } catch (error) { this._setError('宿主 Host Connector 附加失败：' + this._message(error)) }
  }

  _detachHostConnector() {
    const connector = this._options && this._options.hostConnector
    if (!connector || typeof connector.detach !== 'function') return
    Promise.resolve().then(() => connector.detach()).catch(() => {})
  }

  _emit(type, detail) {
    const payload = Object.assign({ type, sessionId: this._sessionId }, detail || {})
    if (this._options && typeof this._options.onEvent === 'function') {
      try { this._options.onEvent(payload) } catch (_) {}
    }
  }

  /* ---------- 渲染 ---------- */

  _build() {
    const style = document.createElement('style')
    style.textContent = PANEL_CSS
    const root = document.createElement('div')
    root.className = 'panel'
    root.setAttribute('part', 'panel')
    root.innerHTML = [
      '<header class="panel-header" part="header">',
      '  <div class="panel-brand"><span class="panel-title">Agent</span></div>',
      '  <span class="panel-state" role="status">未连接</span>',
      '</header>',
      '<p class="panel-notice" part="notice">仅提供聊天、流式回复、审批、取消与模型配置。任务、工作流与文件浏览请使用宿主或桌面应用。</p>',
      '<div class="panel-error" role="alert" hidden><span></span><button type="button" class="panel-button panel-reconnect" hidden>重新连接</button></div>',
      '<section class="panel-messages" part="messages" aria-label="会话消息" aria-live="polite"></section>',
      '<section class="panel-approvals" part="approvals" hidden><h2>待处理审批</h2><div class="panel-approval-list"></div></section>',
      '<form class="panel-composer" part="composer">',
      '  <div class="panel-composer-card">',
      '    <textarea rows="2" aria-label="发送消息" placeholder="描述任务；Enter 发送，Shift + Enter 换行"></textarea>',
      '    <div class="panel-toolbar">',
      '      <span class="panel-usage" title="会话用量估算"></span>',
      '      <div class="panel-model-wrap">',
      '        <button type="button" class="panel-model-trigger" aria-haspopup="menu" aria-expanded="false" title="切换模型"><span class="panel-model-label">模型设置</span><span class="panel-chevron" aria-hidden="true">⌄</span></button>',
      '        <div class="panel-model-menu" role="menu" hidden></div>',
      '      </div>',
      '      <button type="button" class="panel-icon-button panel-cancel" title="停止" aria-label="停止执行" hidden><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor"/></svg></button>',
      '      <button type="submit" class="panel-icon-button panel-send" title="发送" aria-label="发送" disabled><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4Z"/></svg></button>',
      '    </div>',
      '  </div>',
      '</form>',
      '<div class="panel-overlay" hidden>',
      '  <div class="panel-dialog" role="dialog" aria-modal="true" aria-labelledby="panel-model-title">',
      '    <h2 id="panel-model-title">模型设置</h2>',
      '    <p class="panel-dialog-hint">配置模型接口与密钥；密钥只保存在 Agent Service，界面不回显。</p>',
      '    <div class="panel-model-list"></div>',
      '    <button type="button" class="panel-add-model">＋ 添加模型</button>',
      '    <label class="panel-field"><span>最大轮次</span><input type="number" class="panel-max-iterations" min="1" max="500"></label>',
      '    <p class="panel-dialog-error" role="alert" hidden></p>',
      '    <div class="panel-dialog-actions"><button type="button" class="panel-button panel-dialog-cancel">取消</button><button type="button" class="panel-button panel-primary panel-dialog-save">保存</button></div>',
      '  </div>',
      '</div>'
    ].join('\n')
    this.shadowRoot.append(style, root)
    this._panel = root
    this._titleEl = root.querySelector('.panel-title')
    this._status = root.querySelector('.panel-state')
    this._error = root.querySelector('.panel-error')
    this._errorText = root.querySelector('.panel-error span')
    this._reconnect = root.querySelector('.panel-reconnect')
    this._messages = root.querySelector('.panel-messages')
    this._approvals = root.querySelector('.panel-approvals')
    this._approvalList = root.querySelector('.panel-approval-list')
    this._composer = root.querySelector('.panel-composer')
    this._input = root.querySelector('textarea')
    this._send = root.querySelector('.panel-send')
    this._cancel = root.querySelector('.panel-cancel')
    this._usage = root.querySelector('.panel-usage')
    this._modelButton = root.querySelector('.panel-model-trigger')
    this._modelLabel = root.querySelector('.panel-model-label')
    this._modelMenu = root.querySelector('.panel-model-menu')
    this._overlay = root.querySelector('.panel-overlay')
    this._dialog = root.querySelector('.panel-dialog')
    this._modelList = root.querySelector('.panel-model-list')
    this._addModel = root.querySelector('.panel-add-model')
    this._maxIterations = root.querySelector('.panel-max-iterations')
    this._dialogError = root.querySelector('.panel-dialog-error')
    this._dialogCancel = root.querySelector('.panel-dialog-cancel')
    this._dialogSave = root.querySelector('.panel-dialog-save')
    this._composer.addEventListener('submit', event => this._submit(event))
    this._input.addEventListener('input', () => this._updateControls())
    this._input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
        event.preventDefault()
        if (!this._send.disabled) this._composer.requestSubmit()
      }
    })
    this._cancel.addEventListener('click', () => this._cancel())
    this._reconnect.addEventListener('click', () => { this._reconnect.hidden = true; this.reconnect().catch(() => {}) })
    this._modelButton.addEventListener('click', event => { event.stopPropagation(); this._toggleModelMenu() })
    this._modelMenu.addEventListener('click', event => event.stopPropagation())
    this._panel.addEventListener('click', () => this._closeModelMenu())
    this._addModel.addEventListener('click', () => this._addModelCard())
    this._dialogCancel.addEventListener('click', () => this._closeModelDialog())
    this._dialogSave.addEventListener('click', () => this._saveModels())
    this._overlay.addEventListener('click', event => { if (event.target === this._overlay) this._closeModelDialog() })
    this._dialog.addEventListener('keydown', event => this._dialogKeydown(event))
    this._applyTitle()
    this._updateControls()
  }

  _applyTitle() { if (this._titleEl) this._titleEl.textContent = this._title }

  _applyTheme() {
    const theme = this._theme === 'auto'
      ? (this._themeMedia && this._themeMedia.matches ? 'light' : 'dark')
      : this._theme
    this._panel.dataset.theme = theme
  }

  _setStatus(text) { if (this._status) this._status.textContent = text }
  _setError(text) {
    this._errorText.textContent = text || ''
    this._error.hidden = !text
    this._reconnect.hidden = !this._blocked && !(text && /授权|凭证|HTTP|连接/.test(text))
  }
  _message(error) { return error && error.message ? error.message : '请求失败，请检查网络后重试。' }
  _renderStatus() {
    this._setStatus(this._running ? '正在执行' : (this._blocked ? '需要核对' : (this._ready ? '空闲' : '正在连接')))
    this._updateControls()
  }
  _updateControls() {
    if (!this._send) return
    this._send.disabled = !this._ready || this._busy || this._running || !this._input.value.trim()
    this._input.disabled = !this._ready
    this._cancel.hidden = !this._running
    this._cancel.disabled = !this._ready || this._busy
  }

  _paint(state) {
    this._state = state
    this._cursor = state.cursor
    // 重绘前记录阅读位置：用户不在底部时保持原位，只有贴底时才继续跟随新消息。
    const stick = this._nearBottom()
    const offset = this._messages ? this._messages.scrollTop : 0
    this._messages.replaceChildren()
    for (const message of state.messages) {
      if (message.role !== 'user' && message.role !== 'assistant') continue
      const text = message.role === 'user' ? visibleUserText(message.content) : textOf(message.content)
      if (text) this._bubble(message.role, text)
    }
    if (state.pending) this._bubble('user', state.pending.text + '\n[本地待确认，可使用相同内容重试]')
    if (!this._messages.childNodes.length) {
      const empty = document.createElement('p')
      empty.className = 'panel-empty'
      empty.textContent = '还没有消息，开始与 Agent 对话。'
      this._messages.appendChild(empty)
    }
    this._renderApprovals(state.approvals)
    this._renderStatus()
    this._renderUsage()
    if (stick) this._scrollToBottom()
    else if (this._messages) this._messages.scrollTop = offset
  }

  _paintTransient(entries) {
    const stick = this._nearBottom()
    for (const entry of entries) {
      const event = entry && entry.event
      if (!event) continue
      if (event.type === 'assistant:delta') this._delta(event)
      else if (event.type === 'assistant:message') this._assistantFinal(event)
      else if (event.type === 'tool:start' || event.type === 'tool:result') this._toolEvent(event, true)
      else if (event.type === 'finished') {
        this._streams.forEach(stream => stream.el.remove())
        this._streams.clear()
        this._running = false
        this._renderStatus()
        this._emit('finished', { requestId: event.requestId || '', failed: Boolean(event.failed) })
      } else if (event.type === 'status') {
        this._setStatus(String(event.text || '正在执行').slice(0, 120))
      }
    }
    if (stick) this._scrollToBottom()
  }

  _stream(requestId) {
    const key = String(requestId || '')
    let stream = this._streams.get(key)
    if (stream) return stream
    const wrapper = this._bubble('assistant', '', true)
    stream = { el: wrapper.querySelector('.panel-bubble-body'), text: '', wrapper }
    this._streams.set(key, stream)
    return stream
  }

  _delta(event) {
    const stick = this._nearBottom()
    const stream = this._stream(event.requestId)
    stream.text += String(event.text || '')
    stream.el.dataset.raw = stream.text
    stream.el.textContent = stream.text
    if (stick) this._scrollToBottom()
  }

  _nearBottom() {
    const el = this._messages
    return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  _scrollToBottom() {
    const el = this._messages
    if (el) el.scrollTop = el.scrollHeight
  }

  _focusInput() {
    if (!this._input || this._input.disabled) return
    if (this._options && this._options.autoFocus === false) return
    try { this._input.focus({ preventScroll: true }) } catch (_) { this._input.focus() }
  }

  _assistantFinal(event) {
    const stream = this._streams.get(String(event.requestId || ''))
    const text = String(event.text || '')
    if (stream) {
      stream.el.textContent = text
      this._streams.delete(String(event.requestId || ''))
      if (!text.trim()) stream.wrapper.remove()
      return
    }
    if (text.trim()) this._bubble('assistant', text)
  }

  _bubble(role, text, streaming) {
    const wrapper = document.createElement('div')
    wrapper.className = 'panel-bubble ' + role + (streaming ? ' streaming' : '')
    const label = document.createElement('div')
    label.className = 'panel-bubble-label'
    label.textContent = role === 'user' ? '你' : 'Agent'
    const body = document.createElement('div')
    body.className = 'panel-bubble-body'
    this._setContent(body, text, role === 'assistant')
    body.querySelectorAll('.knowledge-citation').forEach(button => {
      const note = document.createElement('span')
      note.textContent = '[来源请在桌面端查看]'
      button.replaceWith(note)
    })
    if (text) wrapper.dataset.raw = String(text)
    wrapper.append(label, body)
    this._messages.appendChild(wrapper)
    return wrapper
  }

  _setContent(body, text, markdown) {
    const value = String(text === undefined || text === null ? '' : text)
    if (markdown && typeof renderMarkdown === 'function') {
      body.innerHTML = renderMarkdown(value)
      if (typeof highlightAll === 'function') highlightAll(body)
    } else body.textContent = value
  }

  _toolEvent(event, live) {
    if (!live) return
    if (event.type === 'tool:start') this._emit('tool', { phase: 'start', name: event.name || '' })
    else if (event.type === 'tool:result') this._emit('tool', { phase: 'result', name: event.name || '', outcome: event.outcome || '' })
  }

  _renderApprovals(items) {
    const key = JSON.stringify(items || [])
    if (this._approvalsKey === key) return
    this._approvalsKey = key
    this._approvalList.replaceChildren()
    this._approvals.hidden = !items || items.length === 0
    for (const item of items || []) {
      const card = document.createElement('article')
      card.className = 'panel-approval'
      const title = document.createElement('strong')
      title.textContent = String((item.request && item.request.title) || '操作需要你的确认')
      const detail = document.createElement('pre')
      detail.textContent = valueText(item.request)
      const expires = document.createElement('p')
      if (item.expiresAt) expires.textContent = '有效期至：' + new Date(item.expiresAt).toLocaleString()
      const actions = document.createElement('div')
      actions.className = 'panel-actions'
      const deny = document.createElement('button')
      deny.type = 'button'; deny.className = 'panel-button'; deny.textContent = '拒绝'
      const approve = document.createElement('button')
      approve.type = 'button'; approve.className = 'panel-button panel-primary'; approve.textContent = '批准'
      deny.addEventListener('click', () => this._decide(item, false))
      approve.addEventListener('click', () => this._decide(item, true))
      actions.append(deny, approve)
      card.append(title, detail, expires, actions)
      this._approvalList.appendChild(card)
      this._emit('approval-request', { id: item.id })
    }
  }
}

if (!customElements.get('agent-panel')) customElements.define('agent-panel', AgentPanelElement)

function defineAgentPanel() {
  if (!customElements.get('agent-panel')) customElements.define('agent-panel', AgentPanelElement)
  return AgentPanelElement
}

const AgentPanel = Object.freeze({
  tag: 'agent-panel',
  version: VERSION,
  element: AgentPanelElement,
  define: defineAgentPanel,
  async mount(container, options) {
    if (!container || typeof container.appendChild !== 'function') throw fail('mount 需要有效的容器元素。')
    defineAgentPanel()
    const element = document.createElement('agent-panel')
    element.style.display = 'block'
    container.appendChild(element)
    try { await element.connect(options) } catch (error) { element.remove(); throw error }
    return element
  },
  unmount(element) {
    if (!element) return
    if (typeof element.disconnect === 'function') element.disconnect()
    if (element.parentNode) element.parentNode.removeChild(element)
  }
})

export { AgentPanelElement, AgentPanel, defineAgentPanel }
export const version = VERSION
export default AgentPanel
