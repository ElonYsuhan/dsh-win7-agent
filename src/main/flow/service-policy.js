'use strict'

function hostAllowed(user, host) { return Boolean(user && host && user.hosts.includes(host.id) && host.users.includes(user.id)) }
function toolAllowed(binding, name, fingerprint) { return Boolean(binding && binding.tools[name] && binding.tools[name] === fingerprint) }
function recoverCall(status) { return ['prepared', 'running'].includes(status) ? 'uncertain' : status }
module.exports = { hostAllowed, toolAllowed, recoverCall }
