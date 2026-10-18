'use strict'
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process')
const root=path.resolve(__dirname,'..'),source=path.join(root,'scripts/knowledge-native'),out=path.join(root,'src/main/knowledge/vendor/sqlite')
const flags=['-O2','-DSQLITE_THREADSAFE=0','-DSQLITE_ENABLE_FTS5','-DSQLITE_OMIT_LOAD_EXTENSION','-DSQLITE_DQS=0']
const zig=process.env.KNOWLEDGE_ZIG||path.join(root,'release/.knowledge-build/zig-macos-aarch64-0.13.0/zig')
const targets={'darwin-arm64':['clang',['-arch','arm64','-mmacosx-version-min=11.0']],'darwin-x64':['clang',['-arch','x86_64','-mmacosx-version-min=10.13']],'win32-x64.exe':['x86_64-w64-mingw32-gcc',['-static','-static-libgcc','-mcrtdll=msvcrt-os','-U__MSVCRT_VERSION__','-D__MSVCRT_VERSION__=0x0700','-D_WIN32_WINNT=0x0601','-DWINVER=0x0601','-municode','-s']],'linux-x64':[zig,['cc','-target','x86_64-linux-musl','-static','-s']],'linux-arm64':[zig,['cc','-target','aarch64-linux-musl','-static','-s']]}
const selected=process.argv[2]==='--manifest'?[]:process.argv[2]?[process.argv[2]]:Object.keys(targets)
fs.mkdirSync(out,{recursive:true})
const sourceBytes=fs.readFileSync(path.join(source,'sqlite3.c'))
if(crypto.createHash('sha3-256').update(sourceBytes).digest('hex')!=='8efd453d08a7cfc4c79de5923153036cdc4dcaa254d4f1e617be6a2a98828f9e')throw Error('SQLITE_UPSTREAM_HASH_MISMATCH')
for(const target of selected){const [command,args]=targets[target]||[];if(!command)throw Error('UNKNOWN_TARGET');console.log('Build SQLite 3.54.0 '+target);const result=spawnSync(command,[...args,...flags,path.join(source,'bridge.c'),path.join(source,'sqlite3.c'),'-o',path.join(out,target)],{stdio:'inherit',env:{...process.env,ZIG_GLOBAL_CACHE_DIR:path.join(root,'release/.knowledge-build/zig-cache')},timeout:300000});if(result.status!==0)throw Error('SQLITE_BUILD_FAILED '+target);fs.chmodSync(path.join(out,target),0o755)}
const manifest={bridgeSourceSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(source,'bridge.c'))).digest('hex'),version:'3.54.0',bridgeVersion:1,targets:Object.fromEntries(Object.entries(targets).map(([key,value])=>[key,{command:path.basename(value[0]),args:value[1]}])),sourceSha256:crypto.createHash('sha256').update(sourceBytes).digest('hex'),flags,compiler:{mac:'Apple clang (build-host SDK)',cross:'Zig 0.13.0 (Linux); MinGW-w64 14.0.0_3, GCC 16.2.0 (Windows, MSVCRT)',zigArchiveSha256:'46fae219656545dfaf4dce12fb4e8685cec5b51d721beee9389ab4194d43394c'},win7HardwareVerified:false,files:{}}
for(const name of Object.keys(targets))if(fs.existsSync(path.join(out,name)))manifest.files[name]=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex')
fs.writeFileSync(path.join(out,'manifest.json'),JSON.stringify(manifest,null,2)+'\n')
