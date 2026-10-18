'use strict'
const fs=require('fs'),path=require('path'),{spawn}=require('child_process')
const schema=`
PRAGMA application_id=1262634801;
CREATE TABLE IF NOT EXISTS bases(id TEXT PRIMARY KEY,name TEXT NOT NULL,scope TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS disabled_bases(id TEXT PRIMARY KEY REFERENCES bases(id));
CREATE TABLE IF NOT EXISTS documents(id TEXT PRIMARY KEY,base_id TEXT NOT NULL REFERENCES bases(id),name TEXT NOT NULL,active TEXT,revision INTEGER NOT NULL DEFAULT 1,deleted INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),hash TEXT NOT NULL,format TEXT NOT NULL,created INTEGER NOT NULL,parser TEXT NOT NULL DEFAULT '1');
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,doc_id TEXT NOT NULL REFERENCES documents(id),version_id TEXT NOT NULL REFERENCES versions(id),phase TEXT NOT NULL,sequence INTEGER NOT NULL DEFAULT 0,error TEXT NOT NULL DEFAULT '',created INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events(job_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job_id,sequence));
CREATE TABLE IF NOT EXISTS chunks(id TEXT PRIMARY KEY,version_id TEXT NOT NULL REFERENCES versions(id),ordinal INTEGER NOT NULL,text TEXT NOT NULL,locator TEXT NOT NULL,UNIQUE(version_id,ordinal));
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(tokens,chunk_id UNINDEXED,tokenize='unicode61');
CREATE TABLE IF NOT EXISTS base_scopes(base_id TEXT NOT NULL REFERENCES bases(id),scope TEXT NOT NULL,PRIMARY KEY(base_id,scope));
INSERT OR IGNORE INTO base_scopes SELECT id,scope FROM bases WHERE scope<>'' AND id NOT IN (SELECT id FROM disabled_bases);
UPDATE bases SET scope='';
CREATE TABLE IF NOT EXISTS knowledge_sessions(id TEXT PRIMARY KEY,base_id TEXT REFERENCES bases(id),title TEXT NOT NULL DEFAULT '',deleted INTEGER NOT NULL DEFAULT 0);
PRAGMA user_version=3;
`
function sql(value){if(value===null||value===undefined)return 'NULL';return "CAST(X'"+Buffer.from(String(value),'utf8').toString('hex')+"' AS TEXT)"}
class Repository{
 constructor(home){this.dir=path.join(home,'knowledge');this.file=path.join(this.dir,'knowledge.db');this.chain=Promise.resolve();this.pending=new Set();this.closed=false;this.opened=false}
 async open(){if(this.opened)return;fs.mkdirSync(this.dir,{recursive:true});this.lock=path.join(this.dir,'owner.json');
  try{this.fd=fs.openSync(this.lock,'wx')}catch(error){if(error.code!=='EEXIST')throw error;let owner;try{owner=JSON.parse(fs.readFileSync(this.lock,'utf8'));process.kill(owner.pid,0)}catch(e){if(e.code==='ESRCH'){fs.unlinkSync(this.lock);return this.open()}throw Error('KNOWLEDGE_OWNER_LOCKED')}throw Error('KNOWLEDGE_OWNER_LOCKED')}
  fs.writeFileSync(this.fd,JSON.stringify({pid:process.pid}));this.opened=true
  try{const engine=await this.raw('SELECT sqlite_version() AS version;');if(engine[0].version!=='3.54.0')throw Error('KNOWLEDGE_SQLITE_VERSION_MISMATCH');const identity=await this.raw('PRAGMA application_id;');if(!['0','1262634801'].includes(identity[0].application_id))throw Error('KNOWLEDGE_DATABASE_IDENTITY');const version=await this.raw('PRAGMA user_version;');if(Number(version[0].user_version)>3)throw Error('KNOWLEDGE_DATABASE_NEWER');if([1,2].includes(Number(version[0].user_version))){const backup=this.file+'.schema'+Number(version[0].user_version)+'.bak';try{fs.copyFileSync(this.file,backup,fs.constants.COPYFILE_EXCL);const fd=fs.openSync(backup,'r');try{fs.fsyncSync(fd)}finally{fs.closeSync(fd)}}catch(error){if(error.code!=='EEXIST')throw error}}await this.raw('BEGIN IMMEDIATE;'+schema+'COMMIT;');const integrity=await this.raw('PRAGMA quick_check;');if(integrity[0].quick_check!=='ok')throw Error('KNOWLEDGE_DATABASE_CORRUPT')}
  catch(e){await this.close();throw e}
 }
 raw(query){if(this.closed)return Promise.reject(Error('KNOWLEDGE_CLOSED'));const binary=path.join(__dirname,'vendor','sqlite',process.platform+'-'+process.arch+(process.platform==='win32'?'.exe':'')).replace('app.asar'+path.sep,'app.asar.unpacked'+path.sep);if(!fs.existsSync(binary))return Promise.reject(Error('KNOWLEDGE_PLATFORM_NOT_BUILT'));
  return new Promise((resolve,reject)=>{let child,output=[],bytes=0,done=false;const finish=(error,rows)=>{if(done)return;done=true;clearTimeout(timer);this.pending.delete(child);if(error)reject(error);else resolve(rows)};const timer=setTimeout(()=>{if(child)child.kill();finish(Error('KNOWLEDGE_DB_TIMEOUT'))},15000)
   try{child=spawn(binary,[this.file],{windowsHide:true,stdio:['pipe','pipe','pipe'],shell:false});this.pending.add(child);child.on('error',finish);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>16*1024*1024){child.kill();finish(Error('KNOWLEDGE_DB_OUTPUT_LIMIT'));return}output.push(chunk)});child.on('close',code=>{try{const value=JSON.parse(Buffer.concat(output).toString('utf8'));if(code!==0||value.error)throw Error('KNOWLEDGE_DB: '+(value.error||code));finish(null,value.rows)}catch(e){finish(e)}});child.stdin.end(query)}catch(e){finish(e)}
  })
 }
 query(query){const work=this.chain.then(()=>this.raw(query));this.chain=work.catch(()=>{});return work}
 async close(){this.closed=true;await this.chain;for(const child of this.pending)child.kill();if(this.fd!==undefined){fs.closeSync(this.fd);this.fd=undefined;fs.unlinkSync(this.lock)}this.opened=false}
}
module.exports={Repository,sql}
