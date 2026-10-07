#!/usr/bin/env node
'use strict'

/**
 * shell/menu.js 的冒烟：应用菜单到底有没有把 Edit 那套 role 补回来。
 *
 * 这条断言守的是一个很容易复发、而且一复发就全应用不可用的 bug：
 * 只要用 Menu.setApplicationMenu() 换掉默认菜单，又没自己声明 Edit，
 * 剪贴板/撤销快捷键就会全部失效 —— 表现就是「输入框粘贴不了内容」。
 * 纯数据断言，不用起 Electron，所以能进 npm run check 的默认链路。
 */

const fs = require('fs')
const path = require('path')

const SHELL_DIR = path.join(__dirname, '..', 'shell')
const menu = require(path.join(SHELL_DIR, 'menu.js'))

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

function submenuOf(template, label) {
  for (const item of template) {
    if (item && item.label === label) return item.submenu || []
  }
  return null
}

function rolesOf(submenu) {
  return (submenu || []).filter((item) => item && item.role).map((item) => item.role)
}

const PLATFORMS = ['darwin', 'win32', 'linux']

/* ------------------------------------------------------------- 结构断言 */

check('导出 menuTemplate', typeof menu.menuTemplate === 'function')
check('导出 EDIT_ROLES', Array.isArray(menu.EDIT_ROLES))
check('EDIT_ROLES 含 paste', menu.EDIT_ROLES.indexOf('paste') >= 0)

for (const os of PLATFORMS) {
  const template = menu.menuTemplate({}, os)

  const edit = submenuOf(template, 'Edit')
  check(os + '：有 Edit 菜单', edit !== null)

  const roles = rolesOf(edit)
  for (const role of menu.EDIT_ROLES) {
    check(os + '：Edit 里有 ' + role, roles.indexOf(role) >= 0)
  }
  // 少一个 paste 就复现「输入框粘贴不了」，所以单独再钉一次
  check(os + '：paste 确实在 Edit 下', roles.indexOf('paste') >= 0)

  check(os + '：有 Service 菜单', submenuOf(template, 'Service') !== null)
  check(os + '：有 View 菜单', submenuOf(template, 'View') !== null)
  check(os + '：还有 quit', rolesOf(submenuOf(template, 'Service')).indexOf('quit') >= 0)

  // macOS 第一项必须是 appMenu，否则 About / 隐藏 / 退出 这些标准项全没有
  if (os === 'darwin') {
    check('darwin：第一项是 appMenu', template[0] && template[0].role === 'appMenu', template[0] && template[0].role)
    check('darwin：Edit 排在 appMenu 之后', template[1] && template[1].label === 'Edit')
  } else {
    check(os + '：没有 appMenu（非 macOS 用不上）', template.every((item) => item.role !== 'appMenu'))
  }

  // 同一套 role 不该出现两次，重复声明往往意味着改坏了
  const all = rolesOf(edit)
  check(os + '：Edit 内角色不重复', new Set(all).size === all.length, all.join(','))
}

/* ------------------------------------------------------------- 回调接线 */

{
  const called = []
  const template = menu.menuTemplate({
    onSettings: () => called.push('settings'),
    onReload: () => called.push('reload'),
    onRestart: () => called.push('restart'),
    onOpenBrowser: () => called.push('browser')
  }, 'linux')
  for (const item of submenuOf(template, 'Service')) {
    if (item && typeof item.click === 'function') item.click()
  }
  check('Service 回调全部接到', called.join(',') === 'settings,reload,restart,browser', called.join(','))
}

{
  // 不传 handlers 也不能炸（主进程启动早期、菜单先于窗口建立时就是这个状态）
  let threw = false
  try {
    const template = menu.menuTemplate()
    for (const item of submenuOf(template, 'Service')) {
      if (item && typeof item.click === 'function') item.click()
    }
  } catch (error) {
    threw = true
  }
  check('不传 handlers 不报错', !threw)
}

/* ------------------------------------------- main.js 真的把它装上了吗 */

{
  const mainSource = fs.readFileSync(path.join(SHELL_DIR, 'main.js'), 'utf8')
  check('main.js require 了 menu 模块', /require\(['"]\.\/menu['"]\)/.test(mainSource))
  check('main.js 调用了 menuTemplate(', mainSource.indexOf('menuTemplate(') >= 0)
  // 模板再对，不 setApplicationMenu 也不会生效
  check('main.js 调用了 Menu.setApplicationMenu', mainSource.indexOf('Menu.setApplicationMenu(') >= 0)
  // 换掉默认菜单是这件事的前提，哪天不换了就该回来重看这段
  check('main.js 仍然在替换默认菜单', mainSource.indexOf('buildFromTemplate') >= 0)
}

console.log('')
if (failed > 0) {
  console.log('shell menu smoke: ' + passed + '/' + (passed + failed) + ' checks passed, ' + failed + ' FAILED')
  process.exit(1)
}
console.log('shell menu smoke: ' + passed + '/' + (passed + failed) + ' checks passed, node ' + process.version)
