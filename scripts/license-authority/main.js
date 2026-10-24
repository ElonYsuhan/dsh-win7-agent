'use strict'
const {app,BrowserWindow,ipcMain,dialog}=require('electron'),path=require('path'),fs=require('fs')
const issuer=require('./service/index')
const override=process.argv.find(x=>x.startsWith('--authority-dir=')),directory=override?path.resolve(override.slice(16)):issuer.defaultDirectory()
app.setName('Agent 授权签发工具')
let window
app.whenReady().then(()=>{
 ipcMain.handle('authority:status',()=>issuer.status(directory))
 ipcMain.handle('authority:init',()=>issuer.init(directory))
 ipcMain.handle('authority:issue',async(_event,data)=>{
  if(!data||typeof data.requestText!=='string'||typeof data.customer!=='string')throw Error('请填写设备申请、客户与有效期')
  const issued=issuer.issue({directory,requestText:data.requestText,customer:data.customer.trim(),days:Number(data.days)})
  const result=await dialog.showSaveDialog(window,{title:'保存设备授权文件',defaultPath:'Agent-'+issued.claims.deviceDigest.slice(0,12)+'.agentlic',filters:[{name:'Agent 授权文件',extensions:['agentlic']}]})
  if(result.canceled||!result.filePath)return{canceled:true}
  fs.writeFileSync(result.filePath,issued.text,{mode:0o600});issuer.record(directory,issued.claims,result.filePath)
  return{file:result.filePath,expiresAt:issued.claims.expiresAt}
 })
 window=new BrowserWindow({width:760,height:790,minWidth:620,minHeight:640,title:'Agent 授权签发工具',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}})
 window.webContents.setWindowOpenHandler(()=>({action:'deny'}));window.webContents.on('will-navigate',event=>event.preventDefault())
 window.loadFile(path.join(__dirname,'src/renderer/index.html'))
})
app.on('window-all-closed',()=>app.quit())
