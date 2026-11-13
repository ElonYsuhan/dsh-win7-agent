'use strict'

/**
 * permission-policy.js —— 权限决策的唯一入口
 *
 * 三种档位（settings.permissionMode）：
 *   readonly   仅可查看：不能写/改任何文件；执行命令需要用户逐条确认
 *   workspace  工作区内修改：工作区内文件直接改；只有「危险命令」需要确认
 *   full       完全权限：文件与普通命令直接执行；仅「危险命令」需要确认
 *
 * 工具侧的 permission 取值：read / write / edit / command
 * 决策返回：'allow' 直接执行 | 'ask' 先走审批 | 'deny' 直接拒绝
 *
 * 所有工具（内置 + 插件）都必须经 tool-registry 走这里，不允许各自再写一套判断。
 */

const not = (value) => value ? false : true

const PERMISSION_LEVELS = ['read', 'write', 'edit', 'command']

/** 从一条命令里取出「程序名」，作为审批放行清单的 key。
 *  例：`npm create vite@latest .` -> `npm`；`C:\x\npm.cmd install` -> `npm`
 *  复合命令只取第一段（cd a && npm i -> cd），宁保守不放行。 */
function commandProgram(command) {
  const text = String(command || '').trim()
  if (text === '') return ''
  const first = text.split(/&&|\|\||[;|]/)[0].trim()
  const match = first.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/)
  if (not(match)) return ''
  const raw = match[1] || match[2] || match[3] || ''
  const parts = raw.split(/[\\/]/)
  const base = parts[parts.length - 1] || raw
  return base.replace(/\.(exe|cmd|bat|com|ps1)$/i, '')
}

/** 危险命令清单：命中就需要确认。按「真会造成不可逆破坏」收敛，宁缺毋滥。 */
const DANGEROUS_PATTERNS = [
  /\b(rm|del|erase|unlink|Remove-Item)\s+/i, // 删除操作，即使不是递归删除也需确认。
  /\brm\s+-[a-z]*[rR]/i,                          // rm -r / -rf / -fr
  /\b(rmdir|rd)\s+\/[a-z]*s/i,                    // Windows rmdir /s
  /\bdel\s+\/[a-z]*[sq]/i,                        // del /s /q
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|halt|poweroff)\b/i,
  /\bgit\s+push\s+(--force\b|-f\b|--force-with-lease\b)/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-z]*[fdx]/i,
  /\bgit\s+checkout\s+--\s+\./i,                  // 丢弃全部未提交改动
  /\bgit\s+branch\s+-D\b/i,
  /\bnpm\s+(publish|unpublish)\b/i,
  /\bchmod\s+-R\b/i,
  /\bchown\s+-R\b/i,
  /\btaskkill\s+\/[a-z]*f/i,
  /\bkill\s+-9\b/i,
  /\b(curl|wget)\b[^|]*\|\s*(ba)?sh\b/i,          // 下载即执行
  /\b(curl|wget)\b[^|]*\|\s*powershell\b/i,
  /\bRemove-Item\b[\s\S]*-Recurse/i,
  /\breg\s+delete\b/i,
  /\bdrop\s+(table|database|db)\b/i,
  /\btruncate\s+table\b/i,
  />\s*\/dev\/(sd|nvme|hd)/i,
  /\bsudo\s+rm\b/i
]

function isDangerousCommand(command) {
  const text = String(command || '')
  if (text.trim() === '') return false
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(text)) return true
  }
  return false
}

function normalizeLevel(permission) {
  return PERMISSION_LEVELS.indexOf(permission) !== -1 ? permission : 'write'
}

function decideToolPermission(permission, mode, args, settings) {
  const level = normalizeLevel(permission)
  const permissionMode = mode === 'readonly' || mode === 'workspace' || mode === 'full' ? mode : 'workspace'
  if (permissionMode === 'readonly') {
    if (level === 'read') return 'allow'
    if (level === 'command') return 'ask'
    return 'deny'
  }
  if (level === 'command') {
    if (permissionMode === 'workspace' && settings && settings.approveCommands === true) return 'ask'
    return isDangerousCommand(args && args.command) ? 'ask' : 'allow'
  }
  return 'allow'
}

const CAPABILITY_LABELS = {
  'entity.create': '新增一个实体',
  'entity.update': '修改实体属性',
  'entity.delete': '删除一个实体',
  'entity.list': '查看实体列表',
  'entity.get': '查看实体信息',
  'animation.get': '查看动画工程',
  'animation.track.create': '添加动画轨道',
  'animation.track.update': '修改动画轨道',
  'animation.track.remove': '删除动画轨道',
  'animation.clip.add': '添加动画片段',
  'animation.clip.update': '修改动画片段',
  'animation.clip.remove': '删除动画片段',
  'animation.keyframe.update': '修改动画关键帧',
  'animation.preset.add': '添加动画效果',
  'animation.project.update': '修改动画工程',
}
function sceneActionLabel(capabilityId) {
  if (CAPABILITY_LABELS[capabilityId]) return CAPABILITY_LABELS[capabilityId]
  const value = String(capabilityId || '')
  if (value.startsWith('camera.')) return '调整推演镜头'
  if (value.startsWith('animation.camera')) return '调整推演镜头'
  if (value.startsWith('animation.')) return '修改动画'
  if (value.startsWith('entity.')) return '修改场景实体'
  if (value.startsWith('resource.')) return '使用场景资源'
  if (value.startsWith('knowledge.')) return '修改知识库'
  return '修改当前场景'
}
// 审批提示面向最终用户：用一句话说明将要发生的业务动作，技术参数只放在可展开详情里。
function buildApprovalRequest(permission, args, toolName) {
  const level = normalizeLevel(permission)
  if (String(toolName || '') === 'hesyn_call') {
    const capabilityId = String((args && args.capabilityId) || '')
    return {
      kind: 'command',
      signature: 'hesyn:' + (capabilityId || 'scene'),
      program: '',
      title: '需要你的确认',
      description: 'AI 准备' + sceneActionLabel(capabilityId) + '。确认后才会写入当前场景，你可以先拒绝再让它调整方案。',
      detail: JSON.stringify(args || {}, null, 2)
    }
  }
  if (String(toolName || '').startsWith('host__')) {
    const action = {
      host__hesyn__entity_create: '在当前场景部署装备',
      host__hesyn__entity_update: '修改当前场景的装备',
      host__hesyn__entity_delete: '删除当前场景的装备',
      host__hesyn__hesyn_call: '调用 HESYN 能力'
    }[toolName]
    return {
      kind: level === 'command' ? 'command' : (level === 'edit' ? 'edit' : 'write'),
      signature: 'host:' + toolName,
      title: '需要确认宿主操作：' + toolName,
      description: action ? 'AI 准备' + action + '。确认后才会执行。' : 'AI 准备调用宿主工具并可能修改宿主数据。确认后才会执行。',
      detail: JSON.stringify(args || {}, null, 2)
    }
  }
  if (level === 'command') {
    const command = String((args && args.command) || '')
    const program = commandProgram(command)
    return {
      kind: 'command',
      signature: program ? 'command:' + program : 'command',
      program,
      title: '需要你的确认',
      description: command ? 'AI 准备在你的电脑上执行命令。' : 'AI 准备执行一项需要授权的操作。',
      detail: command ? 'cwd=' + String((args && args.cwd) || '.') + '\n' + command : JSON.stringify(args || {}, null, 2)
    }
  }
  if (level === 'edit') {
    const editPath = String((args && args.path) || '')
    return { kind: 'edit', signature: 'edit', title: '需要你的确认', description: editPath ? 'AI 准备修改文件：' + editPath : 'AI 准备修改一个文件。', detail: editPath }
  }
  const writePath = String((args && args.path) || '')
  return { kind: 'write', signature: 'write', title: '需要你的确认', description: writePath ? 'AI 准备写入文件：' + writePath : 'AI 准备写入一个文件。', detail: writePath }
}
module.exports = {
  commandProgram,
  isDangerousCommand,
  decideToolPermission,
  buildApprovalRequest,
  DANGEROUS_PATTERNS
}
