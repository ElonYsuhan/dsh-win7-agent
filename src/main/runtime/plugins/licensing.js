'use strict'
const path=require('path'),{Licensing}=require('../../licensing/service'),{deviceIdentity}=require('../../licensing/device')
module.exports={name:'core/licensing',inject:['agentConfig'],async apply(ctx){
 const options=ctx.agentConfig,policy=options.licensing&&options.licensing.policy||require('../../licensing/policy.js')
 if(!policy||policy.version!==1||typeof policy.enforced!=='boolean'||!policy.publicKeys||typeof policy.publicKeys!=='object')throw Error('LICENSE_POLICY_INVALID')
 if(!policy.enforced){ctx.provide('licensing',new Licensing({home:'',policy,device:null}));return}
 try{const device=options.licensing&&options.licensing.device||await deviceIdentity(),settings=options.settings,home=settings&&settings.file&&path.dirname(settings.file);if(!home)throw Error('LICENSE_HOME_UNAVAILABLE');ctx.provide('licensing',new Licensing({home,policy,device,...(options.licensing&&options.licensing.clock?{clock:options.licensing.clock,monotonic:options.licensing.monotonic}:{} )}))}catch(error){ctx.provide('licensing',{status:()=>({status:'device_error',allowed:false,trialAvailable:false,error:'无法读取本机设备标识：'+error.message,device:null,serverNow:Date.now()}),assert(){const error=Error('LICENSE_REQUIRED: 设备身份不可用');error.code='LICENSE_REQUIRED';throw error},request(){throw Error('设备身份不可用')},startTrial(){throw Error('设备身份不可用')},activate(){throw Error('设备身份不可用')}})}
}}
