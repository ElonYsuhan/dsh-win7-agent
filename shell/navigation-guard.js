'use strict'
// Application windows are not browsers: startup pages must never be reachable
// through mouse/browser history. Explicit loadURL/loadFile/reload still work.
function attachNavigationGuard(win) {
 const contents=win.webContents
 const command=(event,name)=>{if(name==='browser-backward'||name==='browser-forward')event.preventDefault()}
 const input=(event,value)=>{if(['BrowserBack','BrowserForward','GoBack','GoForward'].includes(value.key))event.preventDefault()}
 const loaded=()=>{if(!contents.isDestroyed())contents.clearHistory()}
 win.on('app-command',command);contents.on('before-input-event',input);contents.on('did-finish-load',loaded)
 win.once('closed',()=>{win.removeListener('app-command',command);contents.removeListener('before-input-event',input);contents.removeListener('did-finish-load',loaded)})
}
module.exports={attachNavigationGuard}
