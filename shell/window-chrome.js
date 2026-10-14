'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const TITLEBAR_HEIGHT = 48
const MAC_TRAFFIC_LIGHT = { x: 16, y: 16 }
let linuxControlsSide = ''

function windowChromeOptions(platform) {
  if ((platform || process.platform) === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: MAC_TRAFFIC_LIGHT }
  }
  // 自绘窗口按钮兼容 Win7，不依赖 titleBarOverlay。
  return { frame: false }
}

function detectControlsSide(platform, options) {
  const target = platform || process.platform
  if (target === 'darwin') return 'left'
  if (target !== 'linux') return 'right'
  const config = options || {}
  const env = config.env || process.env
  const execute = config.execFileSync || execFileSync
  const read = config.readFileSync || fs.readFileSync
  if (/KDE/i.test(String(env.XDG_CURRENT_DESKTOP || ''))) {
    try {
      const file = path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kwinrc')
      const raw = String(read(file, 'utf8'))
      const section = (raw.match(/\[org\.kde\.kdecoration2\]([^]*?)(?=\n\[|$)/) || [])[1] || ''
      const left = (section.match(/^ButtonsOnLeft=(.*)$/m) || [])[1] || ''
      const right = (section.match(/^ButtonsOnRight=(.*)$/m) || [])[1] || ''
      if (left.indexOf('X') >= 0) return 'left'
      if (right.indexOf('X') >= 0) return 'right'
    } catch (error) {}
  }
  try {
    const raw = String(execute('gsettings', ['get', 'org.gnome.desktop.wm.preferences', 'button-layout'], {
      encoding: 'utf8', timeout: 700, stdio: ['ignore', 'pipe', 'ignore']
    })).trim().replace(/^['"]|['"]$/g, '')
    const sides = raw.split(':')
    if (sides.length === 2) {
      if (sides[0].split(',').indexOf('close') >= 0) return 'left'
      if (sides[1].split(',').indexOf('close') >= 0) return 'right'
    }
  } catch (error) {}
  return 'right'
}

function controlsSide(platform) {
  const target = platform || process.platform
  if (target !== 'linux') return detectControlsSide(target)
  if (!linuxControlsSide) linuxControlsSide = detectControlsSide(target)
  return linuxControlsSide
}

function windowState(win, platform) {
  if (!win || win.isDestroyed()) return null
  const target = platform || process.platform
  return {
    platform: target,
    controlsSide: controlsSide(target),
    nativeControls: target === 'darwin',
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
    focused: win.isFocused()
  }
}

function applyWindowAction(win, action) {
  if (!win || win.isDestroyed()) return false
  if (action === 'minimize') win.minimize()
  else if (action === 'toggle-maximize') {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  } else if (action === 'close') win.close()
  else return false
  return true
}

function attachWindowChrome(win, platform) {
  const publish = () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('window:state', windowState(win, platform))
  }
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur']) {
    win.on(event, publish)
  }
  win.webContents.on('did-finish-load', publish)
}

function normalizeTheme(value) {
  return value === 'light' ? 'light' : 'dark'
}

function windowBackground(theme) {
  return normalizeTheme(theme) === 'light' ? '#ffffff' : '#212121'
}

function applyWindowTheme(windows, theme, nativeTheme) {
  const value = normalizeTheme(theme)
  nativeTheme.themeSource = value
  for (const win of windows) {
    if (!win || win.isDestroyed()) continue
    win.setBackgroundColor(windowBackground(value))
    if (!win.webContents.isDestroyed()) win.webContents.send('window:theme', value)
  }
  return value
}

module.exports = { TITLEBAR_HEIGHT, MAC_TRAFFIC_LIGHT, windowChromeOptions, detectControlsSide, controlsSide, windowState, applyWindowAction, attachWindowChrome, normalizeTheme, windowBackground, applyWindowTheme }
