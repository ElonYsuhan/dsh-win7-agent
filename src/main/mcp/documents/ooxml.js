'use strict'
const X = require('./xml')
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const P = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const xml = body => '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+body
const esc = X.escape
function get(files, name) { const value=files.get(name); if (!value) throw new Error('OOXML_PART_MISSING: '+name); return value.toString('utf8') }
function root(files, name, local, uri) { const doc=X.parse(get(files,name)); if(doc.local!==local||doc.uri!==uri) throw new Error('UNSUPPORTED_OOXML_NAMESPACE: '+name); return doc }
function checkPackage(files, edit) {
  root(files,'[Content_Types].xml','Types',CT)
  if (edit && Array.from(files.keys()).some(k => /(^_xmlsignatures\/|vbaProject\.bin$)/i.test(k))) throw new Error('SIGNED_OR_MACRO_DOCUMENT_EDIT_UNSUPPORTED')
}
function parts(type, main, extras) {
  const files = new Map()
  files.set('[Content_Types].xml',xml('<Types xmlns="'+CT+'"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/'+main+'" ContentType="application/vnd.openxmlformats-officedocument.'+type+'.main+xml"/>'+(extras||'')+'</Types>'))
  files.set('_rels/.rels',xml('<Relationships xmlns="'+P+'"><Relationship Id="rId1" Type="'+R+'/officeDocument" Target="'+main+'"/></Relationships>'))
  return files
}
function wordText(p) { return X.descendants(p,'t',W).map(X.text).join('') }
function wordParagraphs(files) { return X.descendants(root(files,'word/document.xml','document',W),'p',W) }
function readWord(files,args) {
  checkPackage(files,false)
  const ps=wordParagraphs(files), start=args.start===undefined?0:args.start, limit=args.limit===undefined?200:args.limit
  if(!Number.isInteger(start)||start<0||!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('INVALID_PARAGRAPH_PAGE')
  const paragraphs=ps.slice(start,start+limit).map((p,i)=>({index:start+i,text:wordText(p)}))
  const doc=root(files,'word/document.xml','document',W)
  const tables=X.descendants(doc,'tbl',W).slice(0,30).map(t=>X.children(t,'tr').slice(0,100).map(r=>X.children(r,'tc').map(c=>X.descendants(c,'p',W).map(wordText).join('\n'))))
  return { paragraphs,totalParagraphs:ps.length,nextStart:start+limit<ps.length?start+limit:null,tables,notice:'Text extraction only; headers, footers, drawings and pagination are not rendered. Table preview limited to 30 tables / 100 rows.' }
}
function paragraph(text,heading) { return '<w:p>'+(heading?'<w:pPr><w:outlineLvl w:val="'+(heading-1)+'"/></w:pPr>':'')+'<w:r>'+(heading?'<w:rPr><w:b/><w:sz w:val="'+(36-heading*4)+'"/></w:rPr>':'')+'<w:t xml:space="preserve">'+esc(text)+'</w:t></w:r></w:p>' }
function createWord(args) {
  if(!Array.isArray(args.paragraphs)||args.paragraphs.length>10000||!Array.isArray(args.tables||[])) throw new Error('INVALID_WORD_CONTENT')
  let body=args.paragraphs.map(p=>paragraph(p.text,p.heading)).join('')
  let cells=0
  for(const table of args.tables||[]) {
    if(!table.length) throw new Error('EMPTY_WORD_TABLE')
    body+='<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>'
    body+=table.map(row=>{if(!row.length)throw new Error('EMPTY_WORD_TABLE_ROW');cells+=row.length;if(cells>10000)throw new Error('WORD_TABLE_LIMIT');return '<w:tr>'+row.map(value=>'<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">'+esc(value)+'</w:t></w:r></w:p></w:tc>').join('')+'</w:tr>'}).join('')+'</w:tbl>'
  }
  const files=parts('wordprocessingml.document','word/document.xml')
  files.set('word/document.xml',xml('<w:document xmlns:w="'+W+'"><w:body>'+body+'<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>'))
  return files
}
function editWord(files,args) {
  checkPackage(files,true)
  const source=get(files,'word/document.xml'), ps=wordParagraphs(files), seen=new Set(), changes=[]
  if(!args.changes.length||args.changes.length>1000)throw new Error('WORD_EDIT_LIMIT')
  for(const change of args.changes) {
    const p=ps[change.index]
    if(!Number.isInteger(change.index)||!p||seen.has(change.index))throw new Error('INVALID_OR_DUPLICATE_PARAGRAPH_INDEX')
    seen.add(change.index)
    const unsupported=['fldChar','instrText','drawing','object','hyperlink','ins','del','sdt','bookmarkStart','bookmarkEnd','commentRangeStart','commentRangeEnd','tab','br','pict']
    if(unsupported.some(n=>X.descendants(p,n,W).length)||X.descendants(p,'p',W).length)throw new Error('COMPLEX_PARAGRAPH_EDIT_UNSUPPORTED: '+change.index)
    if(p.children.some(n=>!['pPr','r'].includes(n.local))||X.children(p,'r').some(r=>r.children.some(n=>!['rPr','t'].includes(n.local))))throw new Error('COMPLEX_PARAGRAPH_EDIT_UNSUPPORTED: '+change.index)
    const prop=X.child(p,'pPr'), runs=X.children(p,'r'), style=runs[0]&&X.child(runs[0],'rPr'), prefix=p.name.includes(':')?p.name.split(':')[0]+':':''
    const keep=n=>n?source.slice(n.start,n.end):''
    // Retain paragraph attributes and first run formatting; explicitly reject fields.
    const open=p.selfClosing?source.slice(p.start,p.openEnd).replace(/\/>$/,'>'):source.slice(p.start,p.openEnd)
    changes.push({start:p.start,end:p.end,text:open+keep(prop)+'<'+prefix+'r>'+keep(style)+'<'+prefix+'t xml:space="preserve">'+esc(change.text)+'</'+prefix+'t></'+prefix+'r></'+p.name+'>'})
  }
  files.set('word/document.xml',X.patch(source,changes));return files
}
function address(value) {
  const m=/^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(String(value||'')); if(!m)throw new Error('INVALID_CELL_ADDRESS: '+value)
  let col=0;for(const c of m[1])col=col*26+c.charCodeAt(0)-64
  const row=Number(m[2]);if(col>16384||row>1048576)throw new Error('CELL_OUT_OF_RANGE');return {col,row}
}
function range(value) {
  const parts=String(value||'A1:T100').split(':');if(parts.length>2)throw new Error('INVALID_RANGE')
  const a=address(parts[0]),b=address(parts[1]||parts[0]);if(a.col>b.col||a.row>b.row||(b.col-a.col+1)*(b.row-a.row+1)>10000)throw new Error('RANGE_LIMIT: maximum 10000 cells');return {a,b}
}
function workbook(files) {
  checkPackage(files,false)
  const book=root(files,'xl/workbook.xml','workbook',S), rels=root(files,'xl/_rels/workbook.xml.rels','Relationships',P)
  return X.descendants(book,'sheet',S).map(s=>{
    const id=Object.keys(s.attrs).find(k=>k.endsWith(':id')&&s.ns[k.split(':')[0]]===R), rel=rels.children.find(r=>r.attrs.Id===s.attrs[id])
    if(!rel||rel.attrs.TargetMode==='External'||rel.attrs.Type!==R+'/worksheet')throw new Error('UNSUPPORTED_SHEET_RELATIONSHIP')
    let target=rel.attrs.Target||''
    if(target.includes('\\')||target.includes(':')||target.includes('%'))throw new Error('UNSUPPORTED_SHEET_PATH')
    const path=require('path').posix
    target=target.startsWith('/')?target.slice(1):path.normalize('xl/'+target)
    if(!target.startsWith('xl/')||target.includes('..'))throw new Error('UNSUPPORTED_SHEET_PATH')
    return {name:s.attrs.name,path:target}
  })
}
function readSheet(files,args) {
  const sheets=workbook(files), selected=args.sheet?sheets.find(s=>s.name===args.sheet):sheets[0];if(!selected)throw new Error('SHEET_NOT_FOUND')
  const area=range(args.range), doc=root(files,selected.path,'worksheet',S), shared=files.has('xl/sharedStrings.xml')?X.children(root(files,'xl/sharedStrings.xml','sst',S),'si').map(si=>X.descendants(si,'t',S).map(X.text).join('')):[]
  const cells=[]
  for(const c of X.descendants(doc,'c',S)) {
    const p=address(c.attrs.r);if(p.col<area.a.col||p.col>area.b.col||p.row<area.a.row||p.row>area.b.row)continue
    const raw=X.text(X.child(c,'v')),type=c.attrs.t;let value=raw
    if(type==='s'){if(!/^\d+$/.test(raw)||Number(raw)>=shared.length)throw new Error('INVALID_SHARED_STRING');value=shared[Number(raw)]}
    else if(type==='inlineStr')value=X.descendants(c,'t',S).map(X.text).join('')
    else if(type==='b')value=raw==='1'
    else if((!type||type==='n')&&raw!==''&&Number.isFinite(Number(raw)))value=Number(raw)
    const entry={cell:c.attrs.r,value,styleId:Number(c.attrs.s||0)};if(X.child(c,'f'))entry.formula=X.text(X.child(c,'f'));if(type==='e')entry.error=raw;cells.push(entry)
    if(cells.length>10000)throw new Error('CELL_LIMIT')
  }
  return {sheets:sheets.map(s=>s.name),sheet:selected.name,range:args.range||'A1:T100',cells,notice:'Raw cell values; dates may be serial numbers. Formula cached values may be stale; no formula evaluation.'}
}
const FORMATS=['general','number','percent','date']
function cellXml(c,style,prefix) {
  address(c.cell);const p=prefix||'', s=style===undefined?'':' s="'+style+'"';let content='',type=''
  if(c.formula!==undefined) {if(typeof c.formula!=='string'||!c.formula||c.formula.length>8192)throw new Error('INVALID_FORMULA');content='<'+p+'f>'+esc(c.formula.replace(/^=/,''))+'</'+p+'f>'}
  else if(typeof c.value==='number'){if(!Number.isFinite(c.value))throw new Error('INVALID_CELL_NUMBER');content='<'+p+'v>'+c.value+'</'+p+'v>'}
  else if(typeof c.value==='boolean'){type=' t="b"';content='<'+p+'v>'+(c.value?1:0)+'</'+p+'v>'}
  else if(typeof c.value==='string'){if(c.value.length>32767)throw new Error('CELL_TEXT_LIMIT');type=' t="inlineStr"';content='<'+p+'is><'+p+'t xml:space="preserve">'+esc(c.value)+'</'+p+'t></'+p+'is>'}
  else throw new Error('CELL_VALUE_OR_FORMULA_REQUIRED')
  if(c.formula!==undefined&&c.value!==undefined)throw new Error('CELL_VALUE_AND_FORMULA_CONFLICT')
  return '<'+p+'c r="'+c.cell+'"'+s+type+'>'+content+'</'+p+'c>'
}
function ordered(cells) {const seen=new Set();if(cells.length>10000)throw new Error('CELL_LIMIT');return cells.slice().sort((a,b)=>{const aa=address(a.cell),bb=address(b.cell);return aa.row-bb.row||aa.col-bb.col}).map(c=>{if(seen.has(c.cell))throw new Error('DUPLICATE_CELL');seen.add(c.cell);return c})}
function createSheet(args) {
  if(!args.sheets.length||args.sheets.length>50)throw new Error('SHEET_LIMIT')
  const names=new Set();for(const sheet of args.sheets){if(!sheet.name||sheet.name.length>31||/[\\/?*\[\]:]/.test(sheet.name)||/^'|'$/.test(sheet.name)||names.has(sheet.name.toLowerCase()))throw new Error('INVALID_OR_DUPLICATE_SHEET_NAME');names.add(sheet.name.toLowerCase())}
  const extras=args.sheets.map((s,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
  const files=parts('spreadsheetml.sheet','xl/workbook.xml',extras)
  files.set('xl/workbook.xml',xml('<workbook xmlns="'+S+'" xmlns:r="'+R+'"><sheets>'+args.sheets.map((s,i)=>'<sheet name="'+esc(s.name)+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets><calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>'))
  files.set('xl/_rels/workbook.xml.rels',xml('<Relationships xmlns="'+P+'">'+args.sheets.map((s,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+R+'/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+'<Relationship Id="styles" Type="'+R+'/styles" Target="styles.xml"/></Relationships>'))
  let xfs='';for(let bold=0;bold<2;bold++)for(const id of [0,2,10,14])xfs+='<xf numFmtId="'+id+'" fontId="'+bold+'" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>'
  files.set('xl/styles.xml',xml('<styleSheet xmlns="'+S+'"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="8">'+xfs+'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'))
  args.sheets.forEach((s,i)=>{let row=0,body='';for(const c of ordered(s.cells)){const n=address(c.cell).row;if(n!==row){if(row)body+='</row>';body+='<row r="'+n+'">';row=n}body+=cellXml(c,(c.bold?4:0)+Math.max(0,FORMATS.indexOf(c.numberFormat||'general')))}if(row)body+='</row>';files.set('xl/worksheets/sheet'+(i+1)+'.xml',xml('<worksheet xmlns="'+S+'"><sheetData>'+body+'</sheetData></worksheet>'))})
  return files
}
function editSheet(files,args) {
  checkPackage(files,true)
  const selected=workbook(files).find(s=>s.name===args.sheet);if(!selected)throw new Error('SHEET_NOT_FOUND')
  const source=get(files,selected.path),doc=root(files,selected.path,'worksheet',S),data=X.child(doc,'sheetData');if(!data)throw new Error('SHEET_DATA_MISSING')
  if(X.descendants(doc,'f',S).some(f=>f.attrs.t==='array'||f.attrs.t==='shared')||files.has('xl/calcChain.xml'))throw new Error('SHARED_ARRAY_FORMULA_OR_CALC_CHAIN_EDIT_UNSUPPORTED')
  const merges=X.descendants(doc,'mergeCell',S).map(m=>range(m.attrs.ref))
  if(data.children.some(n=>n.local!=='row'||n.uri!==S))throw new Error('COMPLEX_SHEET_DATA_EDIT_UNSUPPORTED')
  const changes=ordered(args.cells);if(!changes.length)throw new Error('EMPTY_CELL_EDITS')
  const rows=new Map(),prefix=data.name.includes(':')?data.name.split(':')[0]+':':''
  for(const r of X.children(data,'row')){const n=Number(r.attrs.r);if(!Number.isInteger(n)||n<1||rows.has(n))throw new Error('INVALID_SHEET_ROWS');rows.set(n,{node:r,cells:new Map(X.children(r,'c').map(c=>[c.attrs.r,source.slice(c.start,c.end)]))})}
  for(const c of changes){const at=address(c.cell);if(merges.some(m=>at.col>=m.a.col&&at.col<=m.b.col&&at.row>=m.a.row&&at.row<=m.b.row))throw new Error('MERGED_CELL_EDIT_UNSUPPORTED')
    if(c.bold!==undefined||c.numberFormat!==undefined)throw new Error('EXISTING_WORKBOOK_FORMAT_EDIT_UNSUPPORTED')
    if(!rows.has(at.row))rows.set(at.row,{node:null,cells:new Map()})
    const r=rows.get(at.row),old=r.node&&X.children(r.node,'c').find(n=>n.attrs.r===c.cell)
    if(old&&(Object.keys(old.attrs).some(k=>!['r','s','t'].includes(k))||old.children.some(n=>!['f','v','is'].includes(n.local))))throw new Error('COMPLEX_CELL_EDIT_UNSUPPORTED')
    r.cells.set(c.cell,cellXml(c,old?old.attrs.s:undefined,prefix));r.changed=true
  }
  let body=''
  for(const [n,r] of Array.from(rows).sort((a,b)=>a[0]-b[0])) {
    if(!r.changed){body+=source.slice(r.node.start,r.node.end);continue}
    if(r.node&&r.node.children.some(c=>c.local!=='c'))throw new Error('COMPLEX_ROW_EDIT_UNSUPPORTED')
    const open=r.node?source.slice(r.node.start,r.node.openEnd).replace(/\/>$/,'>'):'<'+prefix+'row r="'+n+'">'
    body+=open+Array.from(r.cells).sort((a,b)=>address(a[0]).col-address(b[0]).col).map(c=>c[1]).join('')+'</'+prefix+'row>'
  }
  const open=source.slice(data.start,data.openEnd).replace(/\/>$/,'>'), patches=[{start:data.start,end:data.end,text:open+body+'</'+data.name+'>'}]
  const dim=X.child(doc,'dimension');if(dim)patches.push({start:dim.start,end:dim.end,text:''}) // let the spreadsheet app infer the new used range
  files.set(selected.path,X.patch(source,patches))
  const bookSource=get(files,'xl/workbook.xml'),book=root(files,'xl/workbook.xml','workbook',S),calc=X.child(book,'calcPr'),p=book.name.includes(':')?book.name.split(':')[0]+':':''
  const recalc='<'+p+'calcPr calcId="0" fullCalcOnLoad="1" forceFullCalc="1"/>'
  files.set('xl/workbook.xml',X.patch(bookSource,[calc?{start:calc.start,end:calc.end,text:recalc}:{start:book.closeStart,end:book.closeStart,text:recalc}]))
  return files
}
module.exports = { readWord, createWord, editWord, readSheet, createSheet, editSheet }
