import {organizationAccess} from './team.mjs';
import {handleDataApi} from './data.mjs';
const PAGE_RUNTIME_ID=/^[a-f0-9-]{36}$/;
export async function pageUserState(db,orgId,page,userId){
  const row=await db.first('SELECT values_json,revision FROM page_user_states WHERE organization_id=? AND page_id=? AND user_id=?',orgId,page.id,userId);
  return {values:row?JSON.parse(row.values_json):(page.values||{}),revision:row?.revision||0};
}
function pageRuntimeValues(value,fail){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>['__proto__','constructor','prototype'].includes(k)))fail(400,'invalid_page_values','Sidens værdier skal være et objekt.');const json=JSON.stringify(value);if(new TextEncoder().encode(json).length>32000)fail(413,'page_values_too_large','Gem større dataposter i en tabel.');return json;}
export async function handlePageRuntime(request,env,ctx){
  const {db,user,now,fail,json,body}=ctx;
  const route=new URL(request.url).pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/pages\/([a-f0-9-]{36})\/(state|data|agent-requests)$/);if(!route)return null;
  const expected=request.headers.get('X-Finch-User');if(expected&&expected!==user.id)fail(409,'page_identity_changed','Dit login er ændret. Genindlæs Finch.');
  const org=await organizationAccess(db,route[1],user),page=org&&JSON.parse(org.state_json).pages?.find(p=>p.id===route[2]&&p.status==='ready');
  if(!page)fail(404,'page_not_found','Siden findes ikke, eller du har ikke adgang.');
  if(route[3]==='state'&&request.method==='GET')return json(await pageUserState(db,org.id,page,user.id));
  if(request.method!=='POST'&&!(route[3]==='state'&&request.method==='PUT'))fail(405,'method_not_allowed','Metoden understøttes ikke.');
  const input=await body(request,1024*1024);
  if(input.page_revision!==page.revision)fail(409,'page_changed','Siden er ændret. Genindlæs den, før du fortsætter.');
  if(route[3]==='state'){
    const values=pageRuntimeValues(input.values,fail);if(!Number.isSafeInteger(input.revision)||input.revision<0)fail(400,'invalid_revision','Ugyldig version.');
    const existing=await pageUserState(db,org.id,page,user.id);if(existing.revision!==input.revision)fail(409,'page_state_conflict','Dine sideværdier er ændret i en anden fane. Genindlæs siden.');
    const row=await db.first(`INSERT INTO page_user_states(organization_id,page_id,user_id,values_json,revision,updated_at)
      SELECT ?,?,?,?,1,? WHERE EXISTS(SELECT 1 FROM organizations o WHERE id=? AND (owner_id=? OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=o.id AND user_id=? AND status='active'))
        AND EXISTS(SELECT 1 FROM json_each(o.state_json,'$.pages') p WHERE json_extract(p.value,'$.id')=? AND json_extract(p.value,'$.status')='ready' AND json_extract(p.value,'$.revision')=?))
      ON CONFLICT(organization_id,page_id,user_id) DO UPDATE SET values_json=excluded.values_json,revision=page_user_states.revision+1,updated_at=excluded.updated_at WHERE page_user_states.revision=? RETURNING revision`,org.id,page.id,user.id,values,now,org.id,user.id,user.id,page.id,page.revision,input.revision);
    if(!row)fail(409,'page_state_conflict','Siden eller dine værdier er ændret. Genindlæs siden.');return json({status:'saved',revision:row.revision,values:JSON.parse(values)});
  }
  if(route[3]==='data'){
    const operation=input.operation,data=input.input||{},tableId=data.table_id;
    if(!PAGE_RUNTIME_ID.test(tableId||'')||!page.tableIds.includes(tableId))fail(403,'page_table_scope','Siden kan kun bruge sine valgte tabeller.');
    const writes=['insert_rows','update_row','delete_row'];if(writes.includes(operation)&&!(page.writableTableIds||[]).includes(tableId))fail(403,'page_table_read_only','Siden må kun læse denne tabel.');
    let suffix='',method='GET',payload;
    if(operation==='get_table')suffix=`/tables/${tableId}`;
    else if(operation==='query_table'){suffix=`/tables/${tableId}/query`;method='POST';payload=data;}
    else if(operation==='insert_rows'){suffix=`/tables/${tableId}/rows`;method='POST';payload=data;}
    else if(['get_row','update_row','delete_row'].includes(operation)){
      if(!PAGE_RUNTIME_ID.test(data.row_id||''))fail(400,'invalid_row_id','Ugyldig række.');suffix=`/tables/${tableId}/rows/${data.row_id}`;
      if(operation==='update_row'){method='PUT';payload=data;}if(operation==='delete_row'){method='DELETE';payload=data;}
    }else fail(400,'invalid_page_operation','Siden kan læse og ændre rækker, men ikke ændre tabellers schema.');
    const url=new URL(request.url);url.pathname=`/api/organizations/${org.id}/data${suffix}`;
    const headers=new Headers(request.headers);headers.delete('Content-Length');
    const delegated=new Request(url,{method,headers,...(payload?{body:JSON.stringify(payload)}:{})});
    return handleDataApi(delegated,env,ctx);
  }
  if(!PAGE_RUNTIME_ID.test(input.request_id||''))fail(400,'invalid_request_id','Ugyldig opgaveanmodning.');
  const name=typeof input.name==='string'?input.name.trim().slice(0,80):'';if(!name)fail(400,'name_required','Beskriv det arbejde, agenten skal udføre.');
  const values=JSON.parse(pageRuntimeValues(input.values||{},fail));
  for(let attempt=0;attempt<4;attempt++){
    const previous=await db.first('SELECT case_id FROM page_agent_requests WHERE organization_id=? AND page_id=? AND user_id=? AND request_id=?',org.id,page.id,user.id,input.request_id);
    if(previous)return json({status:'queued',case_id:previous.case_id,request_id:input.request_id,duplicate:true});
    const latest=await organizationAccess(db,org.id,user),state=latest&&JSON.parse(latest.state_json),current=state?.pages?.find(p=>p.id===page.id&&p.status==='ready'&&p.revision===input.page_revision);
    if(!current)fail(409,'page_changed','Siden eller din adgang er ændret. Genindlæs siden.');
    if(state.tasks.length>=5000)fail(400,'too_many_tasks','Organisationen har for mange opgaver.');
    state.seq=(Number.isSafeInteger(state.seq)?state.seq:0)+1;const caseId=`S-${200+state.seq}`;if(state.tasks.some(t=>t.id===caseId))fail(409,'case_id_conflict','Opgaven kunne ikke oprettes. Genindlæs organisationen.');
    const pageRequest={pageId:page.id,pageTitle:current.title,name,values,requestedBy:user.id,requestId:input.request_id,tableIds:[...current.tableIds],fileIds:[...(current.fileIds||[])]};
    state.tasks.push({id:caseId,kind:'case',phase:'active',agentWorkStatus:'queued',title:`${current.title}: ${name}`.slice(0,80),tag:'Fra side',from:state.agent||'Agenten',preview:'Venter på agenten',at:now,createdAt:now,time:new Date(now).toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'}),read:false,ui:[],draft:{},updates:[],pageRequest});
    state.events.push({id:`E-${crypto.randomUUID()}`,type:'page_agent_requested',caseId,at:now,delivered:false});state.events=state.events.slice(-100);state._workWriteId=crypto.randomUUID();const snapshot=JSON.stringify(state);
    if(new TextEncoder().encode(snapshot).length>2*1024*1024)fail(413,'too_large','Organisationens data er for store.');
    const changed=await db.batch([
      db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND (owner_id=? OR EXISTS(SELECT 1 FROM organization_members WHERE organization_id=? AND user_id=? AND status='active')) AND NOT EXISTS(SELECT 1 FROM page_agent_requests WHERE organization_id=? AND page_id=? AND user_id=? AND request_id=?) RETURNING revision`,snapshot,now,org.id,latest.revision,user.id,org.id,user.id,org.id,page.id,user.id,input.request_id),
      db.statement(`INSERT INTO page_agent_requests(organization_id,page_id,user_id,request_id,case_id,created_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)`,org.id,page.id,user.id,input.request_id,caseId,now,org.id,latest.revision+1,snapshot),
      db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)`,org.id,caseId,latest.owner_id,'Organisationens administrator modtager agentarbejde fra siden.','[]',user.id,now,org.id,latest.revision+1,snapshot),
    ]);
    if(changed[0].results?.length)return json({status:'queued',case_id:caseId,request_id:input.request_id});
  }
  fail(409,'page_request_conflict','Organisationen er ændret. Prøv igen med samme anmodnings-id.');
}
