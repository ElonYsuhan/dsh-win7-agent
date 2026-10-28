'use strict'
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto')
const dir=path.resolve(__dirname,'../src/main/knowledge/vendor/sqlite'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json')))
assert.strictEqual(manifest.version,'3.54.0')
for(const name of ['darwin-arm64','darwin-x64','win32-x64.exe','linux-x64','linux-arm64']){const bytes=fs.readFileSync(path.join(dir,name));assert.strictEqual(crypto.createHash('sha256').update(bytes).digest('hex'),manifest.files[name],name+' checksum')}
const b=fs.readFileSync(path.join(dir,'win32-x64.exe')),pe=b.readUInt32LE(0x3c),opt=pe+24,sections=[]
assert.strictEqual(b.readUInt16LE(pe+4),0x8664);assert(b.readUInt16LE(opt+48)<=6)
for(let i=0;i<b.readUInt16LE(pe+6);i++){const s=opt+b.readUInt16LE(pe+20)+i*40;sections.push({rva:b.readUInt32LE(s+12),size:Math.max(b.readUInt32LE(s+8),b.readUInt32LE(s+16)),offset:b.readUInt32LE(s+20)})}
const off=rva=>{const s=sections.find(s=>s.rva<=rva&&rva<s.rva+s.size);assert(s);return s.offset+rva-s.rva},text=p=>b.subarray(p,b.indexOf(0,p)).toString()
let cursor=off(b.readUInt32LE(opt+120));const dlls=[]
while(b.readUInt32LE(cursor+12)){const name=text(off(b.readUInt32LE(cursor+12))).toLowerCase();assert(['kernel32.dll','msvcrt.dll'].includes(name),'Win7 external runtime: '+name);dlls.push(name);let thunk=off(b.readUInt32LE(cursor)||b.readUInt32LE(cursor+16));while(true){const value=b.readBigUInt64LE(thunk);thunk+=8;if(!value)break;if(value>>63n)continue;const fn=text(off(Number(value))+2);assert(!['GetSystemTimePreciseAsFileTime','GetTempPath2W','SetThreadDescription','GetOverlappedResultEx','InitializeCriticalSectionEx','WaitOnAddress'].includes(fn),'Unverified newer Windows API: '+fn)}cursor+=20}
assert(dlls.includes('msvcrt.dll'))
for(const name of ['linux-x64','linux-arm64']){const b=fs.readFileSync(path.join(dir,name));assert.strictEqual(b.subarray(0,4).toString('hex'),'7f454c46');const start=Number(b.readBigUInt64LE(32)),size=b.readUInt16LE(54),count=b.readUInt16LE(56);for(let i=0;i<count;i++)assert.notStrictEqual(b.readUInt32LE(start+i*size),3,'Linux requires external dynamic loader')}
const source=Buffer.from(fs.readFileSync(path.resolve(__dirname,'knowledge-native/sqlite3.c'),'utf8').replace(/\r\n/g,'\n'));assert.strictEqual(crypto.createHash('sha256').update(source).digest('hex'),manifest.sourceSha256);if(crypto.getHashes().includes('sha3-256'))assert.strictEqual(crypto.createHash('sha3-256').update(source).digest('hex'),'8efd453d08a7cfc4c79de5923153036cdc4dcaa254d4f1e617be6a2a98828f9e')
console.log('Knowledge native: 5 target hashes, SQLite source SHA256 (upstream SHA3 when available), Win x64/legacy CRT imports, Linux static ELF passed; Win7 hardware NOT tested')
