'use strict'

/*
 * 文件预览用的**只读**端点（右侧面板的目录树 / 文件预览 / 图片 / PDF 都走这里）。
 *
 * 为什么单独一个模块：server/index.js 已经四百多行，文件类逻辑塞进去会糊成一团。
 * ⚠️ 新增 server 下的文件必须同步登记到 `scripts/build-desktop.js` 的 fillAppDir()，
 *    否则开发态能跑、打包后 404 —— 那个脚本里有对账，漏了会直接报错。
 *
 * 安全模型（这是本模块最要紧的部分）：
 *   允许访问的根 = 当前项目 settings.projects[currentProjectId].folders（回退 workspacePath）。
 *   每一个进来的 path 都要：
 *     ① 落在某个根**里面**（字符串层面 isInside）
 *     ② 真实路径（realpath）也落在根的 realpath 里面 —— 挡 symlink 逃逸
 *   复用 src/main/agent/path-guard.js，不另造一套。
 *
 * 编码：服务端**不做**文本解码，只吐字节（/raw）+ 一个「像不像文本」的嗅探（/file）。
 *   原因：Win 上 GBK 文件很常见，而 Node 16.17.1 是 small-icu，`new TextDecoder('gbk')` 会抛。
 *   Chromium 有完整 ICU，所以交给渲染层 decode（先严格 UTF-8，失败退 GBK）。
 */

const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const { isInside, existingRealPath } = require('../src/main/agent/path-guard')

const not = (value) => value ? false : true

/** 目录树里跳过的目录 —— 与 src/main/agent/tools.js 的 IGNORED_DIRS 保持一致 */
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.cache', 'coverage'])

/** 单次列目录最多吐多少条，防一手超大的目录把页面卡死 */
const MAX_ENTRIES_PER_DIR = 2000
/** depth 上限，避免有人 ?depth=99 把整棵树拉过来 */
const MAX_DEPTH = 3
/** 文本嗅探只读头部这么多字节 */
const SNIFF_BYTES = 8192
/** 单次 /raw 不分段时最多吐多少（分段请求不受此限） */
const MAX_RAW_BYTES = 64 * 1024 * 1024
/** 单次写入最多接受多少字节。渲染层把「可编辑」限在 5MB，这里给一倍冗余。 */
const MAX_WRITE_BYTES = 16 * 1024 * 1024
/** 写请求的 body 上限。内容是 base64（体积 ×4/3），再留点余量。
    注意不能复用 server/index.js 的 readBody —— 那个卡在 1MB，一个 800KB 的文件
    编码后就超了，编辑保存会莫名其妙 413。 */
const MAX_WRITE_BODY = 32 * 1024 * 1024

/**
 * 扩展名 → 预览类型。渲染层按 kind 决定用哪个预览器。
 * 缺省 text 的走纯文本，其余的走 /raw（img / iframe / 外部打开）。
 */
const KIND_BY_EXT = {
  // ---- 代码 / 配置（语法高亮）----
  '.js': 'code', '.mjs': 'code', '.cjs': 'code', '.jsx': 'code',
  '.ts': 'code', '.tsx': 'code', '.mts': 'code', '.cts': 'code',
  '.vue': 'code', '.svelte': 'code', '.astro': 'code',
  '.css': 'code', '.scss': 'code', '.sass': 'code', '.less': 'code', '.styl': 'code',
  '.html': 'code', '.htm': 'code', '.xhtml': 'code', '.xml': 'code', '.svg': 'image',
  '.json': 'code', '.jsonc': 'code', '.json5': 'code', '.webmanifest': 'code',
  '.yml': 'code', '.yaml': 'code', '.toml': 'code', '.ini': 'code', '.cfg': 'code', '.conf': 'code',
  '.env': 'code', '.properties': 'code', '.editorconfig': 'code', '.gitignore': 'code',
  '.gitattributes': 'code', '.npmrc': 'code', '.babelrc': 'code', '.eslintrc': 'code',
  '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.fish': 'code',
  '.bat': 'code', '.cmd': 'code', '.ps1': 'code', '.psm1': 'code',
  '.py': 'code', '.pyw': 'code', '.rb': 'code', '.php': 'code', '.pl': 'code', '.lua': 'code',
  '.go': 'code', '.rs': 'code', '.java': 'code', '.kt': 'code', '.kts': 'code', '.scala': 'code',
  '.c': 'code', '.h': 'code', '.cc': 'code', '.cpp': 'code', '.cxx': 'code', '.hpp': 'code', '.hh': 'code',
  '.cs': 'code', '.swift': 'code', '.m': 'code', '.mm': 'code', '.dart': 'code', '.r': 'code',
  '.sql': 'code', '.graphql': 'code', '.gql': 'code', '.proto': 'code', '.gradle': 'code',
  '.dockerfile': 'code', '.makefile': 'code', '.cmake': 'code', '.diff': 'code', '.patch': 'code',
  // ---- Markdown ----
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  // ---- 纯文本 ----
  '.txt': 'text', '.log': 'text', '.text': 'text', '.csv': 'text', '.tsv': 'text',
  '.lock': 'text', '.sum': 'text', '.map': 'text',
  // ---- 图片（走 <img src=/api/fs/raw>）----
  '.png': 'image', '.jpg': 'image', '.jpeg': 'image', '.gif': 'image', '.webp': 'image',
  '.bmp': 'image', '.ico': 'image', '.avif': 'image', '.apng': 'image',
  // ---- PDF（走 <iframe>，Chromium 自带阅读器）----
  '.pdf': 'pdf',
  // ---- Office（不能内嵌渲染，给「用系统默认程序打开」卡片）----
  '.doc': 'office', '.docx': 'office', '.rtf': 'office', '.odt': 'office',
  '.ppt': 'office', '.pptx': 'office', '.odp': 'office',
  '.xls': 'office', '.xlsx': 'office', '.ods': 'office',
  // ---- 音视频 ----
  '.mp3': 'audio', '.wav': 'audio', '.ogg': 'audio', '.flac': 'audio', '.m4a': 'audio', '.aac': 'audio',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video', '.mkv': 'video', '.avi': 'video',
  // ---- 压缩包 / 其他二进制 ----
  '.zip': 'archive', '.gz': 'archive', '.tgz': 'archive', '.tar': 'archive',
  '.rar': 'archive', '.7z': 'archive', '.bz2': 'archive', '.xz': 'archive',
  '.exe': 'binary', '.dll': 'binary', '.so': 'binary', '.dylib': 'binary', '.bin': 'binary',
  '.wasm': 'binary', '.pdfx': 'binary'
}

/** /raw 用的 content-type。缺省 application/octet-stream，让浏览器下载而不是瞎猜。 */
const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.apng': 'image/apng',
  '.pdf': 'application/pdf',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8'
}

function extensionOf(name) {
  const lower = String(name || '').toLowerCase()
  // 无扩展名的常见文件靠名字本身认（Dockerfile / Makefile）
  if (lower === 'dockerfile') return '.dockerfile'
  if (lower === 'makefile') return '.makefile'
  if (lower === '.gitignore') return '.gitignore'
  const ext = path.extname(lower)
  return ext
}

function kindOf(name) {
  return KIND_BY_EXT[extensionOf(name)] || 'text'
}

function mimeOf(name) {
  return MIME_BY_EXT[extensionOf(name)] || 'application/octet-stream'
}

/** 二进制嗅探：与 src/main/agent/tools.js 的 isProbablyText 同款判定 */
function isProbablyText(buffer) {
  if (buffer.includes(0)) return false
  let suspicious = 0
  for (let index = 0; index < buffer.length; index += 1) {
    const byte = buffer[index]
    if (byte === 9 || byte === 10 || byte === 13) continue
    if (byte < 32) suspicious += 1
  }
  return suspicious * 20 < buffer.length
}

/**
 * 允许访问的根目录列表。
 * 取「当前项目关联的工作区目录」，没有项目就退回单一 workspacePath。
 */
function workspaceRoots(settingsStore) {
  const data = (settingsStore && settingsStore.data) || {}
  const projects = Array.isArray(data.projects) ? data.projects : []
  const current = projects.filter((item) => item && item.id === data.currentProjectId)[0]
  const folders = (current && Array.isArray(current.folders) ? current.folders : []).slice()
  if (folders.length === 0 && data.workspacePath) folders.push(data.workspacePath)

  const roots = []
  const seen = new Set()
  for (const folder of folders) {
    if (not(folder)) continue
    let absolute = path.resolve(String(folder))
    try {
      absolute = fs.realpathSync.native(absolute)
    } catch (error) {
      continue // 目录不存在 / 没权限，直接跳过，别把整个面板搞挂
    }
    let stat = null
    try { stat = fs.statSync(absolute) } catch (error) { continue }
    if (not(stat.isDirectory())) continue
    if (seen.has(absolute)) continue
    seen.add(absolute)
    roots.push({ path: absolute, name: path.basename(absolute) || absolute })
  }
  return roots
}

function accessRoots(settingsStore) {
  const roots = workspaceRoots(settingsStore).slice()
  const sessionRoot = settingsStore && settingsStore.sessionRoot ? String(settingsStore.sessionRoot) : ''
  if (sessionRoot) {
    try {
      const absolute = fs.realpathSync.native(path.resolve(sessionRoot))
      if (not(roots.some((root) => root.path === absolute))) roots.push({ path: absolute, name: 'sessions' })
    } catch (error) { /* 会话目录尚未创建 */ }
  }
  return roots
}

/**
 * 把路径规范化成「真实路径」再拿去比对。
 *
 * 为什么需要这一步：macOS 上 `/tmp` 是 `/private/tmp` 的软链，`roots` 里存的是 realpath，
 * 而请求里带的是用户看到的原始路径 —— 直接做字符串前缀比对会把**合法文件**也判成越界
 * （踩过：/tmp 下的工作区里所有文件都 403）。
 *
 * 做法：找到已经存在的那一段祖先做 realpath，再把还不存在的尾巴接回去。
 * 文件本身存在时（含最后一段是软链）会连同软链一起解析 —— 所以指向外部的软链在这里就被挡下。
 */
function canonicalize(target) {
  const tail = []
  let head = target
  while (not(fs.existsSync(head))) {
    const parent = path.dirname(head)
    if (parent === head) break
    tail.unshift(path.basename(head))
    head = parent
  }
  let real = head
  try {
    real = fs.realpathSync.native(head)
  } catch (error) {
    real = head
  }
  return tail.length > 0 ? path.join(real, tail.join(path.sep)) : real
}

/**
 * 把请求里的绝对路径解析到某个根之下。
 * 两道闸：① 规范化后落在某个根里面；② realpath 后再落一次（防软链逃逸）。
 * 返回 { absolute, root }，越界/不合法一律抛 PATH_ESCAPE。
 */
function resolveInWorkspace(roots, requested) {
  if (roots.length === 0) throw new Error('WORKSPACE_NOT_SET: 没有关联的工作区目录')
  const target = canonicalize(path.resolve(String(requested || '')))
  const owner = roots.filter((root) => isInside(root.path, target))[0]
  if (not(owner)) throw new Error('PATH_ESCAPE: 不在关联的工作区目录内: ' + target)
  // existingRealPath 内部再做一次 assertInside + realpath 比对（文件不存在时原样返回）
  return { absolute: existingRealPath(owner.path, target), root: owner }
}

function toEntry(absolute, name, dirent) {
  let stat = null
  try { stat = fs.statSync(path.join(absolute, name)) } catch (error) { stat = null }
  const isDir = dirent ? dirent.isDirectory() : (stat ? stat.isDirectory() : false)
  return {
    name,
    path: path.join(absolute, name),
    dir: isDir,
    size: stat && stat.isFile() ? stat.size : 0,
    mtime: stat ? stat.mtimeMs : 0,
    kind: isDir ? 'dir' : kindOf(name)
  }
}

/** 隐藏文件默认不出现在树里，只放行这几个常用的（跟编辑器习惯对齐） */
const ALLOWED_DOTFILES = new Set(['.gitignore', '.gitattributes', '.env', '.npmrc', '.editorconfig'])

async function readTree(absolute, depth) {
  const dirents = await fsp.readdir(absolute, { withFileTypes: true })
  const visible = dirents.filter((entry) => {
    if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) return false
    if (entry.name.startsWith('.') && not(ALLOWED_DOTFILES.has(entry.name))) return false
    return true
  })
  const truncated = visible.length > MAX_ENTRIES_PER_DIR
  const entries = visible
    .slice(0, MAX_ENTRIES_PER_DIR)
    .map((entry) => toEntry(absolute, entry.name, entry))

  entries.sort((left, right) => {
    if (left.dir !== right.dir) return left.dir ? -1 : 1
    return left.name.localeCompare(right.name, 'zh-Hans-CN')
  })

  let children = null
  if (depth > 1) {
    children = {}
    for (const entry of entries) {
      if (not(entry.dir)) continue
      try {
        const sub = await readTree(entry.path, depth - 1)
        children[entry.path] = sub.entries
      } catch (error) {
        children[entry.path] = []
      }
    }
  }
  return { entries, truncated, children }
}

/** 解析 Range 头，只支持单段 `bytes=a-b` / `bytes=a-` / `bytes=-n` */
function parseRange(header, size) {
  if (not(header)) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim())
  if (not(match)) return null
  const hasStart = match[1] !== ''
  const hasEnd = match[2] !== ''
  let start = hasStart ? Number(match[1]) : 0
  let end = hasEnd ? Number(match[2]) : size - 1
  if (not(hasStart) && hasEnd) {
    start = Math.max(0, size - Number(match[2]))
    end = size - 1
  }
  if (not(Number.isFinite(start)) || not(Number.isFinite(end))) return null
  if (start < 0 || start >= size) return null
  if (end >= size) end = size - 1
  if (end < start) return null
  return { start, end }
}

/**
 * 目录树的「一份」描述。HTTP 端点（/api/fs/tree）与主进程 IPC（fs:tree）共用这一份，
 * 免得两条路各自实现、慢慢对不上。
 */
async function describeTree(settingsStore, requested, depth) {
  const safeDepth = Math.max(1, Math.min(MAX_DEPTH, Number(depth) || 1))
  const roots = workspaceRoots(settingsStore)
  const target = requested || (roots[0] && roots[0].path) || ''
  const resolved = resolveInWorkspace(roots, target)
  const stat = await fsp.stat(resolved.absolute)
  if (not(stat.isDirectory())) throw new Error('NOT_A_DIRECTORY: ' + resolved.absolute)
  const tree = await readTree(resolved.absolute, safeDepth)
  return {
    path: resolved.absolute,
    root: resolved.root.path,
    parent: path.dirname(resolved.absolute) === resolved.absolute ? null : path.dirname(resolved.absolute),
    depth: safeDepth,
    entries: tree.entries,
    children: tree.children,
    truncated: tree.truncated
  }
}

/**
 * 单个文件的元信息 + 文本嗅探（**不吐内容**，内容走 /raw 或 IPC 的另一条通道）。
 * 注意 kind 会被嗅探改写：扩名声称是文本、头 8KB 却像二进制时降级成 binary。
 */
async function describeFile(settingsStore, requested) {
  if (not(requested)) throw new Error('PATH_REQUIRED')
  const roots = accessRoots(settingsStore)
  const resolved = resolveInWorkspace(roots, requested)
  const stat = await fsp.stat(resolved.absolute)
  if (stat.isDirectory()) throw new Error('IS_DIRECTORY: ' + resolved.absolute)
  const kind = kindOf(resolved.absolute)
  let isText = kind === 'code' || kind === 'markdown' || kind === 'text'
  if (isText && stat.size > 0) {
    // 有扩展名说是文本，再嗅探一次头部 —— 防 .js 里塞二进制
    const handle = await fsp.open(resolved.absolute, 'r')
    try {
      const buffer = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size))
      await handle.read(buffer, 0, buffer.length, 0)
      isText = isProbablyText(buffer)
    } finally {
      await handle.close()
    }
  }
  const passthrough = kind === 'pdf' || kind === 'image' || kind === 'audio' ||
    kind === 'video' || kind === 'office' || kind === 'archive'
  return {
    path: resolved.absolute,
    root: resolved.root.path,
    name: path.basename(resolved.absolute),
    size: stat.size,
    mtime: stat.mtimeMs,
    ext: extensionOf(resolved.absolute),
    kind: isText ? kind : (passthrough ? kind : 'binary'),
    isText: isText
  }
}

/**
 * 文本 → 字节（右侧面板的编辑保存）。
 *
 * 这是本模块唯一的**写**操作，所以安全模型照旧：resolveInWorkspace 的两道闸
 * （字符串层面落在根内 + realpath 再落一次）一个都不能少。
 *
 * 只改**已存在**的文件 —— 这个功能是「编辑现有文件」，新建文件归 agent 的 write_file 工具管。
 * 不这么收的话，面板就成了一个任意路径写文件的口子（前缀落在工作区里就能建）。
 *
 * 原子写：先落同目录的临时文件再 rename 覆盖。直接 writeFile 一旦中途崩了/断电，
 * 用户丢的是整个文件；rename 在同一文件系统上是原子的，最坏也只是留个临时文件。
 *
 * expectedMtime：渲染层打开文件时记下的 mtime。带上它就能挡住「面板里改了半小时，
 * 期间 agent 也写过这个文件」这种静默覆盖 —— 不匹配直接 409，让人自己决定。
 * 传 0 / 不传 = 不检查（用户点了「强制保存」走这条）。
 */
async function writeWorkspaceFile(settingsStore, requested, buffer, options) {
  if (not(requested)) throw new Error('PATH_REQUIRED')
  const opts = options || {}
  const roots = accessRoots(settingsStore)
  const target = resolveInWorkspace(roots, requested).absolute

  let stat = null
  try {
    stat = await fsp.stat(target)
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('FILE_NOT_FOUND: ' + target)
    throw error
  }
  if (stat.isDirectory()) throw new Error('IS_DIRECTORY: ' + target)

  const expected = Number(opts.expectedMtime) || 0
  /* 容 1ms：mtime 经过 「stat → Number」两跳，不同平台精度不一样，卡死会误报冲突 */
  if (expected > 0 && Math.abs(stat.mtimeMs - expected) > 1) {
    throw new Error('MTIME_CONFLICT: ' + target)
  }

  const payload = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
  if (payload.length > MAX_WRITE_BYTES) throw new Error('FILE_TOO_LARGE: ' + payload.length)

  const directory = path.dirname(target)
  const temp = path.join(directory, '.' + path.basename(target) + '.dsh-tmp-' + process.pid + '-' + Date.now())
  try {
    await fsp.writeFile(temp, payload)
    await fsp.rename(temp, target)
  } catch (error) {
    try { await fsp.unlink(temp) } catch (cleanup) {}
    /* rename 在 Windows 上会因为「目标被别的程序占着」失败（EBUSY/EPERM）——
       这时退化成直接写。原子性没了，但总比保存不上强。 */
    if (error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES')) {
      await fsp.writeFile(target, payload)
    } else {
      throw error
    }
  }

  const next = await fsp.stat(target)
  return { path: target, size: next.size, mtime: next.mtimeMs }
}

/** 读请求体（要接二进制 base64，不能像 server/index.js 的 readBody 那样按 utf8 拼字符串） */
function readRawBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let done = false
    const fail = (message) => {
      if (done) return
      done = true
      try { request.destroy() } catch (error) {}
      reject(new Error(message))
    }
    request.on('data', (chunk) => {
      if (done) return
      size += chunk.length
      if (size > limit) { fail('BODY_TOO_LARGE'); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    request.on('error', () => fail('BODY_READ_FAILED'))
  })
}

/**
 * 处理 /api/fs/* —— 返回 true 表示已处理。
 * deps: { json, settingsStore }
 */
async function handleFileApi(url, request, response, deps) {
  const json = deps.json
  const settingsStore = deps.settingsStore
  const name = url.pathname

  if (name.indexOf('/api/fs/') !== 0) return false

  /* 允许访问的根 —— 渲染层靠它拼目录树的第一层 */
  if (name === '/api/fs/roots' && request.method === 'GET') {
    const data = settingsStore.data
    const projects = Array.isArray(data.projects) ? data.projects : []
    const current = projects.filter((item) => item && item.id === data.currentProjectId)[0]
    json(response, 200, {
      projectId: (current && current.id) || '',
      projectName: (current && current.name) || '',
      roots: workspaceRoots(settingsStore)
    })
    return true
  }

  /* 目录树：默认只给一层，渲染层展开时再来要下一层（懒加载） */
  if (name === '/api/fs/tree' && request.method === 'GET') {
    try {
      const depth = url.searchParams.get('depth')
      json(response, 200, await describeTree(settingsStore, url.searchParams.get('path'), depth))
    } catch (error) {
      const escape = String(error.message || '').indexOf('PATH_ESCAPE') === 0
      json(response, escape ? 403 : 400, { error: String(error.message || 'FS_TREE_FAILED') })
    }
    return true
  }

  /* 文件元信息 + 文本嗅探（内容走 /raw） */
  if (name === '/api/fs/file' && request.method === 'GET') {
    const requested = url.searchParams.get('path')
    if (not(requested)) {
      json(response, 400, { error: 'PATH_REQUIRED' })
      return true
    }
    try {
      json(response, 200, await describeFile(settingsStore, requested))
    } catch (error) {
      const escape = String(error.message || '').indexOf('PATH_ESCAPE') === 0
      json(response, escape ? 403 : 400, { error: String(error.message || 'FS_FILE_FAILED') })
    }
    return true
  }

  /* 原样吐字节：图片 <img>、PDF <iframe>、以及文本预览（走 Range 只取头部）都用它 */
  if (name === '/api/fs/raw' && (request.method === 'GET' || request.method === 'HEAD')) {
    const requested = url.searchParams.get('path')
    if (not(requested)) {
      json(response, 400, { error: 'PATH_REQUIRED' })
      return true
    }
    let resolved = null
    try {
      const roots = accessRoots(settingsStore)
      resolved = resolveInWorkspace(roots, requested)
    } catch (error) {
      json(response, 403, { error: String(error.message || 'PATH_ESCAPE') })
      return true
    }
    let stat = null
    try {
      stat = await fsp.stat(resolved.absolute)
    } catch (error) {
      json(response, 404, { error: 'FILE_NOT_FOUND' })
      return true
    }
    if (stat.isDirectory()) {
      json(response, 400, { error: 'IS_DIRECTORY' })
      return true
    }

    const headers = {
      'content-type': mimeOf(resolved.absolute),
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      // inline：PDF 要让内置阅读器接管，不能触发下载
      'content-disposition': 'inline; filename="' + encodeURIComponent(path.basename(resolved.absolute)) + '"'
    }
    const range = parseRange(request.headers.range, stat.size)
    let start = 0
    let end = stat.size - 1
    let status = 200
    if (range) {
      start = range.start
      end = range.end
      status = 206
      headers['content-range'] = 'bytes ' + start + '-' + end + '/' + stat.size
      headers['content-length'] = end - start + 1
    } else {
      if (stat.size > MAX_RAW_BYTES) {
        json(response, 413, { error: 'FILE_TOO_LARGE_FOR_RAW: ' + stat.size })
        return true
      }
      headers['content-length'] = stat.size
    }

    response.writeHead(status, headers)
    if (request.method === 'HEAD') {
      response.end()
      return true
    }
    const stream = fs.createReadStream(resolved.absolute, { start, end })
    stream.on('error', () => { try { response.destroy() } catch (error) {} })
    stream.pipe(response)
    return true
  }

  /* 写回已存在的文本文件（右侧面板的编辑保存）。
     body: { path, data(base64), expectedMtime } —— 走 base64 而不是裸 body，
     是因为渲染层拿到的本来就是字节（编码由它决定，见 panel.js 的 encodeText）。 */
  if (name === '/api/fs/write' && request.method === 'POST') {
    let body = null
    try {
      const raw = await readRawBody(request, MAX_WRITE_BODY)
      body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : {}
    } catch (error) {
      const message = String((error && error.message) || 'BAD_JSON')
      json(response, message === 'BODY_TOO_LARGE' ? 413 : 400, { error: message })
      return true
    }
    /* 空字符串是合法的（用户把文件清空了），所以判类型不判真假 */
    if (typeof body.data !== 'string') {
      json(response, 400, { error: 'DATA_REQUIRED' })
      return true
    }
    try {
      const info = await writeWorkspaceFile(settingsStore, body.path, Buffer.from(body.data, 'base64'),
        { expectedMtime: body.expectedMtime })
      json(response, 200, { ok: true, path: info.path, size: info.size, mtime: info.mtime })
    } catch (error) {
      const message = String((error && error.message) || 'FS_WRITE_FAILED')
      let status = 400
      if (message.indexOf('PATH_ESCAPE') === 0) status = 403
      else if (message.indexOf('FILE_NOT_FOUND') === 0) status = 404
      else if (message.indexOf('MTIME_CONFLICT') === 0) status = 409
      else if (message.indexOf('FILE_TOO_LARGE') === 0) status = 413
      json(response, status, { error: message })
    }
    return true
  }

  return false
}

/**
 * 读一个文件的字节（同样过两道安全闸）。
 * 只有主进程 IPC 那条路用得上 —— HTTP 那边走 /raw 流式吐，不进内存。
 */
async function readWorkspaceFile(settingsStore, requested, maxBytes) {
  const roots = accessRoots(settingsStore)
  const resolved = resolveInWorkspace(roots, requested)
  const stat = await fsp.stat(resolved.absolute)
  if (stat.isDirectory()) throw new Error('IS_DIRECTORY: ' + resolved.absolute)
  if (maxBytes && stat.size > maxBytes) throw new Error('FILE_TOO_LARGE: ' + stat.size)
  return { absolute: resolved.absolute, stat, buffer: await fsp.readFile(resolved.absolute) }
}

/**
 * 导出面：
 *   handleFileApi —— 给 server/index.js 用的 HTTP 入口
 *   其余小件 —— 给 src/main/main.js 的 IPC 那条路复用（开发态 npm start），
 *   免得同一套「哪些目录能看」的规则写两份、慢慢跑偏。
 */
module.exports = {
  handleFileApi,
  workspaceRoots,
  accessRoots,
  resolveInWorkspace,
  describeTree,
  describeFile,
  readWorkspaceFile,
  writeWorkspaceFile,
  readTree,
  kindOf,
  mimeOf,
  extensionOf,
  isProbablyText,
  IGNORED_DIRS,
  MAX_DEPTH,
  MAX_WRITE_BYTES
}
