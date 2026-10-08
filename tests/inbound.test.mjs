import test from 'node:test';
import assert from 'node:assert/strict';
import {createHmac} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
import {verifyInboundWebhook,inboundMailbox,resendInboundProvider} from '../server/inbound.mjs';
const ORIGIN='https://finch.test';const SECRET='whsec_'+Buffer.alloc(32,7).toString('base64');
async function fixture(){
  const DB=sqliteD1();for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const notices=[],objects=new Map(),mails=new Map();let code,providerCalls=0,downloadCalls=0;let getOverride;
  const env={DB,AUTH_SECRET:'inbound-test-secret-at-least-thirty-two-chars',INBOUND_EMAIL_DOMAIN:'tasks.example.test',RESEND_INBOUND_API_KEY:'test-only',RESEND_WEBHOOK_SECRET:SECRET,EMAIL_FROM:'Finch <login@login.example.test>',
    BUCKET:{put:async(k,b)=>objects.set(k,new Uint8Array(b)),get:async k=>objects.has(k)?{body:objects.get(k),arrayBuffer:async()=>objects.get(k).buffer}:null}};
  const deps={sendInboundRejection:async(_,payload,key)=>{notices.push({payload,key});return {id:crypto.randomUUID()};},sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{},inboundProvider:{getEmail:async id=>{providerCalls++;if(getOverride)await getOverride(id);if(!mails.has(id))throw new Error('fake private provider secret');return mails.get(id);},getAttachments:async id=>mails.get(id).attachments,download:async a=>{downloadCalls++;return a.bytes;}}};
  async function call(route,cookie,method='GET',data){const response=await handleApi(new Request(ORIGIN+route,{method,headers:{Origin:ORIGIN,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),env,deps);return {status:response.status,data:await response.json(),cookie:response.headers.get('Set-Cookie')?.split(';')[0]};}
  async function login(email){const c=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:c.data.challengeId,code})).cookie;}
  const owner=await login('owner@example.test'),member=await login('member@example.test'),outsider=await login('outsider@example.test');
  const created=await call('/api/organizations',owner,'POST',{name:'Mailtest'}),base=`/api/organizations/${created.data.organization.id}`;
  const invite=await call(base+'/settings/members',owner,'POST',{email:'member@example.test',name:'Maja'});await call(`/api/invitations/${invite.data.id}/accept`,member,'POST',{});
  async function settings(data={}){const current=(await call(base+'/settings/inbound',owner)).data;return call(base+'/settings/inbound',owner,'PUT',{revision:current.revision,enabled:true,allowedSenders:[],...data});}
  async function notify(event,{messageId='msg_'+crypto.randomUUID(),timestamp=String(Math.floor(Date.now()/1000)),signature,raw=JSON.stringify(event),headers={}}={}){
    const sig=signature??createHmac('sha256',Buffer.from(SECRET.slice(6),'base64')).update(`${messageId}.${timestamp}.${raw}`).digest('base64');
    const response=await handleApi(new Request(ORIGIN+'/api/webhooks/resend/inbound',{method:'POST',headers:{'Content-Type':'application/json','svix-id':messageId,'svix-timestamp':timestamp,'svix-signature':`v1,${sig}`,...headers},body:raw}),env,deps);return {status:response.status,data:await response.json()};
  }
  function mail(address,sender='member@example.test',extra={}){const id=crypto.randomUUID();const m={id,from:`Maja <${sender}>`,to:[address],bcc:[],received_for:[],subject:'Kontrollér motorvalget',text:'Kan I godkende motorvalget i vores lastbilprojekt?',created_at:new Date().toISOString(),authentication:{spf:'pass',dkim:'pass',dmarc:'pass'},attachments:[],...extra};mails.set(id,m);return {type:'email.received',data:{email_id:id,from:m.from,to:m.to,bcc:m.bcc,subject:m.subject}};}
  return {DB,env,objects,mails,notices,deps,call,owner,member,outsider,base,orgId:created.data.organization.id,settings,notify,mail,memberId:invite.data.id,counts:()=>({providerCalls,downloadCalls}),setOverride:f=>getOverride=f};
}
test('mail settings default off, active members default allowed, only owner can enable, revisions and stable aliases survive updates',async()=>{
  const f=await fixture();const initial=(await f.call(f.base+'/settings',f.owner)).data.inbound;assert.equal(initial.enabled,false);assert.equal(initial.address,null);assert.equal(initial.members.length,2);assert.ok(initial.members.every(m=>m.allowed));
  assert.equal((await f.call(f.base+'/settings/inbound',f.member,'PUT',{revision:0,enabled:true})).status,403);
  assert.equal((await f.call(f.base+'/settings/inbound',f.outsider)).status,404);
  const enabled=await f.settings({allowedSenders:['SUPPLIER@example.test']});assert.equal(enabled.status,200);assert.match(enabled.data.address,/^org-[a-f0-9]{32}@tasks.example.test$/);assert.deepEqual(enabled.data.allowedSenders,['supplier@example.test']);
  const changed=await f.settings({enabled:false});assert.equal(changed.status,200);assert.equal(changed.data.address,enabled.data.address);assert.equal(changed.data.revision,2);
  assert.equal((await f.call(f.base+'/settings/inbound',f.owner,'PUT',{revision:1,enabled:true})).status,409);
  assert.equal((await f.settings({allowedSenders:['*@example.test']})).status,400);
  const available=f.env.RESEND_INBOUND_API_KEY;delete f.env.RESEND_INBOUND_API_KEY;assert.equal((await f.settings()).status,503);f.env.RESEND_INBOUND_API_KEY=available;
});
test('Svix verification matches the official known signature and rejects body changes, unknown versions and expired timestamps',async()=>{
  const raw='{"event_type":"ping","data":{"success":true}}',stamp='1731705121';
  const request=()=>new Request(ORIGIN,{method:'POST',headers:{'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':stamp,'svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='},body:raw});
  assert.equal((await verifyInboundWebhook(request(),'whsec_plJ3nmyCDGBKInavdOK15jsl',Number(stamp)*1000)).event.event_type,'ping');
  await assert.rejects(()=>verifyInboundWebhook(request(),'whsec_plJ3nmyCDGBKInavdOK15jsl',Number(stamp)*1000+301000));
  const f=await fixture();const enabled=await f.settings();const event=f.mail(enabled.data.address);
  assert.equal((await f.notify(event,{signature:'invalid'})).status,401);
  assert.equal((await f.notify(event,{timestamp:'1'})).status,401);
  assert.equal((await f.notify(event,{raw:'{"x":"'+ 'a'.repeat(300000)+'"}'})).status,413);
  assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inbound_messages').get().n,0);
});
test('a signed permitted email creates a persisted real case and private binary attachment exactly once, without adding graph facts',async()=>{
  const f=await fixture();const enabled=await f.settings();const bytes=new Uint8Array([37,80,68,70,45,49,46,52,0,255]);
  const event=f.mail(enabled.data.address,'member@example.test',{attachments:[{id:crypto.randomUUID(),filename:'motor.pdf',content_type:'application/pdf',size:bytes.length,bytes}]});
  assert.equal((await f.notify(event)).status,200);assert.equal((await f.notify(event)).status,200);
  const loaded=(await f.call(f.base,f.member)).data;assert.equal(loaded.state.tasks.length,1);assert.equal(loaded.state.graph.nodes.some(n=>n.source==='mail'),false);
  const c=loaded.state.tasks[0];assert.equal(c.phase,'active');assert.equal(c.inboundEmail.id,event.data.email_id);assert.equal(c.emails[0].inbound,true);assert.equal(c.emails[0].body,'Kan I godkende motorvalget i vores lastbilprojekt?');assert.equal(c.assigneeId,loaded.work.administratorId);
  assert.equal(loaded.state.events[0].type,'inbound_email_received');assert.equal(f.counts().providerCalls,1);assert.equal(f.counts().downloadCalls,1);assert.equal(f.objects.size,1);
  const file=c.inboundEmail.attachments[0];const fetched=await f.call(f.base+`/data/files/${file.id}?include_content=true`,f.member);assert.equal(fetched.status,200);assert.deepEqual(new Uint8Array(Buffer.from(fetched.data.content_base64,'base64')),bytes);
  assert.equal((await f.call(f.base+`/settings/inbound/emails/${event.data.email_id}`,f.outsider)).status,404);
  const original=(await f.call(f.base+`/settings/inbound/emails/${event.data.email_id}`,f.owner)).data;assert.equal(original.email.authentication.dmarc,'pass');assert.equal(original.taskId,c.id);
});
test('disabled, revoked and unlisted senders cannot create tasks; explicitly allowed outside senders get no account access',async()=>{
  const f=await fixture();let enabled=await f.settings({enabled:false});await f.notify(f.mail(enabled.data.address));assert.equal(f.counts().providerCalls,1);
  enabled=await f.settings();await f.notify(f.mail(enabled.data.address,'stranger@example.test'));assert.equal(f.counts().providerCalls,2);
  const team=(await f.call(f.base+'/settings',f.owner)).data;const member=team.members.find(m=>m.id===f.memberId);await f.call(f.base+`/settings/members/${member.id}`,f.owner,'DELETE',{revision:member.revision});await f.notify(f.mail(enabled.data.address));assert.equal(f.counts().providerCalls,3);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
  enabled=await f.settings({allowedSenders:['outsider@example.test']});assert.equal((await f.notify(f.mail(enabled.data.address,'outsider@example.test'))).status,200);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,1);assert.equal((await f.call(f.base,f.outsider)).status,404);
});
test('provider authentication and actual delivery address are checked, never attacker-supplied mail headers',async()=>{
  const f=await fixture();const enabled=await f.settings();const forged=f.mail(enabled.data.address,'member@example.test',{authentication:{dmarc:'fail'},headers:{'authentication-results':'dmarc=pass'}});await f.notify(forged);
  const failedSpf=f.mail(enabled.data.address,'member@example.test',{authentication:{spf:'fail',dkim:'gray',dmarc:'gray'}});await f.notify(failedSpf);
  const failedDkim=f.mail(enabled.data.address,'member@example.test',{authentication:{spf:'pass',dkim:'fail',dmarc:'gray'}});await f.notify(failedDkim);
  const wrong=f.mail(enabled.data.address,'member@example.test',{received_for:['somebody@another.example.test']});await f.notify(wrong);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);assert.equal(f.objects.size,0);assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM inbound_messages WHERE status='rejected'").get().n,4);
});
test('retries recover provider errors and concurrent delivery leases cannot duplicate a case',async()=>{
  const f=await fixture();const enabled=await f.settings();const event=f.mail(enabled.data.address);let fail=true;f.setOverride(async()=>{if(fail)throw new Error('fake private credential');});
  const unavailable=await f.notify(event);assert.equal(unavailable.status,503);assert.ok(!JSON.stringify(unavailable.data).includes('credential'));fail=false;
  assert.equal((await f.notify(event)).status,200);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,1);
  let release,started;const blocked=new Promise(resolve=>release=resolve),entered=new Promise(resolve=>started=resolve);const next=f.mail(enabled.data.address);f.setOverride(async()=>{started();await blocked;});
  const first=f.notify(next);await entered;assert.equal((await f.notify(next)).status,503);release();assert.equal((await first).status,200);assert.equal((await f.notify(next)).status,200);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,2);
});
test('incoming mail retries snapshot conflicts without overwriting other work, and rechecks disabled settings before committing',async()=>{
  const f=await fixture();const enabled=await f.settings();const original=f.env.DB.batch.bind(f.env.DB);let raced=false;
  f.env.DB.batch=async statements=>{if(!raced){raced=true;const row=f.DB.sqlite.prepare('SELECT state_json FROM organizations WHERE id=?').get(f.orgId);const state=JSON.parse(row.state_json);state.tasks.push({id:'T-1',kind:'info',title:'Other work',ui:[],read:false});f.DB.sqlite.prepare('UPDATE organizations SET state_json=?,revision=revision+1 WHERE id=?').run(JSON.stringify(state),f.orgId);}return original(statements);};
  assert.equal((await f.notify(f.mail(enabled.data.address))).status,200);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,2);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM task_assignments').get().n,1);
  f.setOverride(async()=>{await f.settings({enabled:false});});await f.notify(f.mail(enabled.data.address));assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,2);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM inbound_messages WHERE status='accepted'").get().n,1);
});
test('HTML-only mail is rendered as inert text, oversized attachments are explicit, and downloads cannot target arbitrary hosts',async()=>{
  const f=await fixture();const enabled=await f.settings();const event=f.mail(enabled.data.address,'member@example.test',{text:null,html:'<html><style>hidden</style><p>Motor &amp; effekt</p><script>alert(1)</script><p>550 kW</p></html>',attachments:[{id:crypto.randomUUID(),filename:'large.xlsx',content_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',size:11*1024*1024}]});
  assert.equal((await f.notify(event)).status,200);const c=(await f.call(f.base,f.owner)).data.state.tasks[0];assert.equal(c.emails[0].body,'Motor & effekt\n550 kW');assert.equal(c.inboundEmail.attachments.length,0);assert.match(c.inboundEmail.warnings[0],/large.xlsx/);assert.equal(f.counts().downloadCalls,0);
  await assert.rejects(()=>resendInboundProvider({}).download({download_url:'http://127.0.0.1/private'}),/unsafe_download/);
  await assert.rejects(()=>resendInboundProvider({}).download({download_url:'https://example.org/private'}),/unsafe_download/);
  assert.equal(inboundMailbox('Alice <ALICE@example.test>'),'alice@example.test');assert.equal(inboundMailbox('alice@example.test, bob@example.test'),null);
});

test('rejection replies explain why, contain no original body, ignore Reply-To and send once across webhook retries',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false});
  const event=f.mail(enabled.data.address,'member@example.test',{subject:'Et vigtigt spørgsmål',text:'Private body never echoed',message_id:'<original@example.test>',headers:{'reply-to':'attacker@example.test'}});
  assert.equal((await f.notify(event)).status,200);assert.equal((await f.notify(event)).status,200);assert.equal(f.notices.length,1);
  const {payload,key}=f.notices[0];assert.deepEqual(payload.to,['member@example.test']);assert.equal(payload.from,f.env.EMAIL_FROM);assert.match(payload.subject,/Et vigtigt spørgsmål/);assert.match(payload.text,/slået fra/);assert.match(payload.text,/slå Opgaver via email til/);assert.ok(!payload.text.includes('Private body'));assert.equal(payload.headers['Auto-Submitted'],'auto-replied');assert.equal(payload.headers['In-Reply-To'],'<original@example.test>');assert.match(key,/^finch-inbound-rejection-/);
  const history=(await f.call(f.base+'/settings/inbound',f.owner)).data.recent;assert.equal(history[0].status,'rejected');assert.equal(history[0].rejectionNoticeStatus,'sent');assert.ok(history[0].rejectionNoticeSentAt);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
});
test('bounce transport failure preserves rejection and retries the same frozen payload and key',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false}),event=f.mail(enabled.data.address);const calls=[];
  f.deps.sendInboundRejection=async(_,payload,key)=>{calls.push({payload,key});if(calls.length===1)throw new Error('fake transport secret');return {id:'sent-after-retry'};};
  const first=await f.notify(event);assert.equal(first.status,503);assert.ok(!JSON.stringify(first.data).includes('secret'));
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_messages').get().status,'rejected');assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_rejection_notices').get().status,'pending');
  f.env.EMAIL_FROM='Finch <changed@example.test>';f.mails.get(event.data.email_id).subject='Changed subject';await f.settings();
  assert.equal((await f.notify(event)).status,200);assert.deepEqual(calls[1],calls[0]);assert.equal((await f.notify(event)).status,200);assert.equal(calls.length,2);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
});
test('concurrent rejection delivery holds a lease and duplicate webhook only retries after the first sender finishes',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false}),event=f.mail(enabled.data.address);let release,entered;const blocked=new Promise(r=>release=r),started=new Promise(r=>entered=r);let calls=0;
  f.deps.sendInboundRejection=async()=>{calls++;entered();await blocked;return {id:'one-send'};};
  const first=f.notify(event);await started;assert.equal((await f.notify(event)).status,503);assert.equal(calls,1);release();assert.equal((await first).status,200);assert.equal((await f.notify(event)).status,200);assert.equal(calls,1);
});
test('GRAY DMARC and DKIM create one task, preserve actual verdicts and warn without sending a rejection',async()=>{
  const f=await fixture();const enabled=await f.settings();const event=f.mail(enabled.data.address,'member@example.test',{authentication:{spf:'pass',dkim:'gray',dmarc:'gray'},headers:{'Return-Path':'<member@example.test>'}});
  assert.equal((await f.notify(event)).status,200);assert.equal((await f.notify(event)).status,200);assert.equal(f.notices.length,0);
  const state=(await f.call(f.base,f.owner)).data.state;assert.equal(state.tasks.length,1);assert.equal(state.events.length,1);const task=state.tasks[0];
  assert.equal(task.phase,'active');assert.equal(task.agentWorkStatus,'queued');assert.deepEqual(task.inboundEmail.authentication,{spf:'pass',dkim:'gray',dmarc:'gray'});assert.match(task.inboundEmail.warnings[0],/ikke fuldt bekræftet/);
  const original=(await f.call(f.base+`/settings/inbound/emails/${event.data.email_id}`,f.owner)).data.email;assert.equal(original.authentication.dmarc,'gray');assert.deepEqual(original.warnings,task.inboundEmail.warnings);
});
test('inconclusive or missing provider results are accepted without inventing DMARC pass or trusting message headers',async()=>{
  const f=await fixture();const enabled=await f.settings();
  for(const authentication of [null,undefined,{spf:'pass',dkim:'pass'},{spf:'gray',dkim:'grey',dmarc:'grey'},{spf:'unknown',dkim:'processing_failed',dmarc:'unknown'}]){
    const event=f.mail(enabled.data.address,'member@example.test',{authentication,headers:{'authentication-results':'dmarc=pass'}});assert.equal((await f.notify(event)).status,200);
    const original=(await f.call(f.base+`/settings/inbound/emails/${event.data.email_id}`,f.owner)).data.email;assert.notEqual(original.authentication.dmarc,'pass');assert.ok(original.warnings.length);
  }
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,5);assert.equal(f.notices.length,0);
  // DMARC pass can rely on SPF even when a separate DKIM test fails (or vice versa).
  assert.equal((await f.notify(f.mail(enabled.data.address,'member@example.test',{authentication:{spf:'pass',dkim:'fail',dmarc:'pass'}}))).status,200);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,6);
});
test('GRAY never bypasses enablement, sender permission, actual delivery or member revocation',async()=>{
  const f=await fixture();let enabled=await f.settings();const extra={authentication:{spf:'pass',dkim:'gray',dmarc:'gray'}};
  await f.notify(f.mail(enabled.data.address,'outsider@example.test',extra));
  await f.notify(f.mail(enabled.data.address,'member@example.test',{...extra,received_for:['different@example.test']}));
  enabled=await f.settings({enabled:false});await f.notify(f.mail(enabled.data.address,'member@example.test',extra));
  await f.settings();f.DB.sqlite.prepare("UPDATE organization_members SET status='revoked' WHERE id=?").run(f.memberId);await f.notify(f.mail(enabled.data.address,'member@example.test',extra));
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);assert.equal(f.objects.size,0);assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM inbound_messages WHERE status='rejected'").get().n,4);
});
test('unsafe origins, duplicate or null reverse paths, automated mail and loops suppress replies',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false});const cases=[
    {authentication:{dmarc:'fail'},headers:{'authentication-results':'dmarc=pass'}},
    {authentication:{spf:'pass',dkim:'pass'}},
    {authentication:{spf:'pass',dmarc:'gray'},headers:{}},
    {authentication:{spf:'fail',dmarc:'gray'},headers:{'Return-Path':'member@example.test'}},
    {authentication:{spf:'pass',dmarc:'gray'},headers:{'Return-Path':'attacker@example.test'}},
    {headers:{'Return-Path':'<>'}},
    {headers:{'Return-Path':'["member@example.test","member@example.test"]'}},
    {headers:{'Return-Path':'member@example.test','return-path':'attacker@example.test'}},
    {headers:{'Auto-Submitted':'auto-replied'}},
    {headers:{'X-Auto-Response-Suppress':'All'}},
    {headers:{Precedence:'bulk'}},
    {headers:{'List-Id':'list@example.test'}},
    {received_for:['elsewhere@example.test']},
  ];
  for(const extra of cases)assert.equal((await f.notify(f.mail(enabled.data.address,'member@example.test',extra))).status,200);
  assert.equal((await f.notify(f.mail(enabled.data.address,'unknown@example.test',{authentication:{spf:'pass',dmarc:'gray'},headers:{'Return-Path':'unknown@example.test'}}))).status,200);
  assert.equal((await f.notify(f.mail(enabled.data.address,'login@login.example.test'))).status,200);
  assert.equal((await f.notify(f.mail(enabled.data.address,'org-abc@tasks.example.test'))).status,200);
  const mismatch=f.mail(enabled.data.address);f.mails.get(mismatch.data.email_id).from='attacker@example.test';assert.equal((await f.notify(mismatch)).status,200);
  assert.equal(f.notices.length,0);assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM inbound_rejection_notices WHERE status!='suppressed'").get().n,0);
});
test('notification retries stop before Resend idempotency expires and historical rejected messages are not mailed retroactively',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false});f.deps.sendInboundRejection=async()=>{throw new Error('timeout');};const event=f.mail(enabled.data.address);assert.equal((await f.notify(event)).status,503);
  f.DB.sqlite.prepare('UPDATE inbound_rejection_notices SET first_attempt_at=?').run(Date.now()-23*3600000-1);
  assert.equal((await f.notify(event)).status,200);assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_rejection_notices').get().status,'failed');
  const old=f.mail(enabled.data.address);f.DB.sqlite.prepare("INSERT INTO inbound_messages(id,organization_id,provider_email_id,webhook_id,sender,subject,status,lease_id,lease_until,created_at,updated_at) VALUES(?,?,?,?,?,?,'rejected','old',0,?,?)").run(crypto.randomUUID(),f.orgId,old.data.email_id,'old','member@example.test','Legacy',Date.now(),Date.now());
  assert.equal((await f.notify(old)).status,200);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM inbound_rejection_notices').get().n,1);
});
test('reply rate caps are recorded without retry loops or extra imported work',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false});let last;
  for(let i=0;i<6;i++){last=f.mail(enabled.data.address);assert.equal((await f.notify(last)).status,200);}
  assert.equal(f.notices.length,5);assert.equal((await f.notify(last)).status,200);assert.equal(f.notices.length,5);
  const suppressed=f.DB.sqlite.prepare("SELECT reason FROM inbound_rejection_notices WHERE status='suppressed'").get();assert.match(suppressed.reason,/Grænsen/);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
});

test('a rejected email survives provider lookup failure and resumes its pending notice, without being imported after enablement',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false}),event=f.mail(enabled.data.address);let unavailable=true;
  f.setOverride(async()=>{if(unavailable)throw new Error('provider unavailable');});
  assert.equal((await f.notify(event)).status,503);assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_messages').get().status,'rejected');
  unavailable=false;await f.settings();assert.equal((await f.notify(event)).status,200);assert.equal(f.notices.length,1);assert.match(f.notices[0].payload.text,/slået fra/);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
});
test('an unconfirmed successful send uses the identical idempotent request when its database confirmation fails',async()=>{
  const f=await fixture();const enabled=await f.settings({enabled:false}),event=f.mail(enabled.data.address);const prepare=f.env.DB.prepare.bind(f.env.DB);let failed=false;
  f.env.DB.prepare=sql=>{const statement=prepare(sql);if(sql.includes("SET status='sent'")&&!failed){const bind=statement.bind.bind(statement);statement.bind=(...args)=>{const bound=bind(...args);bound.run=async()=>{failed=true;throw new Error('confirmation interrupted');};return bound;};}return statement;};
  assert.equal((await f.notify(event)).status,503);assert.equal(f.notices.length,1);assert.equal((await f.notify(event)).status,200);assert.equal(f.notices.length,2);assert.deepEqual(f.notices[0],f.notices[1]);assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_rejection_notices').get().status,'sent');
});

test('Resend rejection transport sets a stable idempotency header, uses server credentials and rejects ambiguous responses',async()=>{
  const {sendInboundRejection}=await import('../server/mail.mjs');const original=globalThis.fetch;const env={RESEND_API_KEY:'test-only-secret',EMAIL_FROM:'Finch <login@example.test>'};const payload={from:env.EMAIL_FROM,to:['member@example.test'],subject:'Afvist',text:'Årsag',headers:{'Auto-Submitted':'auto-replied'}};
  try{
    globalThis.fetch=async(url,options)=>{assert.equal(url,'https://api.resend.com/emails');assert.equal(options.headers['Idempotency-Key'],'stable-key');assert.equal(options.headers.Authorization,'Bearer test-only-secret');assert.deepEqual(JSON.parse(options.body),payload);return Response.json({id:'mock-resend-id'});};
    assert.equal((await sendInboundRejection(env,payload,'stable-key')).id,'mock-resend-id');
    globalThis.fetch=async()=>Response.json({});await assert.rejects(()=>sendInboundRejection(env,payload,'stable-key'),/response invalid/);
    globalThis.fetch=async()=>new Response('provider secret',{status:503});await assert.rejects(()=>sendInboundRejection(env,payload,'stable-key'),error=>error.message==='Rejection delivery failed (503).');
  }finally{globalThis.fetch=original;}
});


test('all active members including the owner are always allowed when enabled, ignoring old member blocks and stale clients',async()=>{
  const f=await fixture();const enabled=await f.settings({blockedMembers:['member@example.test','owner@example.test']});assert.equal(enabled.status,200);
  assert.equal(f.DB.sqlite.prepare('SELECT blocked_members_json FROM organization_inbound_settings').get().blocked_members_json,'[]');
  f.DB.sqlite.prepare('UPDATE organization_inbound_settings SET blocked_members_json=?').run(JSON.stringify(['member@example.test','owner@example.test']));
  const current=(await f.call(f.base+'/settings/inbound',f.owner)).data;assert.ok(current.members.every(m=>m.allowed));assert.equal(current.blockedMembers,undefined);
  assert.equal((await f.notify(f.mail(enabled.data.address))).status,200);assert.equal((await f.notify(f.mail(enabled.data.address,'owner@example.test'))).status,200);
  assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,2);
  await f.settings({enabled:false});assert.equal((await f.notify(f.mail(enabled.data.address))).status,200);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,2);
});

test('automatic member permission is rechecked if membership is revoked while an incoming email is fetched',async()=>{
  const f=await fixture();const enabled=await f.settings();const event=f.mail(enabled.data.address);
  f.setOverride(async()=>{const team=(await f.call(f.base+'/settings',f.owner)).data;const member=team.members.find(m=>m.id===f.memberId);assert.equal((await f.call(f.base+`/settings/members/${member.id}`,f.owner,'DELETE',{revision:member.revision})).status,200);});
  assert.equal((await f.notify(event)).status,200);assert.equal((await f.call(f.base,f.owner)).data.state.tasks.length,0);
  assert.equal(f.DB.sqlite.prepare('SELECT status FROM inbound_messages').get().status,'rejected');
});
