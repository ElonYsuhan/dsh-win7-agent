'use strict'

/**
 * builtin/skill-tools —— 内置 Markdown 技能（SKILL.md）的取用入口
 *
 * 系统提示里挂一份「技能清单」（短），模型按需用 load_skill 取全文 —— 渐进式披露，
 * 65 个技能全塞正文会直接把上下文吃满。
 *
 * 权限：都是 read 级（只读随包内置的技能文件，够不到用户工作区，也不写盘）。
 */

const mdSkills = require('../../../agent/md-skills')

module.exports = {
  name: 'builtin/skill-tools',
  version: '0.1.0',
  description: 'Bundled markdown skills (SKILL.md) index and loader.',
  apply(ctx) {
    ctx.registerTool({
      name: 'load_skill',
      permission: 'read',
      description: 'Load the full text of a bundled skill (a markdown playbook shipped with the app). Call this BEFORE doing a task that matches one of the skills listed in the system prompt. Pass file to read an extra file inside the same skill directory (e.g. references/api.md).',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Skill id from the bundled skill list (for example 01-app-builtin/library or 02-builtin-plugins/tencent-docx/skills/doc-typeset). Short names like "library" also work.' },
          file: { type: 'string', description: 'Optional path relative to that skill directory, for example references/notes.md or scripts/run.py.' }
        },
        required: ['name']
      },
      execute: async (args) => {
        const result = mdSkills.read(args && args.name, args && args.file)
        if (result.ok) return result.text
        const payload = { error: result.error }
        if (result.files) payload.files = result.files
        return JSON.stringify(payload)
      }
    })

    ctx.registerTool({
      name: 'search_skills',
      permission: 'read',
      description: 'Search the bundled skills by keyword (matches id, name and description). Use it when the built-in skill index in the system prompt is too long to scan, or when the right skill is unclear.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Keyword(s), for example "excel" or "ppt 排版". Omit to list all skills.' },
          limit: { type: 'number', description: 'Max results, default 20.' }
        }
      },
      execute: async (args) => {
        const result = mdSkills.search(args && args.query, args && args.limit)
        return JSON.stringify(result)
      }
    })

    /* 技能清单进系统提示（短索引，正文按需取） */
    ctx.addSystemPrompt(() => mdSkills.systemPromptBlock())

    const info = mdSkills.stats()
    ctx.logger.info('skills loaded: ' + info.count + ' from ' + info.root)
  }
}
