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
  console.log('settings migration smoke passed, node ' + process.version)
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
