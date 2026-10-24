'use strict'
// Build host only. Copy public material, never the owner private key.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), os = require('os')
function stamp(appDir, publicFile = path.join(os.homedir(), '.agent-license-authority/public-keys.json')) {
  const info = JSON.parse(fs.readFileSync(publicFile, 'utf8'))
  if (info.version !== 1 || !info.publicKeys || Object.keys(info.publicKeys).length < 1 || Object.keys(info.publicKeys).length > 8) throw Error('LICENSE_BUILD_PUBLIC_KEYS_REQUIRED')
  const publicKeys = {}
  for (const [id, pem] of Object.entries(info.publicKeys)) {
    if (!/^[a-z0-9-]{8,80}$/.test(id) || typeof pem !== 'string' || !pem.startsWith('-----BEGIN PUBLIC KEY-----')) throw Error('LICENSE_BUILD_INVALID_PUBLIC_KEY')
    const key = crypto.createPublicKey(pem)
    if (key.asymmetricKeyType !== 'ed25519') throw Error('LICENSE_BUILD_ED25519_REQUIRED')
    publicKeys[id] = key.export({type:'spki',format:'pem'})
  }
  const bytes = '\'use strict\'\nmodule.exports = '+JSON.stringify({version:1,enforced:true,publicKeys},null,2)+'\n'
  fs.writeFileSync(path.join(appDir, 'src/main/licensing/policy.js'), bytes)
  return {enforced:true, keyIds:Object.keys(publicKeys), policySha256:crypto.createHash('sha256').update(bytes).digest('hex')}
}
module.exports = {stamp}
