'use strict'

;(function () {
  const base = 'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
  const icons = {
    'wf-start': '<svg ' + base + '><circle cx="12" cy="12" r="9"/><path d="m10 8 6 4-6 4z"/></svg>',
    'wf-human': '<svg ' + base + '><circle cx="12" cy="7" r="3"/><path d="M5 21v-3a7 7 0 0 1 14 0v3"/></svg>',
    'wf-rest': '<svg ' + base + '><path d="m8 5-6 7 6 7M16 5l6 7-6 7M14 3l-4 18"/></svg>',
    'wf-evaluate': '<svg ' + base + '><path d="M4 3v18h17M8 16v-4M13 16V8M18 16V5"/></svg>',
    'wf-select': '<svg ' + base + '><path d="m5 3 14 10-7 1-3 7z"/></svg>',
    'wf-split': '<svg ' + base + '><path d="M12 2v20" stroke-dasharray="3 3"/><path d="M9 12H2m0 0 3-3m-3 3 3 3m10-3h7m0 0-3-3m3 3-3 3"/></svg>',
    'wf-split-horizontal': '<svg ' + base + '><path d="M2 12h20" stroke-dasharray="3 3"/><path d="M12 9V2m0 0-3 3m3-3 3 3m-3 10v7m0 0-3-3m3 3 3-3"/></svg>',
    'wf-layout': '<svg ' + base + '><rect x="2" y="8" width="5" height="8" rx="1"/><rect x="10" y="8" width="5" height="8" rx="1"/><rect x="18" y="8" width="4" height="8" rx="1"/><path d="M7 12h3m5 0h3"/></svg>',
    'wf-save': '<svg ' + base + '><path d="M4 3h13l4 4v14H3V3z"/><path d="M7 3v6h10V3M7 21v-8h10v8"/></svg>',
    'wf-back': '<svg ' + base + '><path d="m14 5-7 7 7 7"/></svg>',
    'wf-test': '<svg ' + base + '><path d="m9 12 2 2 4-5"/><circle cx="12" cy="12" r="9"/></svg>',
    'wf-steps': '<svg ' + base + '><path d="M9 5h12M9 12h12M9 19h12"/><rect x="2" y="3" width="3" height="4" rx=".5"/><rect x="2" y="10" width="3" height="4" rx=".5"/><rect x="2" y="17" width="3" height="4" rx=".5"/></svg>',
    'wf-canvas': '<svg ' + base + '><rect x="2" y="4" width="6" height="5" rx="1"/><rect x="16" y="15" width="6" height="5" rx="1"/><path d="M8 6.5h5a3 3 0 0 1 3 3v8"/></svg>',
    'wf-marquee': '<svg ' + base + '><rect x="4" y="4" width="16" height="16" rx="1" stroke-dasharray="3 3"/><path d="m12 11 8 6-4 1-2 4z"/></svg>',
    'wf-card-resize': '<svg ' + base + '><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M7 12V7h5M7 7l4 4m1 6h5v-5m0 5-4-4"/></svg>',
    'wf-pan': '<svg ' + base + '><path d="M8 12V6a2 2 0 0 1 4 0v5-7a2 2 0 0 1 4 0v7-5a2 2 0 0 1 4 0v9c0 5-3 7-7 7-3 0-5-2-7-5l-3-4a2 2 0 0 1 3-3l2 2"/></svg>',
    'wf-link': '<svg ' + base + '><circle cx="5" cy="6" r="3"/><circle cx="19" cy="18" r="3"/><path d="M8 6h4a3 3 0 0 1 3 3v6h1"/></svg>',
    'wf-zoom-in': '<svg ' + base + '><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6M10 7v6"/></svg>',
    'wf-zoom-out': '<svg ' + base + '><circle cx="10" cy="10" r="7"/><path d="m15 15 6 6M7 10h6"/></svg>',
    'wf-fit': '<svg ' + base + '><path d="M9 3H3v6M15 3h6v6M3 15v6h6M21 15v6h-6"/><rect x="7" y="7" width="10" height="10" rx="1"/></svg>',
    library: '<svg ' + base + '><path d="M4 4v16M10 4v16M16 4l4 16"/></svg>',
    customize: '<svg ' + base + '><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5z"/></svg>',
    workflow: '<svg ' + base + '><rect x="3" y="4" width="6" height="6" rx="1.5"/><rect x="15" y="4" width="6" height="6" rx="1.5"/><rect x="9" y="14" width="6" height="6" rx="1.5"/><path d="M9 7h6M6 10v4a3 3 0 0 0 3 3M18 10v4a3 3 0 0 1-3 3"/></svg>',
    'library-books': '<svg ' + base + '><rect x="3" y="4" width="4" height="16" rx="1"/><rect x="9" y="4" width="4" height="16" rx="1"/><path d="m16 5 3-1 4 15-3 1zM4 8h2M10 8h2"/></svg>',
    sliders: '<svg ' + base + '><path d="M4 7h6M14 7h6M4 17h10M18 17h2"/><circle cx="12" cy="7" r="2"/><circle cx="16" cy="17" r="2"/></svg>',
    'markdown-preview': '<svg ' + base + '><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18M6 7h3M6 11h3M14 12s1.5-3 3-3 3 3 3 3-1.5 3-3 3-3-3-3-3"/><circle cx="17" cy="12" r=".8"/></svg>',
    plus: '<svg ' + base + '><path d="M12 5v14M5 12h14"/></svg>',
    folder: '<svg ' + base + '><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
    'folder-open': '<svg ' + base + '><path d="M3 17V7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3 19h15a2 2 0 0 0 1.9-1.4L22 11H7l-2.1 6.6A2 2 0 0 1 3 19Z"/></svg>',
    more: '<svg ' + base + '><circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/></svg>',
    settings: '<svg ' + base + '><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    bell: '<svg ' + base + '><path d="M18 16v-5a6 6 0 1 0-12 0v5l-1.5 2.5h15z"/><path d="M10 21a2 2 0 0 0 4 0"/></svg>',
    shield: '<svg ' + base + '><path d="M12 3l7 3v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z"/></svg>',
    'shield-check': '<svg ' + base + '><path d="M12 3l7 3v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z"/><path d="M9 12l2 2 4-4"/></svg>',
    'shield-edit': '<svg ' + base + '><path d="M12 3l7 3v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z"/><path d="M9 14l5-5M10 16h4"/></svg>',
    'shield-warn': '<svg ' + base + '><path d="M12 3l7 3v5c0 4.4-2.9 7.4-7 9-4.1-1.6-7-4.6-7-9V6z"/><path d="M12 9v4M12 16h.01"/></svg>',
    mic: '<svg ' + base + '><rect x="9" y="3" width="6" height="10" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/></svg>',
    send: '<svg ' + base + '><path d="M12 20V4"/><path d="M5 11l7-7 7 7"/></svg>',
    stop: '<svg ' + base + '><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    theme: '<svg ' + base + '><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    panel: '<svg ' + base + '><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="9" y1="4" x2="9" y2="20"/></svg>',
    close: '<svg ' + base + '><line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
    model: '<svg ' + base + '><rect x="7" y="7" width="10" height="10" rx="2"/><path d="M9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4"/></svg>',
    plugin: '<svg ' + base + '><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><path d="M13 16.5h7M16.5 13v7"/></svg>',
    general: '<svg ' + base + '><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    sun: '<svg ' + base + '><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg ' + base + '><path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/></svg>',
    check: '<svg ' + base + '><path d="M5 13l4 4L19 7"/></svg>',
    chevron: '<svg ' + base + '><path d="M6 9l6 6 6-6"/></svg>',
    trash: '<svg ' + base + '><path d="M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14M10 11v6M14 11v6"/></svg>',
    copy: '<svg ' + base + '><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    edit: '<svg ' + base + '><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>',
    /* ---- 右侧文件面板 ---- */
    /* panel 的镜像：分隔线挪到右边 */
    'panel-right': '<svg ' + base + '><rect x="3" y="4" width="18" height="16" rx="2"/><line x1="15" y1="4" x2="15" y2="20"/></svg>',
    /* 文件目录（资源管理器）：文件夹上多一道横线，跟侧边栏那枚 folder 区分开 */
    'folder-tree': '<svg ' + base + '><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M3 11h18"/></svg>',
    upload: '<svg ' + base + '><path d="M12 16V3m-5 5 5-5 5 5M4 16v4h16v-4"/></svg>',
    download: '<svg ' + base + '><path d="M12 3v13m-5-5 5 5 5-5M4 17v4h16v-4"/></svg>',
    file: '<svg ' + base + '><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z"/><path d="M13 3v6h6"/></svg>',
    'chevron-right': '<svg ' + base + '><path d="M9 6l6 6-6 6"/></svg>',
    refresh: '<svg ' + base + '><path d="M20.5 12a8.5 8.5 0 1 1-2.6-6.1"/><path d="M20.5 4.5V10h-5.5"/></svg>',
    external: '<svg ' + base + '><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/></svg>',
    terminal: '<svg ' + base + '><rect x="2.5" y="4" width="19" height="16" rx="2"/><path d="M6.5 9.5l2.5 2.5-2.5 2.5"/><line x1="11.5" y1="15" x2="16.5" y2="15"/></svg>',
    warning: '<svg ' + base + '><path d="M12 4 2.5 20h19z"/><path d="M12 10v4M12 17h.01"/></svg>',
    /* VS Code 标是实心填充的（官方 logo 路径），不能套上面那套 stroke 基础属性 */
    vscode: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M23.15 2.587 18.21.21a1.494 1.494 0 0 0-1.705.29l-9.46 8.63-4.12-3.128a.999.999 0 0 0-1.276.057L.327 7.261A1 1 0 0 0 .326 8.74L3.899 12 .326 15.26a1 1 0 0 0 .001 1.479L1.65 17.94a.999.999 0 0 0 1.276.057l4.12-3.128 9.46 8.63a1.492 1.492 0 0 0 1.704.29l4.942-2.377A1.5 1.5 0 0 0 24 20.06V3.939a1.5 1.5 0 0 0-.85-1.352zm-5.146 14.861L10.826 12l7.178-5.448z"/></svg>'
  }

  window.renderIcon = function (name) {
    return icons[name] || ''
  }

  window.applyIcons = function (root) {
    const scope = root || document
    const nodes = scope.querySelectorAll('[data-icon]')
    nodes.forEach(function (node) {
      node.innerHTML = icons[node.getAttribute('data-icon')] || node.innerHTML
    })
  }
})()
