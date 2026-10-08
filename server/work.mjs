import {organizationAccess,organizationTeam} from './team.mjs';
const WORK_ASSIGNMENT_FIELDS=['assigneeId','assignmentReason','assignmentEvidence','assignmentRevision'];
const WORK_VIEW_FIELDS=['view','listFilter','agentFilter','selected','selectedStick','graphFocus','organizationMember','organizationFilter'];
export function stripWorkMetadata(state){
  const clean={...state,tasks:state.tasks.map(t=>{const result={...t};for(const k of WORK_ASSIGNMENT_FIELDS)delete result[k];return result;})};
  delete clean._workWriteId;for(const k of WORK_VIEW_FIELDS)delete clean[k];return clean;
}
export async function workContext(db,org,user,now){
  const team=await organizationTeam(db,org,user.id,now);
  const records=await db.all('SELECT id,user_id FROM organization_members WHERE organization_id=? AND status=\'active\'',org.id);
  const members=team.members.filter(m=>m.status==='active').map(m=>{
    const assigneeId=m.isOwner?org.owner_id:records.find(r=>r.id===m.id)?.user_id;const role=team.roles.find(r=>r.id===m.roleId);
    return {assigneeId,memberId:m.id,name:m.name||m.email,isAdministrator:m.isOwner,inGraph:m.inGraph,
      roleId:role?.id || null,roleTitle:role?.title || '',roleDescription:role?.description || '',
      statementIds:role?[`org-role-${role.id}#1`]:[]};
  }).filter(m=>m.assigneeId);
  return {administratorId:org.owner_id,viewerId:user.id,members};
}
export function effectiveAssignee(task,context){return context.members.some(m=>m.assigneeId===task.assigneeId)?task.assigneeId:context.administratorId;}
export function workPhase(task){
  if(task.kind==='case')return ({pending:'active',draft:'open',active:'active',done:'done',discarded:'done'})[task.phase]||'done';
  if(task.kind==='info')return task.read?'done':'open';
  if(task.agentWorkStatus==='done')return 'done';
  if(task.agentWorkStatus==='working')return 'active';
  if(task.response)return task.response.seen?'done':'active'; // Legacy answers remain compatible.
  return 'open';
}
export async function projectWork(db,org,state,user,now){
  const context=await workContext(db,org,user,now);const rows=await db.all('SELECT * FROM task_assignments WHERE organization_id=?',org.id);
  const clean=stripWorkMetadata(state);
  const tasks=clean.tasks.map(task=>{
    const page=task.pageProposalId&&state.pages?.find(p=>p.id===task.pageProposalId);
    const t=page&&['ready','rejected'].includes(page.status)&&!task.agentWorkStatus?{...task,agentWorkStatus:'done'}:task;
    const row=rows.find(r=>r.task_id===t.id);if(!row)return {...t};
    const candidate=context.members.find(m=>m.assigneeId===row.assignee_id);
    return {...t,assigneeId:candidate?row.assignee_id:context.administratorId,
      assignmentReason:candidate?row.reason:'Den tidligere modtager er ikke længere medlem. Administratoren modtager opgaven.',
      assignmentEvidence:JSON.parse(row.basis_json),assignmentRevision:row.revision};
  });
  return {state:{view:'inbox',listFilter:'open',selected:null,...clean,tasks},work:context};
}
function selection(input,context,fail){
  const target=input.assigneeId || context.administratorId;const candidate=context.members.find(m=>m.assigneeId===target);
  if(!candidate)fail(400,'invalid_assignee','Modtageren skal være et aktivt medlem af organisationen.');
  const reason=typeof input.assignmentReason==='string'?input.assignmentReason.trim().slice(0,600):'';
  const ids=input.assignmentStatementIds || input.assignmentEvidence?.map(e=>e.statementId) || [];
  if(!Array.isArray(ids)||ids.length>20)fail(400,'invalid_assignment_basis','Tildelingens grundlag skal være en liste med udsagns-id’er.');
  if(target!==context.administratorId && (!candidate.roleId || reason.length<20 || !ids.includes(candidate.statementIds[0])))fail(400,'assignment_basis_required','Tildelingen kræver en konkret begrundelse og medlemmets rollebeskrivelse fra grafen.');
  return {assigneeId:target,reason:reason||'Ingen anden modtager er angivet. Opgaven går til organisationens administrator.',
    basis:candidate.roleId&&ids.includes(candidate.statementIds[0])?[{statementId:candidate.statementIds[0],conceptId:`org-role-${candidate.roleId}`,conceptLabel:candidate.roleTitle,text:candidate.roleDescription,source:'settings'}]:[]};
}
function same(a,b){return JSON.stringify(a??null)===JSON.stringify(b??null);}
function answerWithoutSeen(response){if(!response)return response;const clean={...response};delete clean.seen;return clean;}
async function createWork(db,orgId,user,input,now,fail){
  if(!['user','agent'].includes(input.kind)||typeof input.title!=='string'||!input.title.trim()||input.title.length>80||typeof input.description!=='string'||!input.description.trim()||input.description.length>4000||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.requestId||''))fail(400,'invalid_work_request','Angiv titel, beskrivelse og opgavetype.');
  if(input.kind==='user'&&typeof input.assigneeId!=='string'||input.kind==='agent'&&input.assigneeId!==undefined)fail(400,'invalid_assignee','Vælg et medlem til brugeropgaven.');
  for(let attempt=0;attempt<4;attempt++){
    const org=await organizationAccess(db,orgId,user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
    const previous=await db.first('SELECT task_id,kind FROM work_intake_requests WHERE organization_id=? AND user_id=? AND request_id=?',orgId,user.id,input.requestId);
    if(previous){if(previous.kind!==input.kind)fail(409,'request_id_used','Anmodningen er allerede brugt.');return {taskId:previous.task_id,duplicate:true};}
    const context=await workContext(db,org,user,now),target=input.kind==='user'?input.assigneeId:org.owner_id;
    const candidate=context.members.find(m=>m.assigneeId===target);if(!candidate)fail(400,'invalid_assignee','Modtageren skal være et aktivt medlem af organisationen.');
    const state=JSON.parse(org.state_json);if(state.tasks.length>=5000)fail(400,'too_many_tasks','Organisationen har for mange opgaver.');
    state.seq=Number.isSafeInteger(state.seq)?state.seq:0;let taskId;do{taskId=`${input.kind==='agent'?'S':'T'}-${200+(++state.seq)}`;}while(state.tasks.some(t=>t.id===taskId));
    const description=input.description.trim();const manualRequest={kind:input.kind,description,requestedBy:user.id,requestId:input.requestId};
    state.tasks.push({id:taskId,kind:input.kind==='agent'?'case':'task',...(input.kind==='agent'?{phase:'active',agentWorkStatus:'queued',progress:0}:{}),title:input.title.trim(),preview:description.slice(0,140),from:user.email,tag:input.kind==='agent'?'Agentopgave':'Opgave',time:new Date(now).toLocaleTimeString('da-DK',{timeZone:'Europe/Copenhagen',hour:'2-digit',minute:'2-digit'}),at:now,createdAt:now,read:false,ui:[{type:'text',text:description},...(input.kind==='user'?[{type:'text_input',id:'svar',label:'Svar',multiline:true}]:[])],actions:[],submit:'Send svar',draft:{},updates:[],manualRequest});
    if(input.kind==='agent')state.events.push({id:`E-${crypto.randomUUID()}`,type:'agent_work_requested',caseId:taskId,at:now,delivered:false});
    state.events=state.events.slice(-100);state._workWriteId=crypto.randomUUID();const snapshot=JSON.stringify(state);
    if(new TextEncoder().encode(snapshot).length>2*1024*1024)fail(413,'too_large','Organisationens data er for store.');
    const guard='EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)',values=[orgId,org.revision+1,snapshot];
    const reason=input.kind==='user'?`Manuelt tildelt af ${user.email} til ${candidate.name}.`:'Oprettet af en bruger til agenten. Administratoren er modtager af eventuelle afklaringer.';
    const basis=candidate.roleId?[{statementId:candidate.statementIds[0],conceptId:`org-role-${candidate.roleId}`,conceptLabel:candidate.roleTitle,text:candidate.roleDescription,source:'settings'}]:[];
    const changed=await db.batch([
      db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?
        AND (owner_id=? OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=? AND status='active'))
        AND (?=owner_id OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=? AND status='active'))
        AND NOT EXISTS(SELECT 1 FROM work_intake_requests WHERE organization_id=? AND user_id=? AND request_id=?) RETURNING revision`,snapshot,now,orgId,org.revision,user.id,orgId,user.id,target,orgId,target,orgId,user.id,input.requestId),
      db.statement(`INSERT INTO work_intake_requests(organization_id,user_id,request_id,task_id,kind,created_at) SELECT ?,?,?,?,?,? WHERE ${guard}`,orgId,user.id,input.requestId,taskId,input.kind,now,...values),
      db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,orgId,taskId,target,reason,JSON.stringify(basis),user.id,now,...values),
    ]);
    if(changed[0].results?.length)return {taskId,duplicate:false};
  }
  fail(409,'work_request_conflict','Organisationen blev ændret. Prøv igen.');
}
export async function prepareWorkSave(db,org,oldState,input,user,now,fail){
  const projected=await projectWork(db,org,oldState,user,now);const context=projected.work;const assignments=[];
  const ids=new Set();
  for(const task of input.tasks){
    if(ids.has(task.id)||!task.id)fail(400,'duplicate_task','Opgaver skal have unikke id’er.');ids.add(task.id);
    const previous=projected.state.tasks.find(t=>t.id===task.id);
    if(previous){
      const owner=effectiveAssignee(previous,context);
      if(task.assigneeId!==undefined && task.assigneeId!==owner)fail(409,'assignment_changed','Tildelingen er ændret. Brug assign_task til at ændre modtageren.');
      if(user.id!==owner && (!same(answerWithoutSeen(task.response),answerWithoutSeen(previous.response)) || !same(task.values,previous.values) ||
        (task.kind==='info'&&task.read!==previous.read) || (!same(task.draft,previous.draft)&&same(task.ui,previous.ui)) ||
        (previous.kind==='case'&&previous.phase==='draft'&&['active','discarded'].includes(task.phase))))fail(403,'assignee_required','Kun opgavens modtager kan svare eller ændre dens felter.');
    } else {
      const selected=selection(task,context,fail);
      if(user.id!==selected.assigneeId&&(task.response || task.values || (task.kind==='info'&&task.read)))fail(403,'assignee_required','Kun modtageren kan besvare opgaven.');
      if(task.assigneeId!==undefined)assignments.push({taskId:task.id,...selected});
    }
  }
  for(const previous of projected.state.tasks)if(!ids.has(previous.id)&&user.id!==context.administratorId&&user.id!==effectiveAssignee(previous,context))fail(403,'assignee_required','En andens opgave kan ikke fjernes gennem din indbakke.');
  const state=stripWorkMetadata(input);state._workWriteId=crypto.randomUUID();return {state,assignments};
}
export function newAssignmentStatements(db,org,prepared,serialized,user,now,newRevision){
  return prepared.assignments.map(a=>db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at)
    SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)`,
    org.id,a.taskId,a.assigneeId,a.reason,JSON.stringify(a.basis),user.id,now,org.id,newRevision,serialized));
}
export async function handleWorkApi(request,env,{db,user,now,fail,json,body}){
  const route=new URL(request.url).pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/work(?:\/([^/]+)\/assignment)?$/);if(!route)return null;
  const org=await organizationAccess(db,route[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
  if(!route[2]&&request.method==='POST')return json(await createWork(db,org.id,user,await body(request,12000),now,fail));
  const projected=await projectWork(db,org,JSON.parse(org.state_json),user,now);
  if(!route[2]&&request.method==='GET')return json({...projected.work,revision:org.revision});
  if(route[2]&&request.method==='PUT'){
    const task=projected.state.tasks.find(t=>t.id===route[2]);if(!task)fail(404,'task_not_found','Opgaven findes ikke i organisationen.');
    const input=await body(request,6000);if(input.revision!==org.revision||(input.assignmentRevision??0)!==(task.assignmentRevision||0))fail(409,'assignment_conflict','Opgaven eller tildelingen er ændret. Hent get_state igen.');
    const selected=selection(input,projected.work,fail);
    const snapshot=JSON.stringify({...JSON.parse(org.state_json),_workWriteId:crypto.randomUUID()});
    const results=await db.batch([
      db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?
        AND (owner_id=? OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=? AND status='active'))
        AND (NOT EXISTS(SELECT 1 FROM task_assignments WHERE organization_id=? AND task_id=?)
          OR EXISTS(SELECT 1 FROM task_assignments WHERE organization_id=? AND task_id=? AND revision=?)) RETURNING revision`,
        snapshot,now,org.id,input.revision,user.id,org.id,user.id,org.id,task.id,org.id,task.id,input.assignmentRevision||0),
      db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at)
        SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)
        ON CONFLICT(organization_id,task_id) DO UPDATE SET assignee_id=excluded.assignee_id,reason=excluded.reason,basis_json=excluded.basis_json,
        updated_by=excluded.updated_by,updated_at=excluded.updated_at,revision=task_assignments.revision+1 RETURNING revision`,
        org.id,task.id,selected.assigneeId,selected.reason,JSON.stringify(selected.basis),user.id,now,org.id,input.revision+1,snapshot),
    ]);
    const assignment=results[1].results?.[0];if(!results[0].results?.[0]||!assignment)fail(409,'assignment_conflict','Tildelingen er ændret. Hent get_state igen.');
    return json({taskId:task.id,assigneeId:selected.assigneeId,assignmentRevision:assignment.revision});
  }
  fail(405,'method_not_allowed','Handlingen understøttes ikke.');
}
