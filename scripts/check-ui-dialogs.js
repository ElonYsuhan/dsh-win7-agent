'use strict'
const fs=require('fs'),path=require('path'),root=path.join(__dirname,'../src/renderer')
const errors=[]
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(entry.name==='vendor')continue;const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(entry.name.endsWith('.js')&&/\bwindow\.(?:confirm|prompt|alert)\s*\(/.test(fs.readFileSync(file,'utf8')))errors.push(path.relative(root,file))}}
walk(root);if(errors.length)throw Error('Use window.appDialogs instead of native browser dialogs: '+errors.join(', '));console.log('UI dialog standard: no native browser confirm/prompt/alert in application renderer code')
