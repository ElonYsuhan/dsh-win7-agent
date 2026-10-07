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
