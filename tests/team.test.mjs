import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
const ORIGIN='https://finch.test';
async function setup(){
  const DB=sqliteD1();for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync(`drizzle/${file}`,'utf8'));
  const objects=new Map();const env={DB,AUTH_SECRET:'team-test-secret-at-least-thirty-two-chars',BUCKET:{put:async(key,bytes)=>objects.set(key,new Uint8Array(bytes)),get:async key=>objects.has(key)?{body:objects.get(key),arrayBuffer:async()=>objects.get(key).buffer}:null}};
  const codes=[];const mails=[];let failMail=false;
  const deps={sendMail:async(_,m)=>codes.push(m),sendInvitation:async(_,m)=>{if(failMail)throw new Error('Provider secret');mails.push(m);}};
  async function call(route,{cookie,method='GET',data,bytes,headers={},origin=ORIGIN}={}){
    const res=await handleApi(new Request(ORIGIN+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{}),...headers},...(data||bytes?{body:data?JSON.stringify(data):bytes}:{})}),env,deps);
    return {status:res.status,headers:res.headers,...(res.headers.get('Content-Type')?.includes('json')?{data:await res.json()}:{text:await res.text()})};
  }
  async function login(email){const start=await call('/api/auth/request-code',{method:'POST',data:{email}});assert.equal(start.status,200);const end=await call('/api/auth/verify-code',{method:'POST',data:{challengeId:start.data.challengeId,code:codes.at(-1).code}});assert.equal(end.status,200);return end.headers.get('Set-Cookie').split(';')[0];}
  const owner=await login('owner@example.test'),member=await login('member@example.test'),outsider=await login('outsider@example.test');
  const created=await call('/api/organizations',{method:'POST',cookie:owner,data:{name:'Truck project'}});const orgId=created.data.organization.id;
  const separate=await call('/api/organizations',{method:'POST',cookie:owner,data:{name:'Unrelated company'}});
  const settings=`/api/organizations/${orgId}/settings`;
  const role=await call(settings+'/roles',{method:'POST',cookie:owner,data:{title:'Konfigurationsansvarlig',description:'Godkender motorvalg og produktregler i vores lastbilprojekt.'}});assert.equal(role.status,201);
  async function invite(inGraph=true,email='member@example.test'){return call(settings+'/members',{method:'POST',cookie:owner,data:{email,name:'Maja',roleId:role.data.id,inGraph}});}
  return {DB,env,call,login,owner,member,outsider,orgId,otherOrg:separate.data.organization.id,settings,roleId:role.data.id,invite,mails,setFailMail:v=>failMail=v};
}
test('invitation grants access only after acceptance by its verified email and cannot be replayed',async()=>{
  const t=await setup();const invite=await t.invite();assert.equal(invite.status,201);const invitationId=invite.data.id;
  assert.equal(t.mails[0].email,'member@example.test');assert.match(t.mails[0].inviteUrl,/#invite=[a-f0-9]{64}$/);
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
  assert.equal((await t.call(`/api/invitations/${invitationId}/accept`,{method:'POST',cookie:t.outsider,data:{}})).status,404);
  assert.equal((await t.call(`/api/invitations/${invitationId}/accept`,{method:'POST',cookie:t.member,data:{},origin:'https://outside.test'})).status,403);
  const me=await t.call('/api/me',{cookie:t.member});assert.equal(me.data.invitations[0].invitationId,invitationId);assert.equal(me.data.organizations.length,0);
  const claims=await Promise.all([0,1].map(()=>t.call(`/api/invitations/${invitationId}/accept`,{method:'POST',cookie:t.member,data:{}})));assert.deepEqual(claims.map(c=>c.status).sort(),[200,404]);
  const after=await t.call('/api/me',{cookie:t.member});assert.equal(after.data.organizations[0].access,'member');assert.equal(after.data.invitations.length,0);
  assert.equal((await t.call(`/api/organizations/${t.otherOrg}`,{cookie:t.member})).status,404);
});
test('invitation emails use the configured public domain and keep the token in the fragment',async()=>{
  const t=await setup();t.env.PUBLIC_ORIGIN='https://mit.finch.dk';
  assert.equal((await t.invite()).status,201);
  const url=new URL(t.mails.at(-1).inviteUrl);assert.equal(url.origin,'https://mit.finch.dk');assert.equal(url.search,'');assert.match(url.hash,/^#invite=[a-f0-9]{64}$/);
});
test('invitation status is private to the verified recipient and confirms acceptance without accepting a link visit',async()=>{
  const t=await setup();const invite=await t.invite();const route=`/api/invitations/${invite.data.id}`;
  assert.equal((await t.call(route)).status,401);assert.equal((await t.call(route,{cookie:t.outsider})).status,404);
  const pending=await t.call(route,{cookie:t.member});assert.equal(pending.data.invitation.status,'invited');assert.equal(pending.data.invitation.organizationId,undefined);
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
  await t.call(route+'/accept',{method:'POST',cookie:t.member,data:{}});
  const accepted=await t.call(route,{cookie:t.member});assert.equal(accepted.data.invitation.status,'accepted');assert.equal(accepted.data.invitation.organizationId,t.orgId);
  await t.call(t.settings+`/members/${invite.data.id}`,{method:'DELETE',cookie:t.owner,data:{revision:1}});
  const revoked=await t.call(route,{cookie:t.member});assert.equal(revoked.data.invitation.status,'revoked');assert.equal(revoked.data.invitation.organizationId,undefined);
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
});
test('expired and declined invitations report their state without granting organisation access',async()=>{
  const t=await setup();const invite=await t.invite();const route=`/api/invitations/${invite.data.id}`;
  await t.DB.prepare('UPDATE organization_members SET expires_at=0 WHERE id=?').bind(invite.data.id).run();assert.equal((await t.call(route,{cookie:t.member})).data.invitation.status,'expired');
  assert.equal((await t.call(route+'/accept',{method:'POST',cookie:t.member,data:{}})).status,404);
  await t.DB.prepare('UPDATE organization_members SET expires_at=? WHERE id=?').bind(Date.now()+86400000,invite.data.id).run();
  await t.call(route+'/decline',{method:'POST',cookie:t.member,data:{}});assert.equal((await t.call(route,{cookie:t.member})).data.invitation.status,'declined');
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
});
test('an email token accepts without login or account creation; only the verified recipient can bind data access',async()=>{
  const t=await setup();const invite=await t.invite();const token=new URL(t.mails[0].inviteUrl).hash.slice('#invite='.length);
  const counts=()=>({users:t.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,sessions:t.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n});const before=counts();
  const stored=t.DB.sqlite.prepare('SELECT * FROM organization_invitation_tokens WHERE member_id=?').get(invite.data.id);assert.notEqual(stored.token_hash,token);assert.ok(!JSON.stringify(stored).includes(token));
  const inspect=await t.call('/api/invitation-links/inspect',{method:'POST',data:{token}});assert.equal(inspect.data.invitation.status,'invited');assert.equal(inspect.headers.get('Set-Cookie'),null);
  const revision=t.DB.sqlite.prepare('SELECT revision FROM organizations WHERE id=?').get(t.orgId).revision;
  const accepts=await Promise.all([0,1].map(()=>t.call('/api/invitation-links/accept',{method:'POST',data:{token}})));assert.ok(accepts.every(r=>r.data.invitation.status==='accepted'&&!r.headers.get('Set-Cookie')));
  assert.equal(t.DB.sqlite.prepare('SELECT revision FROM organizations WHERE id=?').get(t.orgId).revision,revision+1);assert.deepEqual(counts(),before);
  const accepted=t.DB.sqlite.prepare('SELECT * FROM organization_members WHERE id=?').get(invite.data.id);assert.equal(accepted.status,'accepted');assert.equal(accepted.user_id,null);
  assert.equal((await t.call(t.settings+`/members/${invite.data.id}/resend`,{cookie:t.owner,method:'POST',data:{revision:accepted.revision}})).status,409);
  assert.equal((await t.call('/api/invitation-links/inspect',{method:'POST',data:{token}})).data.invitation.status,'accepted');
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);await t.call('/api/me',{cookie:t.outsider});assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.outsider})).status,404);
  const me=await t.call('/api/me',{cookie:t.member});assert.ok(me.data.organizations.some(o=>o.id===t.orgId));assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,200);
});
test('a recipient without an account can accept first and receives membership only after verifying that email later',async()=>{
  const t=await setup();const before=t.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n;await t.invite(true,'fresh@example.test');const token=new URL(t.mails[0].inviteUrl).hash.slice(8);
  assert.equal((await t.call('/api/invitation-links/accept',{method:'POST',data:{token}})).data.invitation.status,'accepted');assert.equal(t.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,before);
  const cookie=await t.login('fresh@example.test');assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie})).status,404);
  const me=await t.call('/api/me',{cookie});assert.equal(me.data.organizations[0].id,t.orgId);assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie})).status,200);
});
test('email invitation tokens expire, reject foreign-origin actions and are replaced on resend and disabled on revocation',async()=>{
  const t=await setup();const invite=await t.invite();const token=new URL(t.mails[0].inviteUrl).hash.slice(8);
  const act=(action,value=token,origin=ORIGIN)=>t.call('/api/invitation-links/'+action,{method:'POST',data:{token:value},origin});
  assert.equal((await act('accept',token,'https://evil.test')).status,403);assert.equal((await act('accept',invite.data.id)).status,400);assert.equal((await act('inspect','a'.repeat(64))).status,404);
  await t.DB.prepare('UPDATE organization_invitation_tokens SET expires_at=0 WHERE member_id=?').bind(invite.data.id).run();const expired=await act('accept');assert.equal(expired.data.invitation.status,'expired');assert.equal(expired.data.invitation.organizationName,undefined);assert.equal(expired.data.invitation.roleTitle,undefined);
  assert.equal(t.DB.sqlite.prepare('SELECT status FROM organization_members WHERE id=?').get(invite.data.id).status,'invited');
  await t.call(t.settings+`/members/${invite.data.id}/resend`,{cookie:t.owner,method:'POST',data:{revision:0}});const fresh=new URL(t.mails.at(-1).inviteUrl).hash.slice(8);assert.notEqual(fresh,token);assert.equal((await act('inspect')).status,404);
  assert.equal((await act('accept',fresh)).data.invitation.status,'accepted');const member=t.DB.sqlite.prepare('SELECT * FROM organization_members WHERE id=?').get(invite.data.id);
  await t.call(t.settings+`/members/${invite.data.id}`,{cookie:t.owner,method:'DELETE',data:{revision:member.revision}});assert.equal((await act('accept',fresh)).data.invitation.status,'unavailable');
  assert.equal((await act('inspect',fresh)).data.invitation.organizationId,undefined);await t.call('/api/me',{cookie:t.member});assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
});
test('declining an email invitation is explicit and cannot be changed through the same token',async()=>{
  const t=await setup();await t.invite();const token=new URL(t.mails[0].inviteUrl).hash.slice(8);
  const act=action=>t.call('/api/invitation-links/'+action,{method:'POST',data:{token}});
  assert.equal((await act('inspect')).data.invitation.status,'invited');assert.equal((await act('decline')).data.invitation.status,'declined');assert.equal((await act('accept')).data.invitation.status,'declined');
  await t.call('/api/me',{cookie:t.member});assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
});
test('role descriptions and selected active people are projected from settings, never trusted from snapshots',async()=>{
  const t=await setup();const invite=await t.invite();let loaded=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});
  assert.equal(loaded.data.state.graph.nodes.some(n=>n.type==='person'),false);assert.ok(loaded.data.state.graph.nodes.some(n=>n.type==='rolle'&&n.managedBy==='settings'));
  await t.call(`/api/invitations/${invite.data.id}/accept`,{method:'POST',cookie:t.member,data:{}});loaded=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});
  const person=loaded.data.state.graph.nodes.find(n=>n.type==='person');assert.equal(person.label,'Maja');assert.ok(person.statements.some(s=>s.text.includes(`org-role-${t.roleId}`)));
  const state=loaded.data.state;person.statements[0].text='Forged membership';
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{method:'PUT',cookie:t.member,data:{revision:loaded.data.organization.revision,state}})).status,200);
  assert.equal(JSON.parse(t.DB.sqlite.prepare('SELECT state_json FROM organizations WHERE id=?').get(t.orgId).state_json).graph.nodes.some(n=>n.managedBy==='settings'),false);
  const settings=await t.call(t.settings,{cookie:t.owner});const m=settings.data.members.find(m=>m.id===invite.data.id);
  assert.equal((await t.call(`${t.settings}/members/${m.id}`,{method:'PUT',cookie:t.owner,data:{revision:m.revision,name:'Maja',roleId:t.roleId,inGraph:false}})).status,200);
  loaded=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member});assert.equal(loaded.data.state.graph.nodes.some(n=>n.type==='person'),false);
  const role=settings.data.roles[0];await t.call(`${t.settings}/roles/${role.id}`,{method:'PUT',cookie:t.owner,data:{revision:role.revision,title:role.title,description:'Har mandat til at godkende alternativer under vores effektkrav.'}});
  loaded=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member});assert.match(loaded.data.state.graph.nodes.find(n=>n.type==='rolle').statements[0].text,/effektkrav/);
});
test('members share work, physical tables, files, branding and pages but cannot manage members or roles',async()=>{
  const t=await setup();const table=await t.call(`/api/organizations/${t.orgId}/data/tables`,{method:'POST',cookie:t.owner,data:{name:'Engines',columns:[{name:'power',type:'number'}]}});
  const file=await t.call(`/api/organizations/${t.orgId}/data/files`,{method:'POST',cookie:t.owner,bytes:new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),headers:{'Content-Type':'image/svg+xml','X-File-Name':'logo.svg'}});
  let org=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});const state=org.data.state;
  state.branding={revision:1,theme:{accent:'#003399'},stylesheet:'',fonts:[],logo:{file_id:file.data.file.id,alt:'Company'}};
  const pageId='11111111-1111-4111-8111-111111111111';state.pages=[{id:pageId,title:'Shared page',status:'ready',tableIds:[table.data.table.id],component:{tag_name:'shared-page',html:'Shared work',css:'',javascript:''}}];
  await t.call(`/api/organizations/${t.orgId}`,{method:'PUT',cookie:t.owner,data:{revision:org.data.organization.revision,state}});
  const invite=await t.invite(false);await t.call(`/api/invitations/${invite.data.id}/accept`,{method:'POST',cookie:t.member,data:{}});
  assert.equal((await t.call(`${t.settings}/members`,{method:'POST',cookie:t.member,data:{email:'new@example.test'}})).status,403);
  assert.equal((await t.call(`${t.settings}/roles`,{method:'POST',cookie:t.member,data:{title:'Boss',description:'I manage access'}})).status,403);
  assert.equal((await t.call(`/api/organizations/${t.orgId}/data/tables/${table.data.table.id}/rows`,{method:'POST',cookie:t.member,data:{rows:[{values:{power:450}}]}})).status,201);
  assert.equal((await t.call(`/api/organizations/${t.orgId}/data/files/${file.data.file.id}/content`,{cookie:t.member})).status,200);
  assert.equal((await t.call(`/api/organizations/${t.orgId}/branding/assets/${file.data.file.id}`,{cookie:t.member})).status,200);
  assert.equal((await t.call(`/api/organizations/${t.orgId}/pages/${pageId}/render?token=22222222-2222-4222-8222-222222222222`,{cookie:t.member})).status,200);
  org=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member});assert.equal(org.data.organization.access,'member');org.data.state.tasks.push({id:'T-member',kind:'info',title:'Shared result'});
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{method:'PUT',cookie:t.member,data:{revision:org.data.organization.revision,state:org.data.state}})).status,200);
  const members=await t.call(t.settings,{cookie:t.owner});const m=members.data.members.find(m=>m.id===invite.data.id);
  await t.call(`${t.settings}/members/${m.id}`,{method:'DELETE',cookie:t.owner,data:{revision:m.revision}});
  for(const route of [`/api/organizations/${t.orgId}`,t.settings,`/api/organizations/${t.orgId}/data`,`/api/organizations/${t.orgId}/branding/assets/${file.data.file.id}`,`/api/organizations/${t.orgId}/pages/${pageId}/render?token=22222222-2222-4222-8222-222222222222`])assert.equal((await t.call(route,{cookie:t.member})).status,404);
  assert.equal((await t.call('/api/me',{cookie:t.member})).data.organizations.length,0);
});
test('failed delivery, expiry, decline and resend preserve invitation controls without granting access',async()=>{
  const t=await setup();t.setFailMail(true);const failed=await t.invite();assert.equal(failed.status,503);assert.doesNotMatch(JSON.stringify(failed.data),/Provider secret/);
  let settings=await t.call(t.settings,{cookie:t.owner});let m=settings.data.members.find(m=>!m.isOwner);assert.equal(m.status,'failed');
  assert.equal((await t.call(`/api/invitations/${m.id}/accept`,{method:'POST',cookie:t.member,data:{}})).status,404);
  t.setFailMail(false);const retry=await t.call(`${t.settings}/members/${m.id}/resend`,{method:'POST',cookie:t.owner,data:{revision:m.revision}});assert.equal(retry.status,201);
  t.DB.sqlite.prepare('UPDATE organization_members SET expires_at=0 WHERE id=?').run(m.id);
  assert.equal((await t.call(`/api/invitations/${m.id}/accept`,{method:'POST',cookie:t.member,data:{}})).status,404);
  settings=await t.call(t.settings,{cookie:t.owner});m=settings.data.members.find(m=>!m.isOwner);assert.equal(m.status,'expired');
  assert.equal((await t.call(`${t.settings}/members/${m.id}/resend`,{method:'POST',cookie:t.owner,data:{revision:m.revision}})).status,201);
  assert.equal((await t.call(`/api/invitations/${m.id}/decline`,{method:'POST',cookie:t.member,data:{}})).status,200);
  assert.equal((await t.call(`/api/organizations/${t.orgId}`,{cookie:t.member})).status,404);
});
test('owner profile can be added to the graph, cannot lose ownership, and foreign roles are rejected',async()=>{
  const t=await setup();const foreign=await t.call(`/api/organizations/${t.otherOrg}/settings/roles`,{method:'POST',cookie:t.owner,data:{title:'Foreign',description:'Only in the other organization.'}});
  assert.equal((await t.call(`${t.settings}/members/owner`,{method:'PUT',cookie:t.owner,data:{revision:0,name:'Ejer',roleId:foreign.data.id,inGraph:true}})).status,400);
  assert.equal((await t.call(`${t.settings}/members/owner`,{method:'PUT',cookie:t.owner,data:{revision:0,name:'Ejer',roleId:t.roleId,inGraph:true}})).status,200);
  const settings=await t.call(t.settings,{cookie:t.owner});const owner=settings.data.members.find(m=>m.isOwner);assert.equal(owner.name,'Ejer');
  assert.equal((await t.call(`${t.settings}/members/${owner.id}`,{method:'DELETE',cookie:t.owner,data:{revision:owner.revision}})).status,400);
  const org=await t.call(`/api/organizations/${t.orgId}`,{cookie:t.owner});assert.ok(org.data.state.graph.nodes.some(n=>n.type==='person'&&n.label==='Ejer'));
  const role=settings.data.roles[0];assert.equal((await t.call(`${t.settings}/roles/${role.id}`,{method:'DELETE',cookie:t.owner,data:{revision:role.revision}})).status,200);
  const after=await t.call(t.settings,{cookie:t.owner});assert.equal(after.data.members.find(m=>m.isOwner).roleId,null);
});
