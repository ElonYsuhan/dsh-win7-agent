#!/usr/bin/env node
'use strict'

/**
 * macOS 顶栏拖拽带的真机冒烟：拿真实 Electron 窗口 + 真实 index.html 跑一遍，
 * 量出拖拽带到底在哪儿、有没有被别的东西盖住。
 *
 * 为什么值得单独写一个：这一处我判断错过两次 ——
 *   1. 一开始只在侧边栏顶部做拖拽区，用户从窗口正上方按住拖，拖不动；
 *   2. 接着把区域挂在 CSS 伪元素（::before）上，而 Chromium 会不会把
 *      伪元素算进拖拽区并没有把握，且量不到、验不了。
 * 现在拖拽带是**真实元素**（各页面 <body> 里的 #titlebarDrag），于是可以在这里
 * 用 getBoundingClientRect 量、用 elementFromPoint 验命中 —— 盖不住才拖得动。
 *
 * 需要 Electron 运行时，所以不进 npm run check 默认链路（同 check:shellpage）。
 *   node scripts/shell-drag-smoke.js      # 或 npm run check:drag
 */

const path = require('path')
const http = require('http')
const fs = require('fs')
const os = require('os')
const { spawnSync } = require('child_process')

const not = (value) => value ? false : true

const ROOT = path.resolve(__dirname, '..')
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer')

/* ------------------------------------------------------- 找 Electron 运行时 */

function electronBinaryIn(dir) {
  if (process.platform === 'darwin') {
    return path.join(dir, 'Electron.app', 'Contents', 'MacOS', 'Electron')
  }
  if (process.platform === 'win32') return path.join(dir, 'electron.exe')
  return path.join(dir, 'electron')
}

function findElectron() {
  const unpackedName = process.platform === 'win32'
    ? 'win32-x64'
    : (process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64')
  const candidates = [
    path.join(ROOT, 'node_modules', 'electron', 'dist'),
    path.join(ROOT, 'release', '.electron-dist', 'unpacked', unpackedName),
    path.join(ROOT, 'release', '.electron-dist', 'unpacked', 'darwin-x64')
  ]
  for (const dir of candidates) {
    const binary = electronBinaryIn(dir)
    try {
      if (fs.existsSync(binary)) return binary
    } catch (error) {}
  }
  return ''
}

let passed = 0
let failed = 0

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

/**
 * 从主进程源码里抠一个具名函数出来 —— 真机冒烟要跑「真的那一份」，不是复刻一份。
 * 简单数括号配对即可：这两个函数里没有带花括号的字符串字面量。
 */
function extractFunction(source, name) {
  const head = 'function ' + name
  const at = source.indexOf(head)
  if (at < 0) return null
  const open = source.indexOf('{', at)
  if (open < 0) return null
  const rawParams = source.slice(at + head.length, open).replace(/[()\s]/g, '')
  const params = rawParams ? rawParams.split(',') : []
  let depth = 0
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        try {
          return new Function(...params, source.slice(open + 1, i)) // eslint-disable-line no-new-func
        } catch (error) {
          return null
        }
      }
    }
  }
  return null
}

/* 用 http 起一个最小静态服务：file:// 下 CSP 'self' 会挡掉脚本，
   而 index.html 是平时由内网服务托管的，这样最接近真实运行环境。 */
/* 面板那段要真的「滚得动」，就得有一个够长的文件当预览内容。
   真机上不落盘，这里虚拟一篇出来（由下面的 fs:text IPC 喂给面板）。 */
const VIRTUAL_LONG_TEXT = Array.from({ length: 400 }, (_, i) => 'line ' + (i + 1) + '  print("hello")  # 中文注释').join('\n')
/* 同内容的 CRLF 版：编辑器要证明「写回时换行没被 textarea 吃掉」 */
const VIRTUAL_CRLF_TEXT = VIRTUAL_LONG_TEXT.split('\n').join('\r\n')

function serveRenderer() {
  const server = http.createServer((req, res) => {
    const target = req.url.split('?')[0]
    const file = path.join(RENDERER_DIR, target === '/' ? 'index.html' : target)
    if (not(file.startsWith(RENDERER_DIR)) || not(fs.existsSync(file))) {
      res.writeHead(404); res.end(); return
    }
    const ext = path.extname(file)
    const type = ext === '.css' ? 'text/css' : (ext === '.js' ? 'application/javascript' : 'text/html')
    res.writeHead(200, { 'content-type': type + '; charset=utf-8' })
    res.end(fs.readFileSync(file))
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

/* 在页面里跑的探针：把拖拽带的几何、层叠、命中情况一次性量出来 */
const PROBE = `(() => {
  const band = document.getElementById('titlebarDrag');
  if (!band) return { missing: true };
  const html = document.documentElement;
  html.classList.add('shell-mac');
  const rect = band.getBoundingClientRect();
  const cs = getComputedStyle(band);
  const frame = document.querySelector('.content-frame');
  const frameRect = frame ? frame.getBoundingClientRect() : null;
  const toggle = document.getElementById('sidebarToggle');
  const toggleRect = toggle ? toggle.getBoundingClientRect() : null;
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'null';
    const name = (node) => {
      /* SVG 元素的 className 是 SVGAnimatedString，直接 String() 会得到
         '[object SVGAnimatedString]'，得先取 baseVal。 */
      const cls = typeof node.className === 'string'
        ? node.className
        : (node.className && node.className.baseVal) || '';
      return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
    };
    /* 命中的常是按钮里那一层 svg/span，再带上最近一个有 id 的祖先 ——
       这样断言既看得出点到了哪儿，也看得出它属于谁。 */
    const owner = el.closest && el.closest('[id]');
    return name(el) + (owner && owner !== el ? ' < ' + name(owner) : '');
  };
  const w = window.innerWidth;
  const pageActions = document.getElementById('pageActions');
  const paRect = pageActions ? pageActions.getBoundingClientRect() : null;
  const center = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return 'missing';
    const r = el.getBoundingClientRect();
    return at(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  };
  const runHint = document.getElementById('composerRunHint');
  return {
    missing: false,
    appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
    display: cs.display,
    position: cs.position,
    zIndex: cs.zIndex,
    rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
    innerWidth: w,
    innerHeight: window.innerHeight,
    scrollHeight: html.scrollHeight,
    frameTop: frameRect ? Math.round(frameRect.top) : null,
    /* 顶栏那组页面操作（刷新整页 / 转发链接）：2026-09-19 新增，
       位置跟 .sidebar-toggle 绑在一起，同样必须压在拖拽带之上、点得到。 */
    pageActions: paRect ? {
      left: Math.round(paRect.left),
      right: Math.round(paRect.right),
      cy: Math.round(paRect.top + paRect.height / 2),
      display: getComputedStyle(pageActions).display,
      region: getComputedStyle(pageActions).webkitAppRegion,
      z: Number(getComputedStyle(pageActions).zIndex),
      refreshHit: center('#pageRefresh'),
      shareHit: center('#pageShare')
    } : null,
    runHint: runHint ? { exists: true, hidden: runHint.className.indexOf('hidden') !== -1 } : { exists: false },
    toggle: toggleRect ? {
      top: Math.round(toggleRect.top),
      left: Math.round(toggleRect.left),
      cx: Math.round(toggleRect.left + toggleRect.width / 2),
      cy: Math.round(toggleRect.top + toggleRect.height / 2),
      bottom: Math.round(toggleRect.bottom),
      region: getComputedStyle(toggle).webkitAppRegion,
      z: Number(getComputedStyle(toggle).zIndex),
      hit: at(Math.round(toggleRect.left + toggleRect.width / 2), Math.round(toggleRect.top + toggleRect.height / 2))
    } : null,
    sidebarWidth: Math.round((document.querySelector('.sidebar') || { getBoundingClientRect: () => ({ width: 0 }) }).getBoundingClientRect().width),
    hitMiddleTop: at(Math.round(w / 2), 20),
    hitOverSidebar: at(100, 20),
    hitTopLeft: at(30, 22),
    hitJustBelow: at(Math.round(w / 2), 46)
  };
})()`

/* 折叠态：左侧应当整片消失，折叠按钮挪到红黄绿右边，内容区铺满整宽。
   加分两步是因为 grid-template-columns / left 都有 0.18s 过渡 ——
   同一个同步块里加 class 再量，量到的是动画**起点**的值。 */
const FOLD_ON = `(() => {
  const app = document.getElementById('app');
  if (!app) return false;
  app.classList.add('sidebar-collapsed');
  return true;
})()`

const PROBE_COLLAPSED = `(() => {
  const sidebar = document.querySelector('.sidebar');
  const sidebarCs = sidebar ? getComputedStyle(sidebar) : null;
  const main = document.querySelector('.main');
  const toggle = document.getElementById('sidebarToggle');
  const tr = toggle ? toggle.getBoundingClientRect() : null;
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'null';
    const name = (node) => {
      /* SVG 元素的 className 是 SVGAnimatedString，直接 String() 会得到
         '[object SVGAnimatedString]'，得先取 baseVal。 */
      const cls = typeof node.className === 'string'
        ? node.className
        : (node.className && node.className.baseVal) || '';
      return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
    };
    /* 命中的常是按钮里那一层 svg/span，再带上最近一个有 id 的祖先 ——
       这样断言既看得出点到了哪儿，也看得出它属于谁。 */
    const owner = el.closest && el.closest('[id]');
    return name(el) + (owner && owner !== el ? ' < ' + name(owner) : '');
  };
  const w = window.innerWidth;
  return {
    missing: false,
    sidebarDisplay: sidebarCs ? sidebarCs.display : 'missing',
    sidebarVisible: sidebar ? sidebar.getBoundingClientRect().width > 0 : false,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    innerWidth: w,
    toggle: tr ? {
      left: Math.round(tr.left),
      cx: Math.round(tr.left + tr.width / 2),
      cy: Math.round(tr.top + tr.height / 2),
      hit: at(Math.round(tr.left + tr.width / 2), Math.round(tr.top + tr.height / 2))
    } : null,
    // 原侧边栏那一列现在的落点：应该已经是内容区，不再是侧边栏
    hitWhereSidebarWas: at(30, 300),
    /* 折叠后这组页面操作要挪到折叠按钮**右边**（118），
       否则会撞上 macOS 红黄绿（占 x=16..68）。 */
    pageActions: (() => {
      const pa = document.getElementById('pageActions');
      if (!pa) return null;
      const r = pa.getBoundingClientRect();
      return {
        left: Math.round(r.left),
        cx: Math.round(r.left + r.width / 2),
        cy: Math.round(r.top + r.height / 2),
        hit: at(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2))
      };
    })(),
    railVisible: (() => {
      const rail = document.querySelector('.sidebar-rail');
      return rail ? rail.getBoundingClientRect().width > 0 : false;
    })()
  };
})()`

/* ------------------------------------------- Win / Linux 那一轮（用户 2026-09-19 明确要求过）
   「这是 mac，至于 linux 还有 win 我不晓得效果是咋样的，因为我没法验证」。
   渲染层对 .shell-mac **没有一行 JS 依赖**（只有 style.css 的 14 条规则），
   所以「把 .shell-mac 摘掉」就是 Win/Linux 下完全一致的 CSS 输入 —— 真机量一遍即可。
   在真正的 Win/Linux 上这一步是空操作（preload 本来就不加那个类），量到的就是实况。 */
const STRIP_MAC = `(() => {
  document.documentElement.classList.remove('shell-mac');
  document.getElementById('app').classList.remove('sidebar-collapsed');
  return document.documentElement.className;
})()`

const ADD_MAC = `(() => {
  document.documentElement.classList.add('shell-mac');
  return document.documentElement.className;
})()`

/* 右侧文件面板（一期）：量两枚折叠按钮 + 面板几何。
   把手/面板宽度都走 CSS 变量，这里只读结果，不去碰内部状态。 */
const PROBE_PANEL = `(() => {
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right),
             bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height),
             cx: Math.round(b.left + b.width / 2), cy: Math.round(b.top + b.height / 2) };
  };
  const name = (node) => {
    const cls = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
  };
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'null';
    const owner = el.closest && el.closest('[id]');
    return name(el) + (owner && owner !== el ? ' < ' + name(owner) : '');
  };
  const left = document.getElementById('sidebarToggle');
  const right = document.getElementById('panelToggle');
  const panel = document.getElementById('filePanel');
  const main = document.querySelector('.main');
  const handle = document.getElementById('panelResize');
  const lr = rect(left);
  const rr = rect(right);
  return {
    missing: !left || !right || !panel,
    open: document.getElementById('app').classList.contains('panel-open'),
    left: lr,
    right: rr,
    panel: rect(panel),
    panelDisplay: panel ? getComputedStyle(panel).display : 'missing',
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    mainRight: main ? Math.round(main.getBoundingClientRect().right) : null,
    innerWidth: window.innerWidth,
    rightHit: rr ? at(rr.cx, rr.cy) : 'null',
    resizeVisible: handle
      ? (handle.getBoundingClientRect().width > 0 && getComputedStyle(handle).display !== 'none')
      : false
  };
})()`

const PANEL_OPEN = `(() => {
  if (!window.filePanel) return false;
  window.filePanel.open();
  return true;
})()`

const PANEL_CLOSE = `(() => {
  if (!window.filePanel) return false;
  window.filePanel.close();
  return true;
})()`

/* ---------------------------------------------------------------
   2026-09-19 用户报的两个真机 bug：
     ① 「上面的几个按钮都点不了」—— 面板从窗口最顶上铺开，.panel-head 整条落在
        macOS 的 40px 拖拽带底下，带子又是 drag，按下去直接变成拖窗口；
     ② 「文件列表没有滚动条，文件内容没有滚动条」—— #app 的隐式网格行是 auto，
        面板一进来把行从 872 撑到 5000+，里面的 overflow:auto 于是没有可滚余量，
        clientHeight === scrollHeight，scrollTop 改都改不动。

   冒烟里没有真服务端，所以下面在 ipcMain 上挂一份「长内容」的假数据，
   让面板把「80 行目录 + 400 行代码」真实渲染出来 —— 否则树太短，量不出滚动。
   ⚠️ 不能像早先那样直接 `window.dsh = {...}`：真 preload 走 contextBridge，
      暴露出来的对象在主世界里是只读的，赋值会静默失败（第一次就是这么翻的车）。
   量法一律用 elementFromPoint + 真的改一次 scrollTop —— 不靠肉眼看截图。 */

const OPEN_LONG_PREVIEW = `(async () => {
  if (!window.filePanel) return false;
  window.filePanel.open();
  await window.filePanel.refresh();
  await new Promise((r) => setTimeout(r, 300));
  /* 两个 root 时没有自动展开（自动展开只给单 root）—— 点一下第一个 root 展开它 */
  const rootRow = document.querySelector('#panelTree .tree-row[data-dir="1"]');
  if (rootRow) rootRow.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  await window.filePanel.openFile('/__smoke__/long.txt', { kind: 'text' });
  await new Promise((r) => setTimeout(r, 300));
  const pre = document.querySelector('#panelPreview pre');
  return {
    treeRows: document.querySelectorAll('#panelTree .tree-row').length,
    previewTag: pre ? pre.tagName : 'none',
    previewChars: pre ? pre.textContent.length : 0
  };
})()`

const PROBE_COMPOSER = `(() => {
  const input = document.getElementById('input');
  if (!input) return { missing: true };
  const chain = [];
  let node = input;
  for (let i = 0; i < 4 && node && node !== document.body; i++) {
    const s = getComputedStyle(node);
    chain.push({
      el: (node.id ? '#' + node.id : '') + '.' + String(node.className).split(' ')[0],
      h: Math.round(node.getBoundingClientRect().height),
      display: s.display, minH: s.minHeight, maxH: s.maxHeight,
      flexGrow: s.flexGrow, padding: s.padding
    });
    node = node.parentElement;
  }
  return {
    inputH: Math.round(input.getBoundingClientRect().height),
    scrollH: input.scrollHeight,
    clientH: input.clientHeight,
    inlineH: input.style.height,
    css: (() => { const s = getComputedStyle(input); return { h: s.height, minH: s.minHeight, maxH: s.maxHeight, p: s.padding, fs: s.fontSize, lh: s.lineHeight } })(),
    childCount: input.childNodes.length,
    html: input.innerHTML.slice(0, 40),
    chain: chain
  };
})()`

const TEST_COMPOSER_SHRINK = `(async () => {
  const input = document.getElementById('input');
  if (!input) return { missing: true };
  if (input.focus) input.focus();
  input.innerText = 'line01\\nline02\\nline03\\nline04\\nline05\\nline06\\nline07\\nline08\\nline09\\nline10\\nline11\\nline12';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const grown = Math.round(input.getBoundingClientRect().height);
  const diag = { len: input.innerText.length, kids: input.childNodes.length, scrollH: input.scrollHeight, inlineH: input.style.height };
  input.innerHTML = '';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 60));
  const cleared = Math.round(input.getBoundingClientRect().height);
  /* 再验 MutationObserver 自愈路径：只改 DOM 不发 input 事件也要缩回去 */
  input.innerText = 'line01\\nline02\\nline03\\nline04\\nline05\\nline06\\nline07\\nline08\\nline09\\nline10\\nline11\\nline12';
  await new Promise((r) => setTimeout(r, 60));
  const grown2 = Math.round(input.getBoundingClientRect().height);
  input.innerHTML = '';
  await new Promise((r) => setTimeout(r, 60));
  const cleared2 = Math.round(input.getBoundingClientRect().height);
  return { grown: grown, cleared: cleared, grown2: grown2, cleared2: cleared2, diag: diag };
})()`

/* ---- 编辑器（四期：编辑 + 实时保存）用的探针 ----
   一律走真实交互：点按钮、改 value、发 input 事件、等防抖；
   再回到宿主侧核对 fake fs:write 记下来的**字节**。 */

const EDITOR_OPEN = `(async () => {
  const preview = document.getElementById('panelPreview');
  const toggle = document.getElementById('panelEditToggle');
  const out = { hasToggle: !!toggle, toggleText: toggle ? String(toggle.textContent) : '' };
  if (!toggle) return out;
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  const ta = document.getElementById('panelEditor');
  const status = document.getElementById('editorStatus');
  out.hasEditor = !!ta;
  out.isEditing = preview ? preview.classList.contains('is-editing') : false;
  out.taH = ta ? Math.round(ta.getBoundingClientRect().height) : 0;
  out.previewH = preview ? Math.round(preview.getBoundingClientRect().height) : 0;
  out.chars = ta ? ta.value.length : 0;
  out.status = status ? String(status.textContent) : '';
  out.label = (function () {
    const node = document.querySelector('.preview-bar-label');
    return node ? String(node.textContent) : '';
  })();
  return out;
})()`

/* 退出编辑（点「完成」），并回预览 */
const EDITOR_DONE = `(async () => {
  const toggle = document.getElementById('panelEditToggle');
  if (toggle) toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  const preview = document.getElementById('panelPreview');
  return {
    hasEditor: !!document.getElementById('panelEditor'),
    hasPre: !!document.querySelector('#panelPreview pre'),
    isEditing: preview ? preview.classList.contains('is-editing') : false
  };
})()`

/* 在编辑框里敲字 → 真发 input 事件 → 等防抖（>700ms）→ 回报状态。
   文本用 JSON 注入，别让外层模板把 \\n \\r 吃掉。 */
const editorType = (text) => `(async () => {
  const ta = document.getElementById('panelEditor');
  if (!ta) return { missing: true };
  ta.value = ${JSON.stringify(String(text))};
  /* 真实浏览器里 textarea 的 value 读回来一定是 LF，这里顺手把它记下来，
     好让宿主侧知道「敲进去的是 LF、落盘应该是什么」 */
  const valueNow = ta.value;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  const dirtyTab = !!document.querySelector('#panelTabs .panel-tab.dirty');
  const statusBefore = document.getElementById('editorStatus');
  const before = statusBefore ? String(statusBefore.textContent) : '';
  /* 固定等 1300ms 会被机器负载打爆（写盘回复晚一拍就误报「保存中…」）——
     轮询到状态落定为止：要么圆点收了（保存成功），要么「强制保存」露出来（冲突）。 */
  let after = before, forceVisible = false, dirtyNow = dirtyTab;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = document.getElementById('editorStatus');
    const f = document.getElementById('editorForce');
    after = s ? String(s.textContent) : '';
    forceVisible = f ? !f.classList.contains('hidden') : false;
    dirtyNow = !!document.querySelector('#panelTabs .panel-tab.dirty');
    if (!dirtyNow || forceVisible) break;
  }
  return {
    normalized: valueNow.indexOf('\\r') === -1,
    dirtyTab: dirtyTab,
    before: before,
    after: after,
    forceVisible: forceVisible,
    dirtyNow: dirtyNow
  };
})()`

/* 点「强制保存」（冲突时才会露出来的那枚）→ 等写盘 */
const EDITOR_FORCE = `(async () => {
  const force = document.getElementById('editorForce');
  if (!force) return { missing: true };
  const visible = !force.classList.contains('hidden');
  force.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 600));
  const status = document.getElementById('editorStatus');
  return {
    visible: visible,
    after: status ? String(status.textContent) : '',
    dirtyTab: !!document.querySelector('#panelTabs .panel-tab.dirty'),
    forceStillVisible: !force.classList.contains('hidden')
  };
})()`

const EDITOR_OPEN_CRLF = `(async () => {
  await window.filePanel.openFile('/__smoke__/crlf.txt', { kind: 'text' });
  await new Promise((r) => setTimeout(r, 300));
  const toggle = document.getElementById('panelEditToggle');
  if (!toggle) return { hasToggle: false };
  toggle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 300));
  const ta = document.getElementById('panelEditor');
  const label = document.querySelector('.preview-bar-label');
  return {
    hasToggle: true,
    hasEditor: !!ta,
    chars: ta ? ta.value.length : 0,
    label: label ? String(label.textContent) : ''
  };
})()`

const PROBE_TAB_CLOSE = `(() => {
  const close = document.querySelector('#panelTabs .panel-tab-close');
  if (!close) return { exists: false, html: '' };
  const rect = close.getBoundingClientRect();
  const cs = getComputedStyle(close);
  const svg = close.querySelector('svg');
  const svgCs = svg ? getComputedStyle(svg) : null;
  return {
    exists: true,
    html: close.innerHTML.slice(0, 60),
    hasSvg: Boolean(svg),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    opacity: cs.opacity,
    display: cs.display,
    cssWidth: cs.width,
    cssMinWidth: cs.minWidth,
    cssPadding: cs.padding,
    boxSizing: cs.boxSizing,
    svgRect: svg ? (function () { const r = svg.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height) })() : 'none',
    svgW: svgCs ? svgCs.width : 'none',
    svgDisplay: svgCs ? svgCs.display : 'none',
    svgStroke: svg ? svg.getAttribute('stroke') : null
  };
})()`

const PROBE_PANEL_INTERACT = `(() => {
  const notNull = (v) => v !== null && v !== undefined;
  const name = (node) => {
    if (!node) return 'null';
    const cls = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
  };
  /* 顶栏那几枚按钮：几何 + 计算样式 + 命中 */
  const headButton = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const cx = Math.round(b.left + b.width / 2);
    const cy = Math.round(b.top + b.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const cs = getComputedStyle(el);
    return {
      cx: cx, cy: cy,
      top: Math.round(b.top), bottom: Math.round(b.bottom), right: Math.round(b.right),
      z: Number(cs.zIndex) || 0,
      position: cs.position,
      region: cs.webkitAppRegion,
      hitSelf: Boolean(hit && (hit === el || el.contains(hit))),
      hitName: name(hit)
    };
  };
  /* 真的滚一次：scrollTop 改不动 = 压根不是滚动容器 */
  const scrollInfo = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    el.scrollTop = 99999;
    const moved = el.scrollTop;
    el.scrollTop = 0;
    return { clientH: el.clientHeight, scrollH: el.scrollHeight, moved: moved };
  };
  const app = document.getElementById('app');
  const panel = document.getElementById('filePanel');
  const band = document.getElementById('titlebarDrag');
  const explorer = document.querySelector('.panel-explorer');
  return {
    bandDisplay: band ? getComputedStyle(band).display : 'missing',
    bandHeight: band ? Math.round(band.getBoundingClientRect().height) : 0,
    appClientH: app.clientHeight,
    appScrollH: app.scrollHeight,
    appOverflowed: app.scrollHeight > app.clientHeight + 1,
    panelH: panel ? Math.round(panel.getBoundingClientRect().height) : null,
    innerHeight: window.innerHeight,
    explorerDisplay: explorer ? getComputedStyle(explorer).display : 'missing',
    tree: scrollInfo('.panel-tree'),
    preview: scrollInfo('.panel-preview'),
    buttons: {
      explorer: headButton('panelExplorerToggle'),
      vscode: headButton('panelVscode'),
      terminal: headButton('panelTerminal'),
      refresh: headButton('panelRefresh')
    }
  };
})()`

/* 用冒泡的合成 click 走一遍真实的委托监听（bindClick 挂在 document 上）。
   注意：这条**证明不了**「真机点得到」—— 合成事件不经过 -webkit-app-region。
   真机能不能按下去，由上面的 elementFromPoint + region==='no-drag' 两条一起证。 */
function clickHead(id) {
  return `(() => {
    const el = document.getElementById('${id}');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return true;
  })()`
}

const PROBE_PANEL_MODE = `(() => {
  const html = document.documentElement;
  const app = document.getElementById('app');
  const panel = document.getElementById('filePanel');
  const explorer = document.querySelector('.panel-explorer');
  const hint = document.querySelector('#terminalView:not(.hidden)');
  return {
    chatHidden: html.classList.contains('chat-hidden'),
    panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    sidebarDisplay: document.querySelector('.sidebar')
      ? getComputedStyle(document.querySelector('.sidebar')).display : 'missing',
    explorerDisplay: explorer ? getComputedStyle(explorer).display : 'missing',
    hintCount: hint ? 1 : 0,
    innerWidth: window.innerWidth
  };
})()`

const CLOSE_TERMINAL_HINT = `(() => {
  const button = document.getElementById('panelTerminal');
  if (!button) return false;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
})()`

/* 终端（三期 → xterm 改版）端到端：视图状态 + xterm 实例 + cwd 下拉 + 输出尾部。
   终端现在是停靠在预览区**下方**的，预览不退场。 */
const PROBE_TERMINAL = `(() => {
  const view = document.getElementById('terminalView');
  const out = document.getElementById('terminalOut');
  const cwd = document.getElementById('terminalCwd');
  return {
    missing: !view || !out,
    visible: view ? !view.classList.contains('hidden') : false,
    xtermReady: !!(out && out.querySelector('.xterm')),
    previewVisible: (() => { const p = document.getElementById('panelPreview'); return p ? getComputedStyle(p).display !== 'none' : false })(),
    dirItems: document.querySelectorAll('#terminalDirs .terminal-dir-item').length,
    dirOn: (() => {
      const on = document.querySelector('#terminalDirs .terminal-dir-item.on .terminal-dir-name');
      return on ? on.textContent : '';
    })(),
    cwdLabel: (() => { const l = document.getElementById('terminalCwdLabel'); return l ? l.textContent : '' })(),
    diag: (() => {
      const st = window.__dshTermState || {};
      let lines = -1;
      let cols = -1;
      try {
        const term = window.__dshXterm;
        if (term && term.buffer && term.buffer.active) {
          cols = term.cols;
          const buf = term.buffer.active;
          lines = 0;
          for (let i = 0; i < buf.length; i++) {
            const line = buf.getLine(i);
            if (line && line.translateToString(true).trim() !== '') lines++;
          }
        }
      } catch (e) { lines = -2 }
      return {
        sid: st.sid || '', replayApplied: st.replayApplied, tabId: st.tabId || '',
        promptDrawn: st.promptDrawn, tabCount: (st.tabId ? 1 : 0),
        hosts: document.querySelectorAll('#terminalOut .terminal-instance').length,
        nonEmptyLines: lines,
        cols: cols,
        chain: (() => {
          const out = [];
          let node = document.getElementById('terminalOut');
          for (let i = 0; i < 6 && node; i++) {
            const rect = node.getBoundingClientRect();
            const style = getComputedStyle(node);
            out.push(((node.id ? '#' + node.id : '') + '.' + String(node.className).split(' ')[0])
              + ' w=' + Math.round(rect.width) + ' h=' + Math.round(rect.height)
              + ' ' + style.display + '/' + style.flexBasis);
            node = node.parentElement;
          }
          return out;
        })(),
        innerW: window.innerWidth
      };
    })(),
    /* 优先读 xterm buffer API（不依赖渲染器往 DOM 里画了什么）。
       ⚠️ 整段套 try：term.buffer 是 proposed API，没开 allowProposedApi 时
       「访问即抛」，抛在 executeJavaScript 里整个脚本就崩了。 */
    outTail: (() => {
      try {
        const term = window.__dshXterm;
        if (term && term.buffer && term.buffer.active) {
          const buf = term.buffer.active;
          const lines = [];
          for (let i = Math.max(0, buf.length - 60); i < buf.length; i++) {
            const line = buf.getLine(i);
            lines.push(line ? line.translateToString(true) : '');
          }
          return lines.join('\\n').slice(-400);
        }
      } catch (e) { /* 落到 DOM 兜底 */ }
      if (!out) return '';
      const rows = out.querySelector('.xterm-rows');
      return (rows || out).textContent.slice(-300);
    })(),
    domHint: (() => {
      if (!out) return 'no-out';
      const rows = out.querySelector('.xterm-rows');
      return rows ? String(rows.innerHTML.length) + ':' + rows.innerHTML.slice(0, 120) : 'no-rows';
    })()
  };
})()`

/* 往终端敲一条命令：走 xterm onData 同一条链路（panel.js 挂的测试钩子）。
   两段喂：先可见字符（本地回显），再 \r 提交 —— 跟真键盘一模一样。 */
const TERMINAL_TYPE = `(() => {
  if (typeof window.__dshTerminalInput !== 'function') return { hooked: false };
  try {
    window.__dshTerminalInput('echo TERMINAL_SMOKE_OK');
    window.__dshTerminalInput('\\r');
    return { hooked: true, err: '' };
  } catch (e) {
    return { hooked: true, err: String((e && e.message) || e) };
  }
})()`

/* 预览 | 终端 之间的横向分隔条：拖高度（--terminal-height 记在 #filePanel 上） */
function dragTerminalSplit(deltaPx) {
  return `(async () => {
    const handle = document.getElementById('terminalSplit');
    if (!handle) return { missing: true };
    const panel = document.getElementById('filePanel');
    const view = document.getElementById('terminalView');
    const read = () => panel.style.getPropertyValue('--terminal-height').trim();
    const b = handle.getBoundingClientRect();
    const x0 = Math.round(b.left + b.width / 2);
    const y0 = Math.round(b.top + b.height / 2);
    const fire = (type, el, cy) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x0, clientY: cy, button: 0
    }));
    const before = read();
    fire('mousedown', handle, y0);
    fire('mousemove', document, y0 + ${deltaPx});
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mid = read();
    fire('mousemove', document, y0 + ${deltaPx});
    fire('mouseup', document, y0 + ${deltaPx});
    await new Promise((r) => setTimeout(r, 80));
    return {
      missing: false,
      before: before,
      mid: mid,
      after: read(),
      height: view ? Math.round(view.getBoundingClientRect().height) : null,
      stored: localStorage.getItem('dsh-panel-terminal-height')
    };
  })()`
}

/* 「只看文件」模式：两枚折叠按钮必须退场，面板顶栏那组按钮必须点得到。
   （2026-09-19 用户报「code 模式上方菜单都跌到一起了」—— 就是 #panelToggle
   30x30 正好压在 .panel-head 右侧那组 VS Code / 终端按钮上。） */
const PROBE_CHAT_HIDDEN = `(() => {
  const name = (node) => {
    if (!node) return 'null';
    const cls = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
  };
  const button = (id) => {
    const el = document.getElementById(id);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2));
    return {
      left: Math.round(b.left),
      display: getComputedStyle(el).display,
      hitSelf: Boolean(hit && (hit === el || el.contains(hit))),
      hitName: name(hit)
    };
  };
  const toggle = (id) => {
    const el = document.getElementById(id);
    return el ? getComputedStyle(el).display : 'missing';
  };
  const panel = document.getElementById('filePanel');
  const head = document.querySelector('.panel-head');
  return {
    panelToggleDisplay: toggle('panelToggle'),
    sidebarToggleDisplay: toggle('sidebarToggle'),
    /* 红黄绿占 x=16..68，顶栏得让到 80 再开始排（不然标题贴在灯上） */
    headPaddingLeft: head ? getComputedStyle(head).paddingLeft : null,
    vscode: button('panelVscode'),
    terminal: button('panelTerminal'),
    explorerToggle: button('panelExplorerToggle'),
    panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : null,
    innerWidth: window.innerWidth
  };
})()`

/* 拖一把手：mousedown 在把手上 → document 上 mousemove/mouseup。
   返回拖动前后两条 CSS 变量与实际几何，断言在宿主侧做。 */
function dragHandle(id, deltaPx) {
  return `(async () => {
    const handle = document.getElementById('${id}');
    if (!handle) return { missing: true };
    const b = handle.getBoundingClientRect();
    const x0 = Math.round(b.left + b.width / 2);
    const y0 = Math.round(b.top + b.height / 2);
    const fire = (type, el, cx) => el.dispatchEvent(new MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: cx, clientY: y0, button: 0
    }));
    const varName = '${id}' === 'panelResize' ? '--panel-width' : '--explorer-width';
    const before = document.documentElement.style.getPropertyValue(varName).trim();
    fire('mousedown', handle, x0);
    fire('mousemove', document, x0 + ${deltaPx});
    /* rAF 节流后 mousemove 不再即时生效 —— 等两帧确认「松手前」宽度已跟着走 */
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const mid = document.documentElement.style.getPropertyValue(varName).trim();
    fire('mousemove', document, x0 + ${deltaPx});
    fire('mouseup', document, x0 + ${deltaPx});
    await new Promise((r) => setTimeout(r, 80));
    const target = document.querySelector('${id}' === 'panelResize' ? '#filePanel' : '.panel-explorer');
    return {
      missing: false,
      variable: varName,
      before: before,
      mid: mid,
      after: document.documentElement.style.getPropertyValue(varName).trim(),
      width: target ? Math.round(target.getBoundingClientRect().width) : null,
      stored: localStorage.getItem(varName === '--panel-width' ? 'dsh-panel-width' : 'dsh-panel-explorer-width')
    };
  })()`
}

/* 双击把手 = 回默认宽度 */
const DBL_HANDLE = (id) => `(() => {
  const handle = document.getElementById('${id}');
  if (!handle) return false;
  const b = handle.getBoundingClientRect();
  handle.dispatchEvent(new MouseEvent('dblclick', {
    bubbles: true, cancelable: true,
    clientX: Math.round(b.left + b.width / 2), clientY: Math.round(b.top + b.height / 2)
  }));
  return true;
})()`

/* 隐藏窗口里 Chromium **会节流甚至停掉 CSS 过渡**（合成器不跑），
   所以「加完 class 等 400ms 再量」是**不稳定**的：`transition: left .18s` 可能一直停在起点。
   2026-09-19 就翻过一次车 —— Win/Linux 那轮量到 `left=80`（过渡起点）而不是 `214`（终值）。
   直接把过渡全冻掉，量到的就一定是终值。断言因此变得确定性，也快。 */
const FREEZE_ANIMATION = `(() => {
  if (document.getElementById('smokeFreeze')) return false;
  const style = document.createElement('style');
  style.id = 'smokeFreeze';
  style.textContent = '*, *::before, *::after { transition: none !important; animation: none !important; }';
  document.head.appendChild(style);
  return true;
})()`

const PROBE_OTHER = `(() => {
  const band = document.getElementById('titlebarDrag');
  const toggle = document.getElementById('sidebarToggle');
  const title = document.querySelector('.brand-title');
  const sidebar = document.querySelector('.sidebar');
  const main = document.querySelector('.main');
  const frame = document.querySelector('.content-frame');
  const rect = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), top: Math.round(b.top), right: Math.round(b.right),
             bottom: Math.round(b.bottom), w: Math.round(b.width), h: Math.round(b.height) };
  };
  const name = (node) => {
    const cls = typeof node.className === 'string'
      ? node.className
      : (node.className && node.className.baseVal) || '';
    return (node.id ? '#' + node.id : '') + (cls ? '.' + String(cls).split(/\\s+/).join('.') : '');
  };
  const at = (x, y) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return 'null';
    const owner = el.closest && el.closest('[id]');
    return name(el) + (owner && owner !== el ? ' < ' + name(owner) : '');
  };
  const tr = rect(toggle);
  return {
    missing: !band || !toggle,
    htmlClass: document.documentElement.className,
    bandDisplay: band ? getComputedStyle(band).display : 'missing',
    // 摘掉 .shell-mac 后内容区不该再白留那 40px（那是给 macOS 拖拽带让位的）
    frameTop: frame ? Math.round(frame.getBoundingClientRect().top) : null,
    frameMarginTop: frame ? getComputedStyle(frame).marginTop : null,
    toggle: tr,
    toggleRegion: toggle ? getComputedStyle(toggle).webkitAppRegion : null,
    toggleHit: tr ? at(Math.round((tr.left + tr.right) / 2), Math.round((tr.top + tr.bottom) / 2)) : 'null',
    // 品牌标题的右沿：按钮要落在它右边，不能压上去
    titleRight: title ? Math.round(title.getBoundingClientRect().right) : null,
    sidebarDisplay: sidebar ? getComputedStyle(sidebar).display : 'missing',
    sidebarVisible: sidebar ? sidebar.getBoundingClientRect().width > 0 : false,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    innerWidth: window.innerWidth
  };
})()`

async function runInElectron() {
  const electron = require('electron')
  if (not(electron.app) || not(electron.BrowserWindow)) {
    console.log('shell drag smoke: skipped (must run under electron, not plain node)')
    return
  }

  const isMac = process.platform === 'darwin'
  console.log('platform: ' + process.platform + '  electron: ' + process.versions.electron)

  // 被 node 重跑进来的，BrowserWindow 得等 app ready 之后才能建
  await electron.app.whenReady()

  const { server, port } = await serveRenderer()
  const win = new electron.BrowserWindow({
    width: 1000,
    height: 700,
    show: false,
    frame: true,
    webPreferences: {
      // 挂真的 preload：双击顶栏那条链路（preload 认拖拽区 → 回主进程）要端到端验
      preload: path.join(ROOT, 'src', 'main', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  const doubleClicks = []
  electron.ipcMain.on('shell:titlebar-dblclick', () => doubleClicks.push(Date.now()))
  // 真 preload 挂上后页面脚本会调这个；这里只求别在日志里刷「没有 handler」
  electron.ipcMain.handle('app:get-state', () => ({}))
  /* 面板会问这几个。这里不止「别刷 IPC 报错」—— 还得给足内容：
     80 行目录 + 400 行文本，面板才量得出「滚动条真的出现、真的滚得动」。 */
  /* 目录切换/终端 spawn 走的是**真** terminal-api：root 路径必须是真实存在的目录，
     不然 pickCwd 会静默回退 homedir（/tmp 下的假路径 /__smoke__ 就吃过这个亏）。
     假目录树行的路径前缀也必须跟 root 一致，不然渲染层按前缀归组会把 80 行过滤剩 2 行。 */
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-drag-smoke-'))
  const smokeRoot2 = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-drag-smoke2-'))
  const smokeRows = Array.from({ length: 80 }, (_, i) => ({
    path: smokeRoot + '/f' + i + '.txt', name: 'file-' + i + '.txt', dir: false, size: 64, kind: 'text'
  }))
  /* 两个 root：目录切换测试需要候选 ≥2（roots 和 cwd 相同时列表只画一项） */
  electron.ipcMain.handle('fs:roots', () => ({
    projectId: 'smoke', projectName: '冒烟',
    roots: [
      { path: smokeRoot, name: 'smoke' },
      { path: smokeRoot2, name: 'smoke2' }
    ]
  }))
  electron.ipcMain.handle('fs:tree', () => ({ entries: smokeRows, children: {}, truncated: false }))
  /* fs:file / fs:text 要**按路径**给内容：编辑器那组用例需要两个换行风格不同的文件
     （一个 LF、一个 CRLF），验证写回时换行没被 textarea 吃掉。
     注意必须给 isText: true —— 真实的 describeFile 就是这么返的，
     少了它 canEdit() 直接 false，「编辑」按钮根本不会出现（第一次就是这么假绿的）。 */
  const virtualText = (target) => (String(target).indexOf('crlf') !== -1 ? VIRTUAL_CRLF_TEXT : VIRTUAL_LONG_TEXT)
  /* 固定 mtime：第一次保存（带 1000）放行，返回 2000；第二次就带 2000 → 被判冲突。
     这样一条链路把「正常自动保存」和「冲突不覆盖」都验了。 */
  const SMOKE_MTIME = 1000
  electron.ipcMain.handle('fs:file', (_event, target) => ({
    kind: 'text', ext: '.txt', isText: true,
    size: virtualText(target).length, mtime: SMOKE_MTIME
  }))
  electron.ipcMain.handle('fs:text', (_event, target) => virtualText(target))
  /* 写盘不真落盘，把每次调用记下来 —— 宿主侧解码 base64 就能核对
     「写出去的到底是不是敲进去的那串字节」。 */
  const editWrites = []
  electron.ipcMain.handle('fs:write', (_event, payload) => {
    const record = {
      path: String((payload && payload.path) || ''),
      base64: String((payload && payload.data) || ''),
      expectedMtime: Number((payload && payload.expectedMtime) || 0),
      rejected: false
    }
    editWrites.push(record)
    /* 模拟「文件已被外部改过」：只有 mtime 对得上、或明确强制（0）才放行 */
    if (record.expectedMtime !== 0 && record.expectedMtime !== SMOKE_MTIME) {
      record.rejected = true
      throw new Error('MTIME_CONFLICT: ' + record.path)
    }
    return { ok: true, path: record.path, size: record.base64.length, mtime: SMOKE_MTIME + 1000 }
  })

  /* ui-store（R24）：渲染层 init 的 loadSessionStore / 各 save* 的后台 PUT 都会走
     这两条 IPC。渲染层对失败有容错，但宿主侧不接的话每次都是 unhandled 噪音，
     还会拖慢invoke 回复 —— 空实现接住即可。 */
  electron.ipcMain.handle('ui-store:get', () => ({ ok: true, store: {} }))
  electron.ipcMain.handle('ui-store:put', () => ({ ok: true }))

  /* 终端（三期）走真模块：dev 主进程本来也是这么接的，这里原样挂一遍，
     端到端 = 渲染层点击 → preload IPC → terminal-api spawn 真 shell → 输出回显 */
  const terminalApi = require('../server/terminal-api')
  electron.ipcMain.handle('term:state', (_event, sid) => terminalApi.state(sid))
  electron.ipcMain.handle('term:start', (_event, cwd) => terminalApi.start(cwd))
  electron.ipcMain.handle('term:write', (_event, payload) => terminalApi.write(payload && payload.sid, payload && payload.text))
  electron.ipcMain.handle('term:kill', (_event, sid) => terminalApi.kill(sid))
  electron.ipcMain.on('term:subscribe', (event, sid) => {
    terminalApi.subscribe(sid, (payload) => {
      if (!event.sender.isDestroyed()) event.sender.send('term:data', payload)
    })
  })
  electron.ipcMain.on('term:unsubscribe', () => {})

  let result = null
  try {
    await win.loadURL('http://127.0.0.1:' + port + '/index.html')
    // 先把过渡冻掉再量 —— 隐藏窗口上过渡不保证推进（见 FREEZE_ANIMATION 的说明）
    await win.webContents.executeJavaScript(FREEZE_ANIMATION)
    result = await win.webContents.executeJavaScript(PROBE)
    /* 品牌行系统徽章（2026-09-19 用户要的）：真机上 init 应该已经把它填好 */
    await new Promise((resolve) => setTimeout(resolve, 250))
    const badgeText = await win.webContents.executeJavaScript(
      "(() => { const b = document.getElementById('brandBadge'); return b ? String(b.textContent).trim() : '' })()")
    check('品牌行系统徽章显示出来了（mac 上应为 Mac）', badgeText === 'Mac', 'badge=' + badgeText)
    /* 输入框高度链诊断（2026-09-19 用户：莫名其妙变高了）—— 量出真数字再谈修复 */
    const composer = await win.webContents.executeJavaScript(PROBE_COMPOSER)
    check('输入框高度链诊断（空输入框应 ≤60px）', composer.inputH <= 60, JSON.stringify(composer))
    /* 端到端：长文本长到上限 → 清空必须缩回 52（发完长消息输入框不许停在半屏）；
       grown2/cleared2 走 MutationObserver 自愈路径（只改 DOM 不发 input 事件） */
    const shrink = await win.webContents.executeJavaScript(TEST_COMPOSER_SHRINK)
    check('输入框：长文本长高（>100px）、清空后缩回（≤60px）',
      shrink && shrink.grown > 100 && shrink.cleared <= 60,
      JSON.stringify(shrink))
    check('输入框：只改 DOM 不发事件也自愈（MutationObserver 兜底）',
      shrink && shrink.grown2 > 100 && shrink.cleared2 <= 60,
      'grown2=' + (shrink && shrink.grown2) + ' cleared2=' + (shrink && shrink.cleared2))
  } catch (error) {
    console.error('probe failed: ' + (error && error.message))
  }

  if (not(result) || result.missing) {
    check('页面里有 #titlebarDrag 元素', false, result ? 'missing' : 'probe failed')
  } else {
    check('页面里有 #titlebarDrag 元素', true)
    check('带子显示出来了（.shell-mac 下）', result.display === 'block', result.display)
    check('-webkit-app-region 计算值是 drag', result.appRegion === 'drag', String(result.appRegion))
    check('定位是 fixed', result.position === 'fixed', result.position)
    check('压在内容之上（z-index > 0）', Number(result.zIndex) > 0, String(result.zIndex))
    check('贴在最顶（top = 0）', result.rect.y === 0, String(result.rect.y))
    check('从最左边起（left = 0）', result.rect.x === 0, String(result.rect.x))
    check('高度是 40px', result.rect.h === 40, String(result.rect.h))
    check('横贯整个窗口宽度', result.rect.w === result.innerWidth, result.rect.w + ' vs ' + result.innerWidth)
    check('没有把窗口撑出滚动条', result.scrollHeight <= result.innerHeight, result.scrollHeight + ' <= ' + result.innerHeight)

    // 关键：带子要是被内容盖住，鼠标就落不到它身上，也就拖不动
    check('窗口正中间顶部命中拖拽带', result.hitMiddleTop.indexOf('titlebar-drag') >= 0, result.hitMiddleTop)
    check('侧边栏上方同样命中拖拽带', result.hitOverSidebar.indexOf('titlebar-drag') >= 0, result.hitOverSidebar)
    check('紧贴红黄绿按钮右侧也命中拖拽带', result.hitTopLeft.indexOf('titlebar-drag') >= 0, result.hitTopLeft)
    check('带子下沿之外不再是拖拽带', result.hitJustBelow.indexOf('titlebar-drag') < 0, result.hitJustBelow)

    // 内容区让开 40px ⇒ 带子下面压着的是空白，不会吞掉消息区的点击
    check('内容区顶部让开了带子高度', result.frameTop !== null && result.frameTop >= result.rect.h,
      'frameTop=' + result.frameTop + ' bar=' + result.rect.h)

    /* 折叠按钮 2026-09-19 改成「待在顶栏那一行里」（跟红黄绿同高），
       不再要求它在带子下方；取而代之要验：它落在那一行内、压在带子之上、点得到。 */
    const t = result.toggle
    if (check('页面里有 #sidebarToggle', t !== null)) {
      check('折叠按钮落在顶栏那一行里（40px 内）', t.top >= 0 && t.bottom <= result.rect.h,
        'top=' + t.top + ' bottom=' + t.bottom + ' 带高=' + result.rect.h)
      check('折叠按钮压在拖拽带之上', t.z > Number(result.zIndex),
        'toggle z=' + t.z + ' 带子 z=' + result.zIndex)
      check('折叠按钮退出了拖拽区（no-drag）', t.region === 'no-drag', String(t.region))
      check('折叠按钮点得到（没被拖拽带盖住）', String(t.hit).indexOf('sidebarToggle') >= 0, String(t.hit))
      // 展开时贴侧边栏右缘：214 + 30/2 = 229
      check('展开时折叠按钮贴侧边栏右缘', Math.abs(t.cx - 229) <= 3, 'cx=' + t.cx)
      check('展开时侧边栏是 260 宽', result.sidebarWidth === 260, String(result.sidebarWidth))
    }

    /* 顶栏那组页面操作（刷新整页 / 转发链接）：用户 2026-09-19 要的两枚按钮。
       位置与折叠按钮绑在一起（贴在它左边），同样落在 mac 的 40px 拖拽带里 ——
       所以必须验：在那一行内、压在带子之上、no-drag、两枚都点得到。 */
    const pa = result.pageActions
    if (check('顶栏有页面操作组 #pageActions（刷新 + 转发两枚）', pa !== null)) {
      check('操作组落在顶栏那一行里（40px 内）', pa.cy > 0 && pa.cy < result.rect.h,
        'cy=' + pa.cy + ' 带高=' + result.rect.h)
      check('操作组压在拖拽带之上', pa.z > Number(result.zIndex),
        'pa z=' + pa.z + ' 带子 z=' + result.zIndex)
      check('操作组退出了拖拽区（no-drag）', pa.region === 'no-drag', String(pa.region))
      check('刷新按钮点得到（没被拖拽带盖住）', String(pa.refreshHit).indexOf('pageRefresh') >= 0, String(pa.refreshHit))
      check('转发按钮点得到（没被拖拽带盖住）', String(pa.shareHit).indexOf('pageShare') >= 0, String(pa.shareHit))
      check('操作组贴在折叠按钮左边（不跟它叠）', t !== null && pa.right <= t.left,
        'paRight=' + pa.right + ' toggleLeft=' + (t ? t.left : '?'))
    }
    check('「并发已满」提示条默认收起（并发正常跑着的时候不占地方）',
      result.runHint.exists && result.runHint.hidden, JSON.stringify(result.runHint))
  }

  if (isMac) {
    check('macOS 上窗口标题栏是隐藏模式', true, 'titleBarStyle=hidden 由主进程设置')
  }

  /* ---------------------------------------- 双击顶栏 → 缩放（原生那套手势被藏没了，自己接的） */

  if (isMac) {
    const fire = (selector) => win.webContents.executeJavaScript(`(function () {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      return true;
    })()`)
    const settle = () => new Promise((resolve) => setTimeout(resolve, 220))

    // 逐个派发、逐个计数，才能分辨出到底是哪一下触发的
    const hasBand = await fire('#titlebarDrag')
    await settle()
    check('双击顶栏带子 → 回发 shell:titlebar-dblclick', hasBand && doubleClicks.length === 1,
      doubleClicks.length + ' 次')

    const hasBrand = await fire('.brand-title')
    await settle()
    check('双击品牌行 → 也算双击顶栏', hasBrand && doubleClicks.length === 2, doubleClicks.length + ' 次')

    // 折叠按钮自带 no-drag，双击它会折叠侧边栏，不该顺手缩放窗口
    const hasButton = await fire('#sidebarToggle')
    await settle()
    check('双击拖拽区里的按钮 → 不缩放窗口', hasButton && doubleClicks.length === 2, doubleClicks.length + ' 次')

    /* 动作本身用真窗口跑一遍：拿源码里的 applyTitlebarDoubleClick（不是复刻一份） */
    const source = fs.readFileSync(path.join(ROOT, 'shell', 'main.js'), 'utf8')
    const apply = extractFunction(source, 'applyTitlebarDoubleClick')
    if (check('从 shell/main.js 抠得出 applyTitlebarDoubleClick', typeof apply === 'function')) {
      win.show() // 隐藏窗口上 isMaximized / isMinimized 不靠谱，先露个面
      await new Promise((resolve) => setTimeout(resolve, 250))
      apply(win, 'maximize')
      await new Promise((resolve) => setTimeout(resolve, 350))
      check('默认偏好下双击 → 窗口最大化', win.isMaximized() === true, 'isMaximized=' + win.isMaximized())
      apply(win, 'maximize')
      await new Promise((resolve) => setTimeout(resolve, 350))
      check('再双击一次 → 还原', win.isMaximized() === false, 'isMaximized=' + win.isMaximized())
      apply(win, 'none')
      await new Promise((resolve) => setTimeout(resolve, 150))
      check('偏好为 None 时双击 → 窗口不动', win.isMaximized() === false, 'isMaximized=' + win.isMaximized())

      // 折叠前先还原窗口，免得量到的是最大化后的几何
      if (win.isMaximized()) apply(win, 'maximize')
      await new Promise((resolve) => setTimeout(resolve, 300))
    }

    /* 折叠态：左边整片隐藏（不再留那条窄栏），按钮落到红黄绿右边 */
    const foldedOn = await win.webContents.executeJavaScript(FOLD_ON)
    await new Promise((resolve) => setTimeout(resolve, 60)) // 过渡已冻掉，这里只等一次样式重算

    if (check('能切到折叠态', foldedOn === true)) {
      const folded = await win.webContents.executeJavaScript(PROBE_COLLAPSED)
      check('折叠后侧边栏不再显示', folded.sidebarDisplay === 'none' && folded.sidebarVisible === false,
        folded.sidebarDisplay + ' / width>0=' + folded.sidebarVisible)
      check('折叠后窄栏图标也没了（左边不留任何东西）', folded.railVisible === false)
      check('折叠后内容区铺满整宽', folded.mainWidth === folded.innerWidth,
        folded.mainWidth + ' / ' + folded.innerWidth)
      // 只看命中元素本身（' < ' 后面是最近一个有 id 的祖先，那可能是 #app.sidebar-collapsed）
      const where = String(folded.hitWhereSidebarWas).split(' < ')[0]
      check('折叠后原来侧边栏那一列已是内容区',
        where !== 'null' && where.indexOf('sidebar') < 0, where)
      if (check('折叠态测得到折叠按钮', folded.toggle !== null)) {
        check('折叠后按钮落到红黄绿右边', folded.toggle.left === 80, String(folded.toggle.left))
        check('折叠后按钮仍点得到', String(folded.toggle.hit).indexOf('sidebarToggle') >= 0, String(folded.toggle.hit))
      }
      if (check('折叠态测得到页面操作组', folded.pageActions !== null)) {
        check('折叠后操作组挪到折叠按钮右边（118，不撞红黄绿）',
          folded.pageActions.left === 118, String(folded.pageActions.left))
        check('折叠后操作组仍点得到',
          String(folded.pageActions.hit).indexOf('pageActions') >= 0, String(folded.pageActions.hit))
      }
    }
  }

  /* ------------------------------------------------ Win / Linux 基线那一轮
     摘掉 .shell-mac 再量一遍。mac 上验的是「模拟」，Win/Linux 上验的是实况 —— 同一段断言两种平台都跑。 */
  {
    await win.webContents.executeJavaScript(STRIP_MAC)
    await new Promise((resolve) => setTimeout(resolve, 60)) // 过渡已冻掉，这里只等一次样式重算
    const other = await win.webContents.executeJavaScript(PROBE_OTHER)

    if (check('Win/Linux：摘掉 .shell-mac 后页面仍正常', not(other.missing),
      'html.class="' + other.htmlClass + '"')) {
      check('Win/Linux：拖拽带不显示（不铺一层透明遮罩吃点击）',
        other.bandDisplay === 'none', other.bandDisplay)
      check('Win/Linux：内容区不再白留顶部 40px',
        other.frameTop === 0, 'frameTop=' + other.frameTop + ' marginTop=' + other.frameMarginTop)
      check('Win/Linux：折叠按钮落在侧边栏右上角（left 214 / top 22）',
        other.toggle !== null && other.toggle.left === 214 && other.toggle.top === 22,
        other.toggle ? ('left=' + other.toggle.left + ' top=' + other.toggle.top) : 'null')
      check('Win/Linux：按钮没压到品牌标题上',
        other.toggle !== null && other.titleRight !== null && other.toggle.left > other.titleRight,
        '按钮左沿=' + (other.toggle && other.toggle.left) + ' 标题右沿=' + other.titleRight)
      check('Win/Linux：折叠按钮点得到（没有东西盖住）',
        String(other.toggleHit).indexOf('sidebarToggle') >= 0, String(other.toggleHit))

      const foldedOther = await win.webContents.executeJavaScript(FOLD_ON)
      await new Promise((resolve) => setTimeout(resolve, 400))
      const fo = await win.webContents.executeJavaScript(PROBE_COLLAPSED)
      check('Win/Linux：折叠后左边整片消失',
        foldedOther === true && fo.sidebarDisplay === 'none' && fo.sidebarVisible === false,
        fo.sidebarDisplay + ' / width>0=' + fo.sidebarVisible)
      check('Win/Linux：折叠后内容区铺满整宽', fo.mainWidth === fo.innerWidth,
        fo.mainWidth + ' / ' + fo.innerWidth)
      if (check('Win/Linux：折叠态测得到折叠按钮', fo.toggle !== null)) {
        check('Win/Linux：折叠后按钮落到窗口最左（16）', fo.toggle.left === 16, String(fo.toggle.left))
        check('Win/Linux：折叠后按钮仍点得到',
          String(fo.toggle.hit).indexOf('sidebarToggle') >= 0, String(fo.toggle.hit))
      }
      if (check('Win/Linux：折叠态测得到页面操作组', fo.pageActions !== null)) {
        check('Win/Linux：折叠后操作组跟在按钮右边（54）',
          fo.pageActions.left === 54, String(fo.pageActions.left))
      }
    }
  }

  /* ------------------------------------------------ 右侧文件面板（一期）：两枚折叠按钮 + 面板几何
     用户 2026-09-19：「右上角有一个折叠按钮，和左侧折叠相反」。
     真机上量三件事：
       ① 左右两枚按钮 top 完全相等（上一轮红黄绿那次就是差 4px 被抓出来的）；
       ② 面板打开后会话区真的让出宽度；
       ③ **侧边栏折叠 + 面板展开**时会话区右沿不许越过面板左沿
          —— 三列网格里 .main 那条 `1 / -1` 会一路铺到面板底下，这就是它存在的理由。 */
  {
    // 上一段结尾刚走了 FOLD_ON，sidebar-collapsed 还挂着 —— 先退回干净基线再量
    await win.webContents.executeJavaScript(STRIP_MAC)
    await new Promise((resolve) => setTimeout(resolve, 60))

    const panelBase = await win.webContents.executeJavaScript(PROBE_PANEL)
    if (check('Win/Linux：页面上有右侧面板与两枚折叠按钮', not(panelBase.missing),
      'missing=' + panelBase.missing)) {
      check('Win/Linux：两枚折叠按钮 top 完全相等（同一中线）',
        panelBase.left.top === panelBase.right.top,
        '左=' + panelBase.left.top + ' 右=' + panelBase.right.top)
      check('Win/Linux：右侧按钮贴窗口最右（right:16 ⇒ 右沿 = 视口宽 − 16）',
        panelBase.right.right === panelBase.innerWidth - 16,
        '右沿=' + panelBase.right.right + ' 视口=' + panelBase.innerWidth)
      check('Win/Linux：面板收起时整块不显示', panelBase.panelDisplay === 'none', panelBase.panelDisplay)
      check('Win/Linux：右侧按钮点得到', String(panelBase.rightHit).indexOf('panelToggle') >= 0, String(panelBase.rightHit))
      check('Win/Linux：收起时会话区铺满（视口 − 侧边栏）',
        panelBase.mainWidth === panelBase.innerWidth - 260 && panelBase.mainRight === panelBase.innerWidth,
        panelBase.mainWidth + ' / ' + panelBase.innerWidth)

      await win.webContents.executeJavaScript(PANEL_OPEN)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const opened = await win.webContents.executeJavaScript(PROBE_PANEL)
      if (check('Win/Linux：面板打开了', opened.open === true && opened.panelDisplay === 'flex',
        'open=' + opened.open + ' display=' + opened.panelDisplay)) {
        check('Win/Linux：面板占了第三列（宽度 > 0）', opened.panel.w > 0, String(opened.panel.w))
        check('Win/Linux：会话区让出面板宽度（会话宽 = 视口 − 侧边栏 − 面板）',
          opened.mainWidth === opened.innerWidth - 260 - opened.panel.w,
          opened.mainWidth + ' vs ' + (opened.innerWidth - 260 - opened.panel.w))
        check('Win/Linux：会话区与面板严丝合缝（右沿 = 面板左沿）',
          opened.mainRight === opened.panel.left,
          '会话右沿=' + opened.mainRight + ' 面板左沿=' + opened.panel.left)
        check('Win/Linux：面板右贴窗口边', opened.panel.right === opened.innerWidth,
          opened.panel.right + ' vs ' + opened.innerWidth)
        check('Win/Linux：打开后两枚按钮仍同一中线',
          opened.left.top === opened.right.top, '左=' + opened.left.top + ' 右=' + opened.right.top)
        check('Win/Linux：右侧按钮让位到面板左边（不压在面板上）',
          opened.right.right <= opened.panel.left,
          '按钮右沿=' + opened.right.right + ' 面板左沿=' + opened.panel.left)
        check('Win/Linux：右侧按钮打开后仍点得到（没被面板盖住）',
          String(opened.rightHit).indexOf('panelToggle') >= 0, String(opened.rightHit))
        check('Win/Linux：面板左缘有可拖的把手', opened.resizeVisible === true)

        /* 侧边栏折叠 + 面板展开：这就是 .main 从 `1 / -1` 改成 `1 / 3` 的那条规则 */
        await win.webContents.executeJavaScript(FOLD_ON)
        await new Promise((resolve) => setTimeout(resolve, 60))
        const both = await win.webContents.executeJavaScript(PROBE_PANEL)
        check('Win/Linux：侧边栏折叠 + 面板展开时会话区不钻到面板底下',
          both.mainRight <= both.panel.left && both.panel.left === both.innerWidth - both.panel.w,
          '会话右沿=' + both.mainRight + ' 面板左沿=' + both.panel.left)
        check('Win/Linux：侧边栏折叠 + 面板展开时面板宽度不变（面板不跟着缩）',
          both.panel.w === opened.panel.w, both.panel.w + ' vs ' + opened.panel.w)
        await win.webContents.executeJavaScript(STRIP_MAC)
        await new Promise((resolve) => setTimeout(resolve, 60))
      }

      await win.webContents.executeJavaScript(PANEL_CLOSE)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const closed = await win.webContents.executeJavaScript(PROBE_PANEL)
      check('Win/Linux：再点一次能收起，会话区宽度复原',
        closed.open === false && closed.mainWidth === closed.innerWidth - 260,
        'open=' + closed.open + ' main=' + closed.mainWidth + ' want=' + (closed.innerWidth - 260))
    }

    /* macOS 那一套：两枚按钮都要跟红黄绿中线对齐（top = 9） */
    await win.webContents.executeJavaScript(ADD_MAC)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const macPanel = await win.webContents.executeJavaScript(PROBE_PANEL)
    check('macOS：面板折叠按钮也在顶栏那一行里（对红黄绿中线）',
      macPanel.right.top === 9 && macPanel.left.top === 9,
      '左=' + macPanel.left.top + ' 右=' + macPanel.right.top)
    check('macOS：右侧按钮退出拖拽带（点得到）',
      String(macPanel.rightHit).indexOf('panelToggle') >= 0, String(macPanel.rightHit))
    await win.webContents.executeJavaScript(STRIP_MAC)
  }

  /* ------------------------------------------------ 面板顶栏按钮 + 滚动链
     用户 2026-09-19 报的两个真机 bug：
       ①「上面的几个按钮都点不了」—— 面板从窗口最顶上铺开，.panel-head 整条落在
          macOS 的 40px 拖拽带底下，带子又是 drag，按下去直接变成拖窗口；
       ②「文件列表没有滚动条，文件内容没有滚动条」—— #app 的隐式网格行是 auto，
          面板一进来把行从 872 撑到 5000+，overflow:auto 因此没有可滚余量。
     这一段的每一条都是「真机量出来的」，不靠肉眼看截图。 */
  {
    await win.webContents.executeJavaScript(STRIP_MAC)
    const loaded = await win.webContents.executeJavaScript(OPEN_LONG_PREVIEW)
    if (check('面板：渲染出 80 行目录 + 400 行长文本预览（够长才量得出滚动）',
      loaded && loaded.treeRows >= 80 && loaded.previewChars > 3000,
      loaded ? ('目录行=' + loaded.treeRows + ' 预览=' + loaded.previewTag + ' ' + loaded.previewChars + ' 字符') : 'false')) {
      /* ---- ⓪ 标签关闭 × 得真渲染出来（2026-09-19 用户：还是没有 X 号）----
         renderIcon 返回裸 svg（没有 .icon 包裹层），选择器写错只会白瞎 —— 直接量。 */
      const tabClose = await win.webContents.executeJavaScript(PROBE_TAB_CLOSE)
      check('面板：标签关闭按钮存在', tabClose.exists, JSON.stringify(tabClose))
      check('面板：关闭按钮里真的渲染出了 ×（svg）', tabClose.hasSvg, tabClose.html)
      check('面板：× 有实际尺寸（18px 按钮 / 13px ×，svg 不能被挤成 0 宽）',
        tabClose.w === 18 && tabClose.svgW === '13px',
        'btn=' + tabClose.w + ' svgW=' + tabClose.svgW)
      check('面板：非悬停时 × 藏着（opacity 0）', tabClose.opacity === '0', tabClose.opacity)
      /* ---- ⑫ 编辑器：编辑 + 实时保存（四期，用户 2026-09-19 要的）----
         真点「编辑」、真敲字、真等防抖，再回到宿主侧核对 fake fs:write 收到的**字节**。
         验的三件事：① 停手真的会自动写盘 ② 写出去的是敲进去的内容、换行没被吃掉
                    ③ mtime 对不上时不覆盖，要人点「强制保存」 */
      editWrites.length = 0
      const edOpen = await win.webContents.executeJavaScript(EDITOR_OPEN)
      if (check('编辑器：文本文件能点「编辑」，点开变 textarea',
        edOpen.hasToggle && edOpen.toggleText === '编辑' && edOpen.hasEditor && edOpen.isEditing,
        JSON.stringify(edOpen))) {
        /* 「撑满」= 至少预览区高度的 80%（只让出工具条那一条）。
           阈值写 100px 太松 —— 曾经 220/589（远古 textarea{max-height:220px} 干的）
           也照样判绿，等于没测。 */
        check('编辑器：textarea 撑满预览区（不是挤成一条，≥80% 高）',
          edOpen.taH > edOpen.previewH * 0.8,
          'taH=' + edOpen.taH + ' previewH=' + edOpen.previewH)
        check('编辑器：带进编辑框的就是文件原内容', edOpen.chars === VIRTUAL_LONG_TEXT.length,
          edOpen.chars + ' vs ' + VIRTUAL_LONG_TEXT.length)

        /* ① LF 文件：改完自动落盘，且不许被强加回车 */
        const lfTyped = 'DSh 编辑保存测试\n第二行 second line'
        const lfEdit = await win.webContents.executeJavaScript(editorType(lfTyped))
        check('编辑器：敲完字标签上出现未保存圆点（切走了也看得见）', lfEdit.dirtyTab === true,
          JSON.stringify(lfEdit))
        const lfWrite = editWrites[editWrites.length - 1]
        check('编辑器：停手约 700ms 自动写盘（这就是「实时保存」）',
          Boolean(lfWrite) && lfWrite.path === '/__smoke__/long.txt',
          lfWrite ? lfWrite.path : 'no write')
        if (lfWrite) {
          const lfBytes = Buffer.from(lfWrite.base64, 'base64')
          const lfText = lfBytes.toString('utf8')
          check('编辑器：写出去的就是敲进去的内容（中文没乱码）', lfText === lfTyped,
            JSON.stringify(lfText))
          check('编辑器：LF 文件保存后没被强加回车', lfText.indexOf('\r') === -1,
            JSON.stringify(lfText))
          check('编辑器：保存带上了 expectedMtime（外部改过就挡得住）',
            lfWrite.expectedMtime === 1000, String(lfWrite.expectedMtime))
        }
        check('编辑器：写完之后圆点收了、状态报「已保存」',
          lfEdit.dirtyNow === false && lfEdit.after.indexOf('已保存') === 0,
          'dirty=' + lfEdit.dirtyNow + ' status=' + lfEdit.after)

        /* ② 同一文件再改一次：fake 这次回的 mtime 对不上 → 应当拒绝覆盖 */
        editWrites.length = 0
        const conflictEdit = await win.webContents.executeJavaScript(editorType('第三次改动'))
        check('编辑器：文件被外部改过 → 不静默覆盖，提示 + 露出「强制保存」',
          conflictEdit.forceVisible === true && conflictEdit.after.indexOf('外部') !== -1,
          JSON.stringify(conflictEdit))
        const conflictWrite = editWrites[editWrites.length - 1]
        check('编辑器：冲突那一次确实发出去了、且被服务端按 MTIME_CONFLICT 拒了',
          Boolean(conflictWrite) && conflictWrite.rejected === true,
          JSON.stringify(conflictWrite))

        editWrites.length = 0
        const forced = await win.webContents.executeJavaScript(EDITOR_FORCE)
        const forceWrite = editWrites[editWrites.length - 1]
        check('编辑器：点「强制保存」用 expectedMtime=0 绕过检查，真的覆盖上去',
          Boolean(forceWrite) && forceWrite.expectedMtime === 0 && forced.dirtyTab === false,
          JSON.stringify([forceWrite && forceWrite.expectedMtime, forced.dirtyTab]))
        check('编辑器：覆盖成功后冲突提示与「强制保存」一起收起',
          forced.forceStillVisible === false && forced.after.indexOf('已保存') === 0,
          JSON.stringify(forced))

        /* ③ CRLF 文件：textarea 会把 \r\n 吃成 \n，写回时必须自己还原 */
        editWrites.length = 0
        const crlfOpen = await win.webContents.executeJavaScript(EDITOR_OPEN_CRLF)
        if (check('编辑器：切到另一个文件能接着编辑（CRLF 那份）',
          crlfOpen.hasEditor === true && crlfOpen.label.indexOf('CRLF') !== -1,
          JSON.stringify(crlfOpen))) {
          const crlfTyped = 'a\nb\nc'
          await win.webContents.executeJavaScript(editorType(crlfTyped))
          const crlfWrite = editWrites[editWrites.length - 1]
          check('编辑器：CRLF 文件保存后仍是 CRLF（textarea 吃掉的 \\r 自己补回来）',
            Boolean(crlfWrite) && Buffer.from(crlfWrite.base64, 'base64').toString('utf8') === 'a\r\nb\r\nc',
            crlfWrite ? JSON.stringify(Buffer.from(crlfWrite.base64, 'base64').toString('utf8')) : 'no write')
        }

        /* 「完成」退出编辑要回到预览，而且内容已经落了盘 */
        const done = await win.webContents.executeJavaScript(EDITOR_DONE)
        check('编辑器：点「完成」回到预览（textarea 收起、pre 回来）',
          done.hasEditor === false && done.hasPre === true && done.isEditing === false,
          JSON.stringify(done))
      } else {
        check('编辑器：textarea 撑满预览区（不是挤成一条）', false, 'no toggle')
      }
      /* ---- ① macOS：三枚按钮必须压过拖拽带 ---- */
      await win.webContents.executeJavaScript(ADD_MAC)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const mac = await win.webContents.executeJavaScript(PROBE_PANEL_INTERACT)
      check('面板：macOS 下拖拽带已显示（这组断言的前提）', mac.bandDisplay === 'block', mac.bandDisplay)

      const headCases = [
        ['explorer', '目录'],
        ['vscode', 'VS Code'],
        ['terminal', '终端']
      ]
      for (const item of headCases) {
        const key = item[0]
        const label = item[1]
        const button = mac.buttons[key]
        if (not(check('macOS：测得到面板顶栏的「' + label + '」按钮', button !== null))) continue
        check('macOS：「' + label + '」按钮确实落在 40px 拖拽带里（原来点不动的根因）',
          button.top >= 0 && button.bottom <= mac.bandHeight,
          'top=' + button.top + ' bottom=' + button.bottom + ' 带高=' + mac.bandHeight)
        check('macOS：「' + label + '」按钮 z-index 压过拖拽带的 30', button.z > 30, String(button.z))
        check('macOS：「' + label + '」按钮退出拖拽区（no-drag）',
          button.region === 'no-drag', String(button.region))
        check('macOS：「' + label + '」按钮点得到（命中它自己，不是 #titlebarDrag）',
          button.hitSelf === true, String(button.hitName))
      }

      /* ---- ② 滚动链（平台无关，用干净的 Win/Linux 基线量）---- */
      await win.webContents.executeJavaScript(STRIP_MAC)
      await new Promise((resolve) => setTimeout(resolve, 60))
      const sc = await win.webContents.executeJavaScript(PROBE_PANEL_INTERACT)
      check('面板：网格行没被面板撑爆（#app 自身不产生滚动）',
        sc.appOverflowed === false, sc.appScrollH + ' vs ' + sc.appClientH)
      check('面板：面板高度 = 视口高（不是被内容撑成几千 px）',
        sc.panelH !== null && Math.abs(sc.panelH - sc.innerHeight) <= 1,
        sc.panelH + ' / ' + sc.innerHeight)
      check('面板：文件列表超出后真的滚得动（scrollTop 改得动）',
        sc.tree !== null && sc.tree.scrollH > sc.tree.clientH && sc.tree.moved > 0,
        JSON.stringify(sc.tree))
      check('面板：预览区超出后真的滚得动（scrollTop 改得动）',
        sc.preview !== null && sc.preview.scrollH > sc.preview.clientH && sc.preview.moved > 0,
        JSON.stringify(sc.preview))

      /* ---- ③ 三枚按钮点下去要真的有反应 ---- */
      await win.webContents.executeJavaScript(clickHead('panelExplorerToggle'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      const explorerOff = await win.webContents.executeJavaScript(PROBE_PANEL_MODE)
      check('面板：点「目录」图标 → 收起文件列表',
        explorerOff.explorerDisplay === 'none', explorerOff.explorerDisplay)
      await win.webContents.executeJavaScript(clickHead('panelExplorerToggle'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      const explorerOn = await win.webContents.executeJavaScript(PROBE_PANEL_MODE)
      check('面板：再点一次 → 文件列表回来',
        explorerOn.explorerDisplay !== 'none', explorerOn.explorerDisplay)

      await win.webContents.executeJavaScript(clickHead('panelVscode'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      const onlyFiles = await win.webContents.executeJavaScript(PROBE_PANEL_MODE)
      check('面板：点 VS Code 图标 → 会话区收起、面板铺满整宽',
        onlyFiles.chatHidden === true && onlyFiles.panelWidth === onlyFiles.innerWidth
          && onlyFiles.sidebarDisplay === 'none',
        'chat-hidden=' + onlyFiles.chatHidden + ' 面板=' + onlyFiles.panelWidth + ' / ' + onlyFiles.innerWidth)
      await win.webContents.executeJavaScript(clickHead('panelVscode'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      const backToChat = await win.webContents.executeJavaScript(PROBE_PANEL_MODE)
      check('面板：再点一次 → 退出「只看文件」模式',
        backToChat.chatHidden === false && backToChat.sidebarDisplay !== 'none',
        'chat-hidden=' + backToChat.chatHidden + ' 侧栏=' + backToChat.sidebarDisplay)

      /* ---- 终端（三期 → xterm 改版）端到端：图标 → 停靠终端 → 真 spawn → 命令回显 → 关面板历史保留 ----
         会话由服务端常驻，这里走的是 preload IPC → server/terminal-api 真模块。 */
      await win.webContents.executeJavaScript(clickHead('panelTerminal'))
      await new Promise((resolve) => setTimeout(resolve, 900))
      const termOpen = await win.webContents.executeJavaScript(PROBE_TERMINAL)
      check('面板：点终端图标 → 终端打开（停靠预览下方，预览不退场）',
        termOpen.visible === true && termOpen.previewVisible === true && termOpen.xtermReady === true,
        'visible=' + termOpen.visible + ' preview=' + termOpen.previewVisible + ' xterm=' + termOpen.xtermReady)
      check('面板：终端目录列表有候选（编号列表，弃下拉框）',
        termOpen.dirItems >= 1 && termOpen.dirOn.length >= 1,
        'items=' + termOpen.dirItems + ' on=' + termOpen.dirOn)

      /* 目录切换：点第 2 项（不等于当前目录就换）→ 当前项高亮 + 头部标签更新。
         ⌥+数字热键：往 xterm 的隐藏 textarea 发 altKey+Digit 键盘事件。 */
      const dirClick = await win.webContents.executeJavaScript(`(async () => {
        const items = document.querySelectorAll('#terminalDirs .terminal-dir-item');
        if (items.length < 2) return { skipped: true };
        const before = document.querySelector('#terminalDirs .terminal-dir-item.on .terminal-dir-name');
        const beforeName = before ? before.textContent : '';
        let target = items[1];
        if (target.classList.contains('on')) target = items[0];
        const name = target.querySelector('.terminal-dir-name').textContent;
        target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        await new Promise((r) => setTimeout(r, 500));
        const after = document.querySelector('#terminalDirs .terminal-dir-item.on .terminal-dir-name');
        const st = window.__dshTermState || {};
        return { skipped: false, beforeName: beforeName, name: name, afterName: after ? after.textContent : '',
                 cwd: st.cwd, sid: st.sid, busy: st.busy };
      })()`)
      if (dirClick && not(dirClick.skipped)) {
        check('面板：点目录列表第 2 项 → 当前目录切换并高亮',
          dirClick.afterName === dirClick.name && dirClick.afterName !== dirClick.beforeName,
          JSON.stringify(dirClick))
      }
      const dirHotkey = await win.webContents.executeJavaScript(`(() => {
        const items = document.querySelectorAll('#terminalDirs .terminal-dir-item');
        const area = document.querySelector('.xterm-helper-textarea');
        if (!area || items.length < 2) return { skipped: true };
        const before = document.querySelector('#terminalDirs .terminal-dir-item.on .terminal-dir-name');
        let index = -1;
        for (let i = 0; i < items.length; i++) if (!items[i].classList.contains('on')) index = i;
        const target = items[index === -1 ? 0 : index];
        const name = target.querySelector('.terminal-dir-name').textContent;
        const code = 'Digit' + target.querySelector('.terminal-dir-num').textContent;
        area.dispatchEvent(new KeyboardEvent('keydown', { code: code, altKey: true, bubbles: true, cancelable: true }));
        return { skipped: false, name: name, before: before ? before.textContent : '' };
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 500))
      if (dirHotkey && not(dirHotkey.skipped)) {
        const afterHotkey = await win.webContents.executeJavaScript(PROBE_TERMINAL)
        check('面板：⌥+数字 → 热键切到对应目录（xterm 收键前拦截）',
          afterHotkey.dirOn === dirHotkey.name && afterHotkey.dirOn !== dirHotkey.before,
          'on=' + afterHotkey.dirOn + ' 期望=' + dirHotkey.name)
      }

      /* 目录列表稳定性（用户：来回切换每切一次多一个目录）：
         来回切 4 次，条目数/名字都不能增长 */
      const dirGrowth = await win.webContents.executeJavaScript(`(async () => {
        const snap = () => Array.from(document.querySelectorAll('#terminalDirs .terminal-dir-item .terminal-dir-name'))
          .map((node) => node.textContent);
        const out = [snap()];
        for (let i = 0; i < 4; i++) {
          const items = Array.from(document.querySelectorAll('#terminalDirs .terminal-dir-item'));
          const target = items.find((item) => !item.classList.contains('on')) || items[0];
          if (!target) break;
          target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          await new Promise((r) => setTimeout(r, 700));
          out.push(snap());
        }
        return out;
      })()`)
      {
        const first = JSON.stringify(dirGrowth[0])
        const grew = dirGrowth.some((list) => JSON.stringify(list) !== first)
        check('面板：目录列表来回切换不增长（每切一次多一个 = bug）', not(grew), JSON.stringify(dirGrowth))
      }

      await win.webContents.executeJavaScript(TERMINAL_TYPE)
      await new Promise((resolve) => setTimeout(resolve, 1200))
      const termRan = await win.webContents.executeJavaScript(PROBE_TERMINAL)
      check('面板：终端命令真的跑了（echo 输出可见）',
        termRan.outTail.indexOf('TERMINAL_SMOKE_OK') >= 0,
        JSON.stringify(termRan.outTail.slice(-120)))

      /* 多行输出要完整显示，内部「命令结束哨兵」不能漏到屏幕上
         （服务端每条命令后追加 marker 让渲染层知道命令跑完了 —— 它只是内部信号） */
      await win.webContents.executeJavaScript(`(() => {
        window.__dshTerminalInput('echo OUT_A; echo OUT_B');
        window.__dshTerminalInput('\\r');
        return true;
      })()`)
      await new Promise((resolve) => setTimeout(resolve, 1500))
      const multiOut = await win.webContents.executeJavaScript(PROBE_TERMINAL)
      /* 折行会把一个词拆到两行，断言前先去掉空白再找（窄终端本来就该折行） */
      const multiFlat = String(multiOut.outTail || '').replace(/\s+/g, '')
      check('面板：多行命令输出完整显示 + 内部哨兵不外泄',
        multiFlat.indexOf('OUT_A') >= 0 && multiFlat.indexOf('OUT_B') >= 0
          && multiFlat.indexOf('__DSH_CMD_READY__') === -1,
        JSON.stringify(multiOut.outTail.slice(-140)))

      /* 关掉终端再打开：会话没死、xterm 内容还在 + 服务端缓冲 replay = 历史保留。
         ⚠️ 还要断言 sid 没变 —— 以前 termState 不带 sid（多会话服务端返回 {sessions}），
         渲染层把活会话误判成死的，重开就偷偷重启，结果只剩提示符（用户报的「命令结果不见了」）。 */
      const sidBeforeClose = termRan.diag.sid
      await win.webContents.executeJavaScript(CLOSE_TERMINAL_HINT)
      await new Promise((resolve) => setTimeout(resolve, 250))
      const termClosed = await win.webContents.executeJavaScript(PROBE_PANEL_MODE)
      check('面板：再点一次终端图标 → 收起终端', termClosed.hintCount === 0, String(termClosed.hintCount))
      await win.webContents.executeJavaScript(clickHead('panelTerminal'))
      await new Promise((resolve) => setTimeout(resolve, 900))
      const termReopen = await win.webContents.executeJavaScript(PROBE_TERMINAL)
      check('面板：重开终端历史还在（xterm 实例 + 服务端缓冲 replay）',
        termReopen.visible === true && termReopen.outTail.indexOf('TERMINAL_SMOKE_OK') >= 0,
        'visible=' + termReopen.visible + ' tail=' + JSON.stringify(termReopen.outTail.slice(-80))
          + ' diag=' + JSON.stringify(termReopen.diag))
      check('面板：重开终端没偷偷换会话（sid 不变，历史才在）',
        not(sidBeforeClose) || termReopen.diag.sid === sidBeforeClose,
        sidBeforeClose + ' -> ' + termReopen.diag.sid)
      /* 列数不能停在个位数：fit 在面板刚显示那一帧会量到 0 而放弃，输出被折断 */
      check('面板：重开终端后列数正常（fit 重试生效，输出不折断）',
        termReopen.diag.cols >= 30, 'cols=' + termReopen.diag.cols)

      /* 分隔条拖高度：向上拖 80 = 终端 240 → 320，rAF 应用 + localStorage 记住 */
      const termSplit = await win.webContents.executeJavaScript(dragTerminalSplit(-80))
      if (not(check('拖拽：测得到预览|终端分隔条', termSplit && not(termSplit.missing)))) {
        /* 把手都没有，后面三条也别跑了 */
      } else {
        check('拖拽：分隔条向上拖 → 终端变高（240 → 320）',
          termSplit.after === '320px' && termSplit.height === 320,
          'var=' + termSplit.after + ' 实高=' + termSplit.height)
        check('拖拽：分隔条拖动中 rAF 已应用', termSplit.mid === '320px', 'mid=' + termSplit.mid)
        check('拖拽：终端高度记进 localStorage', termSplit.stored === '320', String(termSplit.stored))
        /* 双击复位，别把 320 带进后面的布局断言 */
        await win.webContents.executeJavaScript(DBL_HANDLE('terminalSplit'))
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      await win.webContents.executeJavaScript(CLOSE_TERMINAL_HINT)
      await new Promise((resolve) => setTimeout(resolve, 120))

      /* ---- ④ 拖拽要能一路拖到边界（2026-09-19 用户：所有拖动条支持无限拖动，
              拖到最大/最小、不超过边界就好 —— 以前写死 MAX_PANEL=760，宽窗口一拖就卡住）----
         窗口加宽到 1600，旧上限 760 就不够用了：拖到底应该停在
         「视口 1600 − 会话区左沿 260 − 会话区下限 280 = 1060」。 */
      win.setBounds({ width: 1600, height: 900 })
      await new Promise((resolve) => setTimeout(resolve, 200))
      /* 拖 -900：起点 460 + 900 = 1360，早过了边界 1220 —— 断言的是「停在边界」，
         不是「跟着鼠标走多少」。拖太少会量出中间值，那是跟着鼠标走，不是夹到边界。 */
      const panelDrag = await win.webContents.executeJavaScript(dragHandle('panelResize', -900))
      if (not(check('拖拽：测得到面板左缘把手', panelDrag && not(panelDrag.missing)))) {
        /* 把手都没有，后面两条也别跑了 */
      } else {
        /* 边界 = 视口 1600 − 会话区左沿 260 − 会话区下限 120 = 1220（旧上限 760 早就不够） */
        check('拖拽：面板能一路拖到边界（1220，越过旧上限 760）',
          panelDrag.after === '1220px' && panelDrag.width === 1220,
          'var=' + panelDrag.after + ' 实宽=' + panelDrag.width)
        check('拖拽：拖动中（松手前）rAF 已把宽度应用上',
          panelDrag.mid === '1220px', 'mid=' + panelDrag.mid)
        check('拖拽：面板宽度记进 localStorage', panelDrag.stored === '1220', String(panelDrag.stored))

        /* 文件列表右缘：往右拖 = 变宽（210 + 300 = 510，上限是面板宽 − 预览下限 160） */
        const explorerDrag = await win.webContents.executeJavaScript(dragHandle('explorerResize', 300))
        if (check('拖拽：测得到文件列表右缘的把手', explorerDrag && not(explorerDrag.missing))) {
          check('拖拽：文件列表跟着鼠标走（210 → 510）',
            explorerDrag.after === '510px' && explorerDrag.width === 510,
            'var=' + explorerDrag.after + ' 实宽=' + explorerDrag.width)
          check('拖拽：文件列表拖动中 rAF 已应用（510）',
            explorerDrag.mid === '510px', 'mid=' + explorerDrag.mid)
          check('拖拽：文件列表没拖穿预览区（510 ≤ 面板1220 − 预览下限160）',
            explorerDrag.width <= 1220 - 160, explorerDrag.width + ' <= 1060')
          check('拖拽：文件列表宽度记进 localStorage',
            explorerDrag.stored === '510', String(explorerDrag.stored))
          /* 双击复位 */
          await win.webContents.executeJavaScript(DBL_HANDLE('explorerResize'))
          await new Promise((resolve) => setTimeout(resolve, 60))
          const reset = await win.webContents.executeJavaScript(
            "document.documentElement.style.getPropertyValue('--explorer-width').trim()")
          check('拖拽：双击文件列表把手回到默认宽 210', reset === '210px', reset)
        }

        /* 面板把手双击回默认宽度（1600 × 0.38 = 608，在 [460,720] 内） */
        await win.webContents.executeJavaScript(DBL_HANDLE('panelResize'))
        await new Promise((resolve) => setTimeout(resolve, 60))
        const panelReset = await win.webContents.executeJavaScript(
          "document.documentElement.style.getPropertyValue('--panel-width').trim()")
        check('拖拽：双击面板把手回到默认宽 608', panelReset === '608px', panelReset)
      }

      /* ---- ⑤ 「只看文件」模式：两枚折叠按钮退场，顶栏按钮点得到 ----
         红黄绿是 macOS 才有的，让位规则也写在 .shell-mac 下 —— 必须先把类加回来，
         不然量到的是「Win/Linux 没有灯、当然不用让位」，那是条永远绿的假断言。 */
      await win.webContents.executeJavaScript(ADD_MAC)
      await new Promise((resolve) => setTimeout(resolve, 60))
      await win.webContents.executeJavaScript(clickHead('panelVscode'))
      await new Promise((resolve) => setTimeout(resolve, 80))
      const chatHidden = await win.webContents.executeJavaScript(PROBE_CHAT_HIDDEN)
      check('只看文件：面板铺满整窗', chatHidden.panelWidth === chatHidden.innerWidth,
        chatHidden.panelWidth + ' / ' + chatHidden.innerWidth)
      check('只看文件：顶栏靠左给红黄绿让位（padding-left 80 / 目录图标 x ≥ 68）',
        chatHidden.headPaddingLeft === '80px' && chatHidden.explorerToggle !== null
          && chatHidden.explorerToggle.left >= 68,
        'padding=' + chatHidden.headPaddingLeft + ' 目录图标x=' +
          (chatHidden.explorerToggle ? chatHidden.explorerToggle.left : 'null'))
      check('只看文件：右侧折叠按钮退场（不然压在 VS Code / 终端按钮上）',
        chatHidden.panelToggleDisplay === 'none', chatHidden.panelToggleDisplay)
      check('只看文件：左侧折叠按钮退场（左边已经没有侧边栏可折）',
        chatHidden.sidebarToggleDisplay === 'none', chatHidden.sidebarToggleDisplay)
      for (const item of [['vscode', 'VS Code'], ['terminal', '终端'], ['explorerToggle', '目录']]) {
        const button = chatHidden[item[0]]
        if (not(check('只看文件：测得到面板顶栏的「' + item[1] + '」按钮', button !== null))) continue
        check('只看文件：「' + item[1] + '」按钮点得到（没有被折叠按钮盖住）',
          button.display !== 'none' && button.hitSelf === true,
          'display=' + button.display + ' hit=' + button.hitName)
      }
      await win.webContents.executeJavaScript(clickHead('panelVscode'))
      await new Promise((resolve) => setTimeout(resolve, 80))
      await win.webContents.executeJavaScript(STRIP_MAC)
    }

    await win.webContents.executeJavaScript(PANEL_CLOSE)

    /* ---- 收尾：模拟「关掉软件再打开」（页面重载 = 渲染层全新，xterm 是空实例）----
       标签页从 localStorage 恢复，但屏幕内容必须靠服务端 replay 补回来
       （用户报的「执行完没显示正常结果」里就有这一档：重开只剩提示符） */
    await win.webContents.reload()
    await new Promise((resolve) => setTimeout(resolve, 2500))
    /* 重载前面板是关着的（PANEL_CLOSE）—— 先开面板，终端才有可见宽度可言 */
    await win.webContents.executeJavaScript('(() => { if (window.filePanel) window.filePanel.open(); return true })()')
    await new Promise((resolve) => setTimeout(resolve, 400))
    await win.webContents.executeJavaScript(clickHead('panelTerminal'))
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const afterReload = await win.webContents.executeJavaScript(PROBE_TERMINAL)
    const reloadFlat = String(afterReload.outTail || '').replace(/\s+/g, '')
    check('重启界面后终端历史靠 replay 回来（打开关闭软件不丢命令结果）',
      afterReload.visible === true && reloadFlat.indexOf('TERMINAL_SMOKE_OK') >= 0
        && afterReload.diag.nonEmptyLines >= 5,
      'tail=' + JSON.stringify(afterReload.outTail.slice(-100)) + ' diag=' + JSON.stringify(afterReload.diag))
  }

  /* ------------------------------------------------ 思考过程按会话记账（真机，2026-09-19 用户报告）
     并发之后一条会话可能在后台整轮跑完（用户正看着别的会话）。它的过程事件**不能丢** ——
     旧实现里 handleEvent 对「不是当前会话」的事件直接 return，于是切回去整块「思考过程」
     是空的（用户：「有的会话的思考过程没了」）。
     这一段在真 Chromium 里喂真事件：后台会话必须把过程写进自己的 processHtml，
     并且切过去之后真的能画出来（顺带验了 innerHTML 的存取往返）。 */
  {
    /* 假 app:get-state 以前回空对象 {}，init 在 fillSettingsForm 就会抛（state.settings 是
       undefined），onEvent 根本注册不上 —— 事件喂进来像打进黑洞。这里换成一份像样的状态，
       保证 init 能跑完整条链（这也顺带把「init 中途抛掉 = 监听缺席」这种假绿暴露出来）。 */
    try { electron.ipcMain.removeHandler('app:get-state') } catch (error) {}
    electron.ipcMain.handle('app:get-state', () => ({
      settings: { theme: 'dark', models: [], projects: [], currentProjectId: '', approvalAllow: [] },
      workspacePath: '/ws/smoke',
      plugins: [],
      tools: [],
      running: false,
      runningSessions: []
    }))
    await win.webContents.executeJavaScript(`(() => {
      localStorage.setItem('dsh-sessions-v1', JSON.stringify({
        __recent__: [
          { id: 'smoke_cur', scope: 'recent', title: '当前的会话', messages: [], updatedAt: '2026-09-19T00:00:00Z' },
          { id: 'smoke_bg', scope: 'recent', title: '后台的会话', messages: [], updatedAt: '2026-09-19T00:00:00Z' }
        ]
      }));
      localStorage.setItem('dsh-current-session', 'smoke_cur');
      return true;
    })()`)
    await win.webContents.reload()
    await new Promise((resolve) => setTimeout(resolve, 1800))
    const seeded = await win.webContents.executeJavaScript(`(() => {
      return {
        current: localStorage.getItem('dsh-current-session') || '',
        rows: document.querySelectorAll('#chatList .chat-item').length,
        /* init 里 onEvent 的注册在 fillSettingsForm/renderPermission **之后** ——
           前面任何一个抛异常，事件监听就静默缺席（这条探针专门抓这种假绿） */
        pollWired: Boolean(state && state.runPoll),
        inner: document.querySelectorAll('#messagesInner .thinking-block').length
      };
    })()`)
    check('真机：两条会话（当前 / 后台）已喂进渲染层', seeded.current === 'smoke_cur' && seeded.rows >= 2,
      JSON.stringify(seeded))
    check('真机：init 跑到了注册事件监听那一步（没在中间抛掉）', seeded.pollWired === true,
      JSON.stringify(seeded))

    win.webContents.send('agent:event', { type: 'assistant:thinking', sessionId: 'smoke_bg', text: '后台在想_MARKER' })
    win.webContents.send('agent:event', { type: 'tool:start', sessionId: 'smoke_bg', name: 'read_file', args: { path: 'a.js' } })
    win.webContents.send('agent:event', { type: 'tool:result', sessionId: 'smoke_bg', name: 'read_file', result: 'TOOL_RESULT_MARKER' })
    await new Promise((resolve) => setTimeout(resolve, 600))

    const bgState = await win.webContents.executeJavaScript(`(() => {
      let store = {};
      try { store = JSON.parse(localStorage.getItem('dsh-sessions-v1') || '{}') } catch (e) {}
      const list = Array.isArray(store.__recent__) ? store.__recent__ : [];
      const bg = list.filter((s) => s.id === 'smoke_bg')[0] || null;
      const blocks = document.querySelectorAll('#messagesInner .thinking-block');
      const text = Array.prototype.map.call(blocks, (b) => String(b.textContent || '')).join('|');
      return { html: bg && bg.processHtml ? String(bg.processHtml) : '', blocks: blocks.length, text: text.slice(0, 140) };
    })()`)
    check('真机（走 IPC 真事件）：后台会话的过程被记进它自己的 processHtml（思考 + 工具调用 + 工具结果都在）',
      bgState.html.indexOf('后台在想_MARKER') >= 0 && bgState.html.indexOf('read_file') >= 0
        && bgState.html.indexOf('TOOL_RESULT_MARKER') >= 0 && bgState.html.indexOf('thinking-tool') >= 0,
      'html=' + bgState.html.slice(0, 180))
    check('真机：后台会话的过程没有被画进当前会话的画布',
      bgState.text.indexOf('后台在想_MARKER') === -1, 'text=' + bgState.text)

    /* 点侧栏切到那条后台会话：思考过程必须画出来（就是用户说「没了」的那块） */
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const rows = document.querySelectorAll('#chatList .chat-item');
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].textContent || '').indexOf('后台的会话') >= 0) { rows[i].click(); return true; }
      }
      return false;
    })()`)
    await new Promise((resolve) => setTimeout(resolve, 600))
    const afterSwitch = await win.webContents.executeJavaScript(`(() => {
      const blocks = document.querySelectorAll('#messagesInner .thinking-block');
      return {
        current: localStorage.getItem('dsh-current-session') || '',
        blocks: blocks.length,
        text: Array.prototype.map.call(blocks, (b) => String(b.textContent || '')).join('|').slice(0, 160)
      };
    })()`)
    check('真机：切回后台跑过的会话，思考过程画得出来（用户报的「没了」）',
      clicked === true && afterSwitch.current === 'smoke_bg' && afterSwitch.blocks >= 1
        && afterSwitch.text.indexOf('后台在想_MARKER') >= 0 && afterSwitch.text.indexOf('read_file') >= 0,
      JSON.stringify(afterSwitch))
  }

  try { win.destroy() } catch (error) {}
  server.close()

  console.log('')
  try { require('../server/terminal-api').teardownAll() } catch (error) {}
  if (failed > 0) {
    console.log('shell drag smoke: ' + passed + '/' + (passed + failed) + ' checks passed, ' + failed + ' FAILED')
    electron.app.exit(1)
    return
  }
  console.log('shell drag smoke: ' + passed + '/' + (passed + failed) + ' checks passed, electron ' + process.versions.electron)
  electron.app.exit(0)
}

/* ------------------------------------------------ 两种跑法：node 找运行时，electron 干活 */

function runAsNode() {
  const binary = findElectron()
  if (not(binary)) {
    console.log('shell drag smoke: skipped - 找不到 Electron 运行时')
    console.log('  装一个：npm i -D electron@22.3.27，或先跑一次 npm run build:desktop:mac 留下 release/.electron-dist')
    process.exit(0)
  }
  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  /* 受限环境里 Chromium 的 seatbelt 初始化会失败
     （"sandbox initialization failed: Operation not permitted"）——
     设 SMOKE_NO_SANDBOX=1 关掉它继续跑；默认不放开关。 */
  const args = [__filename]
  if (env.SMOKE_NO_SANDBOX === '1') args.unshift('--no-sandbox')
  console.log('shell drag smoke: 用 ' + binary)
  const result = spawnSync(binary, args, { stdio: 'inherit', env })
  process.exit(result.status === null ? 1 : result.status)
}

if (process.versions && process.versions.electron) {
  runInElectron().catch((error) => {
    console.error('shell drag smoke crashed: ' + (error && error.stack ? error.stack : error))
    try { require('electron').app.exit(1) } catch (e) { process.exit(1) }
  })
} else {
  runAsNode()
}
