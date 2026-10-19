'use strict'
// Native Cordis extension; tracked effects release tools when disabled.
module.exports={name:'example.echo',cordis:true,inject:['tools'],apply(ctx){
 ctx.effect(()=>ctx.tools.register({name:'example_echo',plugin:'example.echo',permission:'read',description:'返回输入的文本，用于验证离线插件。',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async args=>String(args.text)}))
}}
