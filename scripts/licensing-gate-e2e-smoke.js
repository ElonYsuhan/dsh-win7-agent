'use strict'

/**
 * licensing-gate-e2e-smoke.js — 启动授权门的真实渲染验收
 *
 * 背景：发行版门控（enforced:true）要打包后才出现，开发态 `licensingUI` 直接放行，
 * 所以这里用一个最小宿主页：真 style.css + 真 licensing.css + 真 licensing.js，
 * 只把 window.dsh.licenseRequest / quitApp 换成可控桩，就能在 Windows 上直接验
 * 布局、对比度、遮罩模糊、按钮收口与「试用用过之后隐藏」这些界面规则。
 *
 * 覆盖用户 2026-11-02 提的六条：
 *   1. 导出申请文件 / 重新检查 / 试用 全部收到底部
 *   2. 底部新增「取消」，点击关闭软件（走 app:quit）
 *   3. 按钮底色与卡片底色要能区分
 *   4. 遮罩要背景模糊
 *   5. 本机设备与授权申请不折叠，全部展开
 *   6. 试用用过之后，顶部提示与试用按钮都不再显示（试用期已改为 1 天）
 *
 * 用法：SMOKE_NO_SANDBOX=1 node scripts/licensing-gate-e2e-smoke.js
 */

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { BrowserDriver } = require('../src/main/agent/browser-driver')

const root = path.resolve(__dirname, '..')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const toUrl = target => 'file:///' + target.replace(/\\/g, '/').replace(/ /g, '%20')

async function wait (fn, label, times = 200) {
  for (let i = 0; i < times; i += 1) {
    try { if (await fn()) return } catch (_) { /* 页面还没就绪，继续等 */ }
    await sleep(60)
  }
  throw Error('Timeout ' + label)
}

function harness () {
  /* 排版令牌在 typography.css：缺了它，style.css 里的 var(--font-size-*) 全部失效，
     宿主页会用初始 16px 渲染，测出来的布局跟真界面不是一回事。 */
  const typography = toUrl(path.join(root, 'src/renderer/typography.css'))
  const style = toUrl(path.join(root, 'src/renderer/style.css'))
  const licenseCss = toUrl(path.join(root, 'src/renderer/licensing.css'))
  const script = toUrl(path.join(root, 'src/renderer/licensing.js'))
  /* 授权页的上传图标走全站图标库（data-icon + applyIcons），宿主页不引就只能测到空的 span。 */
  const icons = toUrl(path.join(root, 'src/renderer/icons.js'))
  const html = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<link rel="stylesheet" href="' + typography + '">',
    '<link rel="stylesheet" href="' + style + '">',
    '<link rel="stylesheet" href="' + licenseCss + '">',
    '</head><body>',
    /* 结构与 index.html 里的启动授权门逐字一致 */
    '<div id="licenseGate" class="modal license-gate" role="dialog" aria-modal="true"',
    ' aria-labelledby="licenseGateTitle" aria-describedby="licenseGateDescription">',
    '<section class="modal-card license-gate-card">',
    '<h2 id="licenseGateTitle">软件授权</h2>',
    '<p id="licenseGateDescription" class="muted">请导入本机授权文件，或开启一次1天试用。</p>',
    '<div id="licenseGateContent"></div>',
    '</section></div>',
    '<div id="licenseSettings"></div>',
    '<script>',
    'window.__state={status:"unlicensed",allowed:false,trialAvailable:true};',
    'window.__digest="a".repeat(64);',
    'window.dsh={',
    ' licenseRequest:(action)=>Promise.resolve(',
    '  ["status","trial"].includes(action)',
    '   ? Object.assign({},window.__state,{device:{deviceDigest:window.__digest,platform:"win32",arch:"x64",name:"test"},serverNow:Date.now()})',
    '   : {version:1,product:"dsh-agent",deviceDigest:window.__digest,platform:"win32",arch:"x64",name:"test"}),',
    ' quitApp:()=>{window.__quitCalled=true;return Promise.resolve(true)}',
    '};',
    'window.close=()=>{window.__closeCalled=true};',
    '<\/script>',
    '<script src="' + icons + '"><\/script>',
    '<script src="' + script + '"><\/script>',
    '</body></html>'
  ].join('')
  return html
}

/* 页面内取最后一个元素的简写（避免在模板串里写一长串 querySelector 链） */

const HELPER = 'window.contentlast=function(n){return n.lastElementChild};'
const LUM = '(function(c){var v=(c.match(/[0-9.]+/g)||[]).slice(0,3).map(Number).map(function(x){var s=x/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4)});return 0.2126*v[0]+0.7152*v[1]+0.0722*v[2]})'

async function main () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'license-gate-'))
  const page = path.join(dir, 'gate.html')
  fs.writeFileSync(page, harness())
  const driver = new BrowserDriver()
  const electronPath = path.join(root, 'node_modules/electron/dist', fs.readFileSync(path.join(root, 'node_modules/electron/path.txt'), 'utf8').trim())
  let passed = 0
  const ok = (label, value, detail) => { if (!value) throw Error('FAIL ' + label + (detail === undefined ? '' : ' :: ' + detail)); passed += 1; console.log('  ok  ' + label) }
  try {
    await driver.launch(toUrl(page), { electronPath, width: 1180, height: 820, noSandbox: process.env.SMOKE_NO_SANDBOX === '1' })
    await wait(() => driver.evaluate('!!window.licensingUI && document.querySelectorAll("#licenseGate .license-actions button").length>0'), 'gate rendered')
    await driver.evaluate(HELPER + 'true')

    ok('授权门默认是锁定的', await driver.evaluate('window.licensingUI.isLocked()'))

    /* ---- 1. 按钮全部收到底部一行，顺序固定 ---- */
    const bar = await driver.evaluate(`(function(){
      /* 上传区本身也是 <button>，它属于内容不属于操作，画面里排除掉 */
      var all=Array.from(document.querySelectorAll('#licenseGate button')).filter(function(b){return b.getClientRects().length&&!b.classList.contains('license-drop')})
      var row=document.getElementById('licenseGateContent').querySelector('.license-actions')
      var inside=Array.from(row.querySelectorAll('button')).map(function(b){return b.textContent})
      var content=document.getElementById('licenseGateContent'),card=document.querySelector('.license-gate-card')
      var last=contentlast(content)
      var r=row.getBoundingClientRect(),c=card.getBoundingClientRect()
      return {labels:inside,total:all.length,inRow:inside.length,
        lastBlock:!!last&&last.classList.contains('license-body')===false&&(!!last.previousElementSibling&&last.previousElementSibling.classList.contains('license-actions')),
        visible:r.top>=c.top-1&&r.bottom<=c.bottom+1&&r.height>20,
        scrollable:!!content.querySelector('.license-body')&&getComputedStyle(content.querySelector('.license-body')).overflowY==='auto'}
    })()`)
    ok('底部操作区按「取消 / 导出申请文件 / 重新检查 / 试用1天」排列', bar.labels.join('|') === '取消|导出申请文件|重新检查|试用1天', JSON.stringify(bar.labels))
    ok('门里所有操作按钮都在这一行里', bar.total === bar.inRow && bar.total === 4, JSON.stringify(bar))
    ok('这一行是内容区最后一块（下面只剩试用说明）', bar.lastBlock === true, JSON.stringify(bar))
    ok('小窗口下按钮行依然完整可见', bar.visible === true, JSON.stringify(bar))
    ok('内容过高时由内容区滚动，不把按钮挤出卡片', bar.scrollable === true, JSON.stringify(bar))
    ok('试用按钮文案已改成 1 天', (await driver.evaluate('document.querySelector("#licenseGate .license-primary").textContent')) === '试用1天')

    /* ---- 1b. 拖拽上传区的图标必须是真图标，不能退回文字字符 ---- */
    const dropIcon = await driver.evaluate(`(function(){
      var box=document.querySelector('#licenseGate .license-drop')
      if(!box)return{fail:'missing'}
      var ico=box.querySelector('.license-upload-icon')
      var svg=ico&&ico.querySelector('svg')
      var r=svg?svg.getBoundingClientRect():{width:0,height:0}
      return {text:ico?ico.textContent.trim():'',svg:!!svg,
        w:Math.round(r.width),h:Math.round(r.height),
        square:Math.abs(r.width-r.height)<=1,
        paths:svg?svg.querySelectorAll('path,rect,circle').length:0,
        stroke:svg?getComputedStyle(svg).stroke:'',
        strokeWidth:svg?getComputedStyle(svg).strokeWidth:'',
        color:svg?getComputedStyle(svg).color:''}
    })()`)
    ok('上传区图标是 SVG，不是文字箭头', dropIcon.svg === true && dropIcon.text === '', JSON.stringify(dropIcon))
    ok('上传图标是正方形的 28px', dropIcon.square && dropIcon.w === 28, JSON.stringify(dropIcon))
    ok('上传图标是描边图形而非实心块', dropIcon.paths >= 1 && dropIcon.stroke !== 'none' && parseFloat(dropIcon.strokeWidth) >= 1.5, JSON.stringify(dropIcon))

    /* ---- 2. 本机设备与授权申请：常驻展开 ---- */
    const device = await driver.evaluate(`(function(){
      var box=document.querySelector('#licenseGate .license-device')
      if(!box)return{fail:'missing'}
      return {details:document.querySelectorAll('#licenseGate details,#licenseGate summary').length,
        title:box.querySelector('.license-device-title').textContent,
        code:box.querySelector('.license-device-code').textContent,
        visible:box.getClientRects().length>0&&box.getBoundingClientRect().height>40}
    })()`)
    ok('申请区不再用 details 折叠', device.details === 0, JSON.stringify(device))
    ok('申请区默认就展开可见', device.visible === true, JSON.stringify(device))
    ok('申请区标题与申请标识都在', device.title === '本机设备与授权申请' && /申请标识：[A-F0-9-]{11}/.test(device.code), JSON.stringify(device))

    /* ---- 3. 整页观感而不是半透明浮层：遮罩完全不透明、盖满视口、不用模糊兜底 ---- */
    const mask = await driver.evaluate(`(function(){
      var node=document.getElementById('licenseGate')
      var gate=getComputedStyle(node)
      var rect=node.getBoundingClientRect()
      var a=(gate.backgroundColor.match(/[0-9.]+/g)||[]).slice(3)
      return {blur:gate.backdropFilter||gate.webkitBackdropFilter||'',
              alpha:a.length?Number(a[0]):1,
              covers:Math.abs(rect.width-innerWidth)<=1&&Math.abs(rect.height-innerHeight)<=1,
              raw:gate.backgroundColor}
    })()`)
    ok('授权页遮罩完全不透明（下层界面一个像素都看不到）', mask.alpha === 1, JSON.stringify(mask))
    ok('遮罩盖满整个视口', mask.covers === true, JSON.stringify(mask))
    ok('不再靠背景模糊遮下层', !/blur\(/.test(mask.blur), mask.blur)

    /* ---- 4. 按钮底色与卡片底色能区分（深/浅两套都要） ---- */
    for (const theme of ['dark', 'light']) {
      await driver.evaluate('document.documentElement.dataset.theme=' + JSON.stringify(theme) + ';true')
      await sleep(450)
      const tone = await driver.evaluate(`(function(){
        var card=getComputedStyle(document.querySelector('.license-gate-card')).backgroundColor
        var plain=getComputedStyle(document.querySelector('#licenseGate .license-actions button:not(.license-primary):not(.license-cancel)')).backgroundColor
        var primary=getComputedStyle(document.querySelector('#licenseGate .license-primary')).backgroundColor
        var lum=${LUM}
        return {card:lum(card),plain:lum(plain),primary:lum(primary),cardRaw:card,plainRaw:plain,primaryRaw:primary}
      })()`)
      ok(theme + ' 下普通按钮与卡片底色可区分', Math.abs(tone.plain - tone.card) >= 0.02, JSON.stringify(tone))
      ok(theme + ' 下试用按钮是反色主操作', Math.abs(tone.primary - tone.card) >= 0.3, JSON.stringify(tone))
    }
    await driver.evaluate('document.documentElement.dataset.theme="dark";true')
    await sleep(450)

    const firstShot = await driver.screenshot()
    fs.mkdirSync(path.join(root, 'release/validation'), { recursive: true })
    fs.writeFileSync(path.join(root, 'release/validation/license-gate-trial.png'), Buffer.from(firstShot, 'base64'))

    /* ---- 5. 试用用过之后：顶部提示、试用按钮、试用说明一起消失 ---- */
    await driver.evaluate("window.__state={status:'trial_expired',allowed:false,trialAvailable:false};window.licensingUI.refresh();true")
    await wait(() => driver.evaluate("document.getElementById('licenseGateDescription').hidden===true"), 'trial-used repaint')
    const hidden = await driver.evaluate(`(function(){
      var trial=document.querySelector('#licenseGate .license-primary')
      var help=document.querySelector('#licenseGate .license-trial-help')
      return {description:document.getElementById('licenseGateDescription').hidden,
        trial:trial.hidden||trial.getClientRects().length===0,
        help:help.hidden||help.getClientRects().length===0,
        buttons:Array.from(document.querySelectorAll('#licenseGate .license-actions button')).filter(function(b){return b.getClientRects().length}).map(function(b){return b.textContent})}
    })()`)
    ok('用过试用后顶部提示不再显示', hidden.description === true, JSON.stringify(hidden))
    ok('用过试用后不再有试用按钮', hidden.trial === true, JSON.stringify(hidden))
    ok('用过试用后试用说明一并撤掉', hidden.help === true, JSON.stringify(hidden))
    ok('按钮只剩取消/导出/重新检查', hidden.buttons.join('|') === '取消|导出申请文件|重新检查', JSON.stringify(hidden.buttons))
    ok('申请区依然常驻展开', await driver.evaluate('document.querySelector("#licenseGate .license-device").getBoundingClientRect().height>40'))
    const usedShot = await driver.screenshot()
    fs.writeFileSync(path.join(root, 'release/validation/license-gate-trial-used.png'), Buffer.from(usedShot, 'base64'))

    /* ---- 6. 取消 = 关闭软件 ---- */
    await driver.evaluate('window.__quitCalled=false;window.__closeCalled=false;true')
    await driver.click('#licenseGate .license-cancel')
    await sleep(120)
    const quit = await driver.evaluate('({quit:!!window.__quitCalled,close:!!window.__closeCalled})')
    ok('点取消会调用 quitApp（关闭软件）', quit.quit === true, JSON.stringify(quit))
    ok('随后关掉本窗口作为兜底', quit.close === true, JSON.stringify(quit))

    fs.writeFileSync(path.join(root, 'release/validation/licensing-gate.json'), JSON.stringify({
      buttonsAtBottom: true, cancelQuits: true, buttonsContrast: true, maskBlur: true,
      deviceAlwaysExpanded: true, trialUsedHidesPrompt: true, trialMs: 86400000, page
    }, null, 2))
    console.log('licensing gate ui: ' + passed + ' checks passed, node ' + process.version)
  } finally {
    try { await driver.finishClose() } catch (_) { /* 已关闭 */ }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
