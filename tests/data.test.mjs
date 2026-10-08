import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { sqliteD1 } from '../scripts/sqlite-d1.mjs';
import { handleApi } from '../server/api.mjs';

const origin = 'https://finch.test';
async function fixture() {
  const DB = sqliteD1(); for (const f of readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()) DB.sqlite.exec(readFileSync(`drizzle/${f}`, 'utf8'));
  const objects = new Map(); const outbox = [];
  const env = { DB, AUTH_SECRET: 'test-secret-at-least-32-characters-long', BUCKET: {
    async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
    async get(key) { const bytes = objects.get(key); return bytes ? { body: new Blob([bytes]).stream(), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null; },
    async delete(key) { objects.delete(key); },
  } };
  async function call(path, { method = 'GET', data, bytes, headers = {}, cookie, requestOrigin = origin } = {}) {
    const response = await handleApi(new Request(`${origin}${path}`, { method,
      headers: { Origin: requestOrigin, 'CF-Connecting-IP': '192.0.2.30', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : bytes ? { body: bytes } : {}),
    }), env, { sendMail: async (_, message) => outbox.push(message) });
    return { status: response.status, headers: response.headers, ...(response.headers.get('Content-Type')?.includes('json') ? { data: await response.json() } : { bytes: new Uint8Array(await response.arrayBuffer()) }) };
  }
  async function login(email) {
    const challenge = await call('/api/auth/request-code', { method: 'POST', data: { email } });
    const result = await call('/api/auth/verify-code', { method: 'POST', data: { challengeId: challenge.data.challengeId, code: outbox.at(-1).code } });
    return result.headers.get('Set-Cookie').split(';')[0];
  }
  const owner = await login('owner@example.test'); const outsider = await login('outsider@example.test');
  const org = await call('/api/organizations', { method: 'POST', cookie: owner, data: { name: 'Data test' } });
  const secondOrg = await call('/api/organizations', { method: 'POST', cookie: owner, data: { name: 'Separate organization' } });
  const base = `/api/organizations/${org.data.organization.id}/data`;
  async function create(columns = [ { name: 'model', type: 'text', required: true }, { name: 'power_kw', type: 'number', unit: 'kW', indexed: true }, { name: 'hybrid', type: 'boolean' }, { name: 'available', type: 'date' }, { name: 'details', type: 'json' } ], name = 'Motorer') {
    const result = await call(`${base}/tables`, { method: 'POST', cookie: owner, data: { name, columns, source_url: 'https://example.test/engines' } });
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.table;
  }
  return { DB, env, objects, call, create, owner, outsider, base, orgId: org.data.organization.id, otherBase: `/api/organizations/${secondOrg.data.organization.id}/data` };
}
test('organisation branding persists and only its owner can load referenced logo and font files', async () => {
  const t=await fixture();
  const logo=await t.call(`${t.base}/files`,{method:'POST',cookie:t.owner,bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'),headers:{'Content-Type':'image/svg+xml','X-File-Name':'logo.svg'}});
  const font=await t.call(`${t.base}/files`,{method:'POST',cookie:t.owner,bytes:Uint8Array.from([1,2,3,4]),headers:{'Content-Type':'font/woff2','X-File-Name':'brand.woff2'}});
  const loaded=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});const state=loaded.data.state;
  state.branding={revision:1,theme:{accent:'#003399'},stylesheet:'.topbar{border-bottom:3px solid #003399}',logo:{file_id:logo.data.file.id,alt:'Company'},fonts:[{file_id:font.data.file.id,family:'Company',weight:400,style:'normal'}]};
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{method:'PUT',cookie:t.owner,data:{revision:0,state}})).status,200);
  const route=`/api/organizations/${t.orgId}/branding/assets/${logo.data.file.id}`;
  assert.equal((await t.call(route)).status,401);assert.equal((await t.call(route,{cookie:t.outsider})).status,404);
  const asset=await t.call(route,{cookie:t.owner});assert.equal(asset.status,200);assert.equal(asset.headers.get('Content-Type'),'image/svg+xml');assert.match(asset.headers.get('Content-Security-Policy'),/sandbox/);
  const fontAsset=await t.call(`/api/organizations/${t.orgId}/branding/assets/${font.data.file.id}`,{cookie:t.owner});assert.equal(fontAsset.status,200);assert.equal(fontAsset.headers.get('Content-Type'),'font/woff2');
  const otherOrg=t.otherBase.split('/')[3];assert.equal((await t.call(`/api/organizations/${otherOrg}/branding/assets/${logo.data.file.id}`,{cookie:t.owner})).status,404);
  const fresh=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});assert.deepEqual(fresh.data.state.branding,state.branding);
  state.branding.stylesheet='@import "https://outside.test/style.css";';assert.equal((await t.call(`/api/organizations/${t.orgId}`,{method:'PUT',cookie:t.owner,data:{revision:1,state}})).status,400);
});
test('agent-created tables are real, typed SQLite tables, with requested indexes', async () => {
  const t = await fixture(); const table = await t.create();
  const info = t.DB.sqlite.prepare(`PRAGMA table_info("${table.physical_name}")`).all();
  assert.equal(info.find((c) => c.name === 'power_kw').type, 'REAL');
  assert.equal(info.find((c) => c.name === 'model').notnull, 1);
  assert.equal(info.some((c) => c.name === 'data_json'), false);
  const indexes = t.DB.sqlite.prepare(`PRAGMA index_list("${table.physical_name}")`).all();
  assert.ok(indexes.some((i) => i.name.endsWith('_column_power_kw')));
  assert.match(table.reference, /^\[\[data:/);
});
test('query filters, projection, sorting, pagination, aggregates and booleans operate on physical columns', async () => {
  const t = await fixture(); const table = await t.create(); const path = `${t.base}/tables/${table.id}`;
  const rows = [{ model: 'Demo A', power_kw: 260, hybrid: false, available: '2026-01-01', details: { cylinders: 6 } }, { model: 'Demo B', power_kw: 400, hybrid: false, details: 'special' }, { model: 'Demo C', power_kw: 330, hybrid: true, details: { cylinders: 6 } }];
  const inserted = await t.call(`${path}/rows`, { method: 'POST', cookie: t.owner, data: { rows: rows.map((values) => ({ values })) } }); assert.equal(inserted.status, 201, JSON.stringify(inserted.data));
  const query = await t.call(`${path}/query`, { method: 'POST', cookie: t.owner, data: { filters: [{ column: 'power_kw', op: 'gte', value: 300 }], order_by: [{ column: 'power_kw', direction: 'desc' }], select: ['model', 'power_kw'], limit: 1, aggregates: [{ op: 'sum', column: 'power_kw', as: 'total_kw' }] } });
  assert.equal(query.status, 200); assert.equal(query.data.total, 2); assert.equal(query.data.rows[0].values.model, 'Demo B'); assert.equal(query.data.aggregates.total_kw, 730); assert.equal(query.data.next_offset, 1);
  assert.equal(Object.hasOwn(query.data.rows[0].values, 'hybrid'), false);
  const boolQuery = await t.call(`${path}/query`, { method: 'POST', cookie: t.owner, data: { filters: [{ column: 'hybrid', op: 'eq', value: true }] } }); assert.equal(boolQuery.data.rows[0].values.hybrid, true); assert.equal(boolQuery.data.total, 1);
  const jsonQuery = await t.call(`${path}/query`, { method: 'POST', cookie: t.owner, data: { filters: [{ column: 'details', op: 'eq', value: 'special' }] } }); assert.equal(jsonQuery.data.rows[0].values.model, 'Demo B');
});
test('row CRUD checks types, preserves sources and rejects stale revisions', async () => {
  const t = await fixture(); const table = await t.create(); const path = `${t.base}/tables/${table.id}`;
  const inserted = await t.call(`${path}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { model: 'Demo', power_kw: 300 } }] } });
  const row = inserted.data.rows[0]; assert.equal(row.source_url, table.source_url);
  const update = await t.call(`${path}/rows/${row.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, values: { model: 'Demo revised', power_kw: 310, hybrid: false } } }); assert.equal(update.status, 200); assert.equal(update.data.row.revision, 1);
  const stale = await t.call(`${path}/rows/${row.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, values: { model: 'Lost', power_kw: 100 } } }); assert.equal(stale.status, 409);
  const bad = await t.call(`${path}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { model: 'Bad', power_kw: '310' } }] } }); assert.equal(bad.status, 400);
  const unknown = await t.call(`${path}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { model: 'Bad', unknown: 1 } }] } }); assert.equal(unknown.status, 400);
  const del = await t.call(`${path}/rows/${row.id}`, { method: 'DELETE', cookie: t.owner, data: { revision: 1 } }); assert.equal(del.status, 200);
  assert.equal((await t.call(`${path}/rows/${row.id}`, { cookie: t.owner })).status, 404);
  assert.equal(t.DB.sqlite.prepare(`SELECT COUNT(*) AS count FROM "${table.physical_name}" WHERE "__deleted_at" IS NOT NULL`).get().count, 1);
});
test('tables and rows are isolated between users and even between the same user’s organizations', async () => {
  const t = await fixture(); const table = await t.create();
  assert.equal((await t.call(`${t.base}/tables/${table.id}`, { cookie: t.outsider })).status, 404);
  assert.equal((await t.call(`${t.otherBase}/tables/${table.id}`, { cookie: t.owner })).status, 404);
  const foreignWrite = await t.call(`${t.otherBase}/tables/${table.id}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { model: 'Attack' } }] } }); assert.equal(foreignWrite.status, 404);
  const catalog = await t.call(t.otherBase, { cookie: t.owner }); assert.equal(catalog.data.tables.length, 0);
});
test('unsafe schema and query identifiers cannot inject SQL or access infrastructure tables', async () => {
  const t = await fixture(); const malicious = await t.call(`${t.base}/tables`, { method: 'POST', cookie: t.owner, data: { name: 'Attack', columns: [{ name: 'a); DROP TABLE users;--', type: 'text' }] } }); assert.equal(malicious.status, 400);
  const table = await t.create();
  for (const input of [{ filters: [{ column: 'model"; DROP TABLE users;--', op: 'eq', value: 'x' }] }, { order_by: [{ column: 'power_kw', direction: 'desc; DROP TABLE users' }] }, { aggregates: [{ op: 'sum', column: 'power_kw', as: 'x" FROM users;--' }] }, { filters: [{ column: 'model', op: 'sql', value: 'anything' }] }]) assert.equal((await t.call(`${t.base}/tables/${table.id}/query`, { method: 'POST', cookie: t.owner, data: input })).status, 400);
  assert.ok(t.DB.sqlite.prepare("SELECT name FROM sqlite_schema WHERE name = 'users'").get());
});
test('table metadata CRUD supports names and descriptions, while existing physical schemas stay stable', async () => {
  const t = await fixture(); const table = await t.create();
  const renamed = await t.call(`${t.base}/tables/${table.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, name: 'Motorprogram', description: 'Specs' } }); assert.equal(renamed.status, 200); assert.equal(renamed.data.table.physical_name, table.physical_name);
  const schemaChange = await t.call(`${t.base}/tables/${table.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 1, columns: [{ name: 'other', type: 'text' }] } }); assert.equal(schemaChange.status, 409);
  const deletion = await t.call(`${t.base}/tables/${table.id}`, { method: 'DELETE', cookie: t.owner, data: { revision: 1 } }); assert.equal(deletion.status, 200);
  assert.equal((await t.call(`${t.base}/tables/${table.id}`, { cookie: t.owner })).status, 404);
  assert.ok(t.DB.sqlite.prepare('SELECT name FROM sqlite_schema WHERE name = ?').get(table.physical_name));
});
test('duplicate table names cannot leave orphaned physical tables under concurrent requests', async () => {
  const t = await fixture();
  const input = { name: 'Same', columns: [{ name: 'title', type: 'text' }] };
  const results = await Promise.all([0, 1].map(() => t.call(`${t.base}/tables`, { method: 'POST', cookie: t.owner, data: input })));
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  const physical = t.DB.sqlite.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name LIKE 'finch_%'").all(); assert.equal(physical.length, 1);
});
test('binary documents round-trip without altering bytes and remain private', async () => {
  const t = await fixture(); const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 255, 1, 128]);
  const upload = await t.call(`${t.base}/files`, { method: 'POST', cookie: t.owner, bytes, headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent('Specifikationer.xlsx') } }); assert.equal(upload.status, 201);
  const file = upload.data.file; assert.equal(file.size_bytes, bytes.length); assert.match(file.reference, /^\[\[file:/); assert.equal(file.sha256.length, 64); assert.equal(Object.hasOwn(file, 'object_key'), false);
  const downloaded = await t.call(file.download_url, { cookie: t.owner }); assert.deepEqual(downloaded.bytes, bytes); assert.match(downloaded.headers.get('Content-Disposition'), /^attachment/); assert.equal(downloaded.headers.get('Cache-Control'), 'no-store');
  const inline = await t.call(`${t.base}/files/${file.id}?include_content=true`, { cookie: t.owner }); assert.deepEqual(new Uint8Array(Buffer.from(inline.data.content_base64, 'base64')), bytes);
  assert.equal((await t.call(file.download_url, { cookie: t.outsider })).status, 404);
  assert.equal((await t.call(`${t.otherBase}/files/${file.id}/content`, { cookie: t.owner })).status, 404);
  assert.equal((await t.call(file.download_url)).status, 401);
});
test('file metadata CRUD and row references are restricted to the current organization', async () => {
  const t = await fixture(); const upload = await t.call(`${t.base}/files`, { method: 'POST', cookie: t.owner, bytes: new TextEncoder().encode('%PDF-test'), headers: { 'X-File-Name': 'Brochure.pdf', 'Content-Type': 'application/pdf' } }); const file = upload.data.file;
  const table = await t.create([{ name: 'document', type: 'file', required: true }], 'Dokumenter');
  const inserted = await t.call(`${t.base}/tables/${table.id}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { document: file.id } }] } }); assert.equal(inserted.status, 201);
  const foreignTable = await t.call(`${t.otherBase}/tables`, { method: 'POST', cookie: t.owner, data: { name: 'Foreign', columns: [{ name: 'document', type: 'file' }] } });
  const foreignRef = await t.call(`${t.otherBase}/tables/${foreignTable.data.table.id}/rows`, { method: 'POST', cookie: t.owner, data: { rows: [{ values: { document: file.id } }] } }); assert.equal(foreignRef.status, 400);
  const edit = await t.call(`${t.base}/files/${file.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, description: 'Original brochure' } }); assert.equal(edit.status, 200); assert.equal(edit.data.file.revision, 1);
  const stale = await t.call(`${t.base}/files/${file.id}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, name: 'Wrong' } }); assert.equal(stale.status, 409);
  const remove = await t.call(`${t.base}/files/${file.id}`, { method: 'DELETE', cookie: t.owner, data: { revision: 1 } }); assert.equal(remove.status, 200); assert.equal((await t.call(file.download_url, { cookie: t.owner })).status, 404);
});
test('file upload limits and cross-origin checks fail before writing any object', async () => {
  const t = await fixture(); const bytes = new Uint8Array([1, 2]);
  const badOrigin = await t.call(`${t.base}/files`, { method: 'POST', cookie: t.owner, bytes, headers: { 'X-File-Name': 'small.pdf' }, requestOrigin: 'https://other.test' }); assert.equal(badOrigin.status, 403);
  const oversized = await t.call(`${t.base}/files`, { method: 'POST', cookie: t.owner, bytes, headers: { 'X-File-Name': 'large.pdf', 'Content-Length': String(11 * 1024 * 1024) } }); assert.equal(oversized.status, 413); assert.equal(t.objects.size, 0);
});
test('work tasks and timeline evidence are persisted independently of raw data', async () => {
  const t = await fixture(); const state = (await t.call(`/api/organizations/${t.orgId}`, { cookie: t.owner })).data.state;
  const evidence = { statementId: 'rule#1', conceptId: 'rule', conceptLabel: 'Mandat', text: 'Ekspres kræver godkendelse.' };
  state.graph.nodes.push({ id: 'rule', label: 'Mandat', type: 'regel', statements: [{ id: 'rule#1', text: evidence.text }] });
  state.tasks.push({ id: 'S-1', kind: 'case', phase: 'active', ui: [], updates: [{ text: 'Jeg spurgte om ekspres.', at: Date.now(), ui: [], knowledgeEvidence: [evidence] }] });
  const save = await t.call(`/api/organizations/${t.orgId}`, { method: 'PUT', cookie: t.owner, data: { revision: 0, state } }); assert.equal(save.status, 200);
  await t.create();
  const loaded = await t.call(`/api/organizations/${t.orgId}`, { cookie: t.owner }); assert.deepEqual(loaded.data.state.tasks[0].updates[0].knowledgeEvidence, [evidence]); assert.equal(loaded.data.state.graph.nodes.length, 1);
});

test('a human file intake atomically queues one durable case, preserves bytes and retries without duplicate files',async()=>{
  const f=await fixture(),requestId=crypto.randomUUID(),bytes=new TextEncoder().encode('Organisationens dokument med faktiske data.');
  const input={method:'POST',cookie:f.owner,bytes,headers:{'Content-Type':'text/plain','X-File-Name':'viden.txt','X-File-Description':encodeURIComponent('Vores særlige arbejdspraksis'),'X-Finch-Request-Id':requestId}};
  const results=await Promise.all([f.call(f.base+'/file-intakes',input),f.call(f.base+'/file-intakes',input)]);
  for(const r of results)assert.equal(r.status,201,JSON.stringify(r.data));
  assert.equal(results[0].data.case_id,results[1].data.case_id);assert.equal(results[0].data.file.id,results[1].data.file.id);assert.equal(f.objects.size,1);
  const org=(await f.call('/api/organizations/'+f.orgId,{cookie:f.owner})).data,task=org.state.tasks[0];
  assert.equal(org.state.tasks.length,1);assert.equal(task.phase,'active');assert.equal(task.agentWorkStatus,'queued');assert.equal(task.assigneeId,org.work.administratorId);
  assert.equal(task.dataRequest.fileId,results[0].data.file.id);assert.equal(task.dataRequest.description,'Vores særlige arbejdspraksis');assert.deepEqual(org.state.graph.nodes,[]);
  assert.equal(org.state.events[0].type,'data_file_uploaded');assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM data_work_requests').get().n,1);
  const content=await f.call(f.base+'/files/'+task.dataRequest.fileId+'/content',{cookie:f.owner});assert.deepEqual(content.bytes,bytes);
  assert.equal((await f.call(f.base+'/file-intakes',input)).data.case_id,task.id);
  // Agent-authored assets still use the ordinary upload operation and do not recursively queue work.
  assert.equal((await f.call(f.base+'/files',{...input,headers:{'Content-Type':'text/plain','X-File-Name':'agent-output.txt'}})).status,201);
  assert.equal((await f.call('/api/organizations/'+f.orgId,{cookie:f.owner})).data.state.tasks.length,1);
});
test('a table description queues agent work without guessing a schema and concurrent distinct requests preserve both cases',async()=>{
  const f=await fixture(),requestId=crypto.randomUUID(),input={name:'Motorer',description:'Gem model, effekt i kW og moment i Nm.',request_id:requestId};
  const results=await Promise.all([0,1].map(()=>f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:input})));
  for(const r of results)assert.equal(r.status,201);assert.equal(results[0].data.case_id,results[1].data.case_id);
  assert.equal((await f.call(f.base,{cookie:f.owner})).data.tables.length,0);
  const requests=await Promise.all(['Priser','Lastbiler'].map(name=>f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:{...input,name,request_id:crypto.randomUUID()}})));
  for(const r of requests)assert.equal(r.status,201,JSON.stringify(r.data));
  const org=(await f.call('/api/organizations/'+f.orgId,{cookie:f.owner})).data;assert.equal(org.state.tasks.length,3);assert.equal(new Set(org.state.tasks.map(t=>t.id)).size,3);
  assert.deepEqual(org.state.tasks[0].dataRequest,{kind:'table',name:'Motorer',description:input.description,requestedBy:org.work.administratorId,requestId});
  assert.equal(org.state.events.filter(e=>e.type==='data_table_requested').length,3);assert.deepEqual(org.state.graph.nodes,[]);
  const table=await f.create([{name:'model',type:'text',required:true},{name:'power_kw',type:'number',unit:'kW'},{name:'torque_nm',type:'number',unit:'Nm'}]);assert.equal(table.name,'Motorer');
});
test('intake rejects invalid descriptions, cross-account and cross-origin requests, and failed queueing leaves no uploaded object',async()=>{
  const f=await fixture(),input={name:'Motorer',description:'Motorernes navn og specifikationer.',request_id:crypto.randomUUID()};
  for(const cookie of [undefined,f.outsider])assert.equal((await f.call(f.base+'/table-requests',{method:'POST',cookie,data:input})).status,cookie?404:401);
  assert.equal((await f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:input,requestOrigin:'https://other.test'})).status,403);
  assert.equal((await f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:{...input,description:'Kort'}})).status,400);
  assert.equal((await f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:{...input,request_id:'../invalid'}})).status,400);
  assert.equal((await f.call(f.base+'/table-requests',{method:'POST',cookie:f.owner,data:input,headers:{'X-Finch-User':'wrong-user'}})).status,409);
  const org=(await f.call('/api/organizations/'+f.orgId,{cookie:f.owner})).data;org.state.tasks=Array.from({length:5000},(_,i)=>({id:'T-'+i,kind:'task'}));
  assert.equal((await f.call('/api/organizations/'+f.orgId,{method:'PUT',cookie:f.owner,data:{state:org.state,revision:org.organization.revision}})).status,200);
  const upload=await f.call(f.base+'/file-intakes',{method:'POST',cookie:f.owner,bytes:new TextEncoder().encode('No partial file'),headers:{'X-Finch-Request-Id':crypto.randomUUID(),'X-File-Name':'partial.txt'}});assert.equal(upload.status,400);assert.equal(f.objects.size,0);assert.equal((await f.call(f.base,{cookie:f.owner})).data.files.length,0);
});

test('partial row edits retain untouched fields and enforce revision, column types and organisation boundaries',async()=>{
 const t=await fixture(),table=await t.create();const inserted=await t.call(t.base+`/tables/${table.id}/rows`,{method:'POST',cookie:t.owner,data:{rows:[{values:{model:'Demo A',power_kw:200,hybrid:false,available:'2026-10-01',details:{a:1}}}]}});const row=inserted.data.rows[0];
 const updated=await t.call(t.base+`/tables/${table.id}/rows/${row.id}`,{method:'PATCH',cookie:t.owner,data:{revision:row.revision,values:{power_kw:350}}});assert.equal(updated.status,200);assert.deepEqual(updated.data.row.values,{model:'Demo A',power_kw:350,hybrid:false,available:'2026-10-01',details:{a:1}});
 assert.equal((await t.call(t.base+`/tables/${table.id}/rows/${row.id}`,{method:'PATCH',cookie:t.owner,data:{revision:0,values:{model:'Stale'}}})).status,409);
 assert.equal((await t.call(t.base+`/tables/${table.id}/rows/${row.id}`,{method:'PATCH',cookie:t.owner,data:{revision:1,values:{power_kw:'invalid'}}})).status,400);
 assert.equal((await t.call(t.base+`/tables/${table.id}/rows/${row.id}`,{method:'PATCH',cookie:t.outsider,data:{revision:1,values:{power_kw:0}}})).status,404);
 assert.equal((await t.call(t.otherBase+`/tables/${table.id}/rows/${row.id}`,{method:'PATCH',cookie:t.owner,data:{revision:1,values:{power_kw:0}}})).status,404);
});
test('a single row creation retries with the same ID without duplicating or overwriting a previously inserted row',async()=>{
 const t=await fixture(),table=await t.create(),requestId=crypto.randomUUID(),data={request_id:requestId,rows:[{values:{model:'Demo A',power_kw:200}}]};
 const results=await Promise.all([t.call(t.base+`/tables/${table.id}/rows`,{method:'POST',cookie:t.owner,data}),t.call(t.base+`/tables/${table.id}/rows`,{method:'POST',cookie:t.owner,data})]);assert.ok(results.every(r=>[200,201].includes(r.status)));assert.equal(results[0].data.rows[0].id,results[1].data.rows[0].id);
 assert.equal((await t.call(t.base+`/tables/${table.id}/query`,{method:'POST',cookie:t.owner,data:{}})).data.total,1);
 assert.equal((await t.call(t.base+`/tables/${table.id}/rows`,{method:'POST',cookie:t.owner,data:{...data,rows:[{values:{model:'Changed'}}]}})).status,409);
});
