'use strict'

/**
 * ValidationLedger：任务验证账本 —— 自我验证闭环的「记得住」那一半。
 *
 * 为什么要落文件而不是只留在对话里：验证循环很长，上下文压缩（阈值 0.8）之后
 * 「当初定的验收标准是什么」最先丢。账本按任务一个 markdown 文件、append-only，
 * 压缩后模型 read 一下就能续上；用户也能直接打开看 Agent 到底验了什么、怎么验的。
 *
 * 存放位置：<workspace>/.agent/validation/<task-slug>.md
 *   （tests/ 留给可复用的用例 —— 那是人的资产；账本是每任务一次的过程产物，两者生命周期不同）
 */

const fs = require('fs')
const path = require('path')
const { ensureParentInside, relativeDisplay } = require('./path-guard')

const not = (value) => value ? false : true
const LEDGER_DIR = '.agent/validation'
const MAX_LEDGER_BYTES = 512 * 1024

function slugify(task) {
  const text = String(task || '').trim()
  if (text.length === 0) {
    throw new Error('LEDGER_NO_TASK: 传任务名（task）')
  }
  const slug = text.replace(/[^\w\u4e00-\u9fa5.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  if (slug.length === 0) {
    throw new Error('LEDGER_BAD_TASK: 任务名里没有可用字符')
  }
  return slug
}

function ledgerPath(root, task) {
  return ensureParentInside(root, LEDGER_DIR + '/' + slugify(task) + '.md', 'ledger')
}

function readLedger(root, task) {
  const target = ledgerPath(root, task)
  if (not(fs.existsSync(target))) {
    return { exists: false, path: relativeDisplay(root, target) }
  }
  const text = fs.readFileSync(target, 'utf8')
  return { exists: true, path: relativeDisplay(root, target), text: text, bytes: Buffer.byteLength(text) }
}

function initLedger(root, task, input) {
  const target = ledgerPath(root, task)
  if (fs.existsSync(target)) {
    /* 已存在不覆盖（append-only 的底线：账本记的是事实，不能重写历史） */
    return Object.assign({ created: false }, readLedger(root, task))
  }
  const requirement = String((input && input.requirement) || '').trim()
  const criteria = Array.isArray(input && input.criteria) ? input.criteria : []
  if (criteria.length === 0) {
    throw new Error('LEDGER_NO_CRITERIA: 先给出可判定的验收标准（每条一句话，能被工具结果判真假）')
  }
  const lines = [
    '# 验证账本：' + String(task),
    '',
    '- 建立时间：' + new Date().toISOString(),
    '- 需求原文：' + (requirement || '(未记录)'),
    '',
    '## 验收标准',
    ...criteria.map((item) => '- [ ] ' + String(item)),
    '',
    '## 验证手段',
    '- （进入验证前补充：静态检查 / 单测 / HTTP / DOM 状态 / console / 网络 / 日志 / 截图）',
    '',
    '## 轮次记录',
    ''
  ]
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, lines.join('\n'), 'utf8')
  return Object.assign({ created: true }, readLedger(root, task))
}

function appendLedger(root, task, note) {
  const target = ledgerPath(root, task)
  const text = String(note || '').trim()
  if (text.length === 0) {
    throw new Error('LEDGER_EMPTY_NOTE: 追加内容不能为空')
  }
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const size = fs.existsSync(target) ? fs.statSync(target).size : 0
  if (size > MAX_LEDGER_BYTES) {
    throw new Error('LEDGER_TOO_LARGE: 账本超过 ' + MAX_LEDGER_BYTES + ' bytes，请开新任务账本')
  }
  const block = [
    '',
    '### ' + new Date().toISOString(),
    '',
    text,
    ''
  ].join('\n')
  fs.appendFileSync(target, block, 'utf8')
  return Object.assign({ appended: true }, readLedger(root, task))
}

module.exports = {
  initLedger,
  appendLedger,
  readLedger,
  ledgerPath,
  slugify,
  LEDGER_DIR
}
