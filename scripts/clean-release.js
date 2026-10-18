#!/usr/bin/env node
'use strict'

// 默认仅清理已成功归档的历史桌面产物，保留原生 Mac 程序、活动程序、缓存和验证报告。
const fs = require('fs')
const path = require('path')
const { prune } = require('./release-retention')
const release = path.resolve(__dirname, '../release')
const desktop = path.join(release, 'desktop')
const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
if (args.includes('--all')) throw new Error('请明确选择要删除的成品；默认清理始终保留最新版。')
if (fs.existsSync(desktop)) prune(desktop, { dryRun })
if (args.includes('--drop-cache')) {
  const cache = path.join(release, '.electron-dist')
  if (!dryRun) fs.rmSync(cache, { recursive: true, force: true })
  console.log((dryRun ? 'would remove ' : 'removed ') + cache)
}
