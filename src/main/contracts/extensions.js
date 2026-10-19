'use strict'
// Portable offline extension contract. No runtime or filesystem dependencies.
const FORMAT_VERSION = 1
const MAX_ARCHIVE = 8 * 1024 * 1024
const MAX_EXPANDED = 32 * 1024 * 1024
const TYPES = ['skill', 'mcp', 'plugin']
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
function fail(message) { throw Error('扩展包：' + message) }
function relativeFile(value) {
  if (typeof value !== 'string' || value.length > 240 || !value || value.includes('\\') || /[\x00-\x1f<>:"|?*]/.test(value)) fail('文件路径无效')
  if (value.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('文件路径不兼容 Windows')
  return value
}
function version(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(value)) fail('版本必须为 x.y.z')
  return value
}
function compareVersions(a, b) { const x=version(a).split('.').map(Number), y=version(b).split('.').map(Number);for(let i=0;i<3;i++)if(x[i]!==y[i])return x[i]>y[i]?1:-1;return 0 }
function manifest(raw, target) {
  if (!object(raw) || raw.formatVersion !== FORMAT_VERSION || !TYPES.includes(raw.type)) fail('不支持的清单版本或类型')
  for (const key of ['publisher','name']) if (typeof raw[key] !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(raw[key])) fail(key + ' 必须为小写标识')
  for (const key of ['displayName','description']) if (typeof raw[key] !== 'string' || !raw[key].trim() || raw[key].length > (key === 'displayName' ? 100 : 1000)) fail('缺少或过长的 ' + key)
  if (!object(raw.engines) || raw.engines.extensionApi !== 1 || raw.engines.node !== '16' || raw.engines.electron !== '22' || raw.engines.chromium !== '108') fail('必须声明 extensionApi 1 / Node 16 / Electron 22 / Chromium 108')
  if (!Array.isArray(raw.targets) || !raw.targets.length || raw.targets.some(t => !['any','win32-x64','darwin-arm64','darwin-x64','linux-x64','linux-arm64'].includes(t))) fail('目标平台声明无效')
  if (target && !raw.targets.includes('any') && !raw.targets.includes(target)) fail('不支持当前平台 ' + target)
  if (!object(raw.files) || !Object.keys(raw.files).length || Object.keys(raw.files).length > 2047) fail('缺少文件 SHA256 清单')
  for (const [file, digest] of Object.entries(raw.files)) { relativeFile(file);if(file==='manifest.json'||!/^[a-f0-9]{64}$/.test(digest))fail('文件 SHA256 无效') }
  const out={formatVersion:1,id:raw.publisher+'.'+raw.name,publisher:raw.publisher,name:raw.name,displayName:raw.displayName.trim(),description:raw.description.trim(),version:version(raw.version),type:raw.type,engines:{...raw.engines},targets:[...raw.targets],files:{...raw.files}}
  if(raw.type==='skill'){out.entry=relativeFile(raw.entry);if(!out.entry.endsWith('SKILL.md'))fail('技能入口必须为 SKILL.md')}
  if(raw.type==='plugin'){out.entry=relativeFile(raw.entry);if(!/\.(js|cjs)$/.test(out.entry))fail('插件入口必须为 CommonJS 文件')}
  if(raw.type==='mcp'){
    if(!object(raw.mcp)||!['http','stdio'].includes(raw.mcp.transport))fail('MCP 传输方式无效')
    const permission=raw.mcp.permission;if(!['read','write','edit','command'].includes(permission))fail('MCP 必须声明工具权限')
    out.mcp={transport:raw.mcp.transport,permission}
    if(raw.mcp.transport==='stdio'){out.entry=relativeFile(raw.entry);if(!/\.(js|cjs)$/.test(out.entry))fail('本地 MCP 必须使用随包 Node 的 CommonJS 入口');if(raw.mcp.args!==undefined&&(!Array.isArray(raw.mcp.args)||raw.mcp.args.length>32||raw.mcp.args.some(a=>typeof a!=='string'||a.length>2048)))fail('MCP 参数无效');out.mcp.args=raw.mcp.args||[]}
    else{let url;try{url=new URL(raw.mcp.url)}catch(_){fail('MCP URL 无效')}if(!['http:','https:'].includes(url.protocol)||url.username||url.password)fail('MCP URL 无效');out.mcp.url=url.href;if(raw.mcp.bearerTokenEnv){if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.mcp.bearerTokenEnv))fail('令牌环境变量名称无效');out.mcp.bearerTokenEnv=raw.mcp.bearerTokenEnv}}
  }
  if(out.entry&&!Object.prototype.hasOwnProperty.call(out.files,out.entry))fail('入口不在文件清单中')
  return out
}
module.exports={FORMAT_VERSION,MAX_ARCHIVE,MAX_EXPANDED,TYPES,manifest,relativeFile,compareVersions}
