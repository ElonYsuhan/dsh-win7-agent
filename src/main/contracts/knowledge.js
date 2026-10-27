'use strict'
const VERSION = 1
const LIMITS = Object.freeze({ fileBytes: 8 * 1024 * 1024, textChars: 1000000, chunks: 2000, documents: 500, bases: 32, queue: 16, queryChars: 200, results: 20 })
const PHASES = Object.freeze(['queued','parsing','indexing','ready','failed','cancelled','interrupted'])
function id(value) { if (!/^[a-f0-9]{32}$/.test(String(value || ''))) throw Error('KNOWLEDGE_ID_INVALID'); return value }
function name(value) { const text=String(value || '').trim(); if (!text || text.length>160 || /[\x00-\x1f]/.test(text)) throw Error('KNOWLEDGE_NAME_INVALID'); return text }
function scope(value) { const text=String(value || '').trim(); if(text.length>2048||text.includes('\0'))throw Error('KNOWLEDGE_SCOPE_INVALID'); return text }
function sessionId(value) { if(typeof value!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(value))throw Error('KNOWLEDGE_SESSION_INVALID');return value }
function filename(value) { const text=String(value||'');if(!text.trim()||text.length>255||/[\x00-\x1f\\/]/.test(text))throw Error('KNOWLEDGE_NAME_INVALID');return text }
function format(value) { const match=/\.([a-z0-9]{1,16})$/i.exec(String(value||''));return match?match[1].toLowerCase():'file' }
module.exports={VERSION,LIMITS,PHASES,id,name,scope,format,sessionId,filename}
