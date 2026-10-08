import test from 'node:test';
import assert from 'node:assert/strict';
import '../data-controls.js';
import {customPageDocument} from '../server/pages.mjs';
const library=globalThis.FinchControlLibrary,id='11111111-1111-4111-8111-111111111111';
test('dashboard bindings constrain configuration, retain typed queries and cannot substitute another table through query',()=>{
 const input={binding:{table_id:id,x:'month',y:['sales'],query:{table_id:'foreign',filters:[{column:'sales',op:'gte',value:10}]},max_rows:100000}};
 const c=library.normalize('chart',input);assert.deepEqual(library.normalize('chart',c),c);assert.deepEqual(library.normalize('data_grid',library.normalize('data_grid',{binding:{table_id:id}})),library.normalize('data_grid',{binding:{table_id:id}}));assert.equal(c.binding.max_rows,10000);assert.equal(c.binding.query.table_id,undefined);assert.equal(c.binding.query.filters[0].value,10);input.binding.query.filters[0].value=0;assert.equal(c.binding.query.filters[0].value,10);
 assert.throws(()=>library.normalize('chart',{binding:{table_id:id,x:'month',y:['sales; DROP TABLE users']}}));
 assert.throws(()=>library.normalize('chart',{binding:{table_id:'https://other.test',x:'month',y:['sales']}}));
 assert.throws(()=>library.normalize('metric',{binding:{table_id:id,aggregation:'sum'}}));assert.equal(library.normalize('metric',{binding:{table_id:id,aggregation:'count'}}).binding.aggregation,'count');
});
test('table rows aggregate by category without converting absent data to zero, and keep negative numeric values',()=>{
 const rows=[{values:{month:'Jan',sales:10}},{values:{month:'Jan',sales:20}},{values:{month:'Feb',sales:-5}},{values:{month:'Mar',sales:null}},{values:{month:'Mar',sales:'12'}}];
 const binding={x:'month',y:['sales'],aggregation:'sum'};assert.deepEqual(library.series(rows,binding).groups.map(g=>g.values.sales),[30,-5,null]);assert.deepEqual(library.series(rows,{...binding,aggregation:'avg'}).groups.map(g=>g.values.sales),[15,-5,null]);assert.deepEqual(library.series(rows,{...binding,aggregation:'count'}).groups.map(g=>g.values.__count),[2,1,2]);
 const label='<img src=x onerror=alert(1)>';assert.equal(library.series([{values:{month:label,sales:2}}],binding).groups[0].key,label);
});
test('dashboard libraries are passed into the sandbox as encoded source without breaking document boundaries',()=>{
 const page={id,component:{tag_name:'test-dashboard',html:'',css:'',javascript:''}};
 const html=customPageDocument(page,'token',{revision:0,theme:{},stylesheet:'',logo:null,fonts:[]},{scripts:['/* </script><script>alert(1)</script> */'],css:'/* </script> */'});
 assert.ok(!html.includes('/* </script>'));assert.match(html,/FinchControlLibrary.install\(finch\)/);assert.match(html,/dashboardLibraries/);
});
