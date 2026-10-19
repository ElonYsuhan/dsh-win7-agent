'use strict'
const {parentPort,workerData}=require('worker_threads'),fs=require('fs'),path=require('path'),{inspect}=require('./archive')
try{const value=inspect(Buffer.from(workerData.data),workerData.target);fs.mkdirSync(workerData.stage,{recursive:true});for(const [name,data] of value.files){const file=path.join(workerData.stage,...name.split('/'));fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,data,{flag:'wx'})}parentPort.postMessage({manifest:value.manifest,digest:value.digest,bytes:value.bytes})}catch(e){parentPort.postMessage({error:e.message})}
