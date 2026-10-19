'use strict'
async function handleExtensionApi(request,response,url,{extensions,json,readBodyLimit}){
 if(!url.pathname.startsWith('/api/extensions'))return false
 try{const action=url.pathname.slice('/api/extensions'.length).replace(/^\//,'');if(!action&&request.method==='GET')json(response,200,extensions.list());else if(request.method==='POST'&&['inspect','discard','install','enable','remove'].includes(action)){const data=await readBodyLimit(request,12*1024*1024);json(response,200,await extensions[action](data||{}))}else json(response,404,{error:'EXTENSION_ROUTE_NOT_FOUND'})}catch(e){json(response,400,{error:e.message})}return true
}
module.exports={handleExtensionApi}
