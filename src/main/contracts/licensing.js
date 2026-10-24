'use strict'
const PRODUCT = 'dsh-agent', TRIAL_MS = 600000, MAX_BYTES = 65536
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function parse(value, message='授权文件格式无效，请选择签发工具生成的 .agentlic 文件') { try { return JSON.parse(value) } catch (_) { throw Error(message) } }
function exact(value, keys) { if (!object(value) || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw Error('授权文件字段无效') }
function text(value, max) { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) throw Error('授权文字字段无效'); return value }
function digest(value) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw Error('设备码无效'); return value }
function canonical(value) { if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'; if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key)+':'+canonical(value[key])).join(',') + '}'; return JSON.stringify(value) }
function claims(raw) {
 exact(raw, ['version','product','licenseId','customer','deviceDigest','issuedAt','notBefore','expiresAt','sequence','features'])
 if (raw.version !== 1 || raw.product !== PRODUCT) throw Error('授权文件不适用于本产品')
 text(raw.licenseId,100);text(raw.customer,200);digest(raw.deviceDigest)
 for (const key of ['issuedAt','notBefore','sequence']) if (!Number.isSafeInteger(raw[key]) || raw[key]<0) throw Error('授权时间或序号无效')
 if(raw.sequence<1 || raw.expiresAt!==null && (!Number.isSafeInteger(raw.expiresAt)||raw.expiresAt<=raw.notBefore||raw.expiresAt>8640000000000000)) throw Error('授权有效期无效')
 if(!Array.isArray(raw.features)||!raw.features.length||raw.features.length>8||new Set(raw.features).size!==raw.features.length||raw.features.some(x=>!['all','chat','workflow','knowledge','extensions','tools'].includes(x)))throw Error('授权功能范围无效')
 return JSON.parse(canonical(raw))
}
function envelope(raw) { exact(raw,['version','keyId','payload','signature']);if(raw.version!==1)throw Error('授权文件版本无效');text(raw.keyId,100);for(const key of ['payload','signature'])if(typeof raw[key]!=='string'||raw[key].length>MAX_BYTES||! /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw[key]))throw Error('授权签名编码无效');return raw }
module.exports={PRODUCT,TRIAL_MS,MAX_BYTES,object,parse,exact,text,digest,canonical,claims,envelope}
