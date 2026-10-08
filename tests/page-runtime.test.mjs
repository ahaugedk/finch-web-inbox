import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
import {customPageDocument} from '../server/pages.mjs';
const ORIGIN='https://finch.test';
async function fixture(){
 const DB=sqliteD1();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
 const env={DB,AUTH_SECRET:'page-runtime-test-secret-at-least-thirty-two-chars'};let code;
 async function call(path,cookie,method='GET',data,origin=ORIGIN,headers={}){const response=await handleApi(new Request(ORIGIN+path,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:{})}),env,{sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{}});return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};}
 async function login(email){const start=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:start.data.challengeId,code})).cookie;}
 const owner=await login('owner@example.test'),member=await login('member@example.test'),outsider=await login('outsider@example.test');
 const org=(await call('/api/organizations',owner,'POST',{name:'Standalone pages'})).data.organization.id,base='/api/organizations/'+org,pageId=crypto.randomUUID();
 const invite=await call(base+'/settings/members',owner,'POST',{email:'member@example.test',inGraph:false});await call('/api/invitations/'+invite.data.id+'/accept',member,'POST',{});
 const table=(await call(base+'/data/tables',owner,'POST',{name:'Orders',columns:[{name:'title',type:'text',required:true}]})).data.table;
 const second=(await call(base+'/data/tables',owner,'POST',{name:'Other',columns:[{name:'title',type:'text'}]})).data.table;
 async function save(edit){const loaded=await call(base,owner);edit(loaded.data.state);assert.equal((await call(base,owner,'PUT',{state:loaded.data.state,revision:loaded.data.organization.revision})).status,200);}
 await save(s=>s.pages=[{id:pageId,title:'Calculator',description:'A deterministic page',status:'ready',revision:0,tableIds:[table.id],writableTableIds:[],fileIds:[],values:{quantity:2},icon:'calculator',ui:[{type:'number',id:'quantity',label:'Antal',value:2}]}]);
 const pageBase=base+'/pages/'+pageId;
 const values=(cookie,value,revision=0,pageRevision=0)=>call(pageBase+'/state',cookie,'PUT',{values:value,revision,page_revision:pageRevision});
 const data=(operation,input,cookie=owner,pageRevision=0)=>call(pageBase+'/data',cookie,'POST',{operation,input,page_revision:pageRevision});
 return {DB,call,owner,member,outsider,base,pageBase,pageId,table,second,save,values,data,memberId:invite.data.id};
}
test('personal page state persists separately from agent snapshots without creating work or events',async()=>{
 const f=await fixture(),before=(await f.call(f.base,f.owner)).data;
 assert.equal((await f.values(f.owner,{quantity:7})).status,200);assert.equal((await f.values(f.member,{quantity:3})).status,200);
 assert.deepEqual((await f.call(f.pageBase+'/state',f.owner)).data.values,{quantity:7});assert.deepEqual((await f.call(f.pageBase+'/state',f.member)).data.values,{quantity:3});
 const after=(await f.call(f.base,f.owner)).data;assert.equal(after.organization.revision,before.organization.revision);assert.deepEqual(after.state.tasks,[]);assert.deepEqual(after.state.events,[]);assert.deepEqual(after.state.pages[0].values,{quantity:2});
 await f.save(s=>s.workspace.tagline='An agent changed unrelated organisation knowledge');assert.deepEqual((await f.call(f.pageBase+'/state',f.owner)).data.values,{quantity:7});
 assert.equal((await f.values(f.owner,{quantity:8},1)).status,200);assert.equal((await f.values(f.owner,{quantity:9},1)).status,409);
 assert.equal((await f.call(f.pageBase+'/state',f.outsider)).status,404);assert.equal((await f.call(f.pageBase+'/state',null)).status,401);
 assert.equal((await f.values(f.owner,{large:'x'.repeat(33000)},2)).status,413);
 assert.equal((await f.call(f.pageBase+'/state',f.owner,'PUT',{values:{quantity:1},revision:2,page_revision:0},'https://evil.test')).status,403);
 const memberId=(await f.call('/api/me',f.member)).data.user.id;assert.equal((await f.call(f.pageBase+'/state',f.owner,'PUT',{values:{quantity:1},revision:2,page_revision:0},ORIGIN,{'X-Finch-User':memberId})).status,409);
});
test('concurrent page saves reject stale values and rebuilt or archived pages cannot accept old writes',async()=>{
 const f=await fixture();const results=await Promise.all([1,2].map(quantity=>f.values(f.owner,{quantity})));assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
 await f.save(s=>s.pages[0].revision=1);assert.equal((await f.values(f.owner,{quantity:4},1,0)).status,409);assert.equal((await f.values(f.owner,{quantity:4},1,1)).status,200);
 await f.save(s=>s.pages[0].status='archived');assert.equal((await f.call(f.pageBase+'/state',f.owner)).status,404);assert.equal((await f.values(f.owner,{quantity:1},2,1)).status,404);
});
test('standalone data operations enforce current read/write scopes, row revisions and schema boundaries',async()=>{
 const f=await fixture();assert.equal((await f.data('get_table',{table_id:f.table.id})).status,200);
 assert.equal((await f.data('get_table',{table_id:f.second.id})).status,403);assert.equal((await f.data('insert_rows',{table_id:f.table.id,rows:[{values:{title:'One'}}]})).status,403);
 await f.save(s=>s.pages[0].writableTableIds=[f.table.id]);const inserted=await f.data('insert_rows',{table_id:f.table.id,rows:[{values:{title:'One'}}]});assert.equal(inserted.status,201);const row=inserted.data.rows[0];
 assert.equal((await f.data('get_row',{table_id:f.table.id,row_id:row.id},f.member)).status,200);
 assert.equal((await f.data('update_row',{table_id:f.table.id,row_id:row.id,revision:0,values:{title:'Two'}},f.member)).status,200);
 assert.equal((await f.data('update_row',{table_id:f.table.id,row_id:row.id,revision:0,values:{title:'Stale'}})).status,409);
 assert.equal((await f.data('create_table',{table_id:f.table.id})).status,400);assert.equal((await f.data('query_table',{table_id:f.table.id,filters:[{column:'title; DROP TABLE users',op:'eq',value:'Two'}]})).status,400);
 assert.equal((await f.data('delete_row',{table_id:f.table.id,row_id:row.id,revision:1})).status,200);
 assert.deepEqual((await f.call(f.base,f.owner)).data.state.events,[]);assert.deepEqual((await f.call(f.base,f.owner)).data.state.tasks,[]);
 await f.save(s=>s.pages[0].writableTableIds=[]);assert.equal((await f.data('insert_rows',{table_id:f.table.id,rows:[{values:{title:'Three'}}]})).status,403);
});
test('explicit agent requests return queued work immediately and are idempotent across concurrent retries',async()=>{
 const f=await fixture(),requestId=crypto.randomUUID(),input={page_revision:0,request_id:requestId,name:'Review this configuration',values:{quantity:7}};
 const requests=await Promise.all([0,1].map(()=>f.call(f.pageBase+'/agent-requests',f.member,'POST',input)));
 assert.equal(requests[0].status,200);assert.equal(requests[1].status,200);assert.equal(requests[0].data.case_id,requests[1].data.case_id);
 const loaded=(await f.call(f.base,f.owner)).data;assert.equal(loaded.state.tasks.length,1);const task=loaded.state.tasks[0];assert.equal(task.phase,'active');assert.equal(task.agentWorkStatus,'queued');assert.deepEqual(task.pageRequest.values,{quantity:7});assert.equal(task.assigneeId,loaded.work.administratorId);
 assert.equal(loaded.state.events.filter(e=>e.type==='page_agent_requested').length,1);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM page_agent_requests').get().n,1);
 assert.equal((await f.call(f.pageBase+'/agent-requests',f.member,'POST',input)).data.case_id,task.id);
 await f.save(s=>s.pages[0].status='archived');assert.equal((await f.call(f.pageBase+'/agent-requests',f.member,'POST',{...input,request_id:crypto.randomUUID()})).status,404);
});
test('revoked members cannot save values, operate tables or queue agent requests',async()=>{
 const f=await fixture();await f.values(f.member,{quantity:1});const team=(await f.call(f.base+'/settings',f.owner)).data;const member=team.members.find(m=>m.id===f.memberId);await f.call(f.base+'/settings/members/'+member.id,f.owner,'DELETE',{revision:member.revision});
 assert.equal((await f.values(f.member,{quantity:2},1)).status,404);assert.equal((await f.data('get_table',{table_id:f.table.id},f.member)).status,404);
 assert.equal((await f.call(f.pageBase+'/agent-requests',f.member,'POST',{name:'Work',values:{},request_id:crypto.randomUUID(),page_revision:0})).status,404);
});
test('local component events are synchronous and do not send RPCs; saves serialize independently and agent work is explicit',async()=>{
 const id=crypto.randomUUID(),listeners=new Map(),requests=[],parent={postMessage:m=>requests.push(m)},window={};
 const document={querySelector:()=>null,createElement:()=>({append(){},textContent:''}),head:{append(){}},body:{append(){}}};
 const sandbox={window,parent,document,addEventListener:(name,fn)=>listeners.set(name,fn),customElements:{get:()=>true},HTMLElement:class{},setTimeout:()=>1,clearTimeout(){},navigator:{userActivation:{isActive:false}},crypto,Blob,Uint8Array,URL};
 vm.runInNewContext(customPageDocument({id,values:{a:2},component:{tag_name:'local-calculator',html:'',css:'',javascript:''}},id).match(/<script>([\s\S]*)<\/script>/)[1],sandbox);const api=window.finch;let result;
 api.on('calculate',values=>result=values.a*values.b);const local=api.emit('calculate',{a:4,b:5});assert.equal(result,20);assert.equal(local.local,true);assert.equal(requests.length,0);assert.equal(api.values.a,4);
 await assert.rejects(api.requestAgent('Work'),/brugerklik/);assert.equal(requests.length,0);
 const save=api.saveValues({a:5}),save2=api.saveValues({a:6});await Promise.resolve();await Promise.resolve();assert.equal(requests.length,1);assert.equal(requests[0].method,'save_values');
 const deliver=(request,result)=>listeners.get('message')({source:parent,data:{channel:'finch-page-result',token:id,id:request.id,result}});
 deliver(requests[0],{status:'saved',revision:1});await save;await Promise.resolve();await Promise.resolve();assert.equal(requests.length,2);assert.equal(requests[1].input.revision,1);deliver(requests[1],{status:'saved',revision:2});await save2;assert.equal(api.values.a,6);
 sandbox.navigator.userActivation.isActive=true;const work=api.requestAgent('Work',{a:6});assert.equal(requests.at(-1).method,'request_agent');deliver(requests.at(-1),{status:'queued',case_id:'S-201'});assert.equal((await work).status,'queued');
});
