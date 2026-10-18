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

function buildApprovalRequest(permission, args, toolName) {
  const level = normalizeLevel(permission)
  if (level === 'command') {
    const command = String((args && args.command) || '')
    const program = commandProgram(command)
    return {
      kind: 'command',
      signature: program ? 'command:' + program : 'command',
      program,
      title: command ? 'Run command' : '工具操作：' + String(toolName || 'command'),
      detail: command ? 'cwd=' + String((args && args.cwd) || '.') + '\n' + command : JSON.stringify(args || {}, null, 2)
    }
  }
  if (level === 'edit') {
    return { kind: 'edit', signature: 'edit', title: 'Edit file', detail: String((args && args.path) || '') }
  }
  return { kind: 'write', signature: 'write', title: 'Write file', detail: String((args && args.path) || '') }
}

module.exports = {
  commandProgram,
  isDangerousCommand,
  decideToolPermission,
  buildApprovalRequest,
  DANGEROUS_PATTERNS
}
