'use strict'
const assert = require('assert'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto')
const { createAuthorityServer, IDLE_MS, ABSOLUTE_MS, privateAddress } = require('./license-authority/web')
async function main() {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-authority-web-')), directory = path.join(scratch, 'keys')
  let now = Date.now(), service = createAuthorityServer({ directory, clock: () => now })
  let address = await service.listen(0, '127.0.0.1'), origin = address.url
  function call(route, data, auth = {}, headers = {}) {
    return new Promise((resolve, reject) => {
      const payload = data === undefined ? null : JSON.stringify(data)
      const request = http.request(new URL(route, origin), { method: payload ? 'POST' : 'GET', headers: { ...(payload ? { Origin: origin, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...(auth.cookie ? { Cookie: auth.cookie, 'X-CSRF-Token': auth.csrf } : {}), ...headers } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', part => { text += part }); response.on('end', () => { let value; try { value = JSON.parse(text) } catch (_) { value = text }; resolve({ status: response.statusCode, headers: response.headers, value }) })
      }); request.on('error', reject); request.end(payload)
    })
  }
  async function login(auth = {}) { const result = await call('/api/login', { username: 'admin', password: 'admin123' }, auth); assert.strictEqual(result.status, 200); const cookie = result.headers['set-cookie'][0]; assert(cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict')); return { cookie: cookie.split(';')[0], csrf: result.value.csrf } }
  try {
    for (const ip of ['127.0.0.1', '::1', '::ffff:192.168.0.2', '10.0.0.2', '172.16.0.1', 'fd12::1']) assert(privateAddress(ip))
    for (const ip of ['8.8.8.8', '172.32.0.1', '2001:4860::1']) assert(!privateAddress(ip))
    assert.strictEqual((await call('/api/session')).value.authenticated, false)
    for (const [route,data] of [['/api/status',undefined],['/api/init',{}],['/api/issue',{}]]) assert.strictEqual((await call(route,data)).status,401)
    assert(!fs.existsSync(directory), 'Unauthenticated requests cannot even initialize signing files')
    assert.strictEqual((await call('/private.pem')).status,404)
    assert.strictEqual((await call('/api/login',{username:'admin',password:'wrong'})).status,401)
    assert.strictEqual((await call('/api/login',{username:'admin',password:'admin123'},{},{Origin:'https://untrusted.example'})).status,403)
    assert.strictEqual((await call('/api/session',undefined,{},{Host:'untrusted.example:'+new URL(origin).port})).status,403)
    let auth=await login(), old=auth
    auth=await login(auth);assert.notStrictEqual(auth.cookie,old.cookie);assert.strictEqual((await call('/api/status',undefined,old)).status,401)
    assert.strictEqual((await call('/api/register',{},auth)).status,404)
    assert.strictEqual((await call('/api/init',{},auth,{'X-CSRF-Token':'0'.repeat(64)})).status,403)
    assert.strictEqual((await call('/api/init',{},auth)).status,200)
    const state=await call('/api/status',undefined,auth);assert(state.value.configured);assert(!JSON.stringify(state).includes('PRIVATE KEY'));assert(!JSON.stringify(state).includes('private.pem'))
    const request={version:1,product:'dsh-agent',deviceDigest:'abcdef123'+'0'.repeat(55),platform:'win32',arch:'x64',name:'客户电脑'}
    const issued=await call('/api/issue',{requestText:JSON.stringify(request),customer:'内网客户',days:365},auth)
    assert.strictEqual(issued.status,200);assert.strictEqual(issued.value.filename,'Agent-ABC-DEF-123.agentlic')
    const envelope=JSON.parse(issued.value.text),payload=Buffer.from(envelope.payload,'base64'),publicKey=JSON.parse(fs.readFileSync(path.join(directory,'public-keys.json'))).publicKeys[envelope.keyId]
    assert(crypto.verify(null,payload,publicKey,Buffer.from(envelope.signature,'base64')));assert.strictEqual(JSON.parse(payload).deviceDigest,request.deviceDigest)
    assert.strictEqual(fs.readFileSync(path.join(directory,'issuance.jsonl'),'utf8').trim().split('\n').length,1)
    assert.strictEqual((await call('/api/issue',{requestText:'x'.repeat(100*1024),customer:'x',days:1},auth)).status,400)
    const before=fs.readFileSync(path.join(directory,'private.pem'))
    now+=IDLE_MS+1;assert.strictEqual((await call('/api/session',undefined,auth)).value.authenticated,false);assert.strictEqual((await call('/api/issue',{},auth)).status,401)
    auth=await login();const created=now
    while(now-created<ABSOLUTE_MS-IDLE_MS){now+=IDLE_MS-1000;assert.strictEqual((await call('/api/activity',{},auth)).status,200)}
    now=created+ABSOLUTE_MS+1;assert.strictEqual((await call('/api/status',undefined,auth)).status,401)
    auth=await login();assert.strictEqual((await call('/api/logout',{},auth)).status,200);assert.strictEqual((await call('/api/status',undefined,auth)).status,401)
    auth=await login();await service.close();service=createAuthorityServer({directory,clock:()=>now});address=await service.listen(0,'127.0.0.1');origin=address.url
    assert.strictEqual((await call('/api/status',undefined,auth)).status,401);assert(fs.readFileSync(path.join(directory,'private.pem')).equals(before))
    for(let i=0;i<5;i++)assert.strictEqual((await call('/api/login',{username:'admin',password:'wrong'})).status,401)
    assert.strictEqual((await call('/api/login',{username:'admin',password:'admin123'})).status,429)
    now+=15*60*1000+1;await login()
    console.log('PASS owner-side browser issuer: required admin login; no registration; signed downloads/name; private key retained; CSRF/Host/origin gates; rate limits; session rotation/logout/idle/absolute/restart expiry; bounded uploads')
  } finally { await service.close(); fs.rmSync(scratch,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
