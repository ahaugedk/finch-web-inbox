import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { validPages, customPageDocument, PAGE_CSP } from '../server/pages.mjs';

const tableId='11111111-1111-4111-8111-111111111111';
const fileId='33333333-3333-4333-8333-333333333333';
const component={tag_name:'truck-configurator',html:'<p>Lastbiler</p>',css:'p{color:green}',javascript:'finch.ready.then(() => {});'};
function setup() {
  const state={pages:[],agent:'Codex',view:'inbox',tasks:[]};const events=[];
  const window={ORDERLY:{COMPONENTS:{text:'Text'}},addEventListener(){},FinchStorage:{ready:true,organization:{id:'org-a'},flush:async()=>{}},FinchData:{tool:async(name,input)=>{if(name==='get_file'){if(input.file_id!==fileId)throw new Error('Filen findes ikke i organisationen.');return {status:'ok',file:{id:fileId,name:'Produkt.png'}};}if(input.table_id!==tableId)throw new Error('Tabellen findes ikke i organisationen.');return {status:'ok',table:{id:tableId}};}}};
  const document={addEventListener(){},getElementById(){return null;}};
  vm.runInNewContext(readFileSync('pages.js','utf8'),{window,document,crypto:webcrypto,console});
  window.FinchPages.configure({state:()=>state,save(){},render(){},cleanUi:ui=>({nodes:ui,warnings:[]}),open:id=>{state.pageId=id;},addTask:task=>{const t={id:'T-1',...task};state.tasks.push(t);return t;},signal:(type,data)=>events.push({type,...data})});
  return {pages:window.FinchPages,state,events};
}
test('agent page proposals become work items and cannot be built before user approval',async()=>{
  const t=setup();const result=await t.pages.tool('propose_page',{title:'Lastbiler',description:'Sammenlign vores motorvalg.',icon:'truck',table_ids:[tableId]});
  assert.equal(t.state.tasks.length,1);assert.equal(t.state.tasks[0].pageProposalId,result.page_id);
  const input={page_id:result.page_id,revision:0,title:'Lastbiler',icon:'truck',table_ids:[tableId],component};
  await assert.rejects(t.pages.tool('build_page',input),/godkende/);
  t.pages.proposalAnswer(t.state.tasks[0],'approve-page');assert.equal(t.events[0].type,'page_approved');
  t.state.pageId='human-selected-page';
  const built=await t.pages.tool('build_page',{...input,revision:1});assert.equal(built.page.status,'ready');assert.equal(t.state.pages[0].component.tag_name,'truck-configurator');
  assert.equal(t.state.pageId,'human-selected-page');assert.equal(t.state.view,'inbox');
  await assert.rejects(t.pages.tool('build_page',{...input,revision:1}),/ændret/);
});
test('rejected proposals and foreign-table sources cannot produce a page',async()=>{
  const t=setup();await assert.rejects(t.pages.tool('propose_page',{title:'X',description:'Y',icon:'chart',table_ids:['22222222-2222-4222-8222-222222222222']}),/organisationen/);assert.equal(t.state.pages.length,0);
  const result=await t.pages.tool('propose_page',{title:'X',description:'Y',icon:'chart',table_ids:[]});
  t.pages.proposalAnswer(t.state.tasks[0],'reject-page');
  await assert.rejects(t.pages.tool('build_page',{page_id:result.page_id,revision:1,title:'X',icon:'chart',table_ids:[],component}),/godkende/);
});
test('component and kit modes are exclusive, revisions are checked and archiving is reversible',async()=>{
  const t=setup();const p={id:tableId,title:'X',description:'Y',icon:'chart',status:'requested',revision:0,tableIds:[]};t.state.pages.push(p);
  const input={page_id:p.id,revision:0,title:'X',icon:'chart',table_ids:[],component};
  await assert.rejects(t.pages.tool('build_page',{...input,ui:[{type:'text',text:'X'}]}),/enten/);assert.equal(p.status,'requested');
  await t.pages.tool('build_page',{...input,component:undefined,ui:[{type:'text',text:'Org-specific page'}]});assert.equal(p.ui[0].text,'Org-specific page');
  await t.pages.tool('archive_page',{page_id:p.id,revision:1});assert.equal(p.status,'archived');
  await t.pages.tool('restore_page',{page_id:p.id,revision:2});assert.equal(p.status,'ready');
  const read=await t.pages.tool('get_page',{page_id:p.id});assert.equal(read.page.revision,3);
});
test('render document encodes authored markup as data and blocks account, network and parent access',()=>{
  const page={id:tableId,title:'X',status:'ready',tableIds:[],component:{...component,html:'</script><img src=x onerror=alert(1)>'}};
  const html=customPageDocument(page,tableId);
  assert.equal((html.match(/<script>/g)||[]).length,1);
  assert.doesNotMatch(html,/<img src=x/);assert.match(html,/\\u003c\/script>/);
  assert.match(PAGE_CSP,/sandbox allow-scripts/);assert.doesNotMatch(PAGE_CSP,/allow-same-origin|unsafe-eval/);assert.match(PAGE_CSP,/connect-src 'none'/);
  assert.equal(validPages([page]),true);assert.equal(validPages([{...page,tableIds:['foreign']}]),false);
  assert.equal(validPages([{...page,component:{...component,javascript:'x'.repeat(80001)}}]),false);
  assert.equal(validPages(undefined),true);
});

test('explicit file sources persist from proposal to build and foreign files are rejected',async()=>{
  const t=setup();await assert.rejects(t.pages.tool('propose_page',{title:'Dokumenter',description:'Vis filer',icon:'page',file_ids:[tableId]}),/organisationen/);
  const result=await t.pages.tool('propose_page',{title:'Dokumenter',description:'Vis produktfoto',icon:'page',file_ids:[fileId]});t.pages.proposalAnswer(t.state.tasks[0],'approve-page');
  const built=await t.pages.tool('build_page',{page_id:result.page_id,revision:1,title:'Dokumenter',icon:'page',table_ids:[],component});assert.deepEqual(Array.from(built.page.file_ids),[fileId]);
  await assert.rejects(t.pages.tool('build_page',{page_id:result.page_id,revision:2,title:'Dokumenter',icon:'page',table_ids:[],file_ids:[tableId],component}),/organisationen/);
});
test('pages default to local runtime with read-only tables and opt-in agent actions',async()=>{
 const t=setup();const p={id:tableId,title:'Standalone',description:'Local calculator',icon:'calculator',status:'requested',revision:0,tableIds:[tableId]};t.state.pages.push(p);
 const built=await t.pages.tool('build_page',{page_id:p.id,revision:0,title:p.title,icon:'calculator',table_ids:[tableId],component});assert.equal(built.page.runtime,'local');assert.deepEqual(Array.from(built.page.writable_table_ids),[]);assert.equal(built.page.agent_action,null);
 await assert.rejects(t.pages.tool('build_page',{page_id:p.id,revision:1,title:p.title,icon:'calculator',table_ids:[tableId],writable_table_ids:[fileId],component}),/delmængde/);
 const opt=await t.pages.tool('build_page',{page_id:p.id,revision:1,title:p.title,icon:'calculator',table_ids:[tableId],writable_table_ids:[tableId],agent_action:{name:'Analyse',label:'Bed agenten om analyse'},component});assert.deepEqual(Array.from(opt.page.writable_table_ids),[tableId]);assert.equal(opt.page.agent_action.label,'Bed agenten om analyse');assert.equal(t.events.length,0);
});
test('dashboard UI controls must bind to a declared table before any page state is changed',async()=>{
 const t=setup();t.state.pages.push({id:crypto.randomUUID(),title:'Dashboard',description:'Our data',tableIds:[tableId],fileIds:[],status:'requested',revision:0});const p=t.state.pages[0];
 const input={page_id:p.id,revision:0,title:'Dashboard',icon:'chart',table_ids:[tableId],ui:[{type:'chart',binding:{table_id:fileId,x:'model',y:['power']}}]};
 await assert.rejects(t.pages.tool('build_page',input),/valgte tabeller/);assert.equal(p.status,'requested');
 input.ui[0].binding.table_id=tableId;assert.equal((await t.pages.tool('build_page',input)).page.status,'ready');
});
