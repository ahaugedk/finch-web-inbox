import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
import {workPhase} from '../server/work.mjs';
const ORIGIN='https://finch.test';
async function fixture(){
  const DB=sqliteD1();for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const env={DB,AUTH_SECRET:'work-test-secret-at-least-thirty-two-chars'};let code;
  async function call(route,cookie,method='GET',data){const res=await handleApi(new Request(ORIGIN+route,{method,headers:{Origin:ORIGIN,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),env,{sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{}});return {status:res.status,data:await res.json(),cookie:res.headers.get('Set-Cookie')?.split(';')[0]};}
  async function login(email){const challenge=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:challenge.data.challengeId,code})).cookie;}
  const owner=await login('owner@example.test'),member=await login('member@example.test'),outsider=await login('outsider@example.test');
  const created=await call('/api/organizations',owner,'POST',{name:'Truck project'});const base=`/api/organizations/${created.data.organization.id}`;
  const role=await call(base+'/settings/roles',owner,'POST',{title:'Motoransvarlig',description:'Maja godkender motorvalg og effektkrav i vores konkrete lastbilprojekt.'});
  const invite=await call(base+'/settings/members',owner,'POST',{email:'member@example.test',name:'Maja',roleId:role.data.id,inGraph:false});
  await call(`/api/invitations/${invite.data.id}/accept`,member,'POST',{});
  const load=cookie=>call(base,cookie);const save=(cookie,state,revision)=>call(base,cookie,'PUT',{state,revision});
  const loaded=await load(owner);const candidate=loaded.data.work.members.find(m=>!m.isAdministrator);
  const assigned={assigneeId:candidate.assigneeId,assignmentReason:'Motorvalget skal godkendes af Maja efter hendes beskrevne ansvar.',assignmentEvidence:[{statementId:candidate.statementIds[0],text:'Untrusted caller text'}]};
  return {DB,call,owner,member,outsider,base,load,save,candidate,assigned,memberId:invite.data.id};
}
const task=(id,extra={})=>({id,kind:'task',title:'Godkend motorvalg',from:'Agenten',ui:[],draft:{},response:null,read:false,...extra});
test('work routing uses active role statements, persists a historical basis, and defaults to the founder',async()=>{
  const f=await fixture();let loaded=await f.load(f.owner);const {work}=loaded.data;
  assert.equal(work.viewerId,work.administratorId);assert.equal(f.candidate.inGraph,false);
  assert.equal(loaded.data.state.graph.nodes.some(n=>n.type==='person'),false);
  loaded.data.state.tasks=[task('T-1'),task('T-2',f.assigned)];loaded.data.state.view='organization';loaded.data.state.organizationMember=f.candidate.assigneeId;
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,200);
  loaded=await f.load(f.member);assert.equal(loaded.data.work.viewerId,f.candidate.assigneeId);assert.equal(loaded.data.state.view,'inbox');assert.equal(loaded.data.state.organizationMember,undefined);
  const t=loaded.data.state.tasks[1];assert.equal(t.assigneeId,f.candidate.assigneeId);assert.equal(t.assignmentRevision,0);assert.equal(t.assignmentEvidence[0].text,f.candidate.roleDescription);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS count FROM task_assignments').get().count,1);
  const settings=await f.call(f.base+'/settings',f.owner);const role=settings.data.roles[0];
  await f.call(f.base+`/settings/roles/${role.id}`,f.owner,'PUT',{revision:role.revision,title:role.title,description:'Maja har nu ansvar for andre produktvalg i organisationen.'});
  loaded=await f.load(f.owner);assert.equal(loaded.data.state.tasks[1].assignmentEvidence[0].text,f.candidate.roleDescription);
  const m=(await f.call(f.base+'/settings',f.owner)).data.members.find(m=>m.id===f.memberId);
  assert.equal((await f.call(f.base+`/settings/members/${m.id}`,f.owner,'DELETE',{revision:m.revision})).status,200);
  loaded=await f.load(f.owner);assert.equal(loaded.data.state.tasks[1].assigneeId,work.administratorId);assert.match(loaded.data.state.tasks[1].assignmentReason,/ikke længere medlem/);
});
test('only the assignee can submit human answers; other members can read the overview and process an answer',async()=>{
  const f=await fixture();let loaded=await f.load(f.owner);loaded.data.state.tasks=[task('T-1'),task('T-2',f.assigned)];await f.save(f.owner,loaded.data.state,loaded.data.organization.revision);
  loaded=await f.load(f.owner);loaded.data.state.tasks[1].response={values:{motor:'D13'},via:'ui',at:1,seen:false};
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,403);
  loaded=await f.load(f.member);loaded.data.state.tasks[0].draft={motor:'D13'};
  assert.equal((await f.save(f.member,loaded.data.state,loaded.data.organization.revision)).status,403);
  loaded=await f.load(f.member);loaded.data.state.tasks[1].response={values:{motor:'D13'},via:'ui',at:1,seen:false};loaded.data.state.tasks[1].agentWorkStatus='working';
  assert.equal((await f.save(f.member,loaded.data.state,loaded.data.organization.revision)).status,200);
  loaded=await f.load(f.owner);assert.equal(workPhase(loaded.data.state.tasks[1]),'active');loaded.data.state.tasks[1].response.seen=true;
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,200);
  loaded=await f.load(f.owner);assert.equal(workPhase(loaded.data.state.tasks[1]),'active');loaded.data.state.tasks[1].agentWorkStatus='done';loaded.data.state.tasks[1].agentResult={summary:'Motorvalget er behandlet.'};
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,200);
  loaded=await f.load(f.member);assert.equal(workPhase(loaded.data.state.tasks[1]),'done');assert.equal(loaded.data.state.tasks.length,2);
  assert.equal((await f.call(f.base+'/work',f.outsider)).status,404);
});
test('assignment changes require current revisions and valid role evidence; stale writes cannot create routing rows',async()=>{
  const f=await fixture();let loaded=await f.load(f.owner);loaded.data.state.tasks=[task('T-1',{assigneeId:f.candidate.assigneeId})];
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,400);
  loaded=await f.load(f.owner);loaded.data.state.tasks=[task('T-1')];await f.save(f.owner,loaded.data.state,loaded.data.organization.revision);
  loaded=await f.load(f.owner);const original=structuredClone(loaded.data);const route=f.base+'/work/T-1/assignment';
  loaded.data.state.tasks[0].assigneeId=f.candidate.assigneeId;
  assert.equal((await f.save(f.owner,loaded.data.state,loaded.data.organization.revision)).status,409);
  assert.equal((await f.call(route,f.owner,'PUT',{...f.assigned,revision:original.organization.revision,assignmentRevision:0,assigneeId:'another-user'})).status,400);
  const races=await Promise.all([0,1].map(()=>f.call(route,f.owner,'PUT',{...f.assigned,revision:original.organization.revision,assignmentRevision:0})));
  assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  assert.equal((await f.call(route,f.owner,'PUT',{assigneeId:original.work.administratorId,revision:original.organization.revision,assignmentRevision:0})).status,409);
  original.state.tasks.push(task('T-3',f.assigned));assert.equal((await f.save(f.owner,original.state,original.organization.revision)).status,409);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM task_assignments WHERE task_id='T-3'").get().n,0);
  loaded=await f.load(f.owner);assert.equal(loaded.data.state.tasks[0].assigneeId,f.candidate.assigneeId);
  assert.equal((await f.call(route,f.owner,'PUT',{assigneeId:loaded.data.work.administratorId,revision:loaded.data.organization.revision,assignmentRevision:0})).status,200);
  loaded=await f.load(f.owner);assert.equal(loaded.data.state.tasks[0].assignmentRevision,1);assert.equal(loaded.data.state.tasks[0].assigneeId,loaded.data.work.administratorId);
});
test('personal scope and the shared agent queue are distinct, and human answers stay active until completed',async()=>{
  const ctx={administratorId:'owner',viewerId:'member',members:[{assigneeId:'owner',name:'Ejer',isAdministrator:true},{assigneeId:'member',name:'Maja',roleId:'role',roleTitle:'Motoransvarlig',roleDescription:'Godkender motorvalg i vores projekt.',statementIds:['org-role-role#1']}]};
  const state={view:'inbox',tasks:[task('T-1'),task('T-2',{assigneeId:'member'}),task('T-3',{assigneeId:'member',response:{seen:true},agentWorkStatus:'working'}),task('T-4',{kind:'case',phase:'pending'})]};
  const sandbox={window:{FinchStorage:{work:ctx,organization:{name:'Test'}}}};vm.runInNewContext(readFileSync('work.js','utf8'),sandbox);const work=sandbox.window.FinchWork;
  work.configure({state:()=>state,save(){},render(){},evidence:()=>({items:[]})});
  assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-2']);state.view='agent';assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-3','T-4']);
  state.view='organization';work.normalizeNavigation();assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-2']);
  state.organizationMember='member';state.organizationFilter='open';assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-2']);
  await work.tool('complete_task',{task_id:'T-3',summary:'Behandlet'});assert.equal(work.phase(state.tasks[2]),'done');state.organizationFilter='done';assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-3']);
  assert.throws(()=>work.assignment({assignee_id:'member'}),/rollebeskrivelse/);
  const assignment=work.assignment({assignee_id:'member',assignment_reason:'Motorvalget skal godkendes af rollen.',assignment_statement_ids:['org-role-role#1']});assert.equal(assignment.assigneeId,'member');
  assert.equal(work.assignment().assigneeId,'owner');assert.ok(work.nav().includes('data-action="org-member"'));assert.ok(!work.nav().includes('I gang'));assert.ok(!work.nav().includes('data-member="agent"'));
});
test('Agent waiting and resolved tabs keep organisation setup out of human inboxes',()=>{
  const state={view:'agent',agentFilter:'open',tasks:[task('S-setup',{kind:'case',phase:'active',organizationSetup:{step:'knowledge'}}),task('S-done',{kind:'case',phase:'done',organizationSetup:{step:'branding'}}),task('T-done',{agentWorkStatus:'done',response:{seen:true}}),task('I-read',{kind:'info',read:true})]};
  const sandbox={window:{FinchStorage:{work:{viewerId:'owner',administratorId:'owner',members:[{assigneeId:'owner'}]}}}};vm.runInNewContext(readFileSync('work.js','utf8'),sandbox);const work=sandbox.window.FinchWork;work.configure({state:()=>state});
  assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['S-setup']);state.agentFilter='done';assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['S-done','T-done']);
  work.openTask(state.tasks[2],{keepAgent:true});assert.equal(state.view,'agent');assert.equal(state.agentFilter,'done');
  state.view='inbox';assert.deepEqual(state.tasks.filter(work.inScope).map(t=>t.id),['T-done','I-read']);
});
test('work navigation moves every active task to Agent and migrates legacy I gang selections',()=>{
  const ctx={administratorId:'owner',viewerId:'member',members:[{assigneeId:'owner',name:'Ejer'},{assigneeId:'member',name:'Maja'}]};
  const tasks=[task('T-own',{assigneeId:'member'}),task('T-other',{assigneeId:'owner'}),task('T-answer',{assigneeId:'member',response:{seen:false}}),task('S-mail',{kind:'case',phase:'active',assigneeId:'owner',inboundEmail:{id:'mail'}}),task('S-file',{kind:'case',phase:'active',assigneeId:'owner',dataRequest:{kind:'file'}}),task('S-page',{kind:'case',phase:'active',assigneeId:'member',pageRequest:{}})];
  const state={view:'inbox',listFilter:'active',selected:'S-mail',tasks};const sandbox={window:{FinchStorage:{work:ctx}}};vm.runInNewContext(readFileSync('work.js','utf8'),sandbox);const work=sandbox.window.FinchWork;work.configure({state:()=>state});
  work.normalizeNavigation({migrateLegacy:true});assert.equal(state.view,'agent');assert.equal(state.listFilter,'open');assert.deepEqual(tasks.filter(work.inScope).map(t=>t.id),['T-answer','S-mail','S-file','S-page']);
  state.view='organization';state.organizationMember='agent';work.normalizeNavigation({migrateLegacy:true});assert.equal(state.view,'agent');assert.equal(state.organizationMember,'member');
  state.view='inbox';state.selectedStick='T-answer';work.normalizeNavigation();assert.deepEqual(tasks.filter(work.inScope).map(t=>t.id),['T-own']);
  for(const t of tasks.slice(2)){work.openTask(t);assert.equal(state.view,'agent');assert.equal(state.selected,t.id);}
  work.openTask(tasks[0]);assert.equal(state.view,'inbox');work.openTask(tasks[1]);assert.equal(state.view,'organization');assert.equal(state.organizationMember,'owner');
  tasks[2].agentWorkStatus='done';work.openTask(tasks[2]);assert.equal(state.view,'inbox');assert.equal(state.listFilter,'done');
});

test('manual user work persists immediately in the chosen member inbox, while explicit agent work is queued with context',async()=>{
  const f=await fixture();const input={kind:'user',title:'Godkend effektkravet',description:'Kontrollér minimumseffekt på den valgte motor.',assigneeId:f.candidate.assigneeId,requestId:crypto.randomUUID()};
  const first=await f.call(f.base+'/work',f.owner,'POST',input);assert.equal(first.status,200);assert.equal((await f.call(f.base+'/work',f.owner,'POST',input)).data.taskId,first.data.taskId);
  let loaded=(await f.load(f.member)).data;const task=loaded.state.tasks.find(t=>t.id===first.data.taskId);assert.equal(workPhase(task),'open');assert.equal(task.assigneeId,f.candidate.assigneeId);assert.equal(task.manualRequest.kind,'user');assert.equal(task.ui[0].text,input.description);assert.match(task.assignmentReason,/Manuelt tildelt/);assert.equal(loaded.state.events.length,0);
  const queued=await f.call(f.base+'/work',f.member,'POST',{kind:'agent',title:'Undersøg motorvalget',description:'Sammenlign motorernes effekt i vores tabel.',requestId:crypto.randomUUID()});assert.equal(queued.status,200);
  loaded=(await f.load(f.owner)).data;const agent=loaded.state.tasks.find(t=>t.id===queued.data.taskId);assert.equal(agent.phase,'active');assert.equal(agent.agentWorkStatus,'queued');assert.equal(agent.assigneeId,loaded.work.administratorId);assert.equal(agent.manualRequest.description,'Sammenlign motorernes effekt i vores tabel.');assert.equal(loaded.state.events[0].type,'agent_work_requested');assert.equal(loaded.state.tasks.length,2);
});
test('work creation rejects foreign access, invalid descriptions, inactive recipients and request ID reuse with a different kind',async()=>{
  const f=await fixture();const input={kind:'user',title:'Opgave',description:'Beskrivelsen',assigneeId:f.candidate.assigneeId,requestId:crypto.randomUUID()};
  assert.equal((await f.call(f.base+'/work',f.outsider,'POST',input)).status,404);
  for(const patch of [{title:''},{description:' '},{description:'x'.repeat(4001)},{kind:'unknown'},{assigneeId:crypto.randomUUID()},{requestId:'invalid'}])assert.equal((await f.call(f.base+'/work',f.owner,'POST',{...input,...patch})).status,400);
  assert.equal((await f.call(f.base+'/work',f.owner,'POST',input)).status,200);
  assert.equal((await f.call(f.base+'/work',f.owner,'POST',{kind:'agent',title:'Andet',description:'En anden type.',requestId:input.requestId})).status,409);
  const member=(await f.call(f.base+'/settings',f.owner)).data.members.find(m=>m.id===f.memberId);await f.call(f.base+`/settings/members/${member.id}`,f.owner,'DELETE',{revision:member.revision});
  assert.equal((await f.call(f.base+'/work',f.owner,'POST',{...input,requestId:crypto.randomUUID()})).status,400);assert.equal((await f.call(f.base+'/work',f.member,'POST',{kind:'agent',title:'Opgave',description:'Beskrivelsen',requestId:crypto.randomUUID()})).status,404);
});
test('concurrent manual work and retries preserve unrelated tasks and cannot duplicate a request',async()=>{
  const f=await fixture();const input={kind:'agent',title:'Analysér data',description:'Sammenlign tabellens rækker.',requestId:crypto.randomUUID()};
  const results=await Promise.all([f.call(f.base+'/work',f.owner,'POST',input),f.call(f.base+'/work',f.owner,'POST',input),f.call(f.base+'/work',f.owner,'POST',{...input,title:'Anden opgave',requestId:crypto.randomUUID()})]);
  assert.ok(results.every(r=>r.status===200));assert.equal(results[0].data.taskId,results[1].data.taskId);assert.equal((await f.load(f.owner)).data.state.tasks.length,2);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM work_intake_requests').get().n,2);
});
