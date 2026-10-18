'use strict'
const { LIMITS }=require('../contracts/knowledge')
function terms(value){const text=String(value||'').normalize('NFKC').toLowerCase();const out=text.match(/[a-z0-9_]+|[\u3400-\u9fff]/g)||[];const han=text.match(/[\u3400-\u9fff]+/g)||[];for(const part of han)for(let i=0;i<part.length-1;i++)out.push(part.slice(i,i+2));return Array.from(new Set(out)).slice(0,6000)}
function chunks(parts){const out=[];for(const part of parts){const text=String(part.text||'');for(let offset=0;offset<text.length;offset+=1000){out.push({text:text.slice(offset,offset+1200),locator:{...part.locator,offset}});if(out.length>LIMITS.chunks)throw Error('KNOWLEDGE_CHUNK_LIMIT')}}return out}
function query(value){const text=String(value||'').trim();if(!text||text.length>LIMITS.queryChars)throw Error('KNOWLEDGE_QUERY_INVALID');return {text,tokens:terms(text).slice(0,100)}}
module.exports={terms,chunks,query}
