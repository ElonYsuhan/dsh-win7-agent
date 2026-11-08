#!/usr/bin/env node
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { SettingsStore } = require('../server/settings-store')
const { Settings } = require('../src/main/agent/settings')

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function oldSettings(workspacePath) {
  return {
    workspacePath,
    maxIterations: 20,
    maxConcurrentRuns: 3,
    maxTokens: 8192,
    contextWindowTokens: 0,
    keepRecentMessages: 12,
    requestTimeoutMs: 120000
  }
}

function verify(data, label) {
  assert(data.maxIterations === 100, label + ': maxIterations')
  assert(data.maxConcurrentRuns === 8, label + ': maxConcurrentRuns')
  assert(data.maxTokens === 32768, label + ': maxTokens')
  assert(data.contextWindowTokens === 131072, label + ': contextWindowTokens')
  assert(data.keepRecentMessages === 50, label + ': keepRecentMessages')
  assert(data.requestTimeoutMs === 1800000, label + ': requestTimeoutMs')
  assert(data.limitsVersion === 2, label + ': limitsVersion')
  assert(Array.isArray(data.mcpServers) && data.mcpServers.length === 0, label + ': mcpServers default')
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-settings-migration-'))
try {
  const serverHome = path.join(root, 'server')
  fs.mkdirSync(serverHome, { recursive: true })
  fs.writeFileSync(path.join(serverHome, 'settings.json'), JSON.stringify(oldSettings(path.join(root, 'workspace'))))
  verify(new SettingsStore(serverHome).data, 'server')

  const desktopHome = path.join(root, 'desktop')
  fs.mkdirSync(desktopHome, { recursive: true })
  fs.writeFileSync(path.join(desktopHome, 'settings.json'), JSON.stringify(oldSettings(path.join(root, 'workspace'))))
  verify(new Settings(desktopHome).data, 'desktop')

  for (const Store of [Settings, SettingsStore]) {
    const home = path.join(root, Store.name)
    const project = path.join(root, 'project')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(project, { recursive: true })
    const file = path.join(home, 'settings.json')
    fs.writeFileSync(file, JSON.stringify({ workspacePath: project, recentWorkspacePath: project, projects: [{ id: 'project', folders: [project] }], currentProjectId: 'project' }))
    const store = new Store(home)
    const recent = path.join(home, 'workspace')
    assert(store.data.recentWorkspacePath === recent, Store.name + ': repair contaminated recent workspace')
    assert(JSON.parse(fs.readFileSync(file, 'utf8')).recentWorkspacePath === recent, Store.name + ': persist repaired workspace')
    store.update({ workspacePath: project })
    assert(store.data.recentWorkspacePath === recent, Store.name + ': project selection cannot retarget recent workspace')
    store.update({ recentWorkspacePath: path.join(project, 'nested') })
    assert(store.data.recentWorkspacePath === recent, Store.name + ': project child cannot become an implicit recent workspace')
    assert(new Store(home).data.recentWorkspacePath === recent, Store.name + ': repair survives restart')
    const alias = path.join(home, 'project-alias')
    fs.symlinkSync(project, alias, 'junction')
    store.update({ recentWorkspacePath: path.join(alias, 'nested') })
    assert(store.data.recentWorkspacePath === recent, Store.name + ': canonicalize missing child under a project alias')
    store.update({ projects: [{ id: 'default-project', folders: [recent] }] })
    assert(store.data.recentWorkspacePath === path.join(home, 'chat-workspace'), Store.name + ': independent fallback if default belongs to a project')
    const personal = path.join(home, 'personal')
    store.update({ recentWorkspacePath: personal })
    assert(new Store(home).data.recentWorkspacePath === personal, Store.name + ': preserve an explicit non-project workspace')
  }
  console.log('settings migration smoke passed, node ' + process.version)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
