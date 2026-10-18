'use strict'

/**
 * md-skills.js —— 内置 Markdown 技能（SKILL.md）注册中心
 *
 * 和 agent/skills.js 的区别：那边是**代码级**技能（导出 { name, description, apply(ctx) }
 * 往 agent 里挂钩子）；这边是**文档级**技能 —— 一堆 SKILL.md，讲「这类任务该怎么做」，
 * 模型按需取用。两者互不影响。
 *
 * 分发方式（渐进式）：
 *   1. 系统提示里只放「技能清单」（id + 简介，短），不塞正文 —— 65 个技能全塞正文能炸上下文；
 *   2. 模型判断某个技能对口 → 调 load_skill(id) 取 SKILL.md 全文；
 *   3. 技能目录里的附加文件（references/、scripts/、assets/）用 load_skill(id, file) 取，
 *      或在工作区里跑（run_command）—— 技能目录不在用户工作区内，read_file 够不到。
 *
 * 目录约定：md-skills/<分类>/<技能>/SKILL.md（分类层可有可无，递归找 SKILL.md）。
 */

const fs = require('fs')
const path = require('path')

const SKILLS_ROOT = path.join(__dirname, 'md-skills')
/** 单个附加文件读取上限 */
const MAX_FILE_BYTES = 256 * 1024
/** SKILL.md 正文返回上限（超长技能截断，避免一发命中就吃满上下文） */
const MAX_BODY_CHARS = 24000
/** 清单里每条简介的截断长度（这是**每轮都在**的系统提示成本，别放太宽） */
const INDEX_DESC_CHARS = 90

const not = (value) => value ? false : true

let cache = null

/** 解析 SKILL.md 头部 frontmatter（只认最前面的 --- 块，够了） */
function parseFrontmatter(text) {
  const source = String(text || '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source)
  if (not(match)) return {}
  const body = match[1]
  const out = {}
  for (const line of body.split(/\r?\n/)) {
    const item = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (not(item)) continue
    let value = item[2].trim()
    if ((value.charAt(0) === '"' && value.slice(-1) === '"') || (value.charAt(0) === "'" && value.slice(-1) === "'")) {
      value = value.slice(1, -1)
    }
    out[item[1]] = value
  }
  return out
}

/** 去掉 frontmatter，返回正文 */
function stripFrontmatter(text) {
  return String(text || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')
}

function countFiles(dir, depth) {
  let total = 0
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    return { files: 0, dirs: 0 }
  }
  for (const entry of entries) {
    if (entry.name === '.DS_Store') continue
    if (entry.isDirectory() && Number(depth) < 3) {
      const inner = countFiles(path.join(dir, entry.name), Number(depth) + 1)
      total += inner.total
    } else if (entry.isFile()) {
      total += 1
    }
  }
  return { files: total, dirs: 0, total: total }
}

/** 递归找所有 SKILL.md，返回技能条目（带缓存；技能是随包内置的，进程内不变） */
function scan() {
  if (cache) return cache
  const items = []
  const walk = (dir, depth) => {
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      return
    }
    for (const entry of entries) {
      if (not(entry.isDirectory()) || entry.name === '.DS_Store') continue
      const full = path.join(dir, entry.name)
      const markdown = path.join(full, 'SKILL.md')
      if (fs.existsSync(markdown)) {
        let text = ''
        try {
          text = fs.readFileSync(markdown, 'utf8')
        } catch (error) {
          text = ''
        }
        const meta = parseFrontmatter(text)
        items.push({
          id: path.relative(SKILLS_ROOT, full).split(path.sep).join('/'),
          dir: full,
          name: String(meta.name || entry.name).trim(),
          description: String(meta.description || '').replace(/\s+/g, ' ').trim(),
          bytes: Buffer.byteLength(text, 'utf8'),
          files: countFiles(full, 1).total
        })
        continue
      }
      if (depth < 4) walk(full, depth + 1)
    }
  }
  walk(SKILLS_ROOT, 0)
  cache = items
  return items
}

/** 按 id / 名字 / 目录名找技能（不区分大小写；skill- 前缀和空格都容错） */
function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/^skill-/, '').replace(/[\s_]+/g, '-')
}

function findSkill(key) {
  const target = normalizeKey(key)
  if (not(target)) return null
  const items = scan()
  for (const item of items) {
    if (normalizeKey(item.id) === target) return item
  }
  for (const item of items) {
    if (normalizeKey(item.name) === target) return item
    if (normalizeKey(path.basename(item.dir)) === target) return item
  }
  for (const item of items) {
    if (normalizeKey(item.id).slice(-target.length) === target) return item
  }
  return null
}

/** 技能目录内的文件清单（相对技能根，含大小） */
function listSkillFiles(item, depth, prefix) {
  const out = []
  let entries = []
  try {
    entries = fs.readdirSync(item.dir, { withFileTypes: true })
  } catch (error) {
    return out
  }
  for (const entry of entries) {
    if (entry.name === '.DS_Store' || entry.name === 'SKILL.md') continue
    const rel = (prefix ? prefix + '/' : '') + entry.name
    const full = path.join(item.dir, entry.name)
    if (entry.isDirectory() && Number(depth) < 3) {
      out.push(rel + '/')
      for (const inner of listSkillFiles({ dir: full }, Number(depth) + 1, rel)) out.push(inner)
    } else if (entry.isFile()) {
      let size = 0
      try {
        size = fs.statSync(full).size
      } catch (error) {
        size = 0
      }
      out.push(rel + ' (' + size + 'B)')
    }
  }
  return out
}

/** 读技能：file 为空 = 读 SKILL.md 正文；否则读技能目录内的相对文件 */
function readSkill(key, file) {
  const item = findSkill(key)
  if (not(item)) {
    const names = scan().slice(0, 12).map((one) => one.id).join(', ')
    return { ok: false, error: 'SKILL_NOT_FOUND: ' + String(key || '') + '. Available examples: ' + names }
  }
  const files = listSkillFiles(item, 1, '')
  const wanted = String(file || '').trim()
  const target = not(wanted) ? path.join(item.dir, 'SKILL.md') : path.join(item.dir, path.normalize(wanted))
  /* 目录穿越护栏：只能在技能目录里读 */
  if (path.relative(item.dir, target).split(path.sep).indexOf('..') !== -1) {
    return { ok: false, error: 'SKILL_PATH_ESCAPE: ' + wanted, id: item.id }
  }
  let stat = null
  try {
    stat = fs.statSync(target)
  } catch (error) {
    return { ok: false, error: 'SKILL_FILE_NOT_FOUND: ' + wanted, id: item.id, files: files }
  }
  if (not(stat.isFile())) return { ok: false, error: 'SKILL_FILE_NOT_FILE: ' + wanted, id: item.id, files: files }
  if (stat.size > MAX_FILE_BYTES) return { ok: false, error: 'SKILL_FILE_TOO_LARGE: ' + wanted + ' (' + stat.size + 'B)', id: item.id }
  let text = ''
  try {
    text = fs.readFileSync(target, 'utf8')
  } catch (error) {
    return { ok: false, error: 'SKILL_FILE_UNREADABLE: ' + wanted, id: item.id }
  }
  const isMain = not(wanted)
  let body = isMain ? stripFrontmatter(text) : text
  let truncated = false
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS)
    truncated = true
  }
  const head = [
    'skill=' + item.id,
    'name=' + item.name,
    isMain ? 'file=SKILL.md' : 'file=' + wanted,
    'dir=' + item.dir + ' (outside workspace: read it through load_skill, not read_file)'
  ].join('\n')
  const extra = files.length
    ? '\n\n--- skill files ---\n' + files.join('\n')
    : '\n\n--- skill files ---\n(none)'
  return {
    ok: true,
    id: item.id,
    name: item.name,
    files: files,
    truncated: truncated,
    text: head + '\n\n' + body + (isMain ? extra : '') + (truncated ? '\n\n[truncated at ' + MAX_BODY_CHARS + ' chars]' : '')
  }
}

/** 关键词搜技能（名称 / 简介 / id） */
function searchSkills(query, limit) {
  const keyword = String(query || '').trim().toLowerCase()
  const items = scan()
  if (not(keyword)) {
    return { ok: true, total: items.length, items: items.slice(0, Number(limit) || 40).map(brief) }
  }
  const words = keyword.split(/\s+/).filter(Boolean)
  const hits = []
  for (const item of items) {
    const haystack = (item.id + ' ' + item.name + ' ' + item.description).toLowerCase()
    let score = 0
    for (const word of words) {
      if (haystack.indexOf(word) !== -1) score += 1
    }
    if (score > 0) hits.push({ score: score, item: item })
  }
  hits.sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id))
  return {
    ok: true,
    total: hits.length,
    items: hits.slice(0, Number(limit) || 20).map((hit) => brief(hit.item))
  }
}

function brief(item) {
  return { id: item.id, name: item.name, description: item.description.slice(0, 200), files: item.files }
}

/** 系统提示里的技能清单块（短：id + 一句简介） */
function systemPromptBlock(disabled) {
  const items = scan().filter((item) => !disabled || !disabled.has(item.id))
  if (not(items.length)) return ''
  const lines = [
    '',
    'Bundled skills (Markdown playbooks, ' + items.length + ' total):',
    'These are built-in "how to do this task" guides. They are NOT loaded yet — the list below is only an index.',
    'When a task matches one of them, call load_skill with its id FIRST, then follow it. Do not guess from the one-line summary.',
    'Extra files inside a skill (references/, scripts/, assets/) can be read with load_skill(id, file) or executed with run_command.',
    'If nothing matches, just do the task normally.'
  ]
  for (const item of items) {
    const desc = item.description.length > INDEX_DESC_CHARS
      ? item.description.slice(0, INDEX_DESC_CHARS) + '…'
      : item.description
    lines.push('- ' + item.id + (desc ? ' — ' + desc : ''))
  }
  return lines.join('\n')
}

function stats() {
  const items = scan()
  return { root: SKILLS_ROOT, count: items.length }
}

module.exports = {
  SKILLS_ROOT,
  parseFrontmatter,
  stripFrontmatter,
  list: scan,
  find: findSkill,
  read: readSkill,
  search: searchSkills,
  systemPromptBlock,
  stats
}
