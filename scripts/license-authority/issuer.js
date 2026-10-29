'use strict'
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto')
const C=require('../../src/main/contracts/licensing')
const defaultDirectory=()=>path.join(os.homedir(),'.agent-license-authority')
function status(directory=defaultDirectory()){const file=path.join(directory,'public-keys.json');if(!fs.existsSync(file))return{configured:false,directory};const info=JSON.parse(fs.readFileSync(file,'utf8'));return{configured:true,directory,keyId:info.keyId,publicKeys:info.publicKeys}}
function init(directory=defaultDirectory()){
 const privateFile=path.join(directory,'private.pem'),publicFile=path.join(directory,'public-keys.json')
 fs.mkdirSync(directory,{recursive:true,mode:0o700})
 if(fs.existsSync(publicFile)&&!fs.existsSync(privateFile))throw Error('签发私钥缺失，请从备份恢复，不能重新生成覆盖旧签发身份')
 if(!fs.existsSync(privateFile)){const keys=crypto.generateKeyPairSync('ed25519');fs.writeFileSync(privateFile,keys.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600,flag:'wx'})}
 const privateKey=crypto.createPrivateKey(fs.readFileSync(privateFile)),publicKey=crypto.createPublicKey(privateKey).export({type:'spki',format:'pem'}),keyId='ed25519-'+crypto.createHash('sha256').update(publicKey).digest('hex').slice(0,16)
 if(!fs.existsSync(publicFile))fs.writeFileSync(publicFile,JSON.stringify({version:1,keyId,publicKeys:{[keyId]:publicKey}},null,2)+'\n',{mode:0o600,flag:'wx'})
 const result=status(directory);if(result.keyId!==keyId||result.publicKeys[keyId]!==publicKey)throw Error('签发公钥与私钥不匹配');return result
}
function request(text){if(typeof text!=='string'||Buffer.byteLength(text)>C.MAX_BYTES)throw Error('申请文件超过64KB');const value=C.parse(text,'设备申请格式无效，请导入客户端导出的 .agentreq 文件');C.exact(value,['version','product','deviceDigest','platform','arch','name']);if(value.version!==1||value.product!==C.PRODUCT)throw Error('设备申请文件不适用');C.digest(value.deviceDigest);for(const k of ['platform','arch','name'])C.text(value[k],200);return value}
function issue({directory=defaultDirectory(),requestText,customer,days,licenseId,sequence=1,now=Date.now()}){
 const authority=init(directory),device=request(requestText);C.text(customer,200);if(!Number.isInteger(days)||days<1||days>36500)throw Error('有效期需为1～36500天');
 const claims=C.claims({version:1,product:C.PRODUCT,licenseId:licenseId||crypto.randomUUID(),customer,deviceDigest:device.deviceDigest,issuedAt:now,notBefore:now-60000,expiresAt:now+days*86400000,sequence,features:['all']})
 const payload=Buffer.from(C.canonical(claims)),signature=crypto.sign(null,payload,fs.readFileSync(path.join(directory,'private.pem')))
 return{claims,text:JSON.stringify({version:1,keyId:authority.keyId,payload:payload.toString('base64'),signature:signature.toString('base64')})+'\n'}
}
function record(directory,claims,output){fs.appendFileSync(path.join(directory,'issuance.jsonl'),JSON.stringify({at:Date.now(),licenseId:claims.licenseId,customer:claims.customer,deviceDigest:claims.deviceDigest,expiresAt:claims.expiresAt,sequence:claims.sequence,output})+'\n',{mode:0o600})}
function fileStem(deviceDigest){return 'Agent-'+C.digest(deviceDigest).slice(0,9).toUpperCase().replace(/(.{3})(.{3})(.{3})/,'$1-$2-$3')}
module.exports={fileStem,defaultDirectory,status,init,request,issue,record}
