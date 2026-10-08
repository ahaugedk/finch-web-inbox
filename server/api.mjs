import { database } from './database.mjs';
import { sendLoginCode, sendOrganizationInvitation,sendInboundRejection } from './mail.mjs';
import { handleDataApi } from './data.mjs';
import { validPages, customPageDocument, PAGE_CSP } from './pages.mjs';
import { brandAsset, embeddedBranding } from './branding-assets.mjs';
import '../brand-model.js';
import '../data-controls.js';
import {handleConnectionApi} from './connections.mjs';
import {organizationAccess,organizationTeam,accessibleOrganizations,pendingInvitations,handleTeamApi,handleInvitationLinkApi,claimAcceptedInvitations,projectTeamKnowledge,withoutTeamKnowledge} from './team.mjs';
import {handleInboundWebhook,handleInboundApi,readInboundSettings} from './inbound.mjs';
import {projectWork,prepareWorkSave,newAssignmentStatements,handleWorkApi} from './work.mjs';
import {handleNotificationApi} from './notifications.mjs';
import {onboardingProfile,organizationSetupTasks,readOnboarding,handleOnboardingApi} from './onboarding.mjs';
import {handlePageFileApi} from './page-files.mjs';
import {handlePageRuntime,pageUserState} from './page-runtime.mjs';

const encoder = new TextEncoder();
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const SESSION_SECONDS = 30 * 24 * 60 * 60;
class HttpError extends Error {
  constructor(status, code, message) { super(message); Object.assign(this, { status, code }); }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
});
const id = () => crypto.randomUUID();
const hex = (bytes) => Array.from(new Uint8Array(bytes), (n) => n.toString(16).padStart(2, '0')).join('');
const token = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const hash = async (value) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(value)));
async function sign(env, value) {
  if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32) throw new Error('AUTH_SECRET is unavailable.');
  const key = await crypto.subtle.importKey('raw', encoder.encode(env.AUTH_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}
function code() {
  const limit = Math.floor(2 ** 32 / 100000000) * 100000000;
  let n;
  do { n = crypto.getRandomValues(new Uint32Array(1))[0]; } while (n >= limit);
  return String(n % 100000000).padStart(8, '0');
}
function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, 'invalid_email', 'Skriv en gyldig emailadresse.');
  return email;
}
function localhost(request) { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(request.url).hostname); }
function cookieName(request) { return localhost(request) ? 'finch_session' : '__Host-finch_session'; }
function sessionCookie(request, value, age = SESSION_SECONDS) {
  return `${cookieName(request)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${localhost(request) ? '' : '; Secure'}`;
}
function cookieValue(request) {
  const entries = (request.headers.get('Cookie') || '').split(';').map((p) => p.trim());
  return entries.find((p) => p.startsWith(`${cookieName(request)}=`))?.split('=')[1] || '';
}
function checkOrigin(request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site')
    fail(403, 'wrong_origin', 'Denne handling skal ske fra Finch.');
}
async function body(request, maxBytes = 4096) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) fail(415, 'invalid_content', 'Forventede JSON.');
  if (Number(request.headers.get('Content-Length')) > maxBytes) fail(413, 'too_large', 'Indholdet er for stort.');
  const reader = request.body?.getReader();
  const chunks = []; let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel(); fail(413, 'too_large', 'Indholdet er for stort.'); }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { const data = JSON.parse(new TextDecoder().decode(bytes)); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
  catch { fail(400, 'invalid_json', 'Ugyldigt indhold.'); }
}
async function limit(db, key, maximum, seconds, now) {
  const row = await db.first(`INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
    expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count`, key, now + seconds * 1000, now, now);
  if (row.count > maximum) fail(429, 'rate_limited', 'For mange forsøg. Vent lidt, og prøv igen.');
}
async function identity(request, db, now) {
  const value = cookieValue(request);
  if (!/^[a-f0-9]{64}$/.test(value)) fail(401, 'login_required', 'Log ind med din email for at fortsætte.');
  const user = await db.first(`SELECT u.id, u.email, u.last_org_id FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`, await hash(value), now);
  if (!user) fail(401, 'login_required', 'Dit login er udløbet. Log ind igen.');
  return user;
}
export function emptyState(name) {
  return { agent: null, workspace: { name, tagline: '' }, tasks: [], pages: [], selected: null, view: 'inbox', listFilter: 'open', events: [], graph: { nodes: [], seq: 0 }, seq: 0 };
}
function checkedState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.tasks) || !Array.isArray(value.graph?.nodes)
    || !Array.isArray(value.events) || value.tasks.length > 5000 || value.graph.nodes.length > 10601)
    fail(400, 'invalid_state', 'Organisationens data har et ugyldigt format.');
  if (!value.graph.nodes.every((n) => n && typeof n.id === 'string' && typeof n.label === 'string' && Array.isArray(n.statements))
    || !value.tasks.every((t) => t && typeof t.id === 'string' && ['case', 'question', 'task', 'info'].includes(t.kind)) || !validPages(value.pages) || globalThis.FinchBrandModel.validate(value.branding))
    fail(400, 'invalid_state', 'Organisationens data har et ugyldigt format.');
  const cleaned=withoutTeamKnowledge(value);
  delete cleaned.onboarding;delete cleaned.organizationProfile;
  if(cleaned.graph.nodes.length>10000)fail(400,'invalid_state','Organisationens data har et ugyldigt format.');
  return JSON.stringify(cleaned);
}
function orgName(value) { const name = typeof value === 'string' ? value.trim().slice(0, 80) : ''; if (!name) fail(400, 'name_required', 'Giv organisationen et navn.'); return name; }
const orgSummary = (row) => ({ id: row.id, name: row.name, revision: row.revision, updatedAt: row.updated_at, access:row.access || 'owner' });

// No OAuth or platform identity is used. All data access is checked against our own verified email account.
export async function handleApi(request, env, dependencies = {}) {
  try {
    const url = new URL(request.url);
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) fail(405, 'method_not_allowed', 'Metoden understøttes ikke.');
    const db = database(env); const now = Date.now();
    if(url.pathname==='/api/webhooks/resend/inbound')return await handleInboundWebhook(request,env,{db,now,fail,json,provider:dependencies.inboundProvider,sendRejection:dependencies.sendInboundRejection||sendInboundRejection,limit,sign});
    if (request.method !== 'GET') checkOrigin(request);
    const invitationLinkResult=await handleInvitationLinkApi(request,env,{db,now,fail,json,body,hash,id,limit,sign});if(invitationLinkResult)return invitationLinkResult;
    const connectionResult=await handleConnectionApi(request,env,{db,now,fail,json,body,id,limit,sign});if(connectionResult)return connectionResult;
    if (url.pathname === '/api/auth/request-code' && request.method === 'POST') {
      if (!dependencies.sendMail && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) fail(503, 'email_unavailable', 'Login-mail er endnu ikke klar. Prøv igen senere.');
      const { email: rawEmail } = await body(request); const email = emailAddress(rawEmail);
      const ip = request.headers.get('CF-Connecting-IP') || (localhost(request) ? 'local' : 'unknown');
      await limit(db, `request-ip:${await sign(env, ip)}`, 20, 3600, now);
      await limit(db, `request-email:${await sign(env, email)}`, 5, 3600, now);
      await limit(db, `cooldown:${await sign(env, email)}`, 1, 60, now);
      const challengeId = id(); const loginCode = code();
      await db.batch([
        db.statement('UPDATE login_challenges SET consumed = 1 WHERE email = ? AND consumed = 0', email),
        db.statement('INSERT INTO login_challenges (id, email, code_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)', challengeId, email, await sign(env, `${challengeId}:${loginCode}`), now + 600000, now),
      ]);
      try { await (dependencies.sendMail || sendLoginCode)(env, { email, code: loginCode, challengeId }); }
      catch {
        await db.run('UPDATE login_challenges SET consumed = 1 WHERE id = ?', challengeId);
        fail(503, 'email_unavailable', 'Vi kunne ikke sende koden. Vent et minut, og prøv igen.');
      }
      return json({ challengeId, expiresIn: 600 });
    }
    if (url.pathname === '/api/auth/verify-code' && request.method === 'POST') {
      const input = await body(request);
      if (typeof input.challengeId !== 'string' || input.challengeId.length > 64 || !/^\d{8}$/.test(input.code || '')) fail(400, 'invalid_code', 'Indtast koden med 8 cifre.');
      const ip = request.headers.get('CF-Connecting-IP') || (localhost(request) ? 'local' : 'unknown');
      await limit(db, `verify-ip:${await sign(env, ip)}`, 30, 900, now);
      const digest = await sign(env, `${input.challengeId}:${input.code}`);
      // The attempt increment and code comparison are atomic. Concurrent requests cannot replay a code.
      const challenge = await db.first(`UPDATE login_challenges SET attempts = attempts + 1
        WHERE id = ? AND consumed = 0 AND expires_at > ? AND attempts < 5 RETURNING email, code_hash`, input.challengeId, now);
      if (!challenge || challenge.code_hash !== digest) fail(400, 'invalid_code', 'Koden er forkert eller udløbet. Bed om en ny kode, hvis nødvendigt.');
      const consumed = await db.first(`UPDATE login_challenges SET consumed = 1
        WHERE id = ? AND consumed = 0 AND expires_at > ? AND code_hash = ? RETURNING email`, input.challengeId, now, digest);
      if (!consumed) fail(400, 'invalid_code', 'Koden er allerede brugt eller udløbet.');
      const userId = id(); const sessionToken = token();
      await db.batch([
        db.statement('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING', userId, consumed.email, now),
        db.statement(`INSERT INTO sessions (token_hash, user_id, expires_at, created_at)
          SELECT ?, id, ?, ? FROM users WHERE email = ?`, await hash(sessionToken), now + SESSION_SECONDS * 1000, now, consumed.email),
      ]);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, sessionToken) });
    }
    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const value = cookieValue(request);
      if (value) await db.run('DELETE FROM sessions WHERE token_hash = ?', await hash(value));
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
    }
    const user = await identity(request, db, now);
    const pageRuntime=await handlePageRuntime(request,env,{db,user,now,fail,json,body,id,emailAddress});if(pageRuntime)return pageRuntime;
    const pageFileResult=await handlePageFileApi(request,env,{db,user,fail,json});if(pageFileResult)return pageFileResult;
    const onboardingResult=await handleOnboardingApi(request,env,{db,user,now,fail,json,body});if(onboardingResult)return onboardingResult;
    const notificationResult=await handleNotificationApi(request,env,{db,user,now,fail,json,body});if(notificationResult)return notificationResult;
    const settingsMatch=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/settings$/);
    if(settingsMatch&&request.method==='GET'){const org=await organizationAccess(db,settingsMatch[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');return json({...await organizationTeam(db,org,user.id,now),inbound:await readInboundSettings(db,org,user.id,env,now)});}
    const inboundResult=await handleInboundApi(request,env,{db,user,now,fail,json,body});if(inboundResult)return inboundResult;
    const teamResult=await handleTeamApi(request,env,{db,user,now,fail,json,body,id,emailAddress,limit,sign,
      token,hash,sendInvitation:dependencies.sendInvitation || sendOrganizationInvitation,canSendInvitation:!!dependencies.sendInvitation || !!(env.RESEND_API_KEY && env.EMAIL_FROM)});
    if(teamResult)return teamResult;
    const workResult=await handleWorkApi(request,env,{db,user,now,fail,json,body});if(workResult)return workResult;
    const dataResult = await handleDataApi(request, env, { db, user, now, fail, json, body, id });
    if (dataResult) return dataResult;
    if (url.pathname === '/api/me' && request.method === 'GET') {
      await claimAcceptedInvitations(db,user,now);
      const organizations = await accessibleOrganizations(db,user);
      return json({ user: { id: user.id, email: user.email }, organizations: organizations.map(orgSummary), invitations:await pendingInvitations(db,user,now), lastOrgId: user.last_org_id });
    }
    if (url.pathname === '/api/organizations' && request.method === 'POST') {
      const input = await body(request, MAX_STATE_BYTES + 4096); const name = orgName(input.name);
      if(input.state&&input.profile)fail(400,'invalid_profile_import','En import kan ikke samtidig starte en ny onboarding.');
      const profile=input.profile?onboardingProfile(input.profile,name,fail):null;
      const initial=input.state?JSON.parse(checkedState(input.state)):emptyState(name);
      if(profile){initial.tasks.push(...organizationSetupTasks(profile,initial,now));initial.events.push({id:`E-${id()}`,type:'organization_created',at:now,delivered:false});}
      const state=JSON.stringify(initial);
      const orgId = id();
      const roleId=profile?id():null;
      await db.batch([
        db.statement('INSERT INTO organizations (id, owner_id, name, state_json, revision, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)', orgId, user.id, name, state, now, now),
        db.statement('UPDATE users SET last_org_id = ? WHERE id = ?', orgId, user.id),
        ...(profile?[
          db.statement('INSERT INTO organization_onboarding(organization_id,profile_json,updated_at) VALUES(?,?,?)',orgId,JSON.stringify(profile),now),
          db.statement('INSERT INTO organization_roles(id,organization_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',roleId,orgId,profile.roleTitle,profile.roleDescription||`Brugeren har angivet sin rolle i denne organisation som ${profile.roleTitle}. Ansvar og mandat er endnu ikke beskrevet.`,now,now),
          db.statement("INSERT INTO organization_members(id,organization_id,email,user_id,role_id,status,invited_by,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?,?)",id(),orgId,user.email,user.id,roleId,user.id,now,now),
        ]:[]),
      ]);
      const org={id:orgId,owner_id:user.id,name,revision:0,updated_at:now,access:'owner'};
      return json({organization:orgSummary(org),...await projectWork(db,org,await projectTeamKnowledge(db,org,JSON.parse(state)),user,now),onboarding:await readOnboarding(db,org,user)},201);
    }
    const brandMatch=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/branding\/assets\/([a-f0-9-]{36})$/);
    if(brandMatch && request.method==='GET') {
      const org=await organizationAccess(db,brandMatch[1],user);
      const brand=org && JSON.parse(org.state_json).branding;
      const kind=brand?.logo?.file_id===brandMatch[2]?'logo':brand?.fonts?.some(f=>f.file_id===brandMatch[2])?'font':null;
      const asset=kind && await brandAsset(db,env,brandMatch[1],brandMatch[2],kind);
      if(!asset)fail(404,'brand_asset_not_found','Designfilen findes ikke, eller du har ikke adgang.');
      return new Response(asset.object.body,{headers:{'Content-Type':asset.file.content_type,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
    }
    const pageMatch = url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/pages\/([a-f0-9-]{36})\/render$/);
    if (pageMatch && request.method === 'GET') {
      const org = await organizationAccess(db,pageMatch[1],user);
      const saved=org && JSON.parse(org.state_json);
      const page = saved && saved.pages?.find(p => p.id === pageMatch[2] && p.status === 'ready' && p.component);
      if (!page) fail(404, 'page_not_found', 'Siden findes ikke, eller du har ikke adgang.');
      const token = url.searchParams.get('token');
      if (!/^[a-f0-9-]{36}$/.test(token || '')) fail(400, 'invalid_page_token', 'Ugyldig sideforbindelse.');
      const branding=await embeddedBranding(db,env,pageMatch[1],saved.branding);
      const runtime=await pageUserState(db,org.id,page,user.id);
      const dashboardLibraries=await dependencies.dashboardLibraries?.()||{scripts:[],css:''};
      return new Response(customPageDocument({...page,values:runtime.values,valuesRevision:runtime.revision}, token, branding,dashboardLibraries), { headers: {
        'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': PAGE_CSP,
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
      }});
    }
    const match = url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})(\/select)?$/);
    if (match) {
      const orgId = match[1];
      const org = await organizationAccess(db,orgId,user);
      if (!org) fail(404, 'organization_not_found', 'Organisationen findes ikke, eller du har ikke adgang.');
      if (match[2] && request.method === 'POST') {
        await db.run('UPDATE users SET last_org_id = ? WHERE id = ?', orgId, user.id);
        const projected=await projectWork(db,org,await projectTeamKnowledge(db,org,JSON.parse(org.state_json)),user,now);
        return json({ organization: orgSummary(org), ...projected,onboarding:await readOnboarding(db,org,user) });
      }
      if (!match[2] && request.method === 'GET') {
        if (url.searchParams.get('revision') === String(org.revision)) return json({ unchanged: true, revision: org.revision });
        const projected=await projectWork(db,org,await projectTeamKnowledge(db,org,JSON.parse(org.state_json)),user,now);
        return json({ organization: orgSummary(org), ...projected,onboarding:await readOnboarding(db,org,user) });
      }
      if (!match[2] && request.method === 'PUT') {
        const input = await body(request, MAX_STATE_BYTES + 4096);
        if (!Number.isSafeInteger(input.revision) || input.revision < 0) fail(400, 'invalid_revision', 'Ugyldig version.');
        const checked=JSON.parse(checkedState(input.state));const prepared=await prepareWorkSave(db,org,JSON.parse(org.state_json),checked,user,now,fail);
        const state=JSON.stringify(prepared.state);const name=input.state.workspace?.name ? orgName(input.state.workspace.name) : org.name;
        const results = await db.batch([db.statement(`UPDATE organizations SET state_json = ?, name = ?, revision = revision + 1, updated_at = ?
          WHERE id = ? AND revision = ? AND (owner_id=? OR EXISTS (SELECT 1 FROM organization_members m WHERE m.organization_id=organizations.id AND m.user_id=? AND m.status='active'))
          RETURNING id, name, revision, updated_at`, state, name, now, orgId, input.revision,user.id,user.id),...newAssignmentStatements(db,org,prepared,state,user,now,input.revision+1)]);
        const result=results[0].results?.[0];
        if (!result) fail(409, 'revision_conflict', 'Organisationen er ændret i en anden browser. Dine ændringer er bevaret her.');
        return json({ organization: orgSummary({...result,access:org.access}) });
      }
    }
    fail(404, 'not_found', 'Siden findes ikke.');
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.code, message: error.message }, error.status);
    console.error('Finch API unavailable:', error?.name || 'Error');
    return json({ error: 'unavailable', message: 'Vi kan ikke hente eller gemme dine data lige nu. Prøv igen om lidt.' }, 503);
  }
}
