'use strict'

const crypto = require('crypto')

// Minimal ephemeral self-signed X.509 CA/leaf for model.test, using Node's built-in crypto.
function der(tag, contents) {
  const data = Buffer.concat(Array.isArray(contents) ? contents : [contents])
  const n = data.length
  let length
  if (n < 128) length = Buffer.from([n])
  else if (n < 256) length = Buffer.from([0x81, n])
  else length = Buffer.from([0x82, n >> 8, n & 255])
  return Buffer.concat([Buffer.from([tag]), length, data])
}
function certForTest() {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const sigAlg = Buffer.from('300d06092a864886f70d01010b0500', 'hex')
  const dn = der(0x30, der(0x31, der(0x30, [Buffer.from('0603550403', 'hex'), der(0x0c, Buffer.from('model.test'))])))
  const validity = der(0x30, [der(0x17, Buffer.from('240101000000Z')), der(0x17, Buffer.from('491231235959Z'))])
  const san = der(0x30, [Buffer.from('0603551d11', 'hex'), der(0x04, der(0x30, [der(0x82, Buffer.from('model.test')), der(0x87, Buffer.from([127, 0, 0, 1]))]))])
  const ca = Buffer.from('300f0603551d130101ff040530030101ff', 'hex')
  const tbs = der(0x30, [der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([1])), sigAlg, dn, validity, dn,
    pair.publicKey.export({ format: 'der', type: 'spki' }), der(0xa3, der(0x30, [ca, san]))])
  const signature = crypto.sign('sha256', tbs, pair.privateKey)
  const certificate = der(0x30, [tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), signature]))])
  const pem = '-----BEGIN CERTIFICATE-----\n' + certificate.toString('base64').match(/.{1,64}/g).join('\n') + '\n-----END CERTIFICATE-----\n'
  return { cert: pem, key: pair.privateKey.export({ format: 'pem', type: 'pkcs8' }) }
}


module.exports = { certForTest }
