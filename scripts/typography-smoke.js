'use strict'

/* 排版验收（静态）：字体随包、令牌唯一真源、字号不再散落字面量。
   运行：node scripts/typography-smoke.js */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const R = (p) => path.join(ROOT, p)
const read = (p) => fs.readFileSync(R(p), 'utf8')
let passed = 0

function ok (name, condition, detail) {
  if (!condition) throw new Error('FAIL ' + name + (detail === undefined ? '' : ' :: ' + detail))
  passed += 1
  console.log('  ok  ' + name)
}

const typo = read('src/renderer/typography.css')
const style = read('src/renderer/style.css')
const html = read('src/renderer/index.html')
const server = read('server/index.js')

/* ---------- 字体文件 ---------- */
const fonts = [
  ['fonts/inter-400.woff2', 'Inter', 400],
  ['fonts/inter-500.woff2', 'Inter', 500],
  ['fonts/inter-600.woff2', 'Inter', 600],
  ['fonts/noto-sans-sc-400.woff2', 'Noto Sans SC', 400],
  ['fonts/noto-sans-sc-600.woff2', 'Noto Sans SC', 600],
  ['fonts/jetbrains-mono-400.woff2', 'JetBrains Mono', 400]
]
let total = 0
for (const [file, family, weight] of fonts) {
  const abs = R('src/renderer/' + file)
  ok('字体随包内置：' + file, fs.existsSync(abs), abs)
  const buffer = fs.readFileSync(abs)
  total += buffer.length
  ok('是合法 woff2：' + file, buffer.slice(0, 4).toString('latin1') === 'wOF2')
  ok('@font-face 声明齐备：' + family + ' ' + weight,
    new RegExp('font-family: "' + family + '"[\\s\\S]{0,120}?' + file.replace('fonts/', '') + '[\\s\\S]{0,120}?font-weight: ' + weight).test(typo))
}
ok('字体总量控制在 4MB 内（实际 ' + (total / 1048576).toFixed(2) + 'MB）', total < 4 * 1024 * 1024)

/* ---------- 令牌 ---------- */
for (const token of ['--font-ui', '--font-mono', '--font-size-caption', '--font-size-small',
  '--font-size-base', '--font-size-heading', '--font-size-title', '--font-size-display',
  '--font-weight-normal', '--font-weight-medium', '--font-weight-semibold']) {
  ok('令牌已定义：' + token, typo.indexOf(token + ':') > 0)
}
ok('拉丁在前、中文在后，回退链含微软雅黑',
  /--font-ui:\s*"Inter",\s*"Noto Sans SC".*"Microsoft YaHei UI",\s*"Microsoft YaHei"/.test(typo))
ok('等宽回退链含 Consolas', /--font-mono:\s*"JetBrains Mono",\s*Consolas/.test(typo))
ok('字号阶梯只有 6 档', (typo.match(/--font-size-[a-z]+:/g) || []).length === 6)
ok('字重只有 3 档', (typo.match(/--font-weight-[a-z]+:/g) || []).length === 3)

/* ---------- 加载顺序与 CSP ---------- */
const typoAt = html.indexOf('href="typography.css"')
const styleAt = html.indexOf('href="style.css"')
ok('typography.css 排在 style.css 之前', typoAt > 0 && typoAt < styleAt, typoAt + ' / ' + styleAt)
ok('CSP 允许本地字体（default-src self 覆盖 font-src）', /default-src 'self'/.test(html) && !/font-src[^;]*https?:/.test(html))
ok('静态服务给 woff2 正确 MIME', /\.woff2':\s*'font\/woff2'/.test(server))

/* ---------- style.css 不再有散落字面量 ---------- */
const css = style.replace(/\/\*[\s\S]*?\*\//g, '')
ok('base 字体走令牌，不再写 font: 简写', !/font:\s*\d/.test(css))
ok('没有裸 font-family（除 var）', (css.match(/font-family:(?!\s*var\()/g) || []).length === 0,
  (css.match(/font-family:(?!\s*var\()[^;]+/g) || []).slice(0, 3).join(' | '))
/* 裸 px 字号只允许出现在图标字形上：图标不是文案，跟着图形尺寸走才对。
   判据看选择器身份，不看数量，避免以后有人加一个「12px 小字」蒙过去。 */
const ICON_ONLY = /icon|arrow|-close|remove|::before|::after/
const pxRules = []
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = m[1].replace(/\s+/g, ' ').trim()
  if (/font-size:\s*[0-9.]+px/.test(m[2])) pxRules.push(selector)
}
const stray = pxRules.filter((selector) => !ICON_ONLY.test(selector))
ok('裸 px 字号只出现在图标字形上（' + pxRules.length + ' 处）', stray.length === 0, stray.slice(0, 4).join(' | '))

/* 图标字形保留原值：这几个是图标不是文案 */
for (const sel of ['.icon-button', '.small-icon', '.send-button', '.composer-attachment-remove', '.tl-icon']) {
  ok('图标字号保持不放大：' + sel, new RegExp('\\' + sel + '\\s*\\{[^}]*font-size:\\s*(?:18|16|13|10|9)px').test(css.replace(/\s+/g, ' ')))
}

/* 正文与代码该落到哪一档 */
const flat = css.replace(/\s+/g, ' ')
ok('正文级文字落到 base 档', /\.composer-input:empty::before\s*\{[^}]*var\(--font-size-base\)/.test(css.replace(/\s+/g, ' ')))
ok('数字等宽已开启', /font-variant-numeric:\s*tabular-nums/.test(css))
ok('代码走 mono 且关闭连字', /pre, code, kbd, samp \{[^}]*var\(--font-mono\)[^}]*font-variant-ligatures: none/.test(flat))
ok('代码块单独落到 13px 档', /pre \{ font-size: var\(--font-size-small\)/.test(flat))

console.log('typography: ' + passed + ' checks passed, node ' + process.version)
