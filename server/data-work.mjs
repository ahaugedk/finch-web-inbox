import {organizationAccess} from './team.mjs';

export function dataWorkId(value,fail){if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value||''))fail(400,'invalid_request_id','Ugyldig anmodning.');return value;}
export async function previousDataWork(db,orgId,userId,requestId,kind,fail){
  const row=await db.first('SELECT kind,case_id,file_id FROM data_work_requests WHERE organization_id=? AND user_id=? AND request_id=?',orgId,userId,requestId);
  if(row&&row.kind!==kind)fail(409,'request_id_used','Anmodningen er allerede brugt til noget andet.');
  return row?{case_id:row.case_id,file_id:row.file_id,duplicate:true}:null;
}
// One D1 transaction commits the case, assignment, deduplication key and optional file metadata.
export async function queueDataWork(context,orgId,requestId,detail,file){
  const {db,user,now,fail}=context;
  for(let attempt=0;attempt<4;attempt++){
    const org=await organizationAccess(db,orgId,user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
    const previous=await previousDataWork(db,orgId,user.id,requestId,detail.kind,fail);if(previous)return previous;
    const state=JSON.parse(org.state_json);if(state.tasks.length>=5000)fail(400,'too_many_tasks','Organisationen har for mange opgaver.');
    state.seq=(Number.isSafeInteger(state.seq)?state.seq:0)+1;const caseId=`S-${200+state.seq}`;
    if(state.tasks.some(t=>t.id===caseId))fail(409,'case_id_conflict','Opgaven kunne ikke oprettes. Genindlæs organisationen.');
    const dataRequest={...detail,requestedBy:user.id,requestId,...(file?{fileId:file.id,fileName:file.name}:{})};
    state.tasks.push({id:caseId,kind:'case',phase:'active',agentWorkStatus:'queued',title:detail.kind==='file'?`Gennemgå fil: ${file.name}`.slice(0,80):`Opret tabel: ${detail.name}`.slice(0,80),tag:detail.kind==='file'?'Fil':'Tabelønske',from:state.agent||'Agenten',preview:'Venter på agenten',at:now,createdAt:now,time:new Date(now).toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'}),read:false,ui:[],draft:{},updates:[],dataRequest});
    state.events.push({id:`E-${crypto.randomUUID()}`,type:detail.kind==='file'?'data_file_uploaded':'data_table_requested',caseId,at:now,delivered:false});state.events=state.events.slice(-100);state._workWriteId=crypto.randomUUID();const snapshot=JSON.stringify(state);
    if(new TextEncoder().encode(snapshot).length>2*1024*1024)fail(413,'too_large','Organisationens data er for store.');
    const guard='EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)',guardValues=[orgId,org.revision+1,snapshot];
    const batch=[db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (owner_id=? OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=? AND status='active')) AND NOT EXISTS(SELECT 1 FROM data_work_requests WHERE organization_id=? AND user_id=? AND request_id=?) RETURNING revision`,snapshot,now,orgId,org.revision,user.id,orgId,user.id,orgId,user.id,requestId)];
    if(file)batch.push(db.statement(`INSERT INTO stored_files(id,organization_id,name,description,content_type,size_bytes,sha256,object_key,source_url,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE ${guard}`,file.id,orgId,file.name,file.description,file.contentType,file.size,file.sha256,file.objectKey,file.sourceUrl,now,now,...guardValues));
    batch.push(db.statement(`INSERT INTO data_work_requests(organization_id,user_id,request_id,kind,case_id,file_id,created_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,orgId,user.id,requestId,detail.kind,caseId,file?.id||null,now,...guardValues));
    batch.push(db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE ${guard}`,orgId,caseId,org.owner_id,'Organisationens administrator modtager dataopgaven, indtil agenten fordeler den efter rollebeskrivelsen.','[]',user.id,now,...guardValues));
    const results=await db.batch(batch);if(results[0].results?.length)return {case_id:caseId,file_id:file?.id||null,duplicate:false};
  }
  fail(409,'data_request_conflict','Organisationen blev ændret. Prøv igen med samme anmodning.');
}
