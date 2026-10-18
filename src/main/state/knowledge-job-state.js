'use strict'
const { VERSION, PHASES }=require('../contracts/knowledge')
const allowed={queued:['parsing','failed','cancelled','interrupted'],parsing:['indexing','failed','cancelled','interrupted'],indexing:['ready','failed','cancelled','interrupted']}
function reduce(current,event){if(event.version!==VERSION||event.sequence!==current.sequence+1||!PHASES.includes(event.phase)||!(allowed[current.phase]||[]).includes(event.phase))throw Error('KNOWLEDGE_TRANSITION_INVALID');return {...current,phase:event.phase,sequence:event.sequence,error:event.error||''}}
module.exports={reduce}
