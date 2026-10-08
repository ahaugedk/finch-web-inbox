import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
const ORIGIN='https://finch.test';
async function fixture(){
  const DB=sqliteD1();for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const env={DB,AUTH_SECRET:'notification-test-secret-at-least-thirty-two-chars'};let code;
  async function call(route,cookie,method='GET',data,origin=ORIGIN){const res=await handleApi(new Request(ORIGIN+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),env,{sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{}});return {status:res.status,data:await res.json(),cookie:res.headers.get('Set-Cookie')?.split(';')[0]};}
  async function login(email){const challenge=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:challenge.data.challengeId,code})).cookie;}
  const owner=await login('owner@example.test'),member=await login('member@example.test'),outsider=await login('outsider@example.test');
  const created=await call('/api/organizations',owner,'POST',{name:'Testorganisation'});const org=created.data.organization.id,base=`/api/organizations/${org}`;
  const role=await call(base+'/settings/roles',owner,'POST',{title:'Motoransvarlig',description:'Godkender motorvalget i organisationens konkrete projekt.'});
  const invite=await call(base+'/settings/members',owner,'POST',{email:'member@example.test',name:'Maja',roleId:role.data.id,inGraph:false});
  await call(`/api/invitations/${invite.data.id}/accept`,member,'POST',{});
  const loaded=await call(base,owner);const candidate=loaded.data.work.members.find(m=>!m.isAdministrator);
  const assigned={assigneeId:candidate.assigneeId,assignmentReason:'Motorvalget skal godkendes efter medlemmets ansvar.',assignmentEvidence:[{statementId:candidate.statementIds[0]}]};
  async function save(edit){const current=await call(base,owner);edit(current.data.state);const saved=await call(base,owner,'PUT',{state:current.data.state,revision:current.data.organization.revision});assert.equal(saved.status,200);}
  const poll=cookie=>call('/api/notifications',cookie,'POST',{});
  const setting=(cookie,enabled)=>call(base+'/notifications',cookie,'PUT',{enabled});
  return {DB,call,login,owner,member,outsider,org,base,assigned,save,poll,setting,memberId:invite.data.id};
}
const task=(id,extra={})=>({id,kind:'task',title:'Hemmeligt motorvalg',from:'Agenten',ui:[],draft:{},response:null,read:false,...extra});
test('personal preferences default off, persist in D1, and enabling seeds old work without alerts',async()=>{
  const f=await fixture();await f.save(s=>s.tasks.push(task('T-1')));
  assert.deepEqual((await f.call(f.base+'/notifications',f.owner)).data,{enabled:false});
  assert.equal((await f.poll(f.owner)).data.organizations[0].newTaskIds.length,0);
  assert.equal((await f.setting(f.owner,true)).status,200);assert.equal((await f.poll(f.owner)).data.organizations[0].newTaskIds.length,0);
  await f.save(s=>s.tasks.push(task('T-2')));
  const summary=(await f.call('/api/notifications',f.owner)).data.organizations[0];assert.equal(summary.count,2);assert.deepEqual(summary.newTaskIds,[]);assert.equal(JSON.stringify(summary).includes('Hemmeligt'),false);
  const races=await Promise.all([f.poll(f.owner),f.poll(f.owner)]);assert.deepEqual(races.flatMap(r=>r.data.organizations[0].newTaskIds),['T-2']);
  assert.deepEqual((await f.poll(f.owner)).data.organizations[0].newTaskIds,[]);
  f.DB.sqlite.exec('UPDATE rate_limits SET expires_at=0');const again=await f.login('owner@example.test');assert.equal((await f.call(f.base+'/notifications',again)).data.enabled,true);
  assert.deepEqual((await f.poll(again)).data.organizations[0].newTaskIds,[]);
  await f.setting(again,false);await f.save(s=>s.tasks.push(task('T-3')));assert.deepEqual((await f.poll(again)).data.organizations[0].newTaskIds,[]);
});
test('notifications follow current assignments and distinguish waiting human work from agent work and read information',async()=>{
  const f=await fixture();await f.setting(f.owner,true);await f.setting(f.member,true);
  await f.save(s=>s.tasks.push(task('T-1'),task('T-2',f.assigned),task('S-1',{kind:'case',phase:'active'}),task('T-3',{agentWorkStatus:'working'}),task('T-4',{response:{seen:false}}),task('T-5',{kind:'info',read:true}),task('T-6',{kind:'info',read:false})));
  assert.deepEqual((await f.poll(f.owner)).data.organizations[0].newTaskIds,['T-1','T-6']);assert.deepEqual((await f.poll(f.member)).data.organizations[0].newTaskIds,['T-2']);
  let loaded=(await f.call(f.base,f.owner)).data;
  assert.equal((await f.call(f.base+'/work/T-1/assignment',f.owner,'PUT',{...f.assigned,assignmentStatementIds:[f.assigned.assignmentEvidence[0].statementId],revision:loaded.organization.revision,assignmentRevision:0})).status,200);
  assert.deepEqual((await f.poll(f.owner)).data.organizations[0].newTaskIds,[]);assert.deepEqual((await f.poll(f.member)).data.organizations[0].newTaskIds,['T-1']);
  await f.save(s=>s.tasks.find(t=>t.id==='T-2').title='Ændret spørgsmål');assert.deepEqual((await f.poll(f.member)).data.organizations[0].newTaskIds,['T-2']);
  await f.save(s=>s.tasks.find(t=>t.id==='T-2').agentWorkStatus='working');await f.poll(f.member);
  await f.save(s=>s.tasks.find(t=>t.id==='T-2').agentWorkStatus=null);assert.deepEqual((await f.poll(f.member)).data.organizations[0].newTaskIds,['T-2']);
});
test('all enabled organisations are checked without switching and preference access is isolated and revoked immediately',async()=>{
  const f=await fixture();await f.setting(f.member,true);await f.setting(f.owner,true);
  const other=await f.call('/api/organizations',f.owner,'POST',{name:'Anden organisation'}),base2=`/api/organizations/${other.data.organization.id}`;
  await f.call(base2+'/notifications',f.owner,'PUT',{enabled:true});const second=await f.call(base2,f.owner);second.data.state.tasks.push(task('T-100'));
  await f.call(base2,f.owner,'PUT',{state:second.data.state,revision:second.data.organization.revision});
  const notices=(await f.poll(f.owner)).data.organizations;assert.equal(notices.length,2);assert.deepEqual(notices.find(o=>o.id===other.data.organization.id).newTaskIds,['T-100']);
  assert.equal((await f.call(f.base+'/notifications',f.outsider)).status,404);assert.equal((await f.setting(f.outsider,true)).status,404);assert.deepEqual((await f.poll(f.outsider)).data.organizations,[]);
  assert.equal((await f.call('/api/notifications',null,'POST',{})).status,401);assert.equal((await f.call('/api/notifications',f.owner,'POST',{},'https://evil.test')).status,403);
  assert.equal((await f.setting(f.owner,'yes')).status,400);
  const team=await f.call(f.base+'/settings',f.owner);const member=team.data.members.find(m=>m.id===f.memberId);
  assert.equal((await f.call(f.base+`/settings/members/${f.memberId}`,f.owner,'DELETE',{revision:member.revision})).status,200);
  assert.deepEqual((await f.poll(f.member)).data.organizations,[]);assert.equal((await f.call(f.base+'/notifications',f.member)).status,404);
});
function clientFixture(permission='default'){
  const listeners=new Map(),elements=new Map(),calls=[],notifications=[];let poll,requested=0,enabled=false,ids=[];
  const org={id:'11111111-1111-1111-1111-111111111111',name:'Test'},user={id:'owner'},state={tasks:[]};
  const storage={user,organization:org,organizations:[org],ready:true,sessionUrl:ORIGIN+'/?org='+org.id,reloadCurrent:async()=>{}};
  class MockNotification{static permission=permission;static async requestPermission(){requested++;if(permission==='pending')return new Promise(()=>{});return MockNotification.permission;}constructor(title,options){notifications.push({title,options});}close(){}}
  const document={title:'finch',hidden:true,body:{appendChild:e=>elements.set(e.id,e)},getElementById:id=>elements.get(id),createElement:()=>({setAttribute(){},hidden:false}),addEventListener:(name,fn)=>listeners.set(name,fn)};
  elements.set('notification-settings',{innerHTML:''});
  const window={FinchStorage:storage,FinchWork:{mine:()=>true,phase:()=> 'open'},Notification:MockNotification,isSecureContext:true,addEventListener:(name,fn)=>listeners.set(name,fn),focus(){}};
  const sandbox={window,Notification:MockNotification,navigator:{},document,URL,location:{href:ORIGIN+'/',origin:ORIGIN},history:{replaceState(){}},AbortSignal,setTimeout:(fn,ms)=>{if(permission==='pending'&&ms===20000){queueMicrotask(fn);return;}return setTimeout(fn,ms);},clearTimeout,setInterval:fn=>poll=fn,fetch:async(path,init)=>{
    calls.push({path,method:init.method});
    if(path.endsWith('/notifications')&&path.startsWith('/api/organizations/')){if(init.method==='PUT')enabled=JSON.parse(init.body).enabled;return Response.json({enabled});}
    return Response.json({organizations:[{...org,enabled,count:ids.length,waitingIds:ids,newTaskIds:init.method==='POST'?ids:[]}]});
  }};
  vm.runInNewContext(readFileSync('notifications.js','utf8'),sandbox);const api=window.FinchNotifications;const opened=[];
  api.configure({state:()=>state,open:id=>opened.push(id),toast(){}});
  const settle=async()=>{for(let i=0;i<6;i++)await new Promise(resolve=>setImmediate(resolve));};
  const click=action=>listeners.get('click')({target:{closest:()=>({dataset:{notification:action}})}});
  return {window,document,storage,api,listeners,elements,calls,notifications,opened,settle,click,poll:()=>poll(),setIds:value=>ids=value,requested:()=>requested};
}
test('background fallback updates the title and shows a banner without consuming native alerts or prompting automatically',async()=>{
  const f=clientFixture();f.listeners.get('finch-account-change')();await f.settle();assert.equal(f.requested(),0);
  f.setIds(['T-1']);await f.poll();assert.match(f.elements.get('notification-banner').innerHTML,/ny opgave/);assert.match(f.document.title,/^\(1\)/);
  assert.equal(f.calls.some(c=>c.path==='/api/notifications'&&c.method==='POST'),false);assert.equal(f.notifications.length,0);
  f.api.paint();assert.match(f.elements.get('notification-settings').innerHTML,/Slå notifikationer til/);
});
test('permission is requested only from a click, denied permission is not saved, and granted notifications contain no task contents',async()=>{
  const denied=clientFixture('denied');denied.listeners.get('finch-account-change')();await denied.settle();await denied.click('enable');assert.equal(denied.requested(),1);
  assert.equal(denied.calls.some(c=>c.method==='PUT'),false);assert.match(denied.elements.get('notification-settings').innerHTML,/ikke tilladelse/);
  const f=clientFixture('granted');f.listeners.get('finch-account-change')();await f.settle();await f.click('enable');await f.settle();f.setIds(['T-1']);await f.poll();
  assert.equal(f.notifications.length,1);assert.equal(f.notifications[0].options.data.taskId,'T-1');assert.equal(f.notifications[0].options.body,'Der venter arbejde på dig i Finch.');
  await f.click('disable');const before=f.calls.filter(c=>c.method==='POST').length;await f.poll();assert.equal(f.calls.filter(c=>c.method==='POST').length,before);
});
test('an embedded browser that never answers permission cannot leave the settings stuck or enabled',async()=>{
  const f=clientFixture('pending');f.listeners.get('finch-account-change')();await f.settle();await f.click('enable');
  assert.match(f.elements.get('notification-settings').innerHTML,/Browseren svarede ikke/);assert.equal(f.calls.some(c=>c.method==='PUT'),false);
  assert.doesNotMatch(f.elements.get('notification-settings').innerHTML,/ disabled/);
});
test('service worker clicks focus an organisation tab or open a same-origin authenticated deep link, without caching work',async()=>{
  const handlers=new Map(),opened=[],messages=[];let focused=0,closed=0,tabs=[];
  const org='11111111-1111-1111-1111-111111111111';
  const self={location:{origin:ORIGIN},addEventListener:(name,fn)=>handlers.set(name,fn),clients:{claim:async()=>{},matchAll:async()=>tabs,openWindow:async url=>opened.push(url)},skipWaiting(){}};
  vm.runInNewContext(readFileSync('notification-sw.js','utf8'),{self,URL});
  const click=async data=>{let waiting;handlers.get('notificationclick')({notification:{data,close:()=>closed++},waitUntil:p=>waiting=p});await waiting;};
  await click({orgId:org,taskId:'T-1',url:'https://evil.test/'});assert.equal(opened[0],ORIGIN+'/?org='+org+'&task=T-1');
  tabs=[{url:ORIGIN+'/?org='+org,focus:async()=>focused++,postMessage:m=>messages.push(m)}];await click({orgId:org,taskId:'T-1',userId:'owner'});
  assert.equal(focused,1);assert.equal(messages[0].type,'finch-notification-open');assert.equal(messages[0].userId,'owner');assert.equal(opened.length,1);
  await click({orgId:'https://evil.test/'});assert.equal(focused,1);assert.equal(closed,3);assert.equal(handlers.has('fetch'),false);
});
