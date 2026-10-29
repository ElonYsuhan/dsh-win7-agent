'use strict'
// Build-host authority, deliberately separate from customer license issuance.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto')
const directory = () => path.join(os.homedir(), '.agent-release-authority')
function init(dir = directory()) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const privateFile = path.join(dir, 'private.pem'), publicFile = path.join(dir, 'public.pem')
  if (!fs.existsSync(privateFile)) {
    if (fs.existsSync(publicFile)) throw Error('发布签名私钥缺失，请恢复备份')
    const pair = crypto.generateKeyPairSync('ed25519')
    fs.writeFileSync(privateFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 })
  }
  const key = read(dir), publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' })
  if (!fs.existsSync(publicFile)) fs.writeFileSync(publicFile, publicKey, { flag: 'wx', mode: 0o644 })
  if (fs.readFileSync(publicFile, 'utf8') !== publicKey) throw Error('发布签名公私钥不匹配')
  return publicFile
}
function read(dir = directory()) {
  const key = crypto.createPrivateKey(fs.readFileSync(path.join(dir, 'private.pem')))
  if (key.asymmetricKeyType !== 'ed25519') throw Error('RELEASE_ED25519_REQUIRED')
  return key
}
function readPublic(dir = directory()) { return crypto.createPublicKey(fs.readFileSync(path.join(dir, 'public.pem'))).export({ type: 'spki', format: 'pem' }) }
module.exports = { init, read, readPublic, directory }
if (require.main === module) {
  if (process.argv[2] !== 'init') throw Error('用法：node scripts/desktop/release-signing.js init')
  console.log(init())
}
