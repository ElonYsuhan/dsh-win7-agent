'use strict'
// Pure policy: callers supply verified claims, persistent facts and observed time.
const {TRIAL_MS}=require('../contracts/licensing')
function evaluate({enforced,deviceDigest,license,trial,now,clockFault,storageFault}) {
 if(!enforced)return{status:'development',allowed:true,expiresAt:null,trialAvailable:false}
 if(storageFault||clockFault)return{status:storageFault?'storage_error':'clock_error',allowed:false,expiresAt:null,trialAvailable:false}
 const valid=license&&license.deviceDigest===deviceDigest&&now>=license.notBefore&&(license.expiresAt===null||now<license.expiresAt)
 if(valid)return{status:'licensed',allowed:true,expiresAt:license.expiresAt,trialAvailable:false,customer:license.customer,licenseId:license.licenseId,features:license.features}
 if(trial&&trial.deviceDigest===deviceDigest&&!trial.expired&&now<trial.startedAt+TRIAL_MS)return{status:'trial',allowed:true,expiresAt:trial.startedAt+TRIAL_MS,trialAvailable:false,features:['all']}
 return{status:license?'expired':trial?'trial_expired':'unlicensed',allowed:false,expiresAt:license&&license.expiresAt||trial&&trial.startedAt+TRIAL_MS||null,trialAvailable:!trial}
}
module.exports={evaluate}
