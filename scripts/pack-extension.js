'use strict'
const path=require('path'),{pack}=require('../src/main/extensions/archive')
if(!process.argv[2]||!process.argv[3]){console.error('Usage: node scripts/pack-extension.js <directory> <output.agentpkg>');process.exitCode=1}else{const output=path.resolve(process.argv[3]);const m=pack(process.argv[2],output);console.log(m.publisher+'.'+m.name+'@'+m.version+' -> '+output)}
