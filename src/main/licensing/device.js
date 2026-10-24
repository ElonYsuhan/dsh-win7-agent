'use strict'
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{execFile}=require('child_process')
function command(file,args){return new Promise((resolve,reject)=>execFile(file,args,{encoding:'utf8',timeout:4000,maxBuffer:65536,windowsHide:true},(error,out)=>error?reject(Error('DEVICE_ID_UNAVAILABLE')):resolve(out)))}
async function deviceIdentity(){
 let id,platform=process.platform
 if(platform==='darwin'){const data=await command('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice']);id=(/"IOPlatformUUID"\s*=\s*"([^"]+)"/.exec(data)||[])[1]}
 else if(platform==='win32'){const data=await command(path.join(process.env.SystemRoot||'C:\\Windows','System32','reg.exe'),['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64']);id=(/MachineGuid\s+REG_SZ\s+([^\r\n]+)/i.exec(data)||[])[1]}
 else if(platform==='linux'){for(const file of ['/etc/machine-id','/var/lib/dbus/machine-id']){try{const stat=await fs.promises.stat(file);if(stat.size>4096)continue;id=(await fs.promises.readFile(file,'utf8')).trim();if(id)break}catch(_){}}}
 if(!id||id.length>512||/^(?:0|-)+$/.test(id))throw Error('DEVICE_ID_UNAVAILABLE')
 return{version:1,platform,arch:process.arch,name:os.hostname(),deviceDigest:crypto.createHash('sha256').update('dsh-agent:device:v1:'+platform+':'+id.trim().toLowerCase()).digest('hex')}
}
module.exports={deviceIdentity}
