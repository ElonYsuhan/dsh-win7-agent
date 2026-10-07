#!/usr/bin/env node
'use strict'

/*
 * 会话/偏好落盘（server/ui-store.js）的单元冒烟。
 *
 * 背景：渲染层会话列表此前只存在 localStorage（按 origin=协议+主机+端口 隔离），
 * 8080 被别的程序占、服务跳 8081 时会话列表「看起来空了」。现在渲染层把这份 store
 * 双写到服务端（GET/PUT /api/ui-store，落 AGENT_HOME/ui-store.json），加载服务端优先。
 *
 * 这里测的是**存储模块**本身（HTTP 路由的真服务用例在 server-concurrency-smoke.js）：
 *   ① save → 重开 load 往返一致
 *   ② normalize 挡掉形状不对的字段（sessions 值必须是数组、prefs 必须是对象）
 *   ③ 损坏文件回落空 store，且**不覆盖坏文件**（一次坏读就把用户会话洗掉是不可接受的）
 *   ④ 连续 save 不等待：后写赢，最终磁盘是最新那份（in-flight 合并 / 顺序写都对）
 *   ⑤ 临时文件不残留（temp+rename 的 temp 用完即删）
 *   ⑥ 超过体量上限要拒写（STORE_TOO_LARGE），原文件别被破坏
 */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { UiStore, isEmptyStore, MAX_STORE_BYTES } = require('../server/ui-store')

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

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-store-smoke-'))
  const storeFile = path.join(home, 'ui-store.json')

  /* ① 新目录：空 store，且不急着写文件（别一启动就落盘） */
  const store = new UiStore(home)
  check('新目录：空 store', isEmptyStore(store.snapshot()) === true)
  check('新目录：还没落盘（别一启动就写）', fs.existsSync(storeFile) === false)

  /* ② save → 重开 load 往返一致 */
  await store.save({
    sessions: {
      proj1: [{ id: 'a', scope: 'project', projectId: 'proj1', title: '会话A', messages: [] }],
      __recent__: [{ id: 'b', scope: 'recent', title: '会话B', messages: [] }]
    },
    currentSessionId: 'a',
    prefs: { sidebarCollapsed: true, messageWidth: 900, sentHistory: ['你好'] }
  })
  check('save 后文件存在', fs.existsSync(storeFile) === true)
  const reopened = new UiStore(home)
  const again = reopened.snapshot()
  check('重开能读回整份 store',
    again.sessions.proj1.length === 1 && again.sessions.proj1[0].id === 'a'
      && again.currentSessionId === 'a'
      && again.prefs.sidebarCollapsed === true && again.prefs.messageWidth === 900,
    JSON.stringify(again).slice(0, 120))
  check('isEmptyStore 认得「有数据」', isEmptyStore(again) === false)
  const firstUpdatedAt = again.updatedAt
  const reloadAgain = new UiStore(home).snapshot()
  check('重开不伪造 updatedAt（否则旧服务端快照会盖掉更新的本地数据）',
    reloadAgain.updatedAt === firstUpdatedAt && firstUpdatedAt > 0,
    String(reloadAgain.updatedAt))

  /* ③ normalize 挡掉形状不对的字段 */
  await store.save({
    sessions: { bad: 'not-an-array', good: [{ id: 'x' }], alsoBad: { nope: 1 } },
    currentSessionId: 12345,
    prefs: 'not-an-object'
  })
  const normalized = store.snapshot()
  check('sessions 里非数组的值被挡掉、数组的保留',
    normalized.sessions.bad === undefined && normalized.sessions.alsoBad === undefined
      && Array.isArray(normalized.sessions.good) && normalized.sessions.good.length === 1,
    JSON.stringify(Object.keys(normalized.sessions)))
  check('currentSessionId 不是字符串就归空', normalized.currentSessionId === '', String(normalized.currentSessionId))
  check('prefs 不是对象就归空', normalized.prefs && typeof normalized.prefs === 'object' && Object.keys(normalized.prefs).length === 0, '')

  /* ④ 损坏文件：回落空 store 且不覆盖坏文件 */
  fs.writeFileSync(storeFile, '{broken json', 'utf8')
  const broken = new UiStore(home)
  check('坏文件回落空 store（服务照常起）', isEmptyStore(broken.snapshot()) === true)
  check('坏文件本体没被覆盖（留给排查，别一次坏读洗掉所有会话）',
    fs.readFileSync(storeFile, 'utf8') === '{broken json')
  /* 之后正常 save 仍然能写（用户改完可以恢复，不用手删文件） */
  await broken.save({ sessions: { p: [{ id: 'fresh' }] }, currentSessionId: 'fresh', prefs: {} })
  const afterRepair = new UiStore(home)
  check('坏文件之后正常保存可自愈', afterRepair.snapshot().sessions.p.length === 1)

  /* ⑤ 连续 save 不等待：后写赢。
     ⚠️ save() 返回 ≠ 已落盘（in-flight 合并只保证「最终会落」）——断言磁盘前必须 flush。 */
  await store.save({ sessions: { p: [{ id: 'first' }] }, currentSessionId: 'first', prefs: {} })
  store.save({ sessions: { p: [{ id: 'second' }] }, currentSessionId: 'second', prefs: {} }) // 故意不 await
  await store.save({ sessions: { p: [{ id: 'third' }] }, currentSessionId: 'third', prefs: {} })
  await store.flush()
  const latest = new UiStore(home).snapshot()
  check('连续保存后磁盘是最新那份（后写赢）',
    latest.currentSessionId === 'third' && latest.sessions.p[0].id === 'third',
    latest.currentSessionId)

  /* ⑥ 临时文件不残留 */
  const leftovers = fs.readdirSync(home).filter((name) => name.indexOf('.dsh-tmp-') !== -1)
  check('temp+rename 的临时文件不残留', leftovers.length === 0, leftovers.join(','))

  /* ⑦ 体量上限：超限拒写且原文件不坏 */
  const before = fs.readFileSync(storeFile, 'utf8')
  const huge = { sessions: { p: [{ id: 'x', blob: 'x'.repeat(MAX_STORE_BYTES) }] }, currentSessionId: '', prefs: {} }
  let rejected = ''
  try {
    await store.save(huge)
    await store.flush()
  } catch (error) {
    rejected = String(error && error.message)
  }
  check('超过上限拒写（STORE_TOO_LARGE）', rejected.indexOf('STORE_TOO_LARGE') === 0, rejected)
  check('拒写不破坏原文件', fs.readFileSync(storeFile, 'utf8') === before)
  check('拒写不污染内存快照', store.snapshot().currentSessionId === 'third', store.snapshot().currentSessionId)

  fs.rmSync(home, { recursive: true, force: true })

  console.log('')
  if (failed > 0) {
    console.log('ui-store smoke: ' + passed + '/' + (passed + failed) + ' checks passed, ' + failed + ' FAILED')
    process.exit(1)
  }
  console.log('ui-store smoke: ' + passed + '/' + (passed + failed) + ' checks passed, node ' + process.version)
}

main().catch((error) => {
  console.error('ui-store smoke crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
