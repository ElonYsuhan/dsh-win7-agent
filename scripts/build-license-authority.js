'use strict'
// Native owner utility; no signing private key is copied into its application.
const fs=require('fs'),path=require('path'),{execFileSync}=require('child_process')
const root=path.resolve(__dirname,'..'),target='mac-'+process.arch
async function main(){
 if(process.platform!=='darwin')throw Error('当前签发工具构建只支持本机 macOS')
 const runtime=path.join(root,'release/.electron-dist/unpacked/darwin-'+process.arch+'/Electron.app')
 const output=path.join(root,'release/licensing/Agent-license-'+target),staging=path.join(root,'release/.desktop-build/license-authority/delivery'),bundle=path.join(staging,'Agent 授权签发工具.app')
 fs.rmSync(staging,{recursive:true,force:true});fs.mkdirSync(staging,{recursive:true})
 execFileSync('ditto',[runtime,bundle])
 const contents=path.join(bundle,'Contents'),payload=path.join(contents,'Resources/app');fs.rmSync(path.join(contents,'Resources/default_app.asar'),{force:true});fs.mkdirSync(path.join(payload,'src/renderer'),{recursive:true});fs.mkdirSync(path.join(payload,'service'),{recursive:true});fs.mkdirSync(path.join(payload,'src/main/contracts'),{recursive:true})
 for(const name of ['main.js','preload.js'])fs.copyFileSync(path.join(__dirname,'license-authority',name),path.join(payload,name))
 for(const name of ['index.html','style.css','app.js'])fs.copyFileSync(path.join(__dirname,'license-authority',name),path.join(payload,'src/renderer',name))
 fs.writeFileSync(path.join(payload,'service/index.js'),fs.readFileSync(path.join(__dirname,'license-authority/issuer.js'),'utf8').replace("../../src/main/contracts/licensing","../src/main/contracts/licensing"))
 fs.copyFileSync(path.join(root,'src/main/contracts/licensing.js'),path.join(payload,'src/main/contracts/licensing.js'))
 fs.writeFileSync(path.join(payload,'package.json'),JSON.stringify({name:'agent-license-authority',version:require('../package.json').version,main:'main.js'}))
 for(const [key,value]of Object.entries({CFBundleIdentifier:'com.dsh.agent.license-authority',CFBundleName:'Agent 授权签发工具',CFBundleDisplayName:'Agent 授权签发工具'}))execFileSync('/usr/libexec/PlistBuddy',['-c','Set :'+key+' '+value,path.join(contents,'Info.plist')])
 const protection=await require('./desktop/source-protection').protect(payload);require('./desktop/source-protection').verify(payload)
 const metadata={formatVersion:1,target,version:require('../package.json').version,sourceCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),runtime:{electron:'22.3.27',node:'16.17.1',chromium:'108'},buildId:require('../shell/installer').computePackageBuildId(payload),sourceProtection:{encrypted:protection.records.filter(r=>r.mode==='aes-256-gcm').length,obfuscated:protection.records.filter(r=>r.mode==='obfuscated').length}}
 fs.writeFileSync(path.join(payload,'license-authority-build.json'),JSON.stringify(metadata,null,2)+'\n')
 execFileSync('codesign',['--force','--deep','--sign','-',bundle]);execFileSync('codesign',['--verify','--deep','--strict',bundle])
 fs.mkdirSync(output,{recursive:true});const destination=path.join(output,path.basename(bundle));if(execFileSync('ps',['ax','-o','command='],{encoding:'utf8'}).split('\n').some(line=>line.includes(destination+'/Contents/MacOS/')))throw Error('签发工具正在运行，请保存并退出后重试');const backup=path.join(staging,'previous.app');if(fs.existsSync(destination))fs.renameSync(destination,backup)
 try{fs.renameSync(bundle,destination)}catch(e){if(fs.existsSync(backup))fs.renameSync(backup,destination);throw e}
 fs.rmSync(backup,{recursive:true,force:true});const inventory=require('./desktop-distribution').inventory(output);fs.mkdirSync(path.join(root,'release/validation'),{recursive:true});fs.writeFileSync(path.join(root,'release/validation/license-authority.json'),JSON.stringify({...metadata,inventory},null,2)+'\n');fs.writeFileSync(path.join(root,'release/licensing/SHA256SUMS.txt'),inventory.filter(r=>r.sha256).map(r=>r.sha256+'  '+path.relative(path.join(root,'release/licensing'),path.join(output,r.path))).join('\n')+'\n');console.log(destination)
}
main().catch(e=>{console.error(e);process.exitCode=1})
