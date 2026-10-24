'use strict'
const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('authority',{status:()=>ipcRenderer.invoke('authority:status'),init:()=>ipcRenderer.invoke('authority:init'),issue:data=>ipcRenderer.invoke('authority:issue',data)})
