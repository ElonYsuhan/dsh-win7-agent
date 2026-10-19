'use strict'
function integer(v,d,min,max){const n=v===undefined?d:Number(v);if(!Number.isInteger(n)||n<min||n>max)throw Error('Agent 限额超出范围 '+min+'～'+max);return n}
function strings(v,max){if(!Array.isArray(v)||v.length>max||v.some(x=>typeof x!=='string'||!x||x.length>200)||new Set(v).size!==v.length)throw Error('能力列表无效');return v.slice()}
function configuration(raw={}){const permission=raw.permission||'readonly';if(!['readonly','workspace'].includes(permission))throw Error('Agent 权限无效');const tools=strings(raw.tools||[],32);if(tools.some(t=>!/^[-A-Za-z0-9_]{1,80}$/.test(t)))throw Error('工具名称无效');return{permission,tools,maxSteps:integer(raw.maxSteps,6,1,20),maxRequests:integer(raw.maxRequests,6,1,20),maxToolCalls:integer(raw.maxToolCalls,8,1,32),timeoutMs:integer(raw.timeoutMs,120000,1000,600000),tokenBudget:integer(raw.tokenBudget,150000,4096,500000),outputBytes:integer(raw.outputBytes,131072,4096,262144)}}
module.exports={configuration,strings}
