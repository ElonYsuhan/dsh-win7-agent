#!/usr/bin/env node
'use strict'

/**
 * 把 release/desktop 下已构建并验收过的安装包发布为 Release 附件。
 *
 * 只发布构建机产物，不参与构建、不改写包内容、不接受未校验的路径：
 * 上传前重新计算 SHA256 并与 release/desktop/SHA256SUMS.txt 比对。
 *
 * 用法：
 *   GITEA_TOKEN=xxx node scripts/publish-release.js --target gitea
 *   GITHUB_TOKEN=yyy node scripts/publish-release.js --target github
 *   GITEA_TOKEN=xxx GITHUB_TOKEN=yyy node scripts/publish-release.js --target both
 *   node scripts/publish-release.js --target both --dry-run
 *
 * 令牌只从环境变量读取，不落盘、不写进命令行历史，也不进入日志。
 * 已存在的同名 Release 会复用，只补传缺失附件。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const https = require('https')
const http = require('http')
const { URL } = require('url')

const ROOT = path.resolve(__dirname, '..')
const DESKTOP = path.join(ROOT, 'release', 'desktop')
const CHANNELS = {
  gitea: {
    api: 'http://192.168.115.246:3000/api/v1/repos/admin/SageAgent',
    upload: null,
    tokenEnv: 'GITEA_TOKEN',
    web: 'http://192.168.115.246:3000/admin/SageAgent/releases'
  },
  github: {
    api: 'https://api.github.com/repos/ElonYsuhan/dsh-win7-agent',
    upload: 'https://uploads.github.com/repos/ElonYsuhan/dsh-win7-agent',
    tokenEnv: 'GITHUB_TOKEN',
    web: 'https://github.com/ElonYsuhan/dsh-win7-agent/releases'
  }
}

// 只有真正构建出来并通过验收的平台才发布；缺失平台如实报告，不用占位文件充数。
const PLATFORMS = [
  { target: 'win-x64', asset: 'Agent-win-x64/Agent.exe', label: 'Windows x64 安装程序' },
  { target: 'linux-x64', asset: 'Agent-linux-x64/Agent.AppImage', label: 'Linux x64 AppImage' },
  { target: 'linux-arm64', asset: 'Agent-linux-arm64/Agent.AppImage', label: 'Linux arm64 AppImage' },
  { target: 'mac-arm64', asset: 'Agent-mac-arm64/Agent.app', label: 'macOS arm64 应用包', directory: true },
  { target: 'mac-x64', asset: 'Agent-mac-x64/Agent.app', label: 'macOS x64 应用包', directory: true }
]

function parseArgs(argv) {
  const options = { target: 'both', dryRun: false, notes: '' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--target') options.target = argv[++index]
    else if (arg === '--notes') options.notes = argv[++index]
    else throw new Error('未知参数: ' + arg)
  }
  if (!['gitea', 'github', 'both'].includes(options.target)) throw new Error('--target 只能是 gitea / github / both')
  return options
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function readSums() {
  const file = path.join(DESKTOP, 'SHA256SUMS.txt')
  if (!fs.existsSync(file)) throw new Error('缺少 release/desktop/SHA256SUMS.txt，请先完成桌面构建')
  const sums = new Map()
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([a-f0-9]{64})\s+(.+)$/)
    if (match) sums.set(match[2].replace(/\\/g, '/'), match[1])
  }
  return sums
}

// 收集本次可发布的产物；目录形态（.app）需要先打包成单个压缩文件，不能直接上传。
function collect() {
  const version = require('../package.json').version
  const sums = readSums()
  const assets = []
  const missing = []
  for (const platform of PLATFORMS) {
    const file = path.join(DESKTOP, platform.asset)
    if (!fs.existsSync(file)) { missing.push(platform.target); continue }
    if (platform.directory) throw new Error(platform.target + ' 是目录形态，请先打包为 .zip 再发布')
    const expected = sums.get(platform.asset)
    if (!expected) throw new Error(platform.target + ' 未登记在 SHA256SUMS.txt 中，拒绝发布未校验产物')
    const actual = sha256(file)
    if (actual !== expected) throw new Error(platform.target + ' 摘要不匹配：' + actual + ' != ' + expected)
    const ext = path.extname(platform.asset)
    assets.push({ ...platform, file, sha256: actual, size: fs.statSync(file).size, name: 'Agent-' + platform.target + '-v' + version + ext })
  }
  if (!assets.length) throw new Error('release/desktop 下没有可发布的安装包')
  return { version, assets, missing, tag: 'v' + version }
}

function releaseNotes(version, assets, missing, extra) {
  const lines = [
    'Agent ' + version + ' 桌面安装包。',
    '',
    '**本次可用平台**',
    '',
    ...assets.map(asset => '- ' + asset.label + '：`' + asset.name + '`（' + (asset.size / 1048576).toFixed(1) + ' MB）\n  SHA256 `' + asset.sha256 + '`'),
    ''
  ]
  if (missing.length) {
    lines.push('**未包含平台**：' + missing.join('、') + '。这些平台尚未构建，等对应构建机产出后再补充发布。', '')
  }
  lines.push(
    '**验收范围**',
    '',
    '- 运行时锁定 Electron 22.3.27 / Node 16.17.1 / Chromium 108，面向 Windows 7 SP1 x64。',
    '- 已通过 `npm run check`、`npm run check:node16` 与交付载荷摘要校验。',
    '- 尚未在 Windows 7 真机上启动验证；构建检查不能替代真机验收。',
    ''
  )
  if (extra) lines.push(extra, '')
  return lines.join('\n')
}

function request(url, options) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const transport = target.protocol === 'http:' ? http : https
    const req = transport.request(target, options, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body = null
        try { body = JSON.parse(text) } catch (error) { body = text }
        resolve({ status: response.statusCode, body })
      })
    })
    req.on('error', reject)
    if (options.body) req.write(options.body)
    req.end()
  })
}

function jsonRequest(url, method, token, payload) {
  const body = payload ? Buffer.from(JSON.stringify(payload)) : null
  // GitHub 强制要求 User-Agent，缺失时直接 403。
  const headers = { Accept: 'application/json', Authorization: 'token ' + token, 'User-Agent': 'agent-release-publisher' }
  if (body) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = body.length }
  return request(url, { method, headers, body })
}

async function ensureRelease(channel, token, tag, name, body) {
  const created = await jsonRequest(channel.api + '/releases', 'POST', token, { tag_name: tag, name, body, draft: false, prerelease: false })
  if (created.status === 201) return { release: created.body, created: true }
  if (created.status === 409 || created.status === 422) {
    const existing = await jsonRequest(channel.api + '/releases/tags/' + encodeURIComponent(tag), 'GET', token)
    if (existing.status === 200) return { release: existing.body, created: false }
    throw new Error('Release 已存在但无法读取: ' + existing.status + ' ' + JSON.stringify(existing.body).slice(0, 200))
  }
  throw new Error('创建 Release 失败: ' + created.status + ' ' + JSON.stringify(created.body).slice(0, 300))
}

function multipart(asset) {
  const boundary = '----agentrelease' + crypto.randomBytes(12).toString('hex')
  const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="attachment"; filename="' + asset.name + '"\r\nContent-Type: application/octet-stream\r\n\r\n')
  const tail = Buffer.from('\r\n--' + boundary + '--\r\n')
  return { body: Buffer.concat([head, fs.readFileSync(asset.file), tail]), contentType: 'multipart/form-data; boundary=' + boundary }
}

async function uploadGitea(channel, token, release, asset) {
  const form = multipart(asset)
  const existing = (release.assets || []).find(item => item.name === asset.name)
  if (existing) return { skipped: true, url: existing.browser_download_url }
  const response = await request(channel.api + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(asset.name), {
    method: 'POST', headers: { Authorization: 'token ' + token, 'Content-Type': form.contentType, 'Content-Length': form.body.length }, body: form.body
  })
  if (response.status !== 201) throw new Error('上传附件失败: ' + response.status + ' ' + JSON.stringify(response.body).slice(0, 300))
  return { skipped: false, url: response.body.browser_download_url }
}

async function uploadGithub(channel, token, release, asset) {
  const existing = (release.assets || []).find(item => item.name === asset.name)
  if (existing) return { skipped: true, url: existing.browser_download_url }
  const body = fs.readFileSync(asset.file)
  const response = await request(channel.upload + '/releases/' + release.id + '/assets?name=' + encodeURIComponent(asset.name), {
    method: 'POST', headers: { Authorization: 'token ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'agent-release-publisher', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length }, body
  })
  if (response.status !== 201) throw new Error('上传附件失败: ' + response.status + ' ' + JSON.stringify(response.body).slice(0, 300))
  return { skipped: false, url: response.body.browser_download_url }
}

async function publish(name, token, options, built) {
  const channel = CHANNELS[name]
  const title = 'Agent ' + built.version
  const notes = releaseNotes(built.version, built.assets, built.missing, options.notes)
  const { release, created } = await ensureRelease(channel, token, built.tag, title, notes)
  console.log('[' + name + '] ' + (created ? '已创建' : '复用已有') + ' Release ' + built.tag)
  for (const asset of built.assets) {
    const result = name === 'gitea' ? await uploadGitea(channel, token, release, asset) : await uploadGithub(channel, token, release, asset)
    console.log('[' + name + '] ' + (result.skipped ? '跳过已存在附件 ' : '已上传 ') + asset.name + ' → ' + result.url)
  }
  return channel.web + '/tag/' + built.tag
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const built = collect()
  const names = options.target === 'both' ? ['gitea', 'github'] : [options.target]
  console.log('待发布 ' + built.tag + '：' + built.assets.map(asset => asset.name).join(', '))
  if (built.missing.length) console.log('本次缺失平台：' + built.missing.join('、'))
  if (options.dryRun) { console.log(releaseNotes(built.version, built.assets, built.missing, options.notes)); return }
  for (const name of names) {
    const token = process.env[CHANNELS[name].tokenEnv]
    if (!token) throw new Error('缺少环境变量 ' + CHANNELS[name].tokenEnv + '，无法发布到 ' + name)
  }
  for (const name of names) console.log('发布完成：' + await publish(name, process.env[CHANNELS[name].tokenEnv], options, built))
}

main().catch(error => { console.error(error.message); process.exit(1) })
