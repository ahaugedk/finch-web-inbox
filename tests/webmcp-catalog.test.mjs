import test from 'node:test';
import assert from 'node:assert/strict';
import {loadToolCatalog} from './helpers/tool-catalog.mjs';

const json=value=>JSON.parse(JSON.stringify(value));
const setup=loadToolCatalog();
test('the actual WebMCP catalog fits conservative size budgets without removing operations',t=>{
  const {catalog,tools,api}=setup,metrics=api.measure(catalog.definitions);
  t.diagnostic(JSON.stringify(metrics));
  assert.equal(catalog.definitions.length,tools.length);
  assert.ok(metrics.bytes<=api.budget.bytes,`Catalog has ${metrics.bytes} bytes; budget ${api.budget.bytes}`);
  assert.ok(metrics.largestToolBytes<=api.budget.toolBytes);
  assert.ok(metrics.maxDescriptionChars<=api.budget.descriptionChars);
  assert.deepEqual(catalog.definitions.map(t=>t.name),tools.map(t=>t.name));
  for(const name of ['start_conversation','wait_for_login','get_state','wait_for_user','build_page','add_knowledge','edit_row','get_tool_help'])assert.ok(catalog.definitions.some(t=>t.name===name));
});

test('compaction preserves every validation keyword, annotation and field named description',()=>{
  const {catalog,tools}=setup;
  const erase=v=>Array.isArray(v)?v.map(erase):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k,x])=>!(k==='description'&&typeof x==='string')).map(([k,x])=>[k,erase(x)])):v;
  for(const tool of tools){const compact=catalog.definitions.find(t=>t.name===tool.name);assert.deepEqual(json(compact.inputSchema),json(erase(tool.inputSchema)));assert.deepEqual(json(compact.annotations||{}),json(tool.annotations||{}));}
  const table=catalog.definitions.find(t=>t.name==='create_table');assert.equal(table.inputSchema.properties.description.type,'string');assert.equal(table.inputSchema.properties.description.maxLength,1000);
  assert.equal(catalog.definitions.find(t=>t.name==='add_knowledge').inputSchema.properties.concepts.items.properties.statements.items.properties.organization_specific_reason.minLength,20);
});

test('get_tool_help exposes complete original documentation on demand and cannot mutate the catalog',()=>{
  const {catalog,tools,briefing}=setup;
  const help=tools.find(t=>t.name==='get_tool_help');
  const result=help.run({tool_name:'post_task'});
  assert.equal(result.status,'ok');assert.ok(result.tool.inputSchema.properties.ui.description.includes(briefing.components.chart));
  assert.ok(help.run({tool_name:'build_page'}).tool.description.includes('finch.renderPdfPage'));
  result.tool.inputSchema.properties.ui.maxItems=999;
  assert.equal(catalog.help('post_task').inputSchema.properties.ui.maxItems,30);
  assert.equal(help.run({tool_name:'not_a_tool'}).status,'error');
});
