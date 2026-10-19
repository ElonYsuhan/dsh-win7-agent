'use strict'
const crypto=require('crypto'),{readZip,writeZip}=require('../mcp/documents/zip'),C=require('../contracts/extensions')
const sha=data=>crypto.createHash('sha256').update(data).digest('hex')
function inspect(buffer,target){
 if(buffer.length>C.MAX_ARCHIVE)throw Error('扩展包压缩文件不能超过8MB')
 const files=readZip(buffer),names=new Set();let total=0
 // Reject links/special files; ZIP paths are portable even when installed on macOS.
 let eocd=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50&&i+22+buffer.readUInt16LE(i+20)===buffer.length){eocd=i;break}
 let cursor=buffer.readUInt32LE(eocd+16)
 for(let i=0;i<buffer.readUInt16LE(eocd+10);i++){const mode=buffer.readUInt32LE(cursor+38)>>>16,type=mode&0xf000;if(type&&type!==0x8000&&type!==0x4000)throw Error('扩展包不允许符号链接或特殊文件');cursor+=46+buffer.readUInt16LE(cursor+28)+buffer.readUInt16LE(cursor+30)+buffer.readUInt16LE(cursor+32)}
 for(const [name,data] of files){const directory=name.endsWith('/'),safe=C.relativeFile(directory?name.slice(0,-1):name),key=safe.toLowerCase();if(names.has(key))throw Error('扩展包包含重名文件');names.add(key);if(directory){if(data.length)throw Error('无效目录项');files.delete(name);continue}total+=data.length;if(total>C.MAX_EXPANDED)throw Error('扩展包解压后不能超过32MB');if(/\.(node|exe|dll|dylib|so)$/i.test(name))throw Error('首版扩展包仅支持纯 JS 和资源文件，不支持原生二进制')}
 const raw=files.get('manifest.json');if(!raw||raw.length>512*1024)throw Error('缺少或过大的 manifest.json')
 const manifest=C.manifest(JSON.parse(raw.toString('utf8')),target)
 if(manifest.type==='skill'&&files.get(manifest.entry)&&files.get(manifest.entry).length>256*1024)throw Error('SKILL.md 不能超过256KB')
 if(files.size!==Object.keys(manifest.files).length+1)throw Error('扩展包文件与清单不一致')
 for(const [name,digest] of Object.entries(manifest.files))if(!files.has(name)||sha(files.get(name))!==digest)throw Error('扩展包文件校验失败：'+name)
 // Compile only; inspection must never execute installed code or installation hooks.
 for(const [name,data] of files)if(/\.(cjs|js)$/.test(name))new (require('vm').Script)('(function(require,module,exports,__filename,__dirname){\n'+data.toString('utf8')+'\n})',{filename:name})
 return{manifest,files,digest:sha(buffer),bytes:total}
}
function pack(directory,output){const fs=require('fs'),path=require('path'),base=fs.realpathSync(directory),files=new Map(),raw=JSON.parse(fs.readFileSync(path.join(base,'manifest.json'),'utf8'));const relativeOutput=path.relative(base,path.resolve(output));if(!relativeOutput.startsWith('..'+path.sep)&&relativeOutput!=='..'&&!path.isAbsolute(relativeOutput))throw Error('输出包必须放在源目录外');function walk(dir,prefix){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['.git','.DS_Store'].includes(entry.name))continue;const rel=prefix+entry.name;C.relativeFile(rel);if(entry.isSymbolicLink())throw Error('不能打包符号链接');if(entry.isDirectory())walk(path.join(dir,entry.name),rel+'/');else if(entry.isFile()&&rel!=='manifest.json')files.set(rel,fs.readFileSync(path.join(dir,entry.name)))}}walk(base,'');raw.files=Object.fromEntries([...files].map(([name,data])=>[name,sha(data)]));files.set('manifest.json',Buffer.from(JSON.stringify(raw,null,2)));const buffer=writeZip(files);const checked=inspect(buffer);C.assertFilename(path.basename(output),checked.manifest.type);fs.writeFileSync(output,buffer);return raw}
module.exports={inspect,pack,sha}
