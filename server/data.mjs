import {dataWorkId,previousDataWork,queueDataWork} from './data-work.mjs';
export const DATA_LIMITS = { fileBytes: 10 * 1024 * 1024, inlineFileBytes: 1024 * 1024, rowBytes: 32000, pageSize: 100 };
const DATA_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const DATA_COLUMN = /^[a-z][a-z0-9_]{0,39}$/;
const DATA_TYPES = ['text', 'number', 'boolean', 'date', 'json', 'file'];
const dataText = (value, limit = 400) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
function dataUrl(value, fail) {
  if (!value) return '';
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.length > 2000) throw new Error(); return url.href; }
  catch { fail(400, 'invalid_source_url', 'Kilden skal være en offentlig http- eller https-adresse.'); }
}
export function dataColumns(input, fail) {
  if (!Array.isArray(input) || !input.length || input.length > 30) fail(400, 'invalid_columns', 'En tabel skal have 1–30 kolonner.');
  const names = new Set();
  return input.map((c) => {
    if (!c || !DATA_COLUMN.test(c.name) || ['constructor', 'prototype'].includes(c.name) || names.has(c.name) || !DATA_TYPES.includes(c.type))
      fail(400, 'invalid_columns', 'Kolonner skal have unikke feltnavne (a-z, 0-9, _) og en gyldig datatype.');
    names.add(c.name);
    return { name: c.name, label: dataText(c.label, 80) || c.name, type: c.type, required: !!c.required, indexed: !!c.indexed, unit: dataText(c.unit, 20), description: dataText(c.description, 300) };
  });
}
function dataValue(value, column, fail) {
  if (value === null || value === undefined) { if (column.required) fail(400, 'required_value', `${column.label} skal udfyldes.`); return null; }
  let valid = false;
  if (column.type === 'text') valid = typeof value === 'string' && value.length <= 4000;
  if (column.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  if (column.type === 'boolean') valid = typeof value === 'boolean';
  if (column.type === 'file') valid = typeof value === 'string' && DATA_UUID.test(value);
  if (column.type === 'date') valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (column.type === 'json') valid = JSON.stringify(value).length <= 8000;
  if (!valid || (column.required && value === '')) fail(400, 'invalid_value', `${column.label} skal være af typen ${column.type}.`);
  return value;
}
export function dataRow(value, columns, fail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_row', 'En række skal være et objekt med kolonnenavne.');
  if (Object.keys(value).some((key) => !columns.some((c) => c.name === key))) fail(400, 'unknown_column', 'Rækken indeholder en ukendt kolonne.');
  const data = Object.fromEntries(columns.map((c) => [c.name, dataValue(value[c.name], c, fail)]));
  if (new TextEncoder().encode(JSON.stringify(data)).length > DATA_LIMITS.rowBytes) fail(413, 'row_too_large', 'Rækken er for stor. Gem større dokumenter som filer.');
  return data;
}
function dataTableInfo(t) {
  return { id: t.id, name: t.name, physical_name: t.physical_name, description: t.description, columns: JSON.parse(t.columns_json), source_url: t.source_url, revision: t.revision, created_at: t.created_at, updated_at: t.updated_at, reference: `[[data:${t.id}|${t.name.replace(/[\[\]|]/g, '')}]]` };
}
function dataRecordInfo(r, columns) {
  const values = Object.fromEntries(columns.map((c) => [c.name, r[c.name] === null ? null : c.type === 'boolean' ? !!r[c.name] : c.type === 'json' ? JSON.parse(r[c.name]) : r[c.name]]));
  return { id: r.__id, values, source_url: r.__source_url, revision: r.__revision, created_at: r.__created_at, updated_at: r.__updated_at };
}
function dataPhysicalName(table, fail) {
  if (!/^finch_[a-f0-9]{32}$/.test(table.physical_name)) fail(503, 'invalid_storage', 'Tabellens lager kunne ikke åbnes.');
  return `"${table.physical_name}"`;
}
function dataSqlValue(value, column) { return value === null ? null : column.type === 'boolean' ? Number(value) : column.type === 'json' ? JSON.stringify(value) : value; }
// These user-requested physical schemas are created on demand. Core application tables use Drizzle migrations.
function dataCreateStatements(db, physicalName, columns) {
  const fields = columns.map((c) => `"${c.name}" ${c.type === 'number' ? 'REAL' : c.type === 'boolean' ? 'INTEGER' : 'TEXT'}${c.required ? ' NOT NULL' : ''}${c.type === 'boolean' ? ` CHECK ("${c.name}" IN (0, 1))` : ''}${c.type === 'file' ? ' REFERENCES stored_files(id)' : ''}`);
  const statements = [db.statement(`CREATE TABLE "${physicalName}" ("__id" TEXT PRIMARY KEY NOT NULL, "__revision" INTEGER NOT NULL DEFAULT 0, "__source_url" TEXT NOT NULL DEFAULT '', "__created_at" INTEGER NOT NULL, "__updated_at" INTEGER NOT NULL, "__deleted_at" INTEGER, ${fields.join(', ')})`),
    db.statement(`CREATE INDEX "idx_${physicalName}_active" ON "${physicalName}" ("__deleted_at", "__id")`)];
  for (const c of columns.filter((c) => c.indexed)) statements.push(db.statement(`CREATE INDEX "idx_${physicalName}_column_${c.name}" ON "${physicalName}" ("${c.name}") WHERE "__deleted_at" IS NULL`));
  return statements;
}
export function dataFileInfo(f, orgId) {
  return { id: f.id, name: f.name, description: f.description, content_type: f.content_type, size_bytes: f.size_bytes, sha256: f.sha256, source_url: f.source_url, revision: f.revision, created_at: f.created_at, updated_at: f.updated_at,
    reference: `[[file:${f.id}|${f.name.replace(/[\[\]|]/g, '').slice(0, 80)}]]`, download_url: `/api/organizations/${orgId}/data/files/${f.id}/content` };
}
export async function dataFileInTables(db,orgId,tableIds,fileId,fail){
  for(const tableId of tableIds){
    const table=await db.first('SELECT * FROM data_tables WHERE id=? AND organization_id=? AND deleted_at IS NULL',tableId,orgId);if(!table)continue;
    const columns=JSON.parse(table.columns_json).filter(c=>c.type==='file');if(!columns.length)continue;
    if(columns.some(c=>!DATA_COLUMN.test(c.name)))fail(503,'invalid_storage','Tabellens filreferencer kunne ikke læses.');
    const physical=dataPhysicalName(table,fail);
    if(await db.first(`SELECT 1 AS found FROM ${physical} WHERE "__deleted_at" IS NULL AND (${columns.map(c=>`"${c.name}"=?`).join(' OR ')}) LIMIT 1`,...columns.map(()=>fileId)))return true;
  }
  return false;
}
function dataRevision(input, fail) { if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail(400, 'revision_required', 'Angiv den seneste revision fra læsekaldet.'); return input.revision; }
async function dataFileReferences(db, orgId, rows, columns, fail) {
  const references = [...new Set(rows.flatMap((r) => columns.filter((c) => c.type === 'file').map((c) => r[c.name]).filter(Boolean)))];
  for (const fileId of references) {
    const file = await db.first('SELECT id FROM stored_files WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', fileId, orgId);
    if (!file) fail(400, 'invalid_file_reference', 'Filreferencen findes ikke i denne organisation.');
  }
}
function dataQuery(query, columns, fail) {
  const values = []; const filters = [];
  const find = (name) => { const c = columns.find((c) => c.name === name); if (!c) fail(400, 'unknown_column', `Ukendt kolonne: ${String(name).slice(0, 40)}.`); return c; };
  const expr = (name) => `"${find(name).name}"`;
  if (query.filters !== undefined && (!Array.isArray(query.filters) || query.filters.length > 12)) fail(400, 'invalid_query', 'Højst 12 filtre pr. forespørgsel.');
  for (const filter of query.filters || []) {
    const column = find(filter.column); const sql = expr(column.name);
    if (filter.op === 'is_null') { filters.push(`${sql} IS NULL`); continue; }
    if (filter.op === 'not_null') { filters.push(`${sql} IS NOT NULL`); continue; }
    const convert = (v) => dataSqlValue(dataValue(v, { ...column, required: false }, fail), column);
    if (filter.op === 'in') {
      if (!Array.isArray(filter.value) || !filter.value.length || filter.value.length > 30) fail(400, 'invalid_query', 'in kræver 1–30 værdier.');
      filters.push(`${sql} IN (${filter.value.map(() => '?').join(',')})`); values.push(...filter.value.map(convert)); continue;
    }
    if (filter.op === 'contains') {
      if (column.type !== 'text' || typeof filter.value !== 'string') fail(400, 'invalid_query', 'contains kan kun bruges på tekst.');
      filters.push(`${sql} LIKE ? ESCAPE '\\'`); values.push(`%${filter.value.replace(/[\\%_]/g, '\\$&')}%`); continue;
    }
    const operations = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
    if (!operations[filter.op] || (['gt', 'gte', 'lt', 'lte'].includes(filter.op) && !['number', 'date', 'text'].includes(column.type))) fail(400, 'invalid_query', 'Ugyldig filteroperation.');
    if (filter.value === null && ['eq', 'ne'].includes(filter.op)) filters.push(`${sql} IS ${filter.op === 'ne' ? 'NOT ' : ''}NULL`);
    else { filters.push(`${sql} ${operations[filter.op]} ?`); values.push(convert(filter.value)); }
  }
  const logic = query.match || 'all'; if (!['all', 'any'].includes(logic)) fail(400, 'invalid_query', 'match skal være all eller any.');
  const condition = filters.length ? ` AND (${filters.join(logic === 'all' ? ' AND ' : ' OR ')})` : '';
  const orders = query.order_by || [];
  if (!Array.isArray(orders) || orders.length > 3) fail(400, 'invalid_query', 'Højst tre sorteringskolonner.');
  const order = orders.map((o) => { const column = find(o.column); if (!['asc', 'desc'].includes(o.direction || 'asc')) fail(400, 'invalid_query', 'Sortering skal være asc eller desc.'); return `${expr(column.name)} ${(o.direction || 'asc').toUpperCase()}`; });
  order.push('"__id" ASC');
  const limit = query.limit ?? 50; const offset = query.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > DATA_LIMITS.pageSize || !Number.isSafeInteger(offset) || offset < 0 || offset > 1000000) fail(400, 'invalid_query', 'limit skal være 1–100, og offset skal være et positivt heltal.');
  const select = query.select || columns.map((c) => c.name);
  if (!Array.isArray(select) || !select.length || select.length > 30) fail(400, 'invalid_query', 'Vælg 1–30 kolonner.');
  select.forEach(find);
  const aggregates = query.aggregates || [];
  if (!Array.isArray(aggregates) || aggregates.length > 6) fail(400, 'invalid_query', 'Højst seks beregninger.');
  const seen = new Set();
  const aggregateSql = aggregates.map((a, i) => {
    if (!['count', 'sum', 'avg', 'min', 'max'].includes(a.op)) fail(400, 'invalid_query', 'Ugyldig beregning.');
    if (a.op !== 'count' && find(a.column).type !== 'number') fail(400, 'invalid_query', 'Denne beregning kræver en talkolonne.');
    const alias = a.as || `${a.op}_${a.column || 'rows'}`;
    if (!DATA_COLUMN.test(alias) || seen.has(alias)) fail(400, 'invalid_query', 'Beregningsnavne skal være unikke feltnavne.'); seen.add(alias);
    return { alias, sql: `${a.op.toUpperCase()}(${a.op === 'count' && !a.column ? '*' : expr(a.column)}) AS result_${i}` };
  });
  return { condition, values, order: order.join(', '), limit, offset, select, aggregateSql };
}
async function dataBytes(request, fail) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > DATA_LIMITS.fileBytes) fail(413, 'file_too_large', 'Filer må højst fylde 10 MB.');
  const chunks = []; let size = 0; const reader = request.body?.getReader();
  if (reader) for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > DATA_LIMITS.fileBytes) { await reader.cancel(); fail(413, 'file_too_large', 'Filer må højst fylde 10 MB.'); } chunks.push(value); }
  if (!size) fail(400, 'empty_file', 'Filen er tom.');
  const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; } return bytes;
}

import { organizationAccess } from './team.mjs';
export async function handleDataApi(request, env, context) {
  const { db, user, now, fail, json, body, id } = context;
  const url = new URL(request.url); const route = url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/data(?:\/(.*))?$/);
  if (!route) return null;
  const orgId = route[1]; const path = route[2] || '';
  const org = await organizationAccess(db,orgId,user);
  if (!org) fail(404, 'organization_not_found', 'Organisationen findes ikke, eller du har ikke adgang.');
  const expected=request.headers.get('X-Finch-User');if(expected&&expected!==user.id)fail(409,'identity_changed','Dit login er ændret. Genindlæs Finch.');
  const getTable = async (tableId) => {
    const table = await db.first('SELECT * FROM data_tables WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', tableId, orgId);
    if (!table) fail(404, 'table_not_found', 'Tabellen findes ikke i denne organisation.'); return table;
  };
  const getFile = async (fileId) => {
    const file = await db.first('SELECT * FROM stored_files WHERE id = ? AND organization_id = ? AND deleted_at IS NULL', fileId, orgId);
    if (!file) fail(404, 'file_not_found', 'Filen findes ikke i denne organisation.'); return file;
  };
  if (!path && request.method === 'GET') {
    const tables = await db.all('SELECT * FROM data_tables WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE', orgId);
    const summaries = [];
    for (const t of tables) { const count = await db.first(`SELECT COUNT(*) AS count FROM ${dataPhysicalName(t, fail)} WHERE "__deleted_at" IS NULL`); summaries.push({ ...dataTableInfo(t), row_count: count.count }); }
    const files = await db.all('SELECT * FROM stored_files WHERE organization_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE', orgId);
    return json({ tables: summaries, files: files.map((f) => dataFileInfo(f, orgId)), limits: DATA_LIMITS });
  }
  if (path === 'tables' && request.method === 'POST') {
    const input = await body(request, 20000); const name = dataText(input.name, 80); if (!name) fail(400, 'name_required', 'Giv tabellen et navn.');
    const columns = dataColumns(input.columns, fail);
    const existing = await db.first('SELECT id FROM data_tables WHERE organization_id = ? AND name = ? AND deleted_at IS NULL', orgId, name);
    if (existing) fail(409, 'table_exists', 'En tabel med dette navn findes allerede.');
    const tableId = id(); const physicalName = `finch_${tableId.replaceAll('-', '')}`;
    const sourceUrl = dataUrl(input.source_url, fail);
    try {
      await db.batch([...dataCreateStatements(db, physicalName, columns),
        db.statement('INSERT INTO data_tables (id, organization_id, name, physical_name, description, columns_json, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', tableId, orgId, name, physicalName, dataText(input.description, 1000), JSON.stringify(columns), sourceUrl, now, now)]);
    } catch (error) {
      if (await db.first('SELECT id FROM data_tables WHERE organization_id = ? AND name = ? AND deleted_at IS NULL', orgId, name)) fail(409, 'table_exists', 'En tabel med dette navn findes allerede.');
      throw error;
    }
    return json({ table: dataTableInfo(await getTable(tableId)) }, 201);
  }
  if(path==='table-requests'&&request.method==='POST'){
    const input=await body(request,12000),requestId=dataWorkId(input.request_id,fail);
    const name=dataText(input.name,80),description=dataText(input.description,4000);
    if(!name||description.length<10)fail(400,'description_required','Giv tabelønsket et navn, og beskriv de data, du vil gemme.');
    return json({status:'queued',...await queueDataWork(context,orgId,requestId,{kind:'table',name,description})},201);
  }
  const tableRoute = path.match(/^tables\/([a-f0-9-]{36})(?:\/(query|rows)(?:\/([a-f0-9-]{36}))?)?$/);
  if (tableRoute) {
    const table = await getTable(tableRoute[1]); const columns = JSON.parse(table.columns_json); const physical = dataPhysicalName(table, fail); const operation = tableRoute[2]; const rowId = tableRoute[3];
    if (!operation && request.method === 'GET') {
      const count = await db.first(`SELECT COUNT(*) AS count FROM ${physical} WHERE "__deleted_at" IS NULL`);
      return json({ table: { ...dataTableInfo(table), row_count: count.count } });
    }
    if (!operation && request.method === 'PUT') {
      const input = await body(request, 20000); const revision = dataRevision(input, fail);
      const nextColumns = input.columns ? dataColumns(input.columns, fail) : columns;
      const schemaChanged = JSON.stringify(nextColumns) !== JSON.stringify(columns);
      if (schemaChanged) fail(409, 'schema_immutable', 'Kolonner og datatyper er faste efter oprettelsen. Opret en ny tabel til et nyt schema.');
      const name = input.name === undefined ? table.name : dataText(input.name, 80); if (!name) fail(400, 'name_required', 'Giv tabellen et navn.');
      const result = await db.first(`UPDATE data_tables SET name = ?, description = ?, columns_json = ?, source_url = ?, revision = revision + 1, updated_at = ?
        WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING *`,
        name, input.description === undefined ? table.description : dataText(input.description, 1000), JSON.stringify(nextColumns), input.source_url === undefined ? table.source_url : dataUrl(input.source_url, fail), now, table.id, revision);
      if (!result) fail(409, 'revision_conflict', 'Tabellen er ændret, eller schemaet har allerede data. Hent den igen.');
      return json({ table: dataTableInfo(result) });
    }
    if (!operation && request.method === 'DELETE') {
      const input = await body(request); const revision = dataRevision(input, fail);
      const result = await db.first('UPDATE data_tables SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING id', now, table.id, revision);
      if (!result) fail(409, 'revision_conflict', 'Tabellen er ændret. Hent den igen.'); return json({ deleted: table.id });
    }
    if (operation === 'query' && !rowId && request.method === 'POST') {
      const input = await body(request, 16000); const query = dataQuery(input, columns, fail);
      const where = `"__deleted_at" IS NULL${query.condition}`; const values = query.values;
      const count = await db.first(`SELECT COUNT(*) AS count FROM ${physical} WHERE ${where}`, ...values);
      const rows = await db.all(`SELECT * FROM ${physical} WHERE ${where} ORDER BY ${query.order} LIMIT ? OFFSET ?`, ...values, query.limit, query.offset);
      let aggregates = {};
      if (query.aggregateSql.length) {
        const result = await db.first(`SELECT ${query.aggregateSql.map((a) => a.sql).join(', ')} FROM ${physical} WHERE ${where}`, ...values);
        aggregates = Object.fromEntries(query.aggregateSql.map((a, i) => [a.alias, result[`result_${i}`]]));
      }
      return json({ table: dataTableInfo(table), rows: rows.map((r) => { const record = dataRecordInfo(r, columns); record.values = Object.fromEntries(query.select.map((c) => [c, record.values[c]])); return record; }), total: count.count, limit: query.limit, offset: query.offset, next_offset: query.offset + rows.length < count.count ? query.offset + rows.length : null, aggregates });
    }
    if (operation === 'rows' && !rowId && request.method === 'POST') {
      const input = await body(request, 1024 * 1024);
      if (!Array.isArray(input.rows) || !input.rows.length || input.rows.length > 100) fail(400, 'invalid_rows', 'Indsæt 1–100 rækker ad gangen.');
      if(input.request_id!==undefined&&(!DATA_UUID.test(input.request_id)||input.rows.length!==1))fail(400,'invalid_request_id','En genforsøgsnøgle gælder én ny række.');
      const rows = input.rows.map((r) => ({ id: input.request_id||id(), values: dataRow(r.values, columns, fail), source_url: dataUrl(r.source_url || table.source_url, fail) }));
      await dataFileReferences(db, orgId, rows.map((r) => r.values), columns, fail);
      const fields = columns.map((c) => `"${c.name}"`).join(', ');
      const results = await db.batch(rows.map((r) => db.statement(`INSERT INTO ${physical} ("__id", "__source_url", "__created_at", "__updated_at", ${fields})
        SELECT ?, ?, ?, ?, ${columns.map(() => '?').join(', ')} FROM data_tables WHERE id = ? AND revision = ? AND deleted_at IS NULL ON CONFLICT("__id") DO NOTHING`, r.id, r.source_url, now, now, ...columns.map((c) => dataSqlValue(r.values[c.name], c)), table.id, table.revision)));
      if(input.request_id&&results[0].meta.changes===0){
        const existing=await db.first(`SELECT * FROM ${physical} WHERE "__id"=? AND "__deleted_at" IS NULL`,input.request_id);
        const row=existing&&dataRecordInfo(existing,columns),sameValue=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
        if(!row||row.source_url!==rows[0].source_url||columns.some(c=>!sameValue(row.values[c.name],rows[0].values[c.name])))fail(409,'request_id_used','Rækken er allerede gemt med andre værdier. Genindlæs rækken.');
        return json({rows:[row],duplicate:true});
      }
      if (results.some((r) => r.meta.changes !== 1)) fail(409, 'revision_conflict', 'Tabellens schema er ændret. Hent det igen.');
      return json({ rows: rows.map((r) => ({ ...r, revision: 0, created_at: now, updated_at: now })) }, 201);
    }
    if (operation === 'rows' && rowId) {
      const record = await db.first(`SELECT * FROM ${physical} WHERE "__id" = ? AND "__deleted_at" IS NULL`, rowId);
      if (!record) fail(404, 'row_not_found', 'Rækken findes ikke i denne tabel.');
      if (request.method === 'GET') return json({ row: dataRecordInfo(record, columns) });
      if (request.method === 'PUT'||request.method==='PATCH') {
        const input = await body(request, 50000); const revision = dataRevision(input, fail);
        if(request.method==='PATCH'&&(!input.values||typeof input.values!=='object'||Array.isArray(input.values)||!Object.keys(input.values).length))fail(400,'invalid_row','Angiv de felter, du vil ændre.');
        const row = dataRow(request.method==='PATCH'?{...dataRecordInfo(record,columns).values,...input.values}:input.values, columns, fail); await dataFileReferences(db, orgId, [row], columns, fail);
        const result = await db.first(`UPDATE ${physical} SET ${columns.map((c) => `"${c.name}" = ?`).join(', ')}, "__source_url" = ?, "__revision" = "__revision" + 1, "__updated_at" = ?
          WHERE "__id" = ? AND "__revision" = ? AND "__deleted_at" IS NULL
          AND EXISTS (SELECT 1 FROM data_tables WHERE id = ? AND revision = ? AND deleted_at IS NULL) RETURNING *`,
          ...columns.map((c) => dataSqlValue(row[c.name], c)), input.source_url === undefined ? record.__source_url : dataUrl(input.source_url, fail), now, record.__id, revision, table.id, table.revision);
        if (!result) fail(409, 'revision_conflict', 'Rækken eller tabellen er ændret. Hent den igen.'); return json({ row: dataRecordInfo(result, columns) });
      }
      if (request.method === 'DELETE') {
        const input = await body(request); const revision = dataRevision(input, fail);
        const result = await db.first(`UPDATE ${physical} SET "__deleted_at" = ?, "__revision" = "__revision" + 1 WHERE "__id" = ? AND "__revision" = ? AND "__deleted_at" IS NULL RETURNING "__id"`, now, record.__id, revision);
        if (!result) fail(409, 'revision_conflict', 'Rækken er ændret. Hent den igen.'); return json({ deleted: record.__id });
      }
    }
  }
  if ((path === 'files'||path==='file-intakes') && request.method === 'POST') {
    if (!env.BUCKET) fail(503, 'files_unavailable', 'Filopbevaring er ikke tilgængelig lige nu.');
    const requestId=path==='file-intakes'?dataWorkId(request.headers.get('X-Finch-Request-Id'),fail):null;
    if(requestId){const previous=await previousDataWork(db,orgId,user.id,requestId,'file',fail);if(previous)return json({status:'queued',...previous,file:dataFileInfo(await getFile(previous.file_id),orgId)},201);}
    let name; try { name = decodeURIComponent(request.headers.get('X-File-Name') || ''); } catch { fail(400, 'invalid_name', 'Ugyldigt filnavn.'); }
    name = name.replace(/[\\/\x00-\x1f]/g, '_').trim().slice(0, 160); if (!name) fail(400, 'name_required', 'Angiv filens navn.');
    let description = ''; let sourceUrl = '';
    try { description = decodeURIComponent(request.headers.get('X-File-Description') || ''); sourceUrl = decodeURIComponent(request.headers.get('X-File-Source') || ''); } catch { fail(400, 'invalid_metadata', 'Ugyldig filbeskrivelse.'); }
    sourceUrl = dataUrl(sourceUrl, fail);
    const contentType = dataText(request.headers.get('Content-Type'), 120) || 'application/octet-stream';
    const bytes = await dataBytes(request, fail); const fileId = id(); const objectKey = `${orgId}/${fileId}`;
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (n) => n.toString(16).padStart(2, '0')).join('');
    await env.BUCKET.put(objectKey, bytes, { httpMetadata: { contentType: 'application/octet-stream' } });
    let work;
    try {
      if(requestId){work=await queueDataWork(context,orgId,requestId,{kind:'file',description:dataText(description,1000)}, {id:fileId,name,description:dataText(description,1000),contentType,size:bytes.length,sha256,objectKey,sourceUrl});if(work.duplicate)await env.BUCKET.delete(objectKey);}
      else await db.run('INSERT INTO stored_files (id, organization_id, name, description, content_type, size_bytes, sha256, object_key, source_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', fileId, orgId, name, dataText(description, 1000), contentType, bytes.length, sha256, objectKey, sourceUrl, now, now);
    }
    catch (error) { await env.BUCKET.delete(objectKey); throw error; }
    return json({ file: dataFileInfo(await getFile(work?.file_id||fileId), orgId),...(work?{status:'queued',...work}:{}) }, 201);
  }
  const fileRoute = path.match(/^files\/([a-f0-9-]{36})(\/content)?$/);
  if (fileRoute) {
    const file = await getFile(fileRoute[1]);
    if (request.method === 'GET' && fileRoute[2]) {
      if (!env.BUCKET) fail(503, 'files_unavailable', 'Filopbevaring er ikke tilgængelig lige nu.');
      const object = await env.BUCKET.get(file.object_key); if (!object) fail(404, 'file_missing', 'Filens indhold findes ikke.');
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size_bytes), 'Content-Disposition': `attachment; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
    }
    if (!fileRoute[2] && request.method === 'GET') {
      const result = { file: dataFileInfo(file, orgId) };
      if (url.searchParams.get('include_content') === 'true') {
        if (file.size_bytes > DATA_LIMITS.inlineFileBytes) fail(413, 'use_download', 'Filen er større end 1 MB. Brug download_url i filens metadata.');
        if (!env.BUCKET) fail(503, 'files_unavailable', 'Filopbevaring er ikke tilgængelig lige nu.');
        const object = await env.BUCKET.get(file.object_key); if (!object) fail(404, 'file_missing', 'Filens indhold findes ikke.');
        const bytes = new Uint8Array(await object.arrayBuffer()); let binary = ''; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
        result.content_base64 = btoa(binary);
      }
      return json(result);
    }
    if (!fileRoute[2] && request.method === 'PUT') {
      const input = await body(request); const revision = dataRevision(input, fail);
      const name = input.name === undefined ? file.name : dataText(input.name, 160).replace(/[\\/\x00-\x1f]/g, '_'); if (!name) fail(400, 'name_required', 'Angiv filens navn.');
      const result = await db.first('UPDATE stored_files SET name = ?, description = ?, source_url = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING *', name, input.description === undefined ? file.description : dataText(input.description, 1000), input.source_url === undefined ? file.source_url : dataUrl(input.source_url, fail), now, file.id, revision);
      if (!result) fail(409, 'revision_conflict', 'Filen er ændret. Hent den igen.'); return json({ file: dataFileInfo(result, orgId) });
    }
    if (!fileRoute[2] && request.method === 'DELETE') {
      const input = await body(request); const revision = dataRevision(input, fail);
      const result = await db.first('UPDATE stored_files SET deleted_at = ?, revision = revision + 1 WHERE id = ? AND revision = ? AND deleted_at IS NULL RETURNING id', now, file.id, revision);
      if (!result) fail(409, 'revision_conflict', 'Filen er ændret. Hent den igen.'); return json({ deleted: file.id });
    }
  }
  fail(404, 'not_found', 'Dataressourcen findes ikke.');
}
