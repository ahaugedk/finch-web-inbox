import '../site-config.js';
// Membership is separate from workspace snapshots. Every route checks current access.
export async function organizationAccess(db, orgId, user) {
  return db.first(`SELECT o.*, CASE WHEN o.owner_id = ? THEN 'owner' ELSE 'member' END AS access
    FROM organizations o WHERE o.id = ? AND (o.owner_id = ? OR EXISTS (
      SELECT 1 FROM organization_members m WHERE m.organization_id = o.id AND m.user_id = ? AND m.status = 'active'))`,user.id,orgId,user.id,user.id);
}
export async function accessibleOrganizations(db, user) {
  return db.all(`SELECT o.id,o.name,o.revision,o.updated_at,CASE WHEN o.owner_id = ? THEN 'owner' ELSE 'member' END AS access
    FROM organizations o WHERE o.owner_id = ? OR EXISTS (SELECT 1 FROM organization_members m
      WHERE m.organization_id = o.id AND m.user_id = ? AND m.status = 'active') ORDER BY o.updated_at DESC`,user.id,user.id,user.id);
}
export async function pendingInvitations(db,user,now) {
  return db.all(`SELECT m.id AS invitationId,o.name AS organizationName,m.display_name AS displayName,
    r.title AS roleTitle,m.expires_at AS expiresAt FROM organization_members m JOIN organizations o ON o.id=m.organization_id
    LEFT JOIN organization_roles r ON r.id=m.role_id AND r.deleted_at IS NULL
    WHERE m.email=? AND m.status='invited' AND m.expires_at>? ORDER BY m.created_at DESC`,user.email,now);
}
export async function organizationTeam(db,org,userId,now) {
  const owner=await db.first('SELECT email FROM users WHERE id=?',org.owner_id);
  const rows=await db.all("SELECT * FROM organization_members WHERE organization_id=? AND status!='revoked' ORDER BY created_at",org.id);
  const roles=await db.all('SELECT id,title,description,revision FROM organization_roles WHERE organization_id=? AND deleted_at IS NULL ORDER BY title',org.id);
  const members=rows.map(m=>({id:m.id,email:m.email,name:m.display_name,roleId:m.role_id,inGraph:!!m.include_in_graph,
    status:m.status==='invited' && m.expires_at<=now?'expired':m.status,expiresAt:m.expires_at,revision:m.revision,isOwner:m.user_id===org.owner_id}));
  if(!members.some(m=>m.isOwner))members.unshift({id:'owner',email:owner.email,name:'',roleId:null,inGraph:false,status:'active',revision:0,isOwner:true});
  return {canManage:org.owner_id===userId,organizationRevision:org.revision,roles,members};
}
const managedTeamId=/^org-(person|role|company)-[a-f0-9-]{36}$/;
export function withoutTeamKnowledge(state) {
  return {...state,graph:{...state.graph,nodes:state.graph.nodes.filter(n=>!managedTeamId.test(n.id))}};
}
export async function projectTeamKnowledge(db,org,state) {
  const clean=withoutTeamKnowledge(state);const nodes=[...clean.graph.nodes];
  const roles=await db.all('SELECT id,title,description FROM organization_roles WHERE organization_id=? AND deleted_at IS NULL',org.id);
  const people=await db.all(`SELECT id,email,display_name,role_id FROM organization_members
    WHERE organization_id=? AND status='active' AND include_in_graph=1`,org.id);
  const labelText=s=>String(s).replace(/[\[\]|]/g,' ').slice(0,80);
  const reason='Defineret i denne organisations indstillinger af organisationens ejer.';
  const node=(nodeId,label,type,texts)=>({id:nodeId,label,type,managedBy:'settings',stub:false,
    statements:texts.map((text,i)=>({id:`${nodeId}#${i+1}`,text,source:'settings',organizationSpecificReason:reason}))});
  for(const r of roles)nodes.push(node(`org-role-${r.id}`,r.title,'rolle',[r.description]));
  if(people.length) {
    let company=nodes.find(n=>n.type==='virksomhed');
    if(!company){company=node(`org-company-${org.id}`,org.name,'virksomhed',[`Organisationen er registreret i Finch som ${org.name}.`]);nodes.push(company);}
    for(const p of people) {
      const r=roles.find(r=>r.id===p.role_id);const statements=[`Er medlem af [[${company.id}|${labelText(org.name)}]].`];
      if(r)statements.push(`Har rollen [[org-role-${r.id}|${labelText(r.title)}]] i organisationen.`);
      nodes.push({...node(`org-person-${p.id}`,p.display_name || p.email,'person',statements),memberId:p.id});
    }
  }
  return {...clean,graph:{...clean.graph,nodes}};
}
function teamText(value,max){return typeof value==='string'?value.trim().slice(0,max):'';}

// Email-link acceptance never creates a user or browser session.
export async function handleInvitationLinkApi(request,env,{db,now,fail,json,body,hash,id,limit,sign}){
  const route=new URL(request.url).pathname.match(/^\/api\/invitation-links\/(inspect|accept|decline)$/);if(!route)return null;
  if(request.method!=='POST')fail(405,'method_not_allowed','Brug invitationssiden til at åbne linket.');
  const ip=request.headers.get('CF-Connecting-IP')||'unknown';await limit(db,`invitation-link:${await sign(env,ip)}`,120,60,now);
  const input=await body(request);if(typeof input.token!=='string'||!/^[a-f0-9]{64}$/.test(input.token))fail(400,'invalid_invitation_token','Invitationslinket er ugyldigt. Bed administratoren sende en ny invitation.');
  const tokenHash=await hash(input.token);
  const read=()=>db.first(`SELECT t.*,m.status AS member_status,m.expires_at AS member_expires,m.organization_id,o.name AS organization_name,r.title AS role_title
    FROM organization_invitation_tokens t JOIN organization_members m ON m.id=t.member_id JOIN organizations o ON o.id=m.organization_id
    LEFT JOIN organization_roles r ON r.id=m.role_id AND r.deleted_at IS NULL WHERE t.token_hash=?`,tokenHash);
  const status=m=>m.expires_at<=now?'expired':['accepted','active'].includes(m.member_status)?'accepted':m.member_status==='declined'?'declined':m.member_status==='invited'&&m.member_expires>now?'invited':m.member_status==='invited'?'expired':'unavailable';
  let m=await read();if(!m)fail(404,'invitation_link_not_found','Linket er ikke længere aktivt. Bed administratoren sende en ny invitation.');
  if(route[1]!=='inspect'&&status(m)==='invited'){
    const decision=route[1]==='accept'?'accepted':'declined',operation=id();
    await db.batch([
      db.statement(`UPDATE organization_invitation_tokens SET decision=?,decided_at=?,decision_id=? WHERE token_hash=? AND decision IS NULL AND expires_at>?
        AND EXISTS(SELECT 1 FROM organization_members WHERE id=member_id AND status='invited' AND expires_at>?)`,decision,now,operation,tokenHash,now,now),
      db.statement(`UPDATE organization_members SET status=?,user_id=NULL,revision=revision+1,updated_at=? WHERE id=? AND status='invited'
        AND EXISTS(SELECT 1 FROM organization_invitation_tokens WHERE token_hash=? AND decision_id=?)`,decision,now,m.member_id,tokenHash,operation),
      db.statement(`UPDATE organizations SET revision=revision+1,updated_at=? WHERE id=?
        AND EXISTS(SELECT 1 FROM organization_invitation_tokens WHERE token_hash=? AND decision_id=?)`,now,m.organization_id,tokenHash,operation),
    ]);m=await read();
  }
  const currentStatus=status(m);
  return json({invitation:{status:currentStatus,expiresAt:m.expires_at,
    ...(['invited','accepted'].includes(currentStatus)?{organizationId:m.organization_id,organizationName:m.organization_name,roleTitle:m.role_title||''}:{})}});
}
export async function claimAcceptedInvitations(db,user,now){
  const activated=await db.all(`UPDATE organization_members SET status='active',user_id=?,revision=revision+1,updated_at=?
    WHERE email=? AND status='accepted' RETURNING organization_id`,user.id,now,user.email);
  if(activated.length)await db.batch([...new Set(activated.map(m=>m.organization_id))].map(orgId=>db.statement('UPDATE organizations SET revision=revision+1,updated_at=? WHERE id=?',now,orgId)));
}
export async function handleTeamApi(request,env,context) {
  const {db,user,now,fail,json,body,id,emailAddress,limit,sign,sendInvitation,token,hash}=context;
  const url=new URL(request.url);
  const invitation=url.pathname.match(/^\/api\/invitations\/([a-f0-9-]{36})$/);
  if(invitation && request.method==='GET'){
    const m=await db.first(`SELECT m.id,m.status,m.user_id,m.expires_at,o.id AS organization_id,o.name AS organization_name,r.title AS role_title
      FROM organization_members m JOIN organizations o ON o.id=m.organization_id
      LEFT JOIN organization_roles r ON r.id=m.role_id AND r.deleted_at IS NULL
      WHERE m.id=? AND m.email=?`,invitation[1],user.email);
    if(!m)fail(404,'invitation_not_found','Invitationen findes ikke eller gælder en anden email.');
    const accepted=m.status==='accepted'||m.status==='active'&&m.user_id===user.id;
    return json({invitation:{invitationId:m.id,organizationName:m.organization_name,roleTitle:m.role_title||'',expiresAt:m.expires_at,
      status:accepted?'accepted':m.status==='invited'&&m.expires_at<=now?'expired':m.status==='active'?'unavailable':m.status,
      ...(accepted?{organizationId:m.organization_id}:{})}});
  }
  const claim=url.pathname.match(/^\/api\/invitations\/([a-f0-9-]{36})\/(accept|decline)$/);
  if(claim && request.method==='POST') {
    const m=await db.first(`UPDATE organization_members SET status=?,user_id=?,revision=revision+1,updated_at=?
      WHERE id=? AND email=? AND status='invited' AND expires_at>? RETURNING organization_id`,
      claim[2]==='accept'?'active':'declined',claim[2]==='accept'?user.id:null,now,claim[1],user.email,now);
    if(!m)fail(404,'invitation_not_found','Invitationen findes ikke, er udløbet eller gælder en anden email.');
    const changes=[db.statement('UPDATE organizations SET revision=revision+1,updated_at=? WHERE id=?',now,m.organization_id)];
    if(claim[2]==='accept')changes.push(db.statement('UPDATE users SET last_org_id=? WHERE id=?',m.organization_id,user.id));
    await db.batch(changes);return json({organizationId:m.organization_id,accepted:claim[2]==='accept'});
  }
  const route=url.pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/settings(?:\/(roles|members)(?:\/(owner|[a-f0-9-]{36})(?:\/(resend))?)?)?$/);
  if(!route)return null;
  const org=await organizationAccess(db,route[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
  if(request.method==='GET' && !route[2])return json(await organizationTeam(db,org,user.id,now));
  if(org.owner_id!==user.id)fail(403,'owner_required','Kun organisationens ejer kan ændre medlemmer og roller.');
  const input=await body(request,6000);
  const touch=()=>db.statement('UPDATE organizations SET revision=revision+1,updated_at=? WHERE id=?',now,org.id);
  const roleId=async value=>{
    if(value===null || value===undefined || value==='')return null;
    const role=typeof value==='string' && await db.first('SELECT id FROM organization_roles WHERE id=? AND organization_id=? AND deleted_at IS NULL',value,org.id);
    if(!role)fail(400,'invalid_role','Rollen findes ikke i organisationen.');return role.id;
  };
  if(route[2]==='roles') {
    if(request.method==='POST' && !route[3]) {
      if((await db.first('SELECT COUNT(*) AS count FROM organization_roles WHERE organization_id=? AND deleted_at IS NULL',org.id)).count>=100)fail(400,'too_many_roles','Organisationen kan have højst 100 roller.');
      const title=teamText(input.title,80),description=teamText(input.description,2000);if(!title || !description)fail(400,'role_required','Giv rollen et navn og en beskrivelse.');
      const role=id();await db.batch([db.statement('INSERT INTO organization_roles(id,organization_id,title,description,created_at,updated_at) VALUES(?,?,?,?,?,?)',role,org.id,title,description,now,now),touch()]);return json({id:role},201);
    }
    const r=await db.first('SELECT * FROM organization_roles WHERE id=? AND organization_id=? AND deleted_at IS NULL',route[3],org.id);
    if(!r)fail(404,'role_not_found','Rollen findes ikke.');
    if(input.revision!==r.revision)fail(409,'team_conflict','Rollen er ændret. Hent indstillingerne igen.');
    if(request.method==='PUT') {
      const title=teamText(input.title,80),description=teamText(input.description,2000);if(!title||!description)fail(400,'role_required','Giv rollen et navn og en beskrivelse.');
      const changed=await db.first('UPDATE organization_roles SET title=?,description=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND deleted_at IS NULL RETURNING id',title,description,now,r.id,r.revision);
      if(!changed)fail(409,'team_conflict','Rollen er ændret. Hent indstillingerne igen.');await db.batch([touch()]);return json({id:r.id});
    }
    if(request.method==='DELETE') {
      const changed=await db.first('UPDATE organization_roles SET deleted_at=?,revision=revision+1 WHERE id=? AND revision=? AND deleted_at IS NULL RETURNING id',now,r.id,r.revision);
      if(!changed)fail(409,'team_conflict','Rollen er ændret. Hent indstillingerne igen.');
      await db.batch([db.statement('UPDATE organization_members SET role_id=NULL,revision=revision+1,updated_at=? WHERE organization_id=? AND role_id=?',now,org.id,r.id),touch()]);return json({id:r.id});
    }
  }
  if(route[2]==='members') {
    if(request.method==='POST' && (!route[3] || route[4]==='resend')) {
      if(!context.canSendInvitation)fail(503,'email_unavailable','Invitationsmail er ikke klar. Prøv igen senere.');
      let m=route[3] && await db.first('SELECT * FROM organization_members WHERE id=? AND organization_id=?',route[3],org.id);
      const email=m?m.email:emailAddress(input.email);
      const owner=await db.first('SELECT email FROM users WHERE id=?',org.owner_id);if(email===owner.email)fail(400,'already_owner','Emailadressen tilhører allerede organisationens ejer.');
      if(!m)m=await db.first('SELECT * FROM organization_members WHERE organization_id=? AND email=?',org.id,email);
      if(m?.status==='active')fail(409,'already_member','Personen er allerede medlem.');
      if(m?.status==='accepted')fail(409,'invitation_already_accepted','Invitationen er allerede accepteret. Medlemmet kan fortsætte i sin agents browser med den inviterede emailadresse.');
      if(m?.status==='sending' && now-m.updated_at<30000)fail(409,'team_conflict','Invitationen er ved at blive sendt. Vent et øjeblik.');
      if(route[3] && (!m || input.revision!==m.revision))fail(409,'team_conflict','Invitationen er ændret. Hent indstillingerne igen.');
      const role=await roleId(input.roleId===undefined?m?.role_id:input.roleId);
      if(input.inGraph!==undefined && typeof input.inGraph!=='boolean')fail(400,'invalid_graph_choice','Vælg, om personen skal være i grafen.');
      const inGraph=input.inGraph===undefined?!!m?.include_in_graph:input.inGraph;
      const name=input.name===undefined?m?.display_name || '':teamText(input.name,80);
      await limit(db,`invite:${org.id}:${await sign(env,user.id)}`,20,3600,now);
      if(!m && (await db.first('SELECT COUNT(*) AS count FROM organization_members WHERE organization_id=?',org.id)).count>=500)fail(400,'too_many_members','Organisationen kan have højst 500 medlemmer og invitationer.');
      const memberId=m?.id || id();const revision=m?m.revision+1:0;const expires=now+7*24*60*60*1000;
      if(m){const changed=await db.first(`UPDATE organization_members SET status='sending',display_name=?,role_id=?,include_in_graph=?,expires_at=?,revision=revision+1,updated_at=?
        WHERE id=? AND revision=? RETURNING id`,name,role,inGraph?1:0,expires,now,m.id,m.revision);if(!changed)fail(409,'team_conflict','Invitationen er ændret.');}
      else {try{await db.run(`INSERT INTO organization_members(id,organization_id,email,display_name,role_id,include_in_graph,status,expires_at,invited_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,'sending',?,?,?,?)`,memberId,org.id,email,name,role,inGraph?1:0,expires,user.id,now,now);}catch{fail(409,'team_conflict','Invitationen findes allerede. Hent indstillingerne igen.');}}
      const invitationToken=token(),tokenHash=await hash(invitationToken);const join=new URL('/',globalThis.FinchSite.publicOrigin(request.url,env.PUBLIC_ORIGIN));join.hash='invite='+invitationToken;
      try {await sendInvitation(env,{email,organizationName:org.name,inviteId:memberId,inviteUrl:join.href,revision});}
      catch {await db.batch([db.statement("UPDATE organization_members SET status='failed' WHERE id=? AND revision=? AND status='sending'",memberId,revision),touch()]);fail(503,'email_unavailable','Invitationen kunne ikke sendes. Den er gemt, så du kan prøve igen.');}
      await db.batch([
        db.statement("UPDATE organization_members SET status='invited' WHERE id=? AND revision=? AND status='sending'",memberId,revision),
        db.statement(`DELETE FROM organization_invitation_tokens WHERE member_id=? AND EXISTS(SELECT 1 FROM organization_members WHERE id=? AND revision=? AND status='invited')`,memberId,memberId,revision),
        db.statement(`INSERT INTO organization_invitation_tokens(token_hash,member_id,expires_at,created_at)
          SELECT ?,id,?,? FROM organization_members WHERE id=? AND revision=? AND status='invited'`,tokenHash,expires,now,memberId,revision),touch(),
      ]);
      return json({id:memberId,expiresAt:expires},201);
    }
    let m=route[3]==='owner'?await db.first('SELECT * FROM organization_members WHERE organization_id=? AND user_id=?',org.id,org.owner_id):await db.first('SELECT * FROM organization_members WHERE id=? AND organization_id=?',route[3],org.id);
    if(!m && route[3]!=='owner')fail(404,'member_not_found','Medlemmet findes ikke.');
    if(m?.status==='revoked')fail(404,'member_not_found','Medlemmet er fjernet fra organisationen.');
    if(input.revision!==(m?.revision || 0))fail(409,'team_conflict','Medlemmet er ændret. Hent indstillingerne igen.');
    if(request.method==='PUT') {
      if(typeof input.inGraph!=='boolean')fail(400,'invalid_graph_choice','Vælg, om personen skal være i grafen.');
      const role=await roleId(input.roleId);const name=teamText(input.name,80);
      if(!m){const owner=await db.first('SELECT email FROM users WHERE id=?',org.owner_id);const memberId=id();
        await db.batch([db.statement(`INSERT INTO organization_members(id,organization_id,email,user_id,display_name,role_id,include_in_graph,status,invited_by,created_at,updated_at)
          VALUES(?,?,?,?,?,?,?,'active',?,?,?)`,memberId,org.id,owner.email,org.owner_id,name,role,input.inGraph?1:0,user.id,now,now),touch()]);return json({id:memberId});}
      const changed=await db.first('UPDATE organization_members SET display_name=?,role_id=?,include_in_graph=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? RETURNING id',name,role,input.inGraph?1:0,now,m.id,m.revision);
      if(!changed)fail(409,'team_conflict','Medlemmet er ændret.');await db.batch([touch()]);return json({id:m.id});
    }
    if(request.method==='DELETE') {
      if(!m || m.user_id===org.owner_id)fail(400,'owner_cannot_leave','Ejeren kan ikke fjernes fra organisationen.');
      const changed=await db.first("UPDATE organization_members SET status='revoked',include_in_graph=0,revision=revision+1,updated_at=? WHERE id=? AND revision=? RETURNING id",now,m.id,m.revision);
      if(!changed)fail(409,'team_conflict','Medlemmet er ændret.');await db.batch([touch()]);return json({id:m.id});
    }
  }
  fail(405,'method_not_allowed','Handlingen understøttes ikke.');
}
