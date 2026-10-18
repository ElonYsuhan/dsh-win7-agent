'use strict'
const path=require('path'),{Knowledge}=require('../../knowledge/service')
module.exports={name:'core/knowledge',inject:['agentConfig'],apply(ctx){
 const settings=ctx.agentConfig.settings,home=settings&&settings.file?path.dirname(settings.file):''
 let emit=()=>{}
 const service=new Knowledge(home,event=>emit(event))
 service.attach=callback=>{emit=typeof callback==='function'?callback:()=>{}}
 ctx.provide('knowledge',service)
 ctx.effect(()=>()=>service.close())
}}
