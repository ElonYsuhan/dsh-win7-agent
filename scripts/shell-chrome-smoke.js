#!/usr/bin/env node
'use strict'

/**
 * 桌面壳窗口外观的冒烟：macOS 上「藏掉系统标题栏」这件事有没有被拆掉。
 *
 * 用户 2026-09-19 反馈窗口顶上那条白条难看，做法是三处配合：
 *   主进程 titleBarStyle:'hidden'（壳层 + 单体入口都要）
 *   preload 给 <html> 打 .shell-mac
 *   CSS 让出顶部留白 + 自建拖拽区（渲染层 + 壳层页面各一份）
 * 少任何一处，就会变成「红黄绿按钮压住品牌行」或者「窗口拖不动」，
 * 而且都是肉眼才看得出来 —— 所以按静态断言钉住，能进 npm run check 默认链路。
 *
 * 顺便做一次几何互检：留白算出来的高度必须盖过交通灯的下沿，
 * 防止哪天有人单方面把 trafficLightPosition.y 调大。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

let passed = 0
let failed = 0
let warned = 0

function check(name, condition, detail) {
  if (condition) {
    passed++
    console.log('PASS  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
    return true
  }
  failed++
  console.log('FAIL  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
  return false
}

function warn(name, detail) {
  warned++
  console.log('WARN  ' + name + (detail === undefined ? '' : '  [' + detail + ']'))
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8')
}

/**
 * 把主进程里的 macWindowChrome() 抠出来真跑一遍（stub 掉 process）。
 * 只断言「源码里出现过 titleBarStyle」是不够的：它完全可能被写在 darwin 判断外面，
 * 那样 Windows / Linux 也会被藏掉标题栏 —— Win7 上那是要出事的。
 */
function loadMacWindowChrome(source) {
  const body = /function macWindowChrome\s*\(\s*\)\s*\{([\s\S]*?)\n\}/.exec(source)
  if (!body) return null
  const values = /const MAC_TRAFFIC_LIGHT\s*=\s*\{([^}]*)\}/.exec(source)
  let trafficLight = null
  if (values) {
    try {
      trafficLight = new Function('return {' + values[1] + '}')() // eslint-disable-line no-new-func
    } catch (error) {
      trafficLight = null
    }
  }
  try {
    const fn = new Function('process', 'MAC_TRAFFIC_LIGHT', body[1]) // eslint-disable-line no-new-func
    return (platform) => fn({ platform: platform }, trafficLight)
  } catch (error) {
    return null
  }
}

/**
 * 抠出源码里的一个具名函数，并可把 process / systemPreferences 这类外界依赖**当参数注进去**。
 * 守卫要能真跑一遍逻辑，而不是只 grep 关键字 —— 关键字在、分支写反了，grep 是看不出来的。
 * 返回的包装函数签名是 (env, ...args)，env 按 envNames 的顺序取。
 */
function loadFunction(source, name, envNames) {
  const head = 'function ' + name
  const start = source.indexOf(head)
  if (start < 0) return null
  const open = source.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  let end = -1
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  if (end < 0) return null
  const rawParams = source.slice(start + head.length, open).replace(/[()\s]/g, '')
  const params = rawParams ? rawParams.split(',') : []
  const names = envNames || []
  try {
    const fn = new Function(...names, ...params, source.slice(open + 1, end)) // eslint-disable-line no-new-func
    return (env, ...args) => fn(...names.map((key) => env[key]), ...args)
  } catch (error) {
    return null
  }
}

/** 取某个选择器块的内容，取不到返回 ''。 */
function cssBlock(source, selectorRegex) {
  const block = new RegExp(selectorRegex.source + '\\s*\\{([\\s\\S]*?)\\}', 'm').exec(source)
  return block ? block[1] : ''
}

/**
 * 按选择器文本取块内容 —— 分组选择器（`a, b { }`）也能取到。
 * 用正则匹配 `选择器\s*\{` 那种写法在逗号分组前就断了，所以这里按文本定位。
 *
 * 必须先剥掉注释：CSS 注释里常顺手写一遍选择器（比如「与 src/renderer/style.css 的
 * .shell-mac .titlebar-drag 保持一致」），indexOf 会先撞上注释里的那串文本，
 * 于是取到注释后面第一个块 —— 取错块比取不到更难查。
 *
 * 另一个坑：这是**文本子串**匹配，`#app.sidebar-collapsed .sidebar` 会先命中同一前缀的
 * `#app.sidebar-collapsed .sidebar-toggle`。有这种前缀冲突时，选择器要带上结尾的 `{`
 * 一起传（`'#app.sidebar-collapsed .sidebar {'`），子串就不再重合。
 */
function blockAfter(source, selector) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, '')
  const at = clean.indexOf(selector)
  if (at < 0) return ''
  const open = clean.indexOf('{', at)
  if (open < 0) return ''
  const close = clean.indexOf('}', open)
  if (close < 0) return ''
  return clean.slice(open + 1, close)
}

/** 取某个选择器块里某条声明的第一个数值，取不到返回 null。 */
function cssNumber(source, selectorRegex, property) {
  const block = cssBlock(source, selectorRegex)
  if (!block) return null
  const declaration = new RegExp('(?:^|;)\\s*' + property + '\\s*:\\s*([^;]+)', 'm').exec(block)
  if (!declaration) return null
  const number = /(-?[\d.]+)/.exec(declaration[1])
  return number ? Number(number[1]) : null
}

/** 选择器出现在哪几行 —— 用来确认新样式没有漏掉 .shell-mac 前缀（漏了会波及 Win7 / 浏览器）。 */
function selectorLines(source, needle) {
  return source.split('\n').filter((line) => line.indexOf(needle) >= 0 && line.indexOf('{') >= 0)
}

/* ------------------------------------------------ 主进程：两个入口都要藏 */

const ENTRYPOINTS = ['shell/main.js', 'src/main/main.js']

for (const entry of ENTRYPOINTS) {
  const source = read(entry)
  const chrome = loadMacWindowChrome(source)

  if (check(entry + ' 有 macWindowChrome()', typeof chrome === 'function')) {
    const mac = chrome('darwin') || {}
    const win = chrome('win32') || {}
    const linux = chrome('linux') || {}

    check(entry + ' darwin 下 hidden 标题栏', mac.titleBarStyle === 'hidden', String(mac.titleBarStyle))
    check(entry + ' darwin 下带 trafficLightPosition', !!mac.trafficLightPosition)
    check(
      entry + ' trafficLightPosition 是合理的 x/y',
      !!mac.trafficLightPosition &&
        typeof mac.trafficLightPosition.x === 'number' &&
        typeof mac.trafficLightPosition.y === 'number' &&
        mac.trafficLightPosition.x >= 0 &&
        mac.trafficLightPosition.x <= 40 &&
        mac.trafficLightPosition.y >= 0 &&
        mac.trafficLightPosition.y <= 40,
      mac.trafficLightPosition ? mac.trafficLightPosition.x + ',' + mac.trafficLightPosition.y : 'n/a'
    )
    // Win7 约束：Windows / Linux 上不能碰标题栏
    check(entry + ' win32 下不动标题栏', Object.keys(win).length === 0, JSON.stringify(win))
    check(entry + ' linux 下不动标题栏', Object.keys(linux).length === 0, JSON.stringify(linux))
  }

  check(entry + ' 把 macWindowChrome() 展开进了 BrowserWindow', /\{\s*\.\.\.macWindowChrome\(\)/.test(source) ||
    /\.\.\.\s*macWindowChrome\s*\(\s*\)/.test(source))
}

{
  // 壳层有主窗口 + 设置窗口，两个都要；单体入口只有一个
  const shellSource = read('shell/main.js')
  const uses = shellSource.match(/\.\.\.\s*macWindowChrome\s*\(\s*\)/g) || []
  check('shell/main.js 主窗口 + 设置窗口都套上了', uses.length >= 2, uses.length + ' 处')
  /* macOS 红叉关窗 → activate 重建窗口：服务已就绪必须直接 loadURL 进界面，
     不能把新窗口留在 loading.html 上没人管（用户卡在「已就绪」启动页骂过） */
  const activateBlock = (shellSource.match(/app\.on\('activate'[\s\S]*?\n  \}\)/) || [''])[0]
  check('activate 重建窗口后服务就绪要直接进界面（不许卡启动页）',
    activateBlock.indexOf('resolvedServiceUrl') >= 0
      && activateBlock.indexOf('loadURL(resolvedServiceUrl)') >= 0,
    activateBlock ? 'matched' : 'activate 块没匹配到')
}

/* ------------------------------------------------ preload：平台标记 */

const PRELOADS = ['shell/preload.js', 'src/main/preload.js']

for (const file of PRELOADS) {
  const source = read(file)
  check(file + " 打上 shell-window 标记", source.indexOf("'shell-window'") >= 0)
  check(file + " darwin 时打上 shell-mac 标记", /darwin[\s\S]{0,120}shell-mac/.test(source))
  check(file + ' 标记挂在 documentElement 上', source.indexOf('documentElement') >= 0)
}

/* ------------------------------------------------ 双击顶栏：缩放 / 最小化 */

/* 原生标题栏被藏掉后，AppKit 那套「双击标题栏」手势跟着一起没了。
   Electron 把它留给应用自己实现（electron#16385），所以必须自己接 —— 这里守三件事：
   1. 动作确实按系统偏好 AppleActionOnDoubleClick 分派（不是写死 maximize）；
   2. 只在 darwin 上接，Windows / Linux 的原生标题栏还在，不能抢；
   3. 挂载点只认拖拽区，且两个入口 / 两个 preload 保持一致。 */

const DOUBLE_CLICK_MATRIX = [
  ['Maximize', 'maximize'],
  ['Minimize', 'minimize'],
  ['None', 'none'],
  [undefined, 'maximize'], // 用户没设过 → macOS 默认就是缩放
  ['SomethingElse', 'none']
]

for (const entry of ENTRYPOINTS) {
  const source = read(entry)
  check(entry + ' 引入了 systemPreferences', /\{\s*[^}]*systemPreferences[^}]*\}\s*=\s*require\('electron'\)/.test(source))
  check(entry + ' 注册了 shell:titlebar-dblclick', source.indexOf("'shell:titlebar-dblclick'") >= 0)

  const action = loadFunction(source, 'titlebarDoubleClickAction', ['process', 'systemPreferences'])
  if (check(entry + ' 抽得出 titlebarDoubleClickAction', typeof action === 'function')) {
    const darwin = { platform: 'darwin' }
    for (const pair of DOUBLE_CLICK_MATRIX) {
      let seenKey = ''
      const env = {
        process: darwin,
        systemPreferences: {
          getUserDefault: (key) => { seenKey = key; return pair[0] }
        }
      }
      const got = action(env, null)
      check(
        entry + ' 偏好 ' + (pair[0] === undefined ? '(未设置)' : pair[0]) + ' → ' + pair[1],
        got === pair[1] && seenKey === 'AppleActionOnDoubleClick',
        got + ' / key=' + seenKey
      )
    }
    // 偏好读不出来（受限环境）要退回 macOS 默认值，不能抛
    const broken = action({ process: darwin, systemPreferences: { getUserDefault: () => { throw new Error('nope') } } }, null)
    check(entry + ' 取不到偏好时退回缩放（不抛）', broken === 'maximize', String(broken))
    // Win7 / Linux：原生标题栏还在，这个手势归系统管，绝不能抢
    const win32 = action({ process: { platform: 'win32' }, systemPreferences: { getUserDefault: () => 'Maximize' } }, null)
    check(entry + ' win32 下不接管双击顶栏', win32 === 'none', String(win32))
  }

  const apply = loadFunction(source, 'applyTitlebarDoubleClick', [])
  if (check(entry + ' 抽得出 applyTitlebarDoubleClick', typeof apply === 'function')) {
    const calls = []
    const fakeWin = (maximized, destroyed) => ({
      isDestroyed: () => destroyed === true,
      isMaximized: () => maximized === true,
      maximize: () => calls.push('maximize'),
      unmaximize: () => calls.push('unmaximize'),
      minimize: () => calls.push('minimize')
    })
    calls.length = 0
    apply({}, fakeWin(false), 'maximize')
    check(entry + ' 未最大化时双击 → 最大化', calls.join(',') === 'maximize', calls.join(',') || '无调用')
    calls.length = 0
    apply({}, fakeWin(true), 'maximize')
    check(entry + ' 已最大化时双击 → 还原', calls.join(',') === 'unmaximize', calls.join(',') || '无调用')
    calls.length = 0
    apply({}, fakeWin(false), 'minimize')
    check(entry + ' 偏好为最小化时双击 → 最小化', calls.join(',') === 'minimize', calls.join(',') || '无调用')
    calls.length = 0
    apply({}, fakeWin(false), 'none')
    check(entry + ' 偏好为无动作时双击 → 什么都不做', calls.length === 0, calls.join(',') || 'ok')
    calls.length = 0
    apply({}, fakeWin(false, true), 'maximize')
    check(entry + ' 窗口已销毁时不动手', calls.length === 0, calls.join(',') || 'ok')
  }
}

/* 两个入口是同一套逻辑的两份拷贝，漂了就得有人发现 */
{
  const body = (file, name) => {
    const source = read(file)
    const at = source.indexOf('function ' + name)
    return at < 0 ? '' : source.slice(at, source.indexOf('\n}\n', at)).replace(/\s+/g, ' ')
  }
  for (const name of ['titlebarDoubleClickAction', 'applyTitlebarDoubleClick']) {
    check(
      '两个主进程入口的 ' + name + ' 一致',
      body('shell/main.js', name) !== '' && body('shell/main.js', name) === body('src/main/main.js', name)
    )
  }
}

for (const file of PRELOADS) {
  const source = read(file)
  check(file + ' 接了顶栏双击', source.indexOf('wireTitlebarDoubleClick') >= 0)
  check(file + ' 双击只在 darwin 上接管', /wireTitlebarDoubleClick[\s\S]{0,160}platform !== 'darwin'/.test(source))
  check(file + " 双击回发 'shell:titlebar-dblclick'", source.indexOf("'shell:titlebar-dblclick'") >= 0)
  check(file + ' 双击只认拖拽区（顶栏带子 / 品牌行）', source.indexOf("'#titlebarDrag, .brand'") >= 0)
  // 拖拽区里的按钮自带 no-drag，双击它们不该缩放窗口
  check(file + ' 双击排除按钮等交互元素', /closest\('button, a, input, select, textarea'\)/.test(source))
}

/* ------------------------------------------------ CSS：让位 + 拖拽区 */

let topBarHeight = null

{
  const css = read('src/renderer/style.css')

  /* 顶栏拖拽带：整条窗口顶边都要能按住拖窗口。
     踩过两次：先只在侧边栏顶部做了拖拽区（用户从正上方按住拖，拖不动），
     又把它挂在 CSS 伪元素上（Chromium 会不会认下来没把握，而且量不到、验不了）。
     所以现在它必须是**真实元素**，且只在 .shell-mac 下出现。 */
  const bandDefault = blockAfter(css, '.titlebar-drag {')
  check('拖拽带默认为隐藏（不参与布局）', /display\s*:\s*none/.test(bandDefault), bandDefault.trim())
  const bandBlock = blockAfter(css, '.shell-mac .titlebar-drag')
  check('渲染层有整宽顶栏拖拽带', bandBlock !== '')
  check('顶栏拖拽带可拖拽', /-webkit-app-region\s*:\s*drag/.test(bandBlock))
  topBarHeight = cssNumber(css, /\.shell-mac\s+\.titlebar-drag/, 'height')
  check('顶栏拖拽带高度是个正数', typeof topBarHeight === 'number' && topBarHeight > 0, String(topBarHeight))
  check('顶栏拖拽带贴在最顶上', cssNumber(css, /\.shell-mac\s+\.titlebar-drag/, 'top') === 0)
  check('顶栏拖拽带横贯整宽', /left\s*:\s*0/.test(bandBlock) && /right\s*:\s*0/.test(bandBlock))
  check('顶栏拖拽带压在内容之上', cssNumber(css, /\.shell-mac\s+\.titlebar-drag/, 'z-index') > 0)

  // 真元素才靠得住：拖拽区挂伪元素上，Chromium 未必算进可拖区域
  const dragLines = css.split('\n').filter((line) => line.indexOf('-webkit-app-region') >= 0)
  const dragOnPseudo = dragLines.filter((line) => line.indexOf('::') >= 0)
  check('拖拽区不挂在伪元素上', dragOnPseudo.length === 0, dragOnPseudo.join(' | ') || 'ok')

  /* 关键不变式：内容区下移的量必须等于拖拽带高度。
     不等的话，带子下面压着的就是消息区正文 —— 顶部一条会开始吞点击。 */
  const contentOffset = cssNumber(css, /\.shell-mac\s+\.content-frame/, 'margin-top')
  check(
    '内容区让开的高度 === 拖拽带高度',
    contentOffset !== null && contentOffset === topBarHeight,
    'offset=' + contentOffset + ' bar=' + topBarHeight
  )

  const spacerBlock = blockAfter(css, '.shell-mac .sidebar::before')
  check('渲染层有 .shell-mac .sidebar::before 留白', spacerBlock !== '')
  check('留白只负责让位、不挂拖拽区', /-webkit-app-region/.test(spacerBlock) === false)
  check('留白有固定高度', cssNumber(css, /\.shell-mac\s+\.sidebar::before/, 'height') !== null)
  // 负 margin 把 flex gap 抵掉，留白底边正好落在品牌行上沿（中间不留空档）
  const spacerMargin = cssNumber(css, /\.shell-mac\s+\.sidebar::before/, 'margin-bottom')
  check('留白用负 margin 抵掉 gap', spacerMargin !== null && spacerMargin < 0, String(spacerMargin))

  const brandBlock = blockAfter(css, '.shell-mac .brand {')
  check('品牌行也可拖拽', /-webkit-app-region\s*:\s*drag/.test(brandBlock))
  const brandButtonBlock = blockAfter(css, '.shell-mac .brand button')
  check('品牌行里的按钮退出拖拽区', /-webkit-app-region\s*:\s*no-drag/.test(brandButtonBlock))
  // 只在 mac 下生效，浏览器 / Win7 不受影响
  const beforeRules = selectorLines(css, '.sidebar::before')
  check(
    '渲染层留白只在 .shell-mac 下生效',
    beforeRules.length > 0 && beforeRules.every((line) => line.indexOf('.shell-mac') >= 0),
    beforeRules.join(' | ')
  )
}

/* ------------------------------------------------ 折叠按钮：顶栏那一行里 */

/* 用户 2026-09-19 的两次调整：① 折叠按钮要跟红黄绿同一行（原生 macOS 观感），
   展开时贴侧边栏右缘；② 折叠后**左边整片隐藏**，按钮落到红黄绿右边。
   两条都容易改回原样（原来是折叠成 64px 图标窄栏、按钮缩在侧边栏里），所以守起来。 */
{
  const css = read('src/renderer/style.css')
  const html = read('src/renderer/index.html')

  // 按钮必须挂在 #app 下 —— 折叠后 .sidebar 整个不显示了，留在里面就再也点不回去
  const asideAt = html.indexOf('<aside class="sidebar">')
  const buttonAt = html.indexOf('id="sidebarToggle"')
  check('index.html 里有折叠按钮', buttonAt >= 0)
  check('折叠按钮不在 .sidebar 里（折叠后侧边栏整个不显示）',
    buttonAt >= 0 && asideAt >= 0 && buttonAt < asideAt,
    'button@' + buttonAt + ' aside@' + asideAt)
  check('折叠按钮是 #app 的直接子元素', /<div id="app">[\s\S]{0,600}id="sidebarToggle"/.test(html))

  check('#app 是定位上下文（折叠按钮 absolute 的参照）', /#app\s*\{[\s\S]{0,120}position:\s*relative/.test(css))

  const base = blockAfter(css, '.sidebar-toggle {')
  check('折叠按钮是绝对定位', /position\s*:\s*absolute/.test(base))
  check('折叠按钮压在拖拽带之上（z-index 31）',
    cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'z-index') === 31,
    String(cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'z-index')))
  check('折叠按钮的位移有过渡（跟列宽动画对上）', /\btransition\s*:/.test(base))

  /* 不变式：展开时按钮贴侧边栏右缘 —— left + 按钮宽 === 侧边栏宽 − 内边距。
     这几个数散在 CSS 里，改了侧边栏宽度忘了改 left 是最容易出的错。 */
  const sidebarPad = cssNumber(css, /(?:^|\n)\.sidebar\s*\{/, 'padding')
  check('侧边栏宽度是 260px', /grid-template-columns:\s*260px/.test(css))
  const toggleLeft = cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'left')
  // .icon-button 的尺寸写在三行分组选择器里，cssNumber 的正则式取不到，按文本取块
  const sizeBlock = blockAfter(css, '.icon-button,\n.small-icon,\n.send-button {')
  const sizeMatch = /width:\s*(\d+)px/.exec(sizeBlock)
  const toggleSize = sizeMatch ? Number(sizeMatch[1]) : null
  check('折叠按钮贴侧边栏右缘（left + 宽 = 260 − 16）',
    toggleLeft !== null && toggleSize !== null && toggleLeft + toggleSize === 260 - 16,
    toggleLeft + ' + ' + toggleSize + ' vs ' + (260 - 16))
  check('侧边栏内边距仍是 16px', /\.sidebar\s*\{[\s\S]{0,200}padding:\s*18px 16px/.test(css), String(sidebarPad))

  // 折叠 = 左边整片消失，不再留窄栏
  const collapsed = blockAfter(css, '#app.sidebar-collapsed {')
  check('折叠后侧边栏那一列宽度归零', /grid-template-columns:\s*0\s+1fr/.test(collapsed), collapsed.trim())
  check('折叠后侧边栏整个不显示',
    /display\s*:\s*none/.test(blockAfter(css, '#app.sidebar-collapsed .sidebar {')))
  check('.main 在折叠时跨满两列', /grid-column\s*:\s*1\s*\/\s*-1/.test(blockAfter(css, '#app.sidebar-collapsed .main')))
  check('折叠后按钮落到窗口最左', cssNumber(css, /#app\.sidebar-collapsed\s+\.sidebar-toggle/, 'left') === 16,
    String(cssNumber(css, /#app\.sidebar-collapsed\s+\.sidebar-toggle/, 'left')))
  // 折叠态下不该再有「保留窄栏」的规则冒出来
  const railLeftovers = css.split('\n').filter((line) =>
    line.indexOf('#app.sidebar-collapsed') >= 0 && /\.(sidebar-rail|new-session|sidebar-scroll|sidebar-footer|brand)/.test(line))
  check('折叠态里没有残留的窄栏规则', railLeftovers.length === 0, railLeftovers.join(' | ') || 'ok')
}

/* ------------------------------------------- 右侧文件面板的折叠按钮（与左边那枚左右镜像）
   用户 2026-09-19：右面板要「右上角有一个折叠按钮，和左侧折叠相反」。
   两枚按钮**必须同一条中线**，否则一眼就看出歪（上一轮红黄绿那件事就是这么被抓出来的）。
   这条断言不带容差：top 必须完全相等。 */
{
  const css = read('src/renderer/style.css')
  const html = read('src/renderer/index.html')

  // 必须挂在 #app 下、不能塞进 .sidebar —— 侧边栏折叠时整片都 display:none，塞进去就再也点不回来了
  const sidebarClose = html.indexOf('</aside>')
  const panelToggleAt = html.indexOf('id="panelToggle"')
  check('面板按钮挂在 #app 下（不在 .sidebar 里）',
    panelToggleAt > 0 && sidebarClose > 0 && panelToggleAt > sidebarClose,
    'aside@' + sidebarClose + ' toggle@' + panelToggleAt)

  // 与左边的按钮共用同一个 top（基线 22 / macOS 9）
  const baseTopLeft = cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'top')
  const baseTopRight = cssNumber(css, /(?:^|\n)\.panel-toggle/, 'top')
  check('两枚折叠按钮基线 top 完全相等', baseTopLeft !== null && baseTopLeft === baseTopRight,
    '左=' + baseTopLeft + ' 右=' + baseTopRight)
  const macTopLeft = cssNumber(css, /\.shell-mac\s+\.sidebar-toggle/, 'top')
  const macTopRight = cssNumber(css, /\.shell-mac\s+\.panel-toggle/, 'top')
  check('macOS 上两枚按钮 top 也完全相等（都对红黄绿中线）',
    macTopLeft !== null && macTopLeft === macTopRight,
    '左=' + macTopLeft + ' 右=' + macTopRight)

  // 基线必须存在（不能整条被 .shell-mac 裹住，否则 Win/Linux 上按钮会掉回文档流）
  const panelToggleLines = selectorLines(css, '.panel-toggle')
  check('面板按钮有基线规则（Win/Linux 也生效）',
    panelToggleLines.some((line) => line.indexOf('.shell-mac') < 0),
    panelToggleLines.map((l) => l.trim()).join(' | ') || '(无)')

  check('面板按钮压在拖拽带之上（z-index 31）',
    cssNumber(css, /(?:^|\n)\.panel-toggle/, 'z-index') === 31,
    String(cssNumber(css, /(?:^|\n)\.panel-toggle/, 'z-index')))
  check('面板按钮在 macOS 上退出拖拽带',
    /-webkit-app-region\s*:\s*no-drag/.test(blockAfter(css, '.shell-mac .panel-toggle {')))

  // 展开后要跟着面板让位 —— 否则按钮会飘在面板中间
  const openBlock = blockAfter(css, '#app.panel-open .panel-toggle {')
  check('面板展开后按钮让开面板宽度',
    /\bright\s*:\s*calc\(\s*var\(--panel-width[^)]*\)\s*\+\s*16px\s*\)/.test(openBlock),
    openBlock.replace(/\s+/g, ' ').trim())
  check('面板按钮收起时贴窗口最右（right:16）',
    cssNumber(css, /(?:^|\n)\.panel-toggle/, 'right') === 16,
    String(cssNumber(css, /(?:^|\n)\.panel-toggle/, 'right')))
}

/* ------------------------------------------- 三列网格：面板列不能把会话区吃掉
   面板是 #app 的第三列。三列的边界线是 1|2|3|4，所以：
     · .main 固定第 2 列；
     · 侧边栏折叠（左边 display:none）时 .main 跨 1/-1 是够的 —— 但**面板一开就不够**，
       那会把它一路铺到面板底下去，必须改成 1/3。 */
{
  const css = read('src/renderer/style.css')
  check('面板列宽走 --panel-width 变量（不是写死 px）',
    /grid-template-columns:\s*260px 1fr var\(--panel-width/.test(blockAfter(css, '#app.panel-open {')))
  check('侧边栏折叠的同时开了面板：.main 只跨前两列',
    /grid-column\s*:\s*1\s*\/\s*3/.test(blockAfter(css, '#app.sidebar-collapsed.panel-open .main {')))
  check('面板收起时第三列不存在（整块 display:none）',
    /display\s*:\s*none/.test(blockAfter(css, '#app:not(.panel-open) .file-panel {')))
}

/* ------------------------------------------- Win / Linux 基线：别被 .shell-mac 带走
   用户 2026-09-19 提的：「这是 mac，至于 linux 还有 win 我不晓得效果是咋样的，因为我没法验证」。
   渲染层对 .shell-mac 没有任何 JS 依赖，Windows / Linux 与 macOS 的差异**全在 CSS**，
   所以这里把「没有 .shell-mac 时会怎样」钉死：
     - 折叠按钮的定位走基线规则（不能整条被 .shell-mac 裹住，否则 Win/Linux 上按钮会失位）；
     - 拖拽带基线必须 display:none（否则 Win/Linux 上会铺一层透明遮罩，把顶栏点击全吃掉）；
     - 内容区基线不留顶部 40px（那是给 macOS 拖拽带让位的，Win/Linux 上没有原生标题栏以外的带子）。
   真机几何由 scripts/shell-drag-smoke.js 的 Win/Linux 那一轮验（摘掉 .shell-mac 再量一遍）。 */
{
  const css = read('src/renderer/style.css') // 上一个是块作用域，这里重取一份
  const toggleSelectors = selectorLines(css, '.sidebar-toggle')
  const baseSelectors = toggleSelectors.filter((line) => line.indexOf('.shell-mac') < 0)
  const macSelectors = toggleSelectors.filter((line) => line.indexOf('.shell-mac') >= 0)

  // 展开 / 折叠两条基线必须**不带** .shell-mac —— 否则 Win/Linux 上按钮根本没有定位规则，会掉回文档流。
  // 第三条是窄窗口 @media 里的 left:10px，也是基线（Win/Linux 同样生效），所以是 >= 2 而不是 == 2。
  check('折叠按钮有基线规则（Win/Linux 也生效）', baseSelectors.length >= 2,
    baseSelectors.map((l) => l.trim()).join(' | ') || '(无)')
  check('基线里有一条负责横向定位（left）',
    baseSelectors.some((line) => line.indexOf('left') >= 0) ||
    cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'left') !== null,
    String(cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'left')))
  // 反过来：macOS 那套偏移不能混进基线，否则 Win/Linux 上按钮会偏 17px
  check('macOS 的 top 偏移没混进基线',
    cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'top') !== cssNumber(css, /\.shell-mac\s+\.sidebar-toggle/, 'top'),
    'base=' + cssNumber(css, /(?:^|\n)\.sidebar-toggle/, 'top') + ' mac=' + cssNumber(css, /\.shell-mac\s+\.sidebar-toggle/, 'top'))

  // macOS 只改 top / no-drag（展开）与 left（折叠），且必须裹在 .shell-mac 里 —— 漏了前缀会波及 Win/Linux
  const macBlock = blockAfter(css, '.shell-mac .sidebar-toggle {')
  check('macOS 只在 .shell-mac 里改 top / no-drag',
    /\btop\s*:/.test(macBlock) && /-webkit-app-region\s*:\s*no-drag/.test(macBlock),
    macBlock.replace(/\s+/g, ' ').trim())
  const collapsedMacBlock = blockAfter(css, '.shell-mac #app.sidebar-collapsed .sidebar-toggle {')
  check('macOS 只在 .shell-mac 里改折叠态 left（让开红黄绿）',
    /\bleft\s*:/.test(collapsedMacBlock), collapsedMacBlock.replace(/\s+/g, ' ').trim())
  check('折叠态的两条规则一基线一 mac 覆盖', macSelectors.length === 2,
    macSelectors.map((l) => l.trim()).join(' | '))
  // 基线那条不该顺手关掉拖拽 —— no-drag 是给 macOS 拖拽带准备的
  check('基线没有给折叠按钮强加 no-drag', !/-webkit-app-region\s*:\s*no-drag/.test(blockAfter(css, '.sidebar-toggle {')))

  // Win/Linux 上压根没有拖拽带：基线 display:none，否则会铺一层透明遮罩把顶栏点击全吃掉
  check('拖拽带基线是 display:none（Win/Linux 不铺遮罩）',
    /display\s*:\s*none/.test(blockAfter(css, '.titlebar-drag {')))
  // Win/Linux 的内容区不该白留 40px（那是给 macOS 拖拽带让位的）
  const baseFrame = blockAfter(css, '.content-frame {').replace(/\s+/g, ' ').trim()
  check('内容区基线不留顶部 40px（那是 macOS 让位用的）',
    !/\bmargin-top\s*:/.test(baseFrame) && /\bmargin\s*:\s*0\s+auto/.test(baseFrame), baseFrame)
}

/* 拖拽带是真实元素，所以每个页面都得有它 —— 元素漏了的话，样式再对也拖不动 */
for (const file of ['src/renderer/index.html', 'shell/loading.html', 'shell/settings.html',
  'shell/offline.html', 'shell/update.html']) {
  const html = read(file)
  const at = html.indexOf('id="titlebarDrag"')
  check(file + ' 有 #titlebarDrag 元素', at >= 0)
  check(file + ' 的拖拽带挂在 <body> 之后', at >= 0 && html.indexOf('<body>') < at)
}

{
  const css = read('shell/style.css')
  check('壳层页面顶部让位', cssNumber(css, /\.shell-mac\s+body/, 'padding-top') !== null)
  const shellBandBlock = blockAfter(css, '.shell-mac .titlebar-drag')
  check('壳层页面拖拽带可拖拽', /-webkit-app-region\s*:\s*drag/.test(shellBandBlock))
  const shellBandHeight = cssNumber(css, /\.shell-mac\s+\.titlebar-drag/, 'height')
  check(
    '壳层页面拖拽带与主界面等高',
    shellBandHeight === topBarHeight,
    shellBandHeight + ' vs ' + topBarHeight
  )
  check(
    '壳层页面拖拽带高度不超过顶部让位',
    shellBandHeight <= cssNumber(css, /\.shell-mac\s+body/, 'padding-top'),
    shellBandHeight + ' <= ' + cssNumber(css, /\.shell-mac\s+body/, 'padding-top')
  )
}

/* ------------------------------------------------ 几何互检：留白够不够高 */

/* 红黄绿的几何 —— **实测值，不是推的**。
   MAC_TRAFFIC_LIGHT = {x:16, y:16} 只是 Electron 收的那个「簇位置」，
   灯的**圆心**并不落在 y + 6 上。用户 2026-09-19 的截图（折叠态、浅色）量出来：
     三颗 12px 圆，圆心 y = 24（= 簇 y + 8），圆心 x = 22 / 42 / 62（间距 20）；
     图标墨迹中心当时在 y = 20，比灯心高 4px —— 反推灯心就是 24。
   所以这里按 centerOffset 建账，别再想当然写 +6。 */
const TRAFFIC = { radius: 6, centerOffset: 8, spacing: 20, widthAcross: 52 }

{
  const css = read('src/renderer/style.css')
  const entry = loadMacWindowChrome(read('shell/main.js'))
  const light = entry ? entry('darwin').trafficLightPosition : null

  const paddingTop = cssNumber(css, /^\.sidebar/, 'padding') // 简写成 padding: 18px 16px
  const gap = cssNumber(css, /^\.sidebar/, 'gap')
  const spacer = cssNumber(css, /\.shell-mac\s+\.sidebar::before/, 'height')
  const spacerMargin = cssNumber(css, /\.shell-mac\s+\.sidebar::before/, 'margin-bottom')

  if (!light || paddingTop === null || gap === null || spacer === null || spacerMargin === null) {
    warn('几何互检跳过（有选择器/声明没解析出来）',
      [light && light.y, paddingTop, gap, spacer, spacerMargin].join('/'))
  } else {
    // 灯的圆心在 light.y + centerOffset，下沿再加半径
    const bottom = light.y + TRAFFIC.centerOffset + TRAFFIC.radius
    const brandTop = paddingTop + spacer + spacerMargin + gap
    check('侧边栏留白盖过交通灯下沿', brandTop >= bottom + 8, 'brandTop=' + brandTop + ' trafficBottom=' + bottom)
    // 留白的盒子底边要正好落在品牌行上沿，中间不能空出可拖的死区
    check(
      '留白与品牌行的拖拽区首尾相接',
      paddingTop + spacer === brandTop,
      'spacerBottom=' + (paddingTop + spacer) + ' brandTop=' + brandTop
    )
  }
}

/* -------------------------------- 几何互检：折叠按钮与红黄绿同一行 */

{
  const css = read('src/renderer/style.css')
  const entry = loadMacWindowChrome(read('shell/main.js'))
  const light = entry ? entry('darwin').trafficLightPosition : null

  const toggleTop = cssNumber(css, /\.shell-mac\s+\.sidebar-toggle/, 'top')
  const sizeMatch2 = /width:\s*(\d+)px/.exec(blockAfter(css, '.icon-button,\n.small-icon,\n.send-button {'))
  const toggleSize = sizeMatch2 ? Number(sizeMatch2[1]) : null
  const collapsedLeft = cssNumber(css, /\.shell-mac\s+#app\.sidebar-collapsed\s+\.sidebar-toggle/, 'left')

  if (!light || toggleTop === null || toggleSize === null || collapsedLeft === null) {
    warn('折叠按钮几何互检跳过（有选择器/声明没解析出来）',
      [light && light.y, toggleTop, toggleSize, collapsedLeft].join('/'))
  } else {
    // 按钮墨迹在 30px 盒子里是居中的（svg 16×16 / viewBox 24，rect y 4..20），
    // 所以「盒子中线 === 墨迹中线」，跟灯心精确对齐即可 —— 这里不用容差。
    const trafficCenter = light.y + TRAFFIC.centerOffset
    const toggleCenter = toggleTop + toggleSize / 2
    check('折叠按钮与红黄绿中线精确对齐',
      toggleCenter === trafficCenter,
      'toggleCenter=' + toggleCenter + ' trafficCenter=' + trafficCenter)
    // 折叠后按钮落在红黄绿右侧：左缘要在灯的右沿之外
    check('折叠后按钮在红黄绿右侧',
      collapsedLeft >= light.x + TRAFFIC.widthAcross && collapsedLeft <= light.x + 90,
      'left=' + collapsedLeft + ' 灯右沿≈' + (light.x + TRAFFIC.widthAcross))
    check('折叠按钮落在 40px 顶栏那一行内',
      toggleTop >= 0 && toggleTop + toggleSize <= 40,
      toggleTop + ' + ' + toggleSize + ' <= 40')
  }
}

console.log('')
if (failed > 0) {
  console.log('shell chrome smoke: ' + passed + '/' + (passed + failed) + ' checks passed, ' + failed + ' FAILED')
  process.exit(1)
}
console.log(
  'shell chrome smoke: ' + passed + '/' + (passed + failed) + ' checks passed' +
  (warned > 0 ? ', ' + warned + ' warning(s)' : '') +
  ', node ' + process.version
)
