'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { PluginHost } = require('../src/main/plugins/plugin-host')

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-'))
  const settings = { approveWrites: false, approveCommands: false }
  const host = new PluginHost({ workspaceRoot: root, settings })
  host.loadBuiltins()
  host.use({
    name: 'smoke/custom',
    version: '0.1.0',
    apply(ctx) {
      ctx.provide('smokeService', { hello: () => 'world' })
      ctx.addSystemPrompt(() => 'SMOKE_PROMPT')
      ctx.registerTool({
        name: 'echo_tool',
        description: 'Echo input.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text']
        },
        execute: async (args) => 'echo:' + args.text
      })
    }
  })
  const names = host.listTools().map((tool) => tool.name)
  console.log('tools:', names.join(','))
  console.log('plugins:', host.listPlugins().join(','))
  console.log('service:', host.get('smokeService').hello())
  console.log('prompt:', await host.buildSystemPrompt('BASE'))
  console.log('echo:', await host.executeTool('echo_tool', { text: 'ok' }, {
    workspaceRoot: root,
    settings,
    approve: async () => true
  }))
  if (not(names.includes('read_file'))) throw new Error('read_file missing')
  if (not(names.includes('echo_tool'))) throw new Error('echo_tool missing')
  if (host.get('smokeService').hello() !== 'world') throw new Error('service failed')

  /* ---- 内置 Markdown 技能（builtin/skill-tools）----
     技能是随包资源，必须真的扫得到、取得到，而且不能越出技能目录。 */
  if (not(names.includes('load_skill'))) throw new Error('load_skill missing')
  if (not(names.includes('search_skills'))) throw new Error('search_skills missing')
  const mdSkills = require('../src/main/agent/md-skills')
  const skillList = mdSkills.list()
  if (skillList.length < 50) throw new Error('builtin skills too few: ' + skillList.length)
  if (not(skillList.every((item) => item.dir && item.name))) throw new Error('skill entry malformed')
  const loaded = await host.executeTool('load_skill', { name: 'library' }, { workspaceRoot: root, settings, approve: async () => true })
  if (String(loaded).indexOf('skill=01-app-builtin/library') !== 0) throw new Error('load_skill body head wrong: ' + String(loaded).slice(0, 80))
  if (String(loaded).length < 500) throw new Error('load_skill body too short')
  const missing = await host.executeTool('load_skill', { name: 'no-such-skill-xyz' }, { workspaceRoot: root, settings, approve: async () => true })
  if (String(missing).indexOf('SKILL_NOT_FOUND') === -1) throw new Error('unknown skill should report SKILL_NOT_FOUND')
  const escaped = await host.executeTool('load_skill', { name: 'library', file: '../../../../etc/passwd' }, { workspaceRoot: root, settings, approve: async () => true })
  if (String(escaped).indexOf('SKILL_PATH_ESCAPE') === -1) throw new Error('path escape not blocked')
  const searched = await host.executeTool('search_skills', { query: 'excel' }, { workspaceRoot: root, settings, approve: async () => true })
  if (String(searched).indexOf('excel') === -1) throw new Error('search_skills found nothing for excel')
  const prompt = await host.buildSystemPrompt('BASE')
  if (prompt.indexOf('Bundled skills') === -1 || prompt.indexOf('01-app-builtin/library') === -1) {
    throw new Error('skill index missing from system prompt')
  }
  console.log('skills:', skillList.length, '| index chars:', prompt.length - 4)
  console.log('skill prompt block chars:', mdSkills.systemPromptBlock().length)

  host.dispose()
  fs.rmSync(root, { recursive: true, force: true })
}

const not = (value) => value ? false : true

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
