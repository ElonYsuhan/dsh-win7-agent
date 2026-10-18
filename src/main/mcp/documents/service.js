'use strict'
const fs = require('fs')
const fsp = fs.promises
const path = require('path')
const crypto = require('crypto')
const { existingRealPath, ensureParentInside, relativeDisplay } = require('../../agent/path-guard')
const { LIMIT, readZip, writeZip } = require('./zip')
const engine = require('./ooxml')
function abort(signal) { if (signal && signal.aborted) throw new Error('ABORTED') }
function revision(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex') }
function extension(file, expected) { if (typeof file !== 'string' || !file.trim() || file.includes('\0') || path.extname(file).toLowerCase() !== expected) throw new Error('DOCUMENT_EXTENSION_REQUIRED: '+expected) }
async function load(root, file, ext, signal) {
  extension(file,ext);abort(signal)
  const target=existingRealPath(root,file), handle=await fsp.open(target,'r')
  try { const stat=await handle.stat();if(!stat.isFile()||stat.size>LIMIT)throw new Error('DOCUMENT_SIZE_LIMIT_OR_NOT_FILE');const buffer=await handle.readFile();abort(signal);return {files:readZip(buffer),revision:revision(buffer)} } finally { await handle.close() }
}
async function save(root,file,ext,files,signal) {
  extension(file,ext);abort(signal)
  const target=ensureParentInside(root,file),parent=await fsp.realpath(path.dirname(target))
  // Resolve the existing parent and stage beside it. link() publishes exclusively:
  // unlike rename(), it cannot overwrite a destination created by another call.
  const output=path.join(parent,path.basename(target)),temp=path.join(parent,'.agent-doc-'+crypto.randomBytes(12).toString('hex')+'.tmp'),buffer=writeZip(files)
  try { await fsp.writeFile(temp,buffer,{flag:'wx',mode:0o600});abort(signal);ensureParentInside(root,file);await fsp.link(temp,output);return {path:relativeDisplay(root,output),bytes:buffer.length,revision:revision(buffer),notice:'Saved a new copy. Original file was not modified.'} }
  finally { await fsp.unlink(temp).catch(()=>{}) }
}
async function execute(root,name,args,signal) {
  const ext=name.startsWith('docx_')?'.docx':'.xlsx';abort(signal)
  if(name.endsWith('_read')) {const source=await load(root,args.path,ext,signal);return {...(name==='docx_read'?engine.readWord(source.files,args):engine.readSheet(source.files,args)),revision:source.revision}}
  if(name.endsWith('_create'))return save(root,args.output,ext,name==='docx_create'?engine.createWord(args):engine.createSheet(args),signal)
  const source=await load(root,args.path,ext,signal)
  if(args.revision!==source.revision)throw new Error('DOCUMENT_REVISION_CONFLICT: read the source again before editing')
  return save(root,args.output,ext,name==='docx_edit'?engine.editWord(source.files,args):engine.editSheet(source.files,args),signal)
}
module.exports = { execute, revision }
