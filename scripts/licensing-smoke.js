'use strict'
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto')
const issuer=require('./license-authority/issuer'),{Licensing}=require('../src/main/licensing/service'),{stamp}=require('./desktop/license-policy'),{PluginHost}=require('../src/main/plugins/plugin-host')
async function main(){
 assert.strictEqual(issuer.fileStem('abcdef123'+'0'.repeat(55)), 'Agent-ABC-DEF-123')
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'agent-license-')),directory=path.join(root,'owner'),authority=issuer.init(directory),policy={version:1,enforced:true,publicKeys:authority.publicKeys},device={version:1,platform:'darwin',arch:'arm64',name:'test',deviceDigest:'a'.repeat(64)}
 let now=Date.now(),tick=0
 const make=(name,other={})=>new Licensing({home:path.join(root,name),policy,device,clock:()=>now,monotonic:()=>tick,...other})
 const sign=(changes={})=>{const value=issuer.issue({directory,requestText:JSON.stringify({version:1,product:'dsh-agent',...Object.fromEntries(Object.entries(device).filter(([k])=>k!=='version'))}),customer:'测试客户',days:1,now}),claims={...value.claims,...changes},bytes=Buffer.from(require('../src/main/contracts/licensing').canonical(claims));return JSON.stringify({version:1,keyId:authority.keyId,payload:bytes.toString('base64'),signature:crypto.sign(null,bytes,fs.readFileSync(path.join(directory,'private.pem'))).toString('base64')})}
 try{
  const service=make('trial');assert.strictEqual(service.status().allowed,false);assert.throws(()=>service.assert('chat'),/LICENSE_REQUIRED/)
  assert.strictEqual(service.startTrial().status,'trial');tick=599999;now+=599999;assert.strictEqual(service.status().allowed,true);tick++;now++;assert.strictEqual(service.status().allowed,false);assert.throws(()=>service.startTrial(),/已使用/)
  assert.strictEqual(make('trial').status().allowed,false);assert.throws(()=>make('trial').startTrial(),/已使用/)
  const locked=make('locked');fs.writeFileSync(path.join(locked.dir,'state.lock'),JSON.stringify({pid:process.pid,at:Date.now()}));assert.throws(()=>locked.startTrial(),/其他窗口/);assert(!fs.existsSync(locked.file))
  const text=sign(),before=service.activate({text});assert.strictEqual(before.status,'licensed');assert.strictEqual(before.customer,'测试客户')
  for(const invalid of [JSON.stringify({...JSON.parse(text),signature:Buffer.alloc(64).toString('base64')}),sign({deviceDigest:'b'.repeat(64)}),sign({product:'other'}),sign({notBefore:now+60000}),JSON.stringify({...JSON.parse(text),keyId:'unknown-authority'}),sign({expiresAt:now-1}),text.replace('"version":1','"version":1,"version":1')]){assert.throws(()=>service.activate({text:invalid}));assert.strictEqual(service.status().status,'licensed')}
  const claims=service.verify(text);service.activate({text:sign({licenseId:claims.licenseId,sequence:2})});assert.throws(()=>service.activate({text}),/旧版本/)
  const changed=make('trial',{device:{...device,deviceDigest:'b'.repeat(64)}});assert.strictEqual(changed.status().allowed,false);changed.activate({text:sign({deviceDigest:'b'.repeat(64)})});assert(changed.status().allowed)
  const rollback=make('clock');rollback.startTrial();now-=180000;assert.strictEqual(make('clock').status().status,'clock_error');now+=180000
  const broken=make('broken');fs.writeFileSync(broken.file,'{"broken":true}');assert.strictEqual(make('broken').status().status,'storage_error');assert.throws(()=>make('broken').startTrial())
  const output=path.join(root,'build');fs.mkdirSync(path.join(output,'src/main/licensing'),{recursive:true});const report=stamp(output,path.join(directory,'public-keys.json'));assert(report.enforced);assert(!fs.readFileSync(path.join(output,'src/main/licensing/policy.js'),'utf8').includes('PRIVATE KEY'));assert.throws(()=>stamp(output,path.join(root,'missing')))
  const host=new PluginHost({workspaceRoot:root,settings:{file:path.join(root,'runtime/settings.json'),data:{}},licensing:{policy,device}})
  try{await host.ready();const service=host.requireService('licensing');assert(!service.status().allowed);assert.throws(()=>host.requireService('workflows').run({id:'missing'}),/LICENSE_REQUIRED/);assert.throws(()=>host.requireService('tasks').run('missing'),/LICENSE_REQUIRED/);await assert.rejects(host.executeTool('license_probe',{},{}),/LICENSE_REQUIRED/);await assert.rejects(host.requireService('llm').request({}),/LICENSE_REQUIRED/);service.startTrial();assert(service.status().allowed)}finally{await host.dispose()}
  let allowed=true,executed=false;const Registry=require('../src/main/plugins/tool-registry').ToolRegistry,registry=new Registry({decideToolPermission:()=> 'ask',buildApprovalRequest:()=>({})},undefined,()=>{if(!allowed)throw Error('LICENSE_REQUIRED')});registry.register({name:'expiry_during_approval',description:'test',parameters:{type:'object',properties:{}},permission:'write',execute:()=>{executed=true}});await assert.rejects(registry.execute('expiry_during_approval',{}, {settings:{},approve:async()=>{allowed=false;return true}}),/LICENSE_REQUIRED/);assert(!executed)
  console.log('PASS licensing: signature, device binding, invalid import preservation, sequence, exact 10-minute trial, restart, clock rollback, corrupt storage, public-only build policy, real Cordis model/tool denial')
 }finally{fs.rmSync(root,{recursive:true,force:true})}
}
main().catch(e=>{console.error(e);process.exitCode=1})
