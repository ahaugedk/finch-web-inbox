import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sqliteD1 } from '../scripts/sqlite-d1.mjs';
import { handleApi, emptyState } from '../server/api.mjs';

const ORIGIN = 'https://finch.test';
function setup(filename) {
  const DB = sqliteD1(filename);
  if (!filename) for (const file of readdirSync('drizzle').filter((f) => f.endsWith('.sql')).sort()) DB.sqlite.exec(readFileSync(`drizzle/${file}`, 'utf8'));
  const env = { DB, AUTH_SECRET: 'test-auth-secret-at-least-32-characters' }; const outbox = [];
  const sendMail = async (_, message) => outbox.push(message);
  async function call(route, { method = 'GET', data, cookie, origin = ORIGIN, ip = '192.0.2.1', dependencies = { sendMail } } = {}) {
    const response = await handleApi(new Request(`${ORIGIN}${route}`, {
      method, headers: { Origin: origin, 'CF-Connecting-IP': ip, ...(data ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}),
    }), env, dependencies);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie') };
  }
  async function login(email = 'owner@example.test', ip = '192.0.2.1') {
    const start = await call('/api/auth/request-code', { method: 'POST', data: { email }, ip }); assert.equal(start.status, 200);
    const message = outbox.at(-1);
    const verify = await call('/api/auth/verify-code', { method: 'POST', data: { challengeId: start.data.challengeId, code: message.code }, ip });
    assert.equal(verify.status, 200); return verify.cookie.split(';')[0];
  }
  return { env, call, login, outbox };
}
test('email login creates a stable identity, uses secure cookies and never returns the code', async () => {
  const t = setup(); const cookie = await t.login(' OWNER@example.test ');
  assert.match(cookie, /^__Host-finch_session=/);
  const me = await t.call('/api/me', { cookie }); assert.equal(me.data.user.email, 'owner@example.test');
  const code = t.outbox[0].code; assert.equal(code.length, 8);
  const row = t.env.DB.sqlite.prepare('SELECT * FROM login_challenges').get();
  assert.notEqual(row.code_hash, code); assert.equal(row.consumed, 1);
  const replay = await t.call('/api/auth/verify-code', { method: 'POST', data: { challengeId: row.id, code } }); assert.equal(replay.status, 400);
  t.env.DB.sqlite.exec('UPDATE rate_limits SET expires_at = 0');
  const secondCookie = await t.login('owner@example.test');
  const secondMe = await t.call('/api/me', { cookie: secondCookie }); assert.equal(secondMe.data.user.id, me.data.user.id);
});
test('bad codes consume attempts, expire, and cannot be reused concurrently', async () => {
  const t = setup(); const { data } = await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' } });
  const correct = t.outbox[0].code; const wrong = correct === '00000000' ? '11111111' : '00000000';
  for (let i = 0; i < 5; i++) assert.equal((await t.call('/api/auth/verify-code', { method: 'POST', data: { challengeId: data.challengeId, code: wrong } })).status, 400);
  assert.equal((await t.call('/api/auth/verify-code', { method: 'POST', data: { challengeId: data.challengeId, code: correct } })).status, 400);
  t.env.DB.sqlite.exec('UPDATE rate_limits SET expires_at = 0');
  const second = await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' } });
  t.env.DB.sqlite.prepare('UPDATE login_challenges SET expires_at = 0 WHERE id = ?').run(second.data.challengeId);
  assert.equal((await t.call('/api/auth/verify-code', { method: 'POST', data: { challengeId: second.data.challengeId, code: t.outbox.at(-1).code } })).status, 400);
  t.env.DB.sqlite.exec('UPDATE rate_limits SET expires_at = 0');
  const third = await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' } });
  const attempts = await Promise.all([0, 1].map(() => t.call('/api/auth/verify-code', { method: 'POST', data: { challengeId: third.data.challengeId, code: t.outbox.at(-1).code } })));
  assert.deepEqual(attempts.map((a) => a.status).sort(), [200, 400]);
});
test('request cooldown limits email spam and missing mail configuration fails closed', async () => {
  const t = setup();
  assert.equal((await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' } })).status, 200);
  assert.equal((await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' } })).status, 429);
  assert.equal(t.outbox.length, 1);
  assert.equal((await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'other@example.test' }, dependencies: {} })).status, 503);
});
test('failed delivery invalidates its challenge without exposing provider errors', async () => {
  const t = setup(); const result = await t.call('/api/auth/request-code', { method: 'POST', data: { email: 'owner@example.test' }, dependencies: { sendMail: async () => { throw new Error('secret'); } } });
  assert.equal(result.status, 503); assert.doesNotMatch(JSON.stringify(result.data), /secret/);
  assert.equal(t.env.DB.sqlite.prepare('SELECT consumed FROM login_challenges').get().consumed, 1);
});
test('all writes reject cross-origin requests, and anonymous users cannot read data', async () => {
  const t = setup();
  assert.equal((await t.call('/api/me')).status, 401);
  assert.equal((await t.call('/api/auth/request-code', { method: 'POST', origin: 'https://attacker.test', data: { email: 'owner@example.test' } })).status, 403);
  const cookie = await t.login();
  assert.equal((await t.call('/api/organizations', { method: 'POST', cookie, origin: 'https://attacker.test', data: { name: 'Secret' } })).status, 403);
});
test('organizations are isolated by account, and complete work survives new sessions', async () => {
  const t = setup(); const owner = await t.login(); const other = await t.login('other@example.test', '192.0.2.2');
  const created = await t.call('/api/organizations', { method: 'POST', cookie: owner, data: { name: 'Becher Madsen' } });
  assert.equal(created.status, 201); const orgId = created.data.organization.id;
  const state = emptyState('Becher Madsen'); state.graph.nodes.push({ id: 'fragt', label: 'Fragt', type: 'proces', statements: [{ id: 'fragt#1', text: 'Ekspres er en undtagelse.' }] });
  state.tasks.push({ id: 'S-201', kind: 'case', phase: 'active', title: 'Beregn fragt', ui: [], updates: [] });
  const saved = await t.call(`/api/organizations/${orgId}`, { method: 'PUT', cookie: owner, data: { revision: 0, state } }); assert.equal(saved.status, 200);
  for (const method of ['GET', 'PUT']) assert.equal((await t.call(`/api/organizations/${orgId}`, { method, cookie: other, ...(method === 'PUT' ? { data: { revision: 1, state } } : {}) })).status, 404);
  assert.equal((await t.call(`/api/organizations/${orgId}/select`, { method: 'POST', cookie: other, data: {} })).status, 404);
  const otherMe = await t.call('/api/me', { cookie: other }); assert.equal(otherMe.data.organizations.length, 0);
  const freshSessionMe = await t.call('/api/me', { cookie: owner }); assert.equal(freshSessionMe.data.lastOrgId, orgId);
  const loaded = await t.call(`/api/organizations/${orgId}`, { cookie: owner }); assert.deepEqual(loaded.data.state, state);
});
test('custom page code is persisted, owner-only, sandboxed and unavailable after archiving', async () => {
  const t=setup();const owner=await t.login();const other=await t.login('other@example.test','192.0.2.2');
  const created=await t.call('/api/organizations',{method:'POST',cookie:owner,data:{name:'Pages'}});const orgId=created.data.organization.id;
  const pageId='11111111-1111-4111-8111-111111111111';const token='22222222-2222-4222-8222-222222222222';
  const state=emptyState('Pages');state.pages=[{id:pageId,title:'Our page',status:'ready',tableIds:[],component:{tag_name:'our-page',html:'<p>Private organisation data</p>',css:'',javascript:''}}];
  assert.equal((await t.call(`/api/organizations/${orgId}`,{method:'PUT',cookie:owner,data:{revision:0,state}})).status,200);
  const route=`${ORIGIN}/api/organizations/${orgId}/pages/${pageId}/render?token=${token}`;
  const render=async cookie=>handleApi(new Request(route,{headers:cookie?{Cookie:cookie}:{}}),t.env);
  assert.equal((await render()).status,401);assert.equal((await render(other)).status,404);
  const response=await render(owner);assert.equal(response.status,200);assert.match(response.headers.get('Content-Security-Policy'),/sandbox allow-scripts/);assert.equal(response.headers.get('Cache-Control'),'no-store');assert.match(await response.text(),/Private organisation data/);
  state.pages[0].status='archived';await t.call(`/api/organizations/${orgId}`,{method:'PUT',cookie:owner,data:{revision:1,state}});assert.equal((await render(owner)).status,404);
  state.pages[0].component.javascript='x'.repeat(80001);assert.equal((await t.call(`/api/organizations/${orgId}`,{method:'PUT',cookie:owner,data:{revision:2,state}})).status,400);
});
test('optimistic revisions reject concurrent overwrites and support unchanged polling', async () => {
  const t = setup(); const cookie = await t.login();
  const org = await t.call('/api/organizations', { method: 'POST', cookie, data: { name: 'Test' } }); const orgId = org.data.organization.id;
  const firstState = emptyState('First'); const secondState = emptyState('Second');
  const results = await Promise.all([firstState, secondState].map((state) => t.call(`/api/organizations/${orgId}`, { method: 'PUT', cookie, data: { revision: 0, state } })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const stored = await t.call(`/api/organizations/${orgId}`, { cookie }); assert.equal(stored.data.organization.revision, 1);
  const unchanged = await t.call(`/api/organizations/${orgId}?revision=1`, { cookie }); assert.equal(unchanged.data.unchanged, true);
});
test('logout and session expiry revoke access', async () => {
  const t = setup(); const cookie = await t.login();
  const logout = await t.call('/api/auth/logout', { method: 'POST', cookie, data: {} }); assert.match(logout.cookie, /Max-Age=0/);
  assert.equal((await t.call('/api/me', { cookie })).status, 401);
  t.env.DB.sqlite.exec('UPDATE rate_limits SET expires_at = 0'); const second = await t.login();
  t.env.DB.sqlite.exec('UPDATE sessions SET expires_at = 0'); assert.equal((await t.call('/api/me', { cookie: second })).status, 401);
});
test('database state survives a process restart and cookie values are not stored in plaintext', async () => {
  const filename = path.join(mkdtempSync(path.join(tmpdir(), 'finch-db-test-')), 'data.sqlite');
  const first = setup(); first.env.DB.sqlite.exec(`VACUUM INTO '${filename.replaceAll("'", "''")}'`); first.env.DB.sqlite.close();
  const t = setup(filename); const cookie = await t.login();
  await t.call('/api/organizations', { method: 'POST', cookie, data: { name: 'Persisted' } });
  const row = t.env.DB.sqlite.prepare('SELECT token_hash FROM sessions').get(); assert.notEqual(row.token_hash, cookie.split('=')[1]);
  t.env.DB.sqlite.close();
  const restarted = setup(filename); const me = await restarted.call('/api/me', { cookie }); assert.equal(me.data.organizations[0].name, 'Persisted');
  restarted.env.DB.sqlite.close();
});
