'use strict'
// Owner-only issuance CLI. Private material is never printed or bundled.
const fs=require('fs'),path=require('path'),issuer=require('./license-authority/issuer')
const args=process.argv.slice(2),command=args.shift(),options={}
while(args.length){const key=args.shift();if(!key.startsWith('--')||!args.length)throw Error('参数无效');options[key.slice(2)]=args.shift()}
const directory=path.resolve(options.dir||issuer.defaultDirectory())
if(directory===path.resolve(__dirname,'..')||directory.startsWith(path.resolve(__dirname,'..')+path.sep))throw Error('私钥目录必须位于仓库之外')
if(command==='init'){const result=issuer.init(directory);console.log(JSON.stringify({directory,keyId:result.keyId,publicKeyFile:path.join(directory,'public-keys.json')},null,2))}
else if(command==='issue'){if(!options.request||!options.customer||!options.days||!options.out)throw Error('用法: issue --request 设备.agentreq --customer 客户 --days 365 --out 授权.agentlic [--dir 独立密钥目录]');const result=issuer.issue({directory,requestText:fs.readFileSync(options.request,'utf8'),customer:options.customer,days:Number(options.days),licenseId:options.id,sequence:options.sequence===undefined?1:Number(options.sequence)});fs.writeFileSync(options.out,result.text,{flag:'wx',mode:0o600});issuer.record(directory,result.claims,path.resolve(options.out));console.log('已签发 '+path.resolve(options.out))}
else throw Error('用法: node scripts/license-authority.js init [--dir 独立密钥目录] 或 issue ...')
