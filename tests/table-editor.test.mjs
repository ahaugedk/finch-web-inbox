import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
function model(){const window={};vm.runInNewContext(readFileSync('table-editor.js','utf8'),{window,structuredClone,Map,Set,Object,JSON,Number,String});return new window.FinchTableEditor.Drafts([{name:'name',label:'Navn',type:'text',required:true},{name:'power',label:'Effekt',type:'number'},{name:'active',label:'Aktiv',type:'boolean'},{name:'meta',label:'Detaljer',type:'json'},{name:'blank',label:'Tom tekst',type:'text'}]);}
const row=(id,revision=0)=>({id,revision,source_url:'https://example.test',values:{name:'Demo',power:200,active:false,meta:{unit:'kW'},blank:''}});
test('row drafts retain typed false, JSON and untouched empty text, and only save the edited row',()=>{
 const m=model();m.ingest([row('a'),row('b')]);m.edit('a','power','350');m.edit('b','name','Anden kladde');const saved=JSON.parse(JSON.stringify(m.payload(m.drafts.get('a'))));assert.deepEqual(saved,{values:{name:'Demo',power:350,active:false,meta:{unit:'kW'},blank:''},source_url:'https://example.test'});m.drafts.delete('a');m.ingest([{...row('a',1),values:saved.values},row('b')]);assert.equal(m.drafts.get('b').changes.name,'Anden kladde');assert.equal(m.payload(m.drafts.get('b')).values.power,200);
});
test('a background update does not move the base revision or overwrite dirty values',()=>{
 const m=model();m.ingest([row('a')]);m.edit('a','power','350');m.ingest([{...row('a',1),values:{...row('a').values,power:280}}]);const d=m.drafts.get('a');assert.equal(d.original.revision,0);assert.equal(d.conflict,true);assert.equal(m.payload(d).values.power,350);assert.equal(m.rows.get('a').values.power,280);
});
test('new row drafts remain when paging, validate required fields and reject bad JSON before saving',()=>{
 const m=model();m.ingest([]);const d=m.add('new','');assert.throws(()=>m.payload(d),/Navn/);m.edit('new','name','Ny motor');m.edit('new','meta','{bad');assert.throws(()=>m.payload(d),/JSON/);m.edit('new','meta','{"tested":true}');m.ingest([row('other')]);assert.equal(m.records().length,2);assert.equal(m.payload(d).values.meta.tested,true);assert.equal(m.payload(d).values.power,null);
});
