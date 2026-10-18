'use strict'
// No model text can grant authority; immutable task configuration is the boundary.
function blocked(tool, args, settings) {
  const task = settings.unattended
  if (!task.tools.includes(tool.name)) return 'outside task tool allowlist'
  if (settings.permissionMode === 'readonly' && tool.permission !== 'read') return 'read-only task'
  if (tool.name === 'run_command') {
    if (settings.permissionMode !== 'workspace' || !task.commands.includes(String(args.command || ''))) return 'command is not explicitly authorized'
    if (args.cwd && args.cwd !== '.') return 'commands must use workspace root'
  }
  if (tool.name.startsWith('browser_')) {
    if (settings.permissionMode !== 'workspace') return 'browser disabled in read-only tasks'
    if (tool.name === 'browser_act' && !['getdom','get_dom','gettext','get_text','screenshot','open','close'].includes(args.action)) return 'only browser inspection and navigation allowed unattended'
    if (tool.name === 'browser_act' && args.action === 'open' && !args.url) return 'explicit URL required'
    const url = args.url
    if (url) { let origin; try { origin = new URL(url).origin } catch (_) { return 'invalid URL' }; if (!task.origins.includes(origin)) return 'origin not authorized' }
    if (tool.name === 'browser_launch' && !url) return 'explicit authorized URL required'
  }
  return ''
}
module.exports = { blocked }
