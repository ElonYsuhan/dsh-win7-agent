'use strict'

const crypto = require('crypto')
const { NAME } = require('../contracts/host-integration')
const { hash } = require('./repository')

function validateEntries(entries, kind) {
  if (!Array.isArray(entries) || !entries.length) throw Error('SERVICE_' + kind.toUpperCase() + '_CONFIG_REQUIRED')
  const ids = new Set()
  return entries.map(entry => {
    if (!entry || !NAME.test(entry.id || '') || ids.has(entry.id) || !/^[a-f0-9]{64}$/.test(entry.tokenHash || '')) throw Error('SERVICE_IDENTITY_INVALID')
    ids.add(entry.id)
    const links = kind === 'user' ? entry.hosts : entry.users
    if (!Array.isArray(links) || !links.every(id => NAME.test(id))) throw Error('SERVICE_IDENTITY_LINKS_INVALID')
    if (kind === 'host') {
      if (!entry.tools || typeof entry.tools !== 'object' || Array.isArray(entry.tools)) throw Error('SERVICE_HOST_TOOLS_REQUIRED')
      for (const [name, permission] of Object.entries(entry.tools)) if (!NAME.test(name) || !['read', 'write', 'command'].includes(permission)) throw Error('SERVICE_HOST_TOOLS_INVALID')
    }
    return { id: entry.id, tokenHash: entry.tokenHash, [kind === 'user' ? 'hosts' : 'users']: links.slice(), ...(kind === 'host' ? { tools: { ...entry.tools } } : {}) }
  })
}
function authenticate(header, entries) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(String(header || ''))
  if (!match) return null
  const digest = Buffer.from(hash(match[1]), 'hex')
  let found = null
  for (const entry of entries) {
    if (crypto.timingSafeEqual(digest, Buffer.from(entry.tokenHash, 'hex'))) found = entry
  }
  return found
}
module.exports = { validateEntries, authenticate }
