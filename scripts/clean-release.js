#!/usr/bin/env node
'use strict'

/**
 * 清理 release/ 里的中间产物与历史包，只留桌面版成品 zip。
 *
 *   node scripts/clean-release.js                # 留 release/desktop/*.zip 与 .electron-dist 缓存
 *   node scripts/clean-release.js --drop-cache   # 连构建缓存一起删（下次打包要重下运行时）
 *   node scripts/clean-release.js --dry-run      # 只看会删什么
 *   node scripts/clean-release.js --all          # 连成品 zip 一起删
 *
 * 为什么要它：build-desktop 每跑一次就在 release/desktop/<target>/ 留一份解包目录
 * （三个平台合计约 670MB），而以前的 Shell/Service/Plugin 三件套和 Linux tar
 * 也堆在 release/ 根下。这份脚本让"清干净"变成一句话。
 *
 * 构建缓存（.electron-dist）默认保留：它是唯一删了要重新联网下载的东西，
 * 而且 scripts/shell-page-smoke.js 会拿它当 Electron 运行时用。
 */

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const RELEASE = path.join(ROOT, 'release')
const DESKTOP = path.join(RELEASE, 'desktop')
const CACHE_DIR = '.electron-dist'

const args = process.argv.slice(2)
const dryRun = args.indexOf('--dry-run') >= 0
const dropCache = args.indexOf('--drop-cache') >= 0
const removeAll = args.indexOf('--all') >= 0

function sizeOf(target) {
  let stat = null
  try {
    stat = fs.lstatSync(target)
  } catch (error) {
    return 0
  }
  if (stat.isSymbolicLink()) return 0
  if (stat.isFile()) return stat.size
  if (!stat.isDirectory()) return 0
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(target)
  } catch (error) {
    return 0
  }
  for (const name of entries) total += sizeOf(path.join(target, name))
  return total
}

function human(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
  if (bytes >= 1024 * 1024) return Math.round(bytes / (1024 * 1024)) + ' MB'
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' KB'
  return bytes + ' B'
}

const victims = []

if (!fs.existsSync(RELEASE)) {
  console.log('clean-release: release/ 不存在，没什么可清的')
  process.exit(0)
}

for (const name of fs.readdirSync(RELEASE)) {
  if (name === 'desktop') continue
  if (name === CACHE_DIR && !dropCache) continue
  victims.push(path.join(RELEASE, name))
}

if (fs.existsSync(DESKTOP)) {
  for (const name of fs.readdirSync(DESKTOP)) {
    const isZip = name.endsWith('.zip')
    if (isZip && !removeAll) continue
    victims.push(path.join(DESKTOP, name))
  }
}

if (victims.length === 0) {
  console.log('clean-release: 已经很干净了')
  process.exit(0)
}

let total = 0
for (const target of victims) {
  const bytes = sizeOf(target)
  total += bytes
  const label = path.relative(ROOT, target)
  if (dryRun) {
    console.log('would remove  ' + label + '  (' + human(bytes) + ')')
    continue
  }
  try {
    fs.rmSync(target, { recursive: true, force: true })
    console.log('removed  ' + label + '  (' + human(bytes) + ')')
  } catch (error) {
    console.error('failed   ' + label + '  ' + ((error && error.message) || error))
    process.exitCode = 1
  }
}

const kept = removeAll
  ? '（什么都没留）'
  : '保留 release/desktop/*.zip' + (dropCache ? '' : ' 与 ' + CACHE_DIR + ' 构建缓存')
console.log('')
console.log((dryRun ? '将释放 ' : '释放 ') + human(total) + '，' + kept)
if (removeAll) {
  console.log('提示：成品包也删了，下次交给别人前要重新 build:desktop')
}
if (dropCache) {
  console.log('提示：构建缓存没了，下次 build:desktop 会重新下载 Electron 运行时（约 260MB）')
  console.log('      scripts/shell-page-smoke.js 在没有缓存又没有 node_modules/electron 时会自动跳过')
}
