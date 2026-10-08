import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import vm from 'node:vm';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
const introTask=s=>s.tasks.find(t=>t.kind==='case'&&!t.organizationSetup);
const ORIGIN='https://finch.test';
const profile={website:'truck-example.test',description:'Vi konfigurerer lastbiler til danske vognmænd med vores egne specifikationskrav.',roleTitle:'Konfigurationsansvarlig',roleDescription:'Jeg godkender motorvalg og de konkrete kundekrav i vores organisation.',workFocus:'Konfiguration af en ny lastbil.'};
async function fixture(){
  const DB=sqliteD1();for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const env={DB,AUTH_SECRET:'onboarding-test-secret-at-least-thirty-two-chars'};let code;
  async function call(route,cookie,method='GET',data,origin=ORIGIN){const res=await handleApi(new Request(ORIGIN+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),env,{sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{}});return {status:res.status,data:await res.json(),cookie:res.headers.get('Set-Cookie')?.split(';')[0]};}
  async function login(email){const start=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:start.data.challengeId,code})).cookie;}
  const owner=await login('owner@example.test'),outsider=await login('outsider@example.test');
  const create=(p=profile)=>call('/api/organizations',owner,'POST',{name:'Lastbilprojekt',...(p?{profile:p}:{})});
  async function action(base,name,extra={}){const loaded=await call(base,owner);return call(base+'/onboarding/'+name,owner,'POST',{revision:loaded.data.onboarding.revision,organizationRevision:loaded.data.organization.revision,...extra});}
  async function save(base,edit){const loaded=await call(base,owner);edit(loaded.data.state);assert.equal((await call(base,owner,'PUT',{state:loaded.data.state,revision:loaded.data.organization.revision})).status,200);}
  return {DB,call,login,owner,outsider,create,action,save};
}
test('profile and owner role persist together, old organisations stay untouched, and invalid profiles cannot leave partial organisations',async()=>{
  const f=await fixture(),created=await f.create();assert.equal(created.status,201);const base='/api/organizations/'+created.data.organization.id;
  assert.equal(created.data.onboarding.phase,'offered');assert.equal(created.data.onboarding.profile.website,'https://truck-example.test/');assert.equal(created.data.work.members[0].roleDescription,profile.roleDescription);
  assert.equal(created.data.onboarding.profile.workFocus,undefined);
  assert.equal(created.data.state.graph.nodes.some(n=>n.type==='person'),false);assert.equal(created.data.state.events[0].type,'organization_created');
  f.DB.sqlite.exec('UPDATE rate_limits SET expires_at=0');assert.deepEqual((await f.call(base,await f.login('owner@example.test'))).data.onboarding,created.data.onboarding);
  const legacy=await f.create(null);assert.equal(legacy.data.onboarding,null);assert.deepEqual(legacy.data.state.events,[]);
  assert.equal((await f.call('/api/organizations',f.owner,'POST',{name:'Import',state:legacy.data.state})).data.onboarding,null);
  const before=f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM organizations').get().n;
  for(const p of [{...profile,description:''},{...profile,roleTitle:''},{...profile,website:'javascript:alert(1)'},{...profile,website:'https://user:pass@example.test'},{...profile,website:'http://127.0.0.1/'}])assert.equal((await f.create(p)).status,400);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM organizations').get().n,before);assert.equal((await f.create({...profile,website:''})).status,201);
});
test('the optional work idea belongs to the first case, is bounded, and can be omitted',async()=>{
  const f=await fixture(),created=await f.create(),base='/api/organizations/'+created.data.organization.id;
  for(const idea of [42,'x'.repeat(1201)])assert.equal((await f.action(base,'start',{idea})).status,400);
  assert.equal((await f.call(base,f.owner)).data.onboarding.phase,'offered');
  assert.equal((await f.action(base,'start',{idea:'  Sammenlign et lokalt trucktilbud.  '})).status,200);
  const loaded=(await f.call(base,f.owner)).data;assert.equal(introTask(loaded.state).firstTaskRequest.idea,'Sammenlign et lokalt trucktilbud.');assert.equal(loaded.onboarding.profile.workFocus,undefined);
  const another=await f.create({...profile,website:''}),base2='/api/organizations/'+another.data.organization.id;
  assert.equal((await f.action(base2,'start')).status,200);assert.equal(introTask((await f.call(base2,f.owner)).data.state).firstTaskRequest.idea,'');
});
test('organisation setup tasks persist independently of the optional first-case flow',async()=>{
  const f=await fixture(),created=await f.create(),base='/api/organizations/'+created.data.organization.id;
  const tasks=created.data.state.tasks;assert.equal(tasks.length,3);assert.deepEqual(tasks.map(t=>t.organizationSetup.step),['knowledge','data','branding']);
  assert.ok(tasks.every(t=>t.phase==='active'&&t.agentWorkStatus==='queued'&&t.updates.length===1));
  assert.deepEqual(tasks[1].organizationSetup.dependsOn,[tasks[0].id]);assert.deepEqual(tasks[2].organizationSetup.dependsOn,[tasks[0].id]);
  await f.save(base,s=>{s.tasks[0].updates.push({at:1,text:'Offentlige kilder gennemgået',ui:[]});s.tasks[0].progress=50;});
  await f.action(base,'skip');const loaded=(await f.call(base,f.owner)).data;
  assert.equal(loaded.onboarding.phase,'skipped');assert.equal(loaded.state.tasks.length,3);assert.equal(loaded.state.tasks[0].progress,50);assert.equal(loaded.state.tasks[0].updates.at(-1).text,'Offentlige kilder gennemgået');
  const noWebsite=await f.create({...profile,website:''});assert.equal(noWebsite.data.state.tasks.length,1);assert.equal(noWebsite.data.state.tasks[0].organizationSetup.website,'');
});
test('starting is atomic, generic snapshots cannot spoof onboarding, and only an approved case unlocks the persistent tutorial',async()=>{
  const f=await fixture(),created=await f.create(),base='/api/organizations/'+created.data.organization.id;
  const races=await Promise.all([0,1].map(()=>f.call(base+'/onboarding/start',f.owner,'POST',{revision:0,organizationRevision:0})));assert.deepEqual(races.map(r=>r.status).sort(),[200,409]);
  let loaded=(await f.call(base,f.owner)).data;const caseId=loaded.onboarding.caseId;assert.equal(loaded.onboarding.phase,'active');assert.equal(loaded.state.tasks.filter(t=>!t.organizationSetup).length,1);assert.equal(introTask(loaded.state).assigneeId,loaded.work.administratorId);
  assert.equal(loaded.state.events.filter(e=>e.type==='onboarding_started').length,1);assert.equal((await f.action(base,'complete')).status,409);assert.equal((await f.action(base,'tutorial',{action:'next'})).status,409);
  await f.save(base,s=>{introTask(s).phase='draft';introTask(s).ui=[{type:'text_input',id:'kunde',label:'Kunde',value:'Eksempelkunde'}];s.onboarding={phase:'completed'};s.organizationProfile={description:'Spoof'};});
  loaded=(await f.call(base,f.owner)).data;assert.equal(loaded.state.onboarding,undefined);assert.equal(loaded.onboarding.phase,'active');assert.equal(loaded.onboarding.profile.description,profile.description);
  await f.save(base,s=>{introTask(s).phase='active';introTask(s).createdAt=Date.now();introTask(s).values={kunde:'Min kundesituation'};s.events.push({id:'E-test',type:'case_created',caseId,delivered:false,at:Date.now()});});
  assert.equal((await f.action(base,'complete')).data.onboarding.phase,'completed');assert.equal((await f.action(base,'tutorial',{action:'next'})).data.onboarding.tutorialStep,1);assert.equal((await f.action(base,'tutorial',{action:'back'})).data.onboarding.tutorialStep,0);
  for(let i=0;i<6;i++)assert.equal((await f.action(base,'tutorial',{action:'next'})).status,200);
  loaded=(await f.call(base,f.owner)).data;assert.equal(loaded.onboarding.tutorialDone,true);assert.equal(introTask(loaded.state).phase,'active');assert.equal(introTask(loaded.state).values.kunde,'Min kundesituation');assert.equal((await f.call(base+'/select',f.owner,'POST',{})).data.onboarding.tutorialDone,true);
});
test('skip cancels only unapproved onboarding work, preserves the profile, and cannot discard approved work',async()=>{
  const f=await fixture(),created=await f.create(),base='/api/organizations/'+created.data.organization.id;await f.action(base,'start');const loaded=(await f.call(base,f.owner)).data;
  await f.save(base,s=>s.tasks.push({id:'T-1',kind:'task',title:'Afklaring',ui:[],caseId:loaded.onboarding.caseId},{id:'T-2',kind:'task',title:'Andet arbejde',ui:[]}));
  assert.equal((await f.action(base,'skip')).data.onboarding.phase,'skipped');const after=(await f.call(base,f.owner)).data;
  assert.equal(introTask(after.state).phase,'discarded');assert.equal(after.state.tasks.find(t=>t.id==='T-1').agentWorkStatus,'done');assert.equal(after.state.tasks.find(t=>t.id==='T-2').agentWorkStatus,undefined);assert.equal(after.onboarding.profile.description,profile.description);assert.equal(after.state.events.some(e=>e.type==='onboarding_started'&&!e.delivered),false);assert.equal(after.state.events.at(-1).type,'onboarding_skipped');
  await f.action(base,'tutorial',{action:'dismiss'});assert.equal((await f.call(base,f.owner)).data.onboarding.tutorialDone,true);
  const second=await f.create(),base2='/api/organizations/'+second.data.organization.id;await f.action(base2,'start');await f.save(base2,s=>{introTask(s).phase='active';introTask(s).createdAt=Date.now();});assert.equal((await f.action(base2,'skip')).status,409);
});
test('profile access and workflow controls respect membership, ownership, origin and organisation isolation',async()=>{
  const f=await fixture(),created=await f.create(),base='/api/organizations/'+created.data.organization.id;assert.equal((await f.call(base+'/onboarding',f.outsider)).status,404);assert.equal((await f.call(base+'/onboarding/start',f.outsider,'POST',{revision:0,organizationRevision:0})).status,404);
  assert.equal((await f.call(base+'/onboarding/start',f.owner,'POST',{revision:0,organizationRevision:0},'https://evil.test')).status,403);
  const member=await f.login('member@example.test'),invite=await f.call(base+'/settings/members',f.owner,'POST',{email:'member@example.test',inGraph:false});await f.call(`/api/invitations/${invite.data.id}/accept`,member,'POST',{});
  assert.equal((await f.call(base+'/onboarding',member)).data.onboarding.canManage,false);assert.equal((await f.call(base+'/onboarding/skip',member,'POST',{})).status,403);
  const another=await f.create({...profile,description:'En anden organisation med et andet arbejdsområde.'});assert.notEqual(another.data.onboarding.profile.description,(await f.call(base,f.owner)).data.onboarding.profile.description);
});
test('agent tools reuse context, protect human approval and honour skip while allowing later requested cases',()=>{
  let context={phase:'active',caseId:'S-201',profile};const state={tasks:[{id:'S-201',kind:'case',phase:'pending'}]};
  const sandbox={window:{FinchStorage:{get onboarding(){return context;}},FinchWork:{context:()=>({administratorId:'owner'})}},document:{addEventListener(){}}};vm.runInNewContext(readFileSync('onboarding.js','utf8'),sandbox);const api=sandbox.window.FinchOnboarding;api.configure({state:()=>state});
  assert.equal(api.toolInput('ask_user',{question:'q'}).input.case_id,'S-201');assert.equal(api.toolInput('draft_case',{}).input.case_id,'S-201');assert.match(api.toolInput('complete_case',{case_id:'S-201'}).error,/godkende/);assert.ok(api.toolInput('assign_task',{task_id:'S-201',assignee_id:'other'}).error);assert.ok(api.toolInput('ask_user',{case_id:'S-other'}).error);assert.equal(api.toolInput('ask_user_batch',{questions:[{question:'q'}]}).input.questions[0].case_id,'S-201');
  context={...context,phase:'offered'};assert.ok(api.toolInput('draft_case',{}).error);assert.match(api.agentContext().guidance_for_agent,/Spørg ikke igen/);context={...context,phase:'skipped'};assert.ok(api.toolInput('draft_case',{}).error);state.tasks.push({id:'S-202',kind:'case',phase:'pending'});assert.equal(api.toolInput('draft_case',{case_id:'S-202'}).input.case_id,'S-202');context={...context,phase:'completed'};assert.equal(api.toolInput('draft_case',{}).error,undefined);
});
test('setup work is actionable after skipping, respects dependencies, and precedes the first draft',()=>{
  const context={phase:'skipped',caseId:'S-demo',profile};const state={tasks:[{id:'S-knowledge',phase:'active',organizationSetup:{step:'knowledge',dependsOn:[]}},{id:'S-data',phase:'active',organizationSetup:{step:'data',dependsOn:['S-knowledge']}},{id:'S-demo',kind:'case',phase:'pending'}]};
  const sandbox={window:{FinchStorage:{onboarding:context}},document:{addEventListener(){}}};vm.runInNewContext(readFileSync('onboarding.js','utf8'),sandbox);const api=sandbox.window.FinchOnboarding;api.configure({state:()=>state});
  assert.equal(api.toolInput('update_case',{case_id:'S-knowledge'}).input.case_id,'S-knowledge');assert.match(api.toolInput('complete_case',{case_id:'S-data'}).error,/afhængigheder/);
  state.tasks[0].phase='done';assert.equal(api.toolInput('update_case',{case_id:'S-data'}).input.case_id,'S-data');context.phase='active';assert.match(api.toolInput('draft_case',{case_id:'S-demo'}).error,/klargøringsopgaver/);
  state.tasks[1].phase='done';assert.equal(api.toolInput('draft_case',{case_id:'S-demo'}).input.case_id,'S-demo');
});
test('initial state adoption selects the persisted draft before login initialization finishes',()=>{
  const context={canManage:true,phase:'active',caseId:'S-201',profile};const state={view:'inbox',selected:null,tasks:[{id:'S-201',kind:'case',phase:'draft'}]};
  const sandbox={window:{FinchStorage:{ready:false,onboarding:context},FinchWork:{mine:()=>true,phase:()=> 'open'}},document:{addEventListener(){}}};vm.runInNewContext(readFileSync('onboarding.js','utf8'),sandbox);const api=sandbox.window.FinchOnboarding;api.configure({state:()=>state,detail(){}});api.prepare();assert.equal(state.selected,'S-201');assert.equal(state.listFilter,'open');
});
test('pending onboarding work opens in Agent, while drafts and the inbox tutorial stay in the human inbox',()=>{
  let context={canManage:true,phase:'active',caseId:'S-201',profile};const state={view:'inbox',selected:null,tasks:[{id:'S-201',kind:'case',phase:'pending'}]};
  const sandbox={window:{FinchStorage:{organization:{id:'test-org'},get onboarding(){return context;}},FinchWork:{mine:()=>true,phase:t=>t.phase==='draft'?'open':'active'}},document:{addEventListener(){}}};vm.runInNewContext(readFileSync('onboarding.js','utf8'),sandbox);const api=sandbox.window.FinchOnboarding;api.configure({state:()=>state,detail(){}});
  api.prepare();assert.equal(state.view,'agent');assert.equal(state.selected,'S-201');assert.equal(state.listFilter,'open');
  state.tasks[0].phase='draft';api.prepare();assert.equal(state.view,'inbox');
  context={...context,phase:'completed',tutorialDone:false,tutorialStep:0};api.prepare();assert.equal(state.view,'inbox');assert.equal(state.listFilter,'open');assert.equal(state.selected,null);
});
