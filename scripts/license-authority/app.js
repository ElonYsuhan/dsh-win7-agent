'use strict'
const byId=id=>document.getElementById(id)
let busy=false,configured=false
function message(text){byId('message').textContent=text}
async function status(){const state=await window.authority.status();configured=state.configured;byId('identity').textContent=state.configured?'签发方：'+state.keyId:'尚未创建签发密钥';byId('directory').textContent='密钥目录：'+state.directory;byId('init').hidden=state.configured;byId('issue').disabled=!configured||busy}
byId('init').addEventListener('click',async()=>{try{await window.authority.init();await status();message('签发身份已创建。发布客户端时必须打包此公钥。')}catch(e){message(e.message)}})
async function read(file){if(!file)return;try{if(file.size>65536)throw Error('设备申请文件最大64KB');byId('request').value=await file.text();preview()}catch(e){message(e.message)}}
function preview(){try{const value=JSON.parse(byId('request').value);byId('device').textContent='设备码：'+value.deviceDigest+' · '+value.platform+' / '+value.arch}catch(_){byId('device').textContent=''}}
byId('request').addEventListener('input',preview);byId('file').addEventListener('change',()=>read(byId('file').files[0]))
byId('drop').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();byId('file').click()}})
for(const type of ['dragenter','dragover'])byId('drop').addEventListener(type,e=>{e.preventDefault();byId('drop').classList.add('dragging')})
byId('drop').addEventListener('dragleave',()=>byId('drop').classList.remove('dragging'))
byId('drop').addEventListener('drop',e=>{e.preventDefault();byId('drop').classList.remove('dragging');if(e.dataTransfer.files.length!==1){message('请一次导入一个设备申请文件');return}read(e.dataTransfer.files[0])})
byId('form').addEventListener('submit',async e=>{e.preventDefault();if(busy||!configured)return;busy=true;byId('issue').disabled=true;message('正在生成授权…');try{const result=await window.authority.issue({requestText:byId('request').value,customer:byId('customer').value,days:Number(byId('days').value)});message(result.canceled?'已取消保存':'已保存：'+result.file+'；有效期至 '+new Date(result.expiresAt).toLocaleString('zh-CN'))}catch(error){message(error.message)}finally{busy=false;byId('issue').disabled=!configured}})
status().catch(e=>message(e.message))
