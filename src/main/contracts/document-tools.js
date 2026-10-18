'use strict'

// Shared by the standard MCP server and its Cordis host adapter. No IO here.
const str = (description) => ({ type: 'string', description })
const path = str('Workspace-relative path. Only .docx or .xlsx as appropriate.')
const output = str('New workspace-relative output path. Must not exist; source is never overwritten.')
const paragraph = { type: 'object', properties: { text: str('Paragraph text'), heading: { type: 'integer', enum: [0, 1, 2, 3] } }, required: ['text'], additionalProperties: false }
const cell = { type: 'object', properties: { cell: str('A1 address, e.g. B3'), value: { type: ['string', 'number', 'boolean'] }, formula: str('Excel formula without leading =; stored, not evaluated'), bold: { type: 'boolean' }, numberFormat: { type: 'string', enum: ['general', 'number', 'percent', 'date'] } }, required: ['cell'], additionalProperties: false }
function tool(name, title, description, permission, properties, required) {
  return { name, title, description, permission, inputSchema: { type: 'object', properties, required, additionalProperties: false }, annotations: { title, readOnlyHint: permission === 'read', destructiveHint: false, idempotentHint: permission === 'read', openWorldHint: false } }
}
const TOOLS = [
  tool('docx_read', '读取 Word / Read Word', 'Read Word paragraphs and table cells with stable paragraph indexes and a source revision. Basic OOXML .docx only; no rendering.', 'read', { path, start: { type: 'integer' }, limit: { type: 'integer' } }, ['path']),
  tool('docx_create', '新建 Word / Create Word', 'Create a basic Word document with paragraphs, headings and tables. Never overwrites existing files.', 'write', { output, paragraphs: { type: 'array', items: paragraph }, tables: { type: 'array', items: { type: 'array', items: { type: 'array', items: str('Cell text') } } } }, ['output', 'paragraphs']),
  tool('docx_edit', '编辑 Word / Edit Word', 'Replace paragraph text (including table-cell paragraphs) by indexes returned by docx_read. Saves a new copy. Replacing text keeps first run formatting; complex fields/revisions are rejected. Other ZIP parts retained.', 'write', { path, output, revision: str('SHA-256 returned by docx_read; required to prevent stale edits'), changes: { type: 'array', items: { type: 'object', properties: { index: { type: 'integer' }, text: str('Full replacement paragraph text') }, required: ['index', 'text'], additionalProperties: false } } }, ['path', 'output', 'revision', 'changes']),
  tool('xlsx_read', '读取 Excel / Read Excel', 'List workbook sheets and read a bounded cell range. Returns raw values, formulas, style IDs and a source revision. Formulas are not evaluated.', 'read', { path, sheet: str('Sheet name; default first sheet'), range: str('Bounded A1 range, e.g. A1:H100; default A1:T100') }, ['path']),
  tool('xlsx_create', '新建 Excel / Create Excel', 'Create a basic Excel workbook with named sheets, typed cells, formulas and basic formatting. Strings beginning = are literal unless formula is explicitly set. No formula calculation.', 'write', { output, sheets: { type: 'array', items: { type: 'object', properties: { name: str('Sheet name'), cells: { type: 'array', items: cell } }, required: ['name', 'cells'], additionalProperties: false } } }, ['output', 'sheets']),
  tool('xlsx_edit', '编辑 Excel / Edit Excel', 'Edit cells on one sheet and save a new copy, retaining other ZIP parts and existing cell style IDs. Does not recalculate formulas; rejects edits intersecting merged cells/array formulas. Basic formatting is supported on newly created workbooks only.', 'write', { path, output, revision: str('SHA-256 returned by xlsx_read'), sheet: str('Sheet name'), cells: { type: 'array', items: cell } }, ['path', 'output', 'revision', 'sheet', 'cells'])
]
module.exports = { TOOLS, SERVER_ID: 'documents', SERVER_NAME: '文档工具 / Document Tools', VERSION: '1.0.0', PROTOCOLS: ['2025-06-18', '2024-11-05'] }
