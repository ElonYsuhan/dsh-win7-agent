'use strict'
/* 应用菜单（标题栏左上角 ☰）：渲染层自绘，取代 Electron 的 menu.popup()。
   原生弹层是 Chromium 自己排的版 —— 左列与右面板顶边差 17px、字号 16px、配色不跟主题走，
   CSS 一点都碰不到。这里用同一份数据画成一个整体面板（左分组 / 右条目），
   取色全走主题变量，命令通过 desktopWindow.menuInvoke 回主进程白名单执行，
   白名单与门控仍然只有 shell/menu.js 一份。 */
;(function () {
  const mod = /Mac/i.test(navigator.userAgent) ? 'Cmd' : 'Ctrl'
  const CHECK = '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.6 7.4l2.9 2.9 5.9-6"/></svg>'
  const GROUPS = [
    {
      id: 'file',
      label: '文件',
      items: [
        { id: 'new-session', label: '新建会话', accel: 'Ctrl+N' },
        { id: 'add-project', label: '添加项目…' },
        { id: 'close-file', label: '关闭当前文件', accel: 'Ctrl+Shift+W', requires: 'file' },
        { id: 'settings', label: '设置…', accel: 'Ctrl+,' },
        { separator: true },
        { id: 'close-window', label: '关闭窗口' },
        { id: 'quit', label: '退出' }
      ]
    },
    {
      id: 'edit',
      label: '编辑',
      items: [
        { id: 'undo', label: '撤销', accel: 'Ctrl+Z' },
        { id: 'redo', label: '重做', accel: 'Ctrl+Y' },
        { separator: true },
        { id: 'cut', label: '剪切', accel: 'Ctrl+X' },
        { id: 'copy', label: '复制', accel: 'Ctrl+C' },
        { id: 'paste', label: '粘贴', accel: 'Ctrl+V' },
        { id: 'paste-style', label: '粘贴并匹配样式', accel: 'Ctrl+Shift+V' },
        { id: 'select-all', label: '全选', accel: 'Ctrl+A' }
      ]
    },
    {
      id: 'view',
      label: '视图',
      items: [
        { id: 'sidebar', label: '显示/隐藏侧栏', accel: 'Ctrl+B', toggle: 'sidebar' },
        { id: 'panel', label: '显示/隐藏文件面板', toggle: 'panel' },
        { id: 'markdown', label: 'Markdown 侧边预览', requires: 'markdown', toggle: 'preview' },
        { separator: true },
        { id: 'zoom-in', label: '放大', accel: 'Ctrl+=' },
        { id: 'zoom-out', label: '缩小', accel: 'Ctrl+-' },
        { id: 'zoom-reset', label: '实际大小', accel: 'Ctrl+0' },
        { id: 'fullscreen', label: '全屏', accel: 'F11' }
      ]
    },
    {
      id: 'window',
      label: '窗口',
      items: [
        { id: 'minimize', label: '最小化' },
        { id: 'toggle-maximize', label: '最大化/还原' }
      ]
    },
    {
      id: 'help',
      label: '帮助',
      items: [
        { id: 'usage', label: '使用说明' },
        { id: 'shortcuts', label: '快捷键' },
        { id: 'open-logs', label: '打开日志目录' },
        { id: 'copy-diagnostics', label: '复制诊断信息' },
        { separator: true },
        { id: 'about', label: '关于 Agent' }
      ]
    }
  ]
  let panel = null
  let groupList = null
  let itemList = null
  let active = GROUPS[0].id
  let cursor = 0
  let shown = false

  /* 状态直接读界面本身：文件面板自己报 file / markdown / panel / preview，侧栏看 #app 的类。 */
  const snapshot = () => {
    const source = window.filePanel && typeof window.filePanel.menuState === 'function' ? window.filePanel.menuState() : {}
    const app = document.getElementById('app')
    return {
      file: source.file === true,
      markdown: source.markdown === true,
      panel: source.panel === true,
      preview: source.preview === true,
      sidebar: app ? !app.classList.contains('sidebar-collapsed') : false
    }
  }
  const allowed = (item, now) => item.requires === 'file' ? now.file : item.requires === 'markdown' ? now.markdown : true
  const isOn = (item, now) => Boolean(item.toggle) && now[item.toggle] === true

  const ensure = () => {
    if (panel) return panel
    panel = document.createElement('div')
    panel.className = 'app-menu hidden'
    panel.setAttribute('role', 'menu')
    panel.setAttribute('aria-label', '应用菜单')
    groupList = document.createElement('div')
    groupList.className = 'app-menu-groups'
    itemList = document.createElement('div')
    itemList.className = 'app-menu-items'
    panel.append(groupList, itemList)
    document.body.appendChild(panel)
    return panel
  }

  const render = () => {
    const now = snapshot()
    groupList.textContent = ''
    itemList.textContent = ''
    for (const group of GROUPS) {
      const row = document.createElement('button')
      row.type = 'button'
      row.tabIndex = -1
      row.className = group.id === active ? 'app-menu-group is-active' : 'app-menu-group'
      const label = document.createElement('span')
      label.className = 'app-menu-label'
      label.textContent = group.label
      const arrow = document.createElement('span')
      arrow.className = 'app-menu-arrow'
      arrow.textContent = '›'
      row.append(label, arrow)
      row.addEventListener('pointerenter', () => { if (shown && active !== group.id) { active = group.id; cursor = 0; render() } })
      row.addEventListener('click', () => { if (active !== group.id) { active = group.id; cursor = 0; render() } })
      groupList.appendChild(row)
    }
    const group = GROUPS.find((entry) => entry.id === active) || GROUPS[0]
    for (const item of group.items) {
      if (item.separator) {
        const line = document.createElement('div')
        line.className = 'app-menu-sep'
        line.setAttribute('role', 'separator')
        itemList.appendChild(line)
        continue
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'app-menu-item'
      row.dataset.command = item.id
      row.disabled = !allowed(item, now)
      row.setAttribute('role', 'menuitem')
      const mark = document.createElement('span')
      mark.className = 'app-menu-check'
      if (isOn(item, now)) mark.innerHTML = CHECK
      const label = document.createElement('span')
      label.className = 'app-menu-label'
      label.textContent = item.label
      const accel = document.createElement('span')
      accel.className = 'app-menu-accel'
      accel.textContent = item.accel ? item.accel.replace(/^Ctrl/, mod) : ''
      row.append(mark, label, accel)
      row.addEventListener('pointerenter', () => { const at = actives().indexOf(row); if (at >= 0) { cursor = at; paint() } })
      row.addEventListener('click', () => run(item.id))
      itemList.appendChild(row)
    }
  }

  const actives = () => Array.from(itemList.querySelectorAll('.app-menu-item:not(:disabled)'))
  /* 光标用索引记账而不是 DOM 焦点：分组切换会重建整个条目列表，
     焦点会掉到 body，键盘就「失灵」了。 */
  const paint = () => {
    const list = actives()
    if (!list.length) return
    cursor = Math.max(0, Math.min(cursor, list.length - 1))
    list.forEach((node, index) => node.classList.toggle('is-active', index === cursor))
  }
  const move = (delta) => {
    const list = actives()
    if (!list.length) return
    cursor = (cursor + delta + list.length) % list.length
    paint()
  }
  const run = (id) => {
    close(false)
    const bridge = window.desktopWindow
    if (bridge && typeof bridge.menuInvoke === 'function') bridge.menuInvoke(id)
  }
  const place = () => {
    const anchor = document.querySelector('.app-menu-button')
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 8, bottom: 44 }
    panel.classList.remove('hidden')
    const width = panel.offsetWidth || 300
    const height = panel.offsetHeight || 220
    const left = Math.min(Math.max(8, rect.left - 2), Math.max(8, window.innerWidth - width - 8))
    let top = rect.bottom + 2
    if (top + height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - height - 8)
    panel.style.left = Math.round(left) + 'px'
    panel.style.top = Math.round(top) + 'px'
  }
  const open = () => {
    ensure()
    /* 每次打开都回到第一个分组：原生菜单栏就是这个习惯，别记住上次悬停的那一列。 */
    active = GROUPS[0].id
    cursor = 0
    render()
    shown = true
    place()
    paint()
  }
  const close = (restore) => {
    if (!shown || !panel) return
    shown = false
    panel.classList.add('hidden')
    if (restore === false) return
    const anchor = document.querySelector('.app-menu-button')
    if (anchor) anchor.focus()
  }
  function onKeydown(event) {
    if (!shown) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'ArrowDown') { event.preventDefault(); event.stopPropagation(); move(1); return }
    if (event.key === 'ArrowUp') { event.preventDefault(); event.stopPropagation(); move(-1); return }
    if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); cursor = 0; paint(); return }
    if (event.key === 'End') { event.preventDefault(); event.stopPropagation(); cursor = actives().length - 1; paint(); return }
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault()
      event.stopPropagation()
      const at = GROUPS.findIndex((group) => group.id === active)
      const step = event.key === 'ArrowRight' ? 1 : GROUPS.length - 1
      active = GROUPS[(at + step) % GROUPS.length].id
      cursor = 0
      render()
      paint()
      return
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      event.stopPropagation()
      const target = actives()[cursor]
      if (target) target.click()
      return
    }
  }

  const boot = () => {
    const bridge = window.desktopWindow
    /* 浏览器直开（没有桌面壳）时没有 ☰，也不需要这套菜单。 */
    if (!bridge || typeof bridge.onMenuOpen !== 'function') return
    bridge.onMenuOpen(() => { if (shown) close(); else open() })
    document.addEventListener('pointerdown', (event) => {
      if (!shown || !panel) return
      const target = event.target
      if (target && panel.contains(target)) return
      /* ☰ 自己交给 IPC 做开关，否则会「先关再开」看起来没反应。 */
      if (target && typeof target.closest === 'function' && target.closest('.app-menu-button')) return
      close(false)
    }, true)
    window.addEventListener('blur', () => close(false))
    window.addEventListener('resize', () => close(false))
    /* 捕获阶段拦：菜单开着时方向键、回车、Esc 都属于菜单，不能漏给编辑器。 */
    document.addEventListener('keydown', onKeydown, true)
  }
  window.appMenu = { open, close: () => close(false) }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true })
  else boot()
})()
