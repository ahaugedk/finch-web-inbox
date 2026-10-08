import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {database} from '../server/database.mjs';
import {organizationAccess,organizationTeam} from '../server/team.mjs';

const tenant='37c57cc9-eaaf-41b3-8bcd-1567ffebf16c';
const old='da336f19-9402-4e94-ae1e-1129495d01db',next='4b231426-39b8-4112-93d4-b587a082a5e7';
const migration=readFileSync('drizzle/0013_volvo_owner_email.sql','utf8');
function fixture({seed=true,status='active',newEmail='rune@orderly.ai'}={}){
  const DB=sqliteD1(),s=DB.sqlite;
  for(const file of readdirSync('drizzle').filter(f=>f.endsWith('.sql')&&!f.startsWith('0013_')).sort())s.exec(readFileSync('drizzle/'+file,'utf8'));
  if(seed){
    const user=s.prepare('INSERT INTO users(id,email,created_at,last_org_id) VALUES(?,?,1,?)');user.run(old,'rune@orderly.dk',tenant);user.run(next,newEmail,tenant);
    const org=s.prepare('INSERT INTO organizations(id,owner_id,name,state_json,revision,created_at,updated_at) VALUES(?,?,?,?,36,1,1)');org.run(tenant,old,'Volvo Trucks','{"tasks":[],"graph":{"nodes":[]}}');org.run('other',old,'Other organisation','{}');
    const member=s.prepare('INSERT INTO organization_members(id,organization_id,email,user_id,status,invited_by,created_at,updated_at) VALUES(?,?,?,?,?,?,1,1)');
    member.run('old-member',tenant,'rune@orderly.dk',old,'active',old);member.run('new-member',tenant,newEmail,next,status,old);member.run('other-member','other','rune@orderly.dk',old,'active',old);
    const assignment=s.prepare('INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at) VALUES(?,?,?,?,?,?,1)');
    assignment.run(tenant,'old-task',old,'Previous ownership','[{"text":"Original evidence"}]',old);assignment.run(tenant,'new-task',next,'Existing assignment','[]',next);assignment.run('other','other-task',old,'Unrelated assignment','[]',old);
  }
  return {DB,s,apply:()=>s.exec(migration)};
}

test('Volvo owner and old-owner assignments transfer without changing unrelated accounts or work',async()=>{
  const f=fixture();const previous=f.s.prepare('SELECT state_json FROM organizations WHERE id=?').get(tenant).state_json;f.apply();
  const db=database({DB:f.DB});const org=await organizationAccess(db,tenant,{id:next});
  assert.equal(org.access,'owner');assert.equal(org.owner_id,next);assert.equal(org.revision,37);assert.equal(org.state_json,previous);
  assert.equal(await organizationAccess(db,tenant,{id:old}),null);
  const team=await organizationTeam(db,org,next,Date.now());assert.equal(team.canManage,true);assert.equal(team.members.length,1);assert.equal(team.members[0].email,'rune@orderly.ai');assert.equal(team.members[0].isOwner,true);
  const task=f.s.prepare('SELECT * FROM task_assignments WHERE organization_id=? AND task_id=?').get(tenant,'old-task');assert.equal(task.assignee_id,next);assert.equal(task.revision,1);assert.equal(task.basis_json,'[{"text":"Original evidence"}]');assert.match(task.reason,/ejerskifte/);
  assert.equal(f.s.prepare('SELECT revision FROM task_assignments WHERE organization_id=? AND task_id=?').get(tenant,'new-task').revision,0);
  assert.equal(f.s.prepare('SELECT assignee_id FROM task_assignments WHERE organization_id=?').get('other').assignee_id,old);
  assert.equal(f.s.prepare('SELECT status FROM organization_members WHERE id=?').get('old-member').status,'revoked');assert.equal(f.s.prepare('SELECT status FROM organization_members WHERE id=?').get('other-member').status,'active');
  assert.equal(f.s.prepare('SELECT last_org_id FROM users WHERE id=?').get(old).last_org_id,null);assert.equal(f.s.prepare('SELECT COUNT(*) AS n FROM users').get().n,2);
  assert.equal((await organizationAccess(db,'other',{id:old})).access,'owner');
});

test('the correction is idempotent and safely does nothing on a fresh database',()=>{
  const f=fixture();f.apply();const before=JSON.stringify(f.s.prepare('SELECT * FROM organizations ORDER BY id').all());f.apply();assert.equal(JSON.stringify(f.s.prepare('SELECT * FROM organizations ORDER BY id').all()),before);
  assert.equal(f.s.prepare('SELECT revision FROM task_assignments WHERE organization_id=? AND task_id=?').get(tenant,'old-task').revision,1);assert.equal(f.s.prepare('SELECT revision FROM organization_members WHERE id=?').get('old-member').revision,1);
  const empty=fixture({seed:false});assert.doesNotThrow(empty.apply);
});

test('ownership and access stay unchanged unless the verified replacement account is an active member',()=>{
  for(const options of [{status:'invited'},{newEmail:'different@example.test'}]){
    const f=fixture(options);f.apply();assert.equal(f.s.prepare('SELECT owner_id FROM organizations WHERE id=?').get(tenant).owner_id,old);assert.equal(f.s.prepare('SELECT status FROM organization_members WHERE id=?').get('old-member').status,'active');assert.equal(f.s.prepare('SELECT assignee_id FROM task_assignments WHERE organization_id=? AND task_id=?').get(tenant,'old-task').assignee_id,old);
  }
});
