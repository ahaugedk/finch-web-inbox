import {organizationAccess} from './team.mjs';

export function onboardingProfile(value,name,fail){
  if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'invalid_profile','Udfyld oplysningerne om organisationen.');
  const field=(key,max,required=false)=>{const v=typeof value[key]==='string'?value[key].trim():'';if(v.length>max||(required&&!v))fail(400,'invalid_profile','Udfyld organisationens beskrivelse og din rolle inden for felternes længdegrænser.');return v;};
  let website=field('website',2048);if(website){
    try{const url=new URL(/^https?:\/\//i.test(website)?website:`https://${website}`);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname.includes('.')||url.hostname.endsWith('.local')||url.hostname==='localhost'||/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)||url.hostname.includes(':'))throw new Error();website=url.href;
    }catch{fail(400,'invalid_website','Angiv en offentlig hjemmeside med http eller https, eller lad feltet være tomt.');}
  }
  return {name,website,description:field('description',2000,true),roleTitle:field('roleTitle',80,true),roleDescription:field('roleDescription',2000)};
}
export function organizationSetupTasks(profile,state,now){
  const steps=[['knowledge',profile.website?'Undersøg hjemmesiden og opdatér viden':'Forstå organisationen ud fra briefet',
    'Læs organisationsbriefet og den angivne offentlige hjemmeside, hvis der er en. Gem kun dokumenteret organisationsspecifik viden med kilde og konkrete begrundelser. Common Sense skal ikke i grafen.'],
    ...(profile.website?[
      ['data','Indsaml data fra hjemmesiden','Find relevante rå data og dokumenter på hjemmesiden. Gem gentagne poster og specifikationer i faktiske datatabeller og originale filer under Filer. Opdatér kun grafen med semantisk relevante referencer til data og filer. Opfind aldrig data; afslut med en forklaring, hvis der ikke er relevante kilder.'],
      ['branding','Tilpas organisationens udseende','Undersøg hjemmesidens farver, skrifter, layout og eventuelle logo. Brug get_branding og set_branding til at tilpasse organisationens samlede oplevelse ud fra dokumenterede designvalg. Bevar læsbarhed og godkendelsesknapper; brug kun relevante offentlige assets.'],
    ]:[])];
  let knowledgeId;
  return steps.map(([step,title,instructions])=>{
    state.seq=(Number.isSafeInteger(state.seq)?state.seq:0)+1;const id=`S-${200+state.seq}`;knowledgeId ||= id;
    if(['knowledge','data'].includes(step))instructions+=' Hvis viden fra hjemmesiden eller dokumenter er uklar, ufuldstændig eller modstridende, opret afklaringsopgaver med ask_user/post_task og denne opgaves case_id. Beskriv kilde og tvivl, meld ventetilstanden med update_case, og vent på brugerens svar. Gem ikke gæt som grafviden eller afslut det berørte arbejde før afklaringen.';
    return {id,kind:'case',phase:'active',agentWorkStatus:'queued',title,tag:'Organisationsklargøring',from:state.agent||'Agenten',preview:'Venter på agenten',ui:[],draft:{},values:{},read:true,progress:0,at:now,createdAt:now,time:new Date(now).toLocaleTimeString('da-DK',{timeZone:'Europe/Copenhagen',hour:'2-digit',minute:'2-digit'}),
      organizationSetup:{step,website:profile.website,instructions,dependsOn:step==='knowledge'?[]:[knowledgeId]},
      updates:[{at:now,text:'Oprettet fra organisationsbriefet. Venter på agenten.',ui:[]}]};
  });
}
export async function readOnboarding(db,org,user){
  const row=await db.first('SELECT * FROM organization_onboarding WHERE organization_id=?',org.id);if(!row)return null;
  return {profile:JSON.parse(row.profile_json),phase:row.phase,caseId:row.case_id,tutorialStep:row.tutorial_step,tutorialDone:!!row.tutorial_done,revision:row.revision,canManage:org.owner_id===user.id};
}
export async function handleOnboardingApi(request,env,{db,user,now,fail,json,body}){
  const route=new URL(request.url).pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/onboarding(?:\/(start|skip|complete|tutorial))?$/);if(!route)return null;
  const org=await organizationAccess(db,route[1],user);if(!org)fail(404,'organization_not_found','Organisationen findes ikke, eller du har ikke adgang.');
  const current=await readOnboarding(db,org,user);
  if(request.method==='GET'&&!route[2])return json({onboarding:current});
  if(request.method!=='POST'||!route[2])fail(405,'method_not_allowed','Metoden understøttes ikke.');
  if(!current?.canManage)fail(403,'owner_required','Kun organisationens ophavsmand kan styre introduktionsforløbet.');
  const input=await body(request);if(input.revision!==current.revision||input.organizationRevision!==org.revision)fail(409,'onboarding_conflict','Organisationen er ændret. Hent den igen.');
  const state=JSON.parse(org.state_json);let phase=current.phase,caseId=current.caseId,step=current.tutorialStep,done=current.tutorialDone;
  let caseTask=state.tasks.find(t=>t.id===caseId),created=null;
  if(route[2]==='start'){
    if(input.idea!==undefined&&typeof input.idea!=='string')fail(400,'invalid_first_task_idea','Skriv din idé som tekst, eller lad feltet være tomt.');
    const idea=(input.idea||'').trim();if(idea.length>1200)fail(400,'invalid_first_task_idea','Din idé må højst fylde 1.200 tegn.');
    if(phase!=='offered')fail(409,'onboarding_started','Introduktionen er allerede startet eller afsluttet.');
    if(state.tasks.length>=5000)fail(400,'too_many_tasks','Organisationen har for mange opgaver.');
    state.seq=(Number.isSafeInteger(state.seq)?state.seq:0)+1;caseId=`S-${200+state.seq}`;
    if(state.tasks.some(t=>t.id===caseId))fail(409,'case_id_conflict','Opgaven kunne ikke oprettes. Hent organisationen igen.');
    created={id:caseId,kind:'case',phase:'pending',title:'Jeres første opgave',tag:'Introduktion',from:state.agent||'Agenten',preview:'Agenten finder en kreativ, realistisk opgave',firstTaskRequest:{idea},ui:[],draft:{},updates:[],read:true,at:now,time:new Date(now).toLocaleTimeString('da-DK',{hour:'2-digit',minute:'2-digit'})};
    state.tasks.push(created);phase='active';state.events.push({id:`E-${crypto.randomUUID()}`,type:'onboarding_started',caseId,at:now,delivered:false});
  }else if(route[2]==='skip'){
    if(!['offered','active'].includes(phase))fail(409,'onboarding_finished','Introduktionen er allerede afsluttet.');
    if(caseTask&&['active','done'].includes(caseTask.phase))fail(409,'case_already_created','Opgaven er allerede oprettet. Den bevares i indbakken.');
    if(caseTask){caseTask.phase='discarded';caseTask.preview='Introduktionen blev sprunget over';}
    if(caseId)for(const t of state.tasks.filter(t=>t.caseId===caseId&&!t.response)){t.agentWorkStatus='done';t.read=true;}
    state.events=state.events.filter(e=>!['onboarding_started','organization_created','new_case_requested'].includes(e.type)||e.delivered);
    state.events.push({id:`E-${crypto.randomUUID()}`,type:'onboarding_skipped',caseId,at:now,delivered:false});phase='skipped';
  }else if(route[2]==='complete'){
    if(phase!=='active'||!caseTask||!['active','done'].includes(caseTask.phase)||!caseTask.createdAt)fail(409,'approval_required','Opgaven skal først oprettes og godkendes af brugeren.');
    phase='completed';
  }else if(route[2]==='tutorial'){
    if(!['completed','skipped'].includes(phase))fail(409,'tutorial_not_ready','Afslut eller spring opgaveforløbet over først.');
    if(done) return json({onboarding:current});
    if(input.action==='next'){if(step===5)done=true;else step++;}
    else if(input.action==='back')step=Math.max(0,step-1);
    else if(input.action==='dismiss')done=true;
    else fail(400,'invalid_tutorial_action','Vælg næste, tilbage eller afslut rundvisningen.');
  }
  state.events=state.events.slice(-100);state._workWriteId=crypto.randomUUID();const snapshot=JSON.stringify(state);
  if(new TextEncoder().encode(snapshot).byteLength>2*1024*1024)fail(413,'too_large','Organisationens data er for store.');
  const changed=await db.batch([
    db.statement(`UPDATE organizations SET state_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND owner_id=?
      AND EXISTS(SELECT 1 FROM organization_onboarding WHERE organization_id=? AND revision=?) RETURNING revision`,snapshot,now,org.id,org.revision,user.id,org.id,current.revision),
    db.statement(`UPDATE organization_onboarding SET phase=?,case_id=?,tutorial_step=?,tutorial_done=?,revision=revision+1,updated_at=?
      WHERE organization_id=? AND revision=? AND EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)`,phase,caseId,step,Number(done),now,org.id,current.revision,org.id,org.revision+1,snapshot),
    ...(created?[db.statement(`INSERT INTO task_assignments(organization_id,task_id,assignee_id,reason,basis_json,updated_by,updated_at)
      SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM organizations WHERE id=? AND revision=? AND state_json=?)`,org.id,caseId,org.owner_id,'Organisationens ophavsmand godkender den første opgave.','[]',user.id,now,org.id,org.revision+1,snapshot)]:[]),
  ]);
  if(!changed[0].results?.length)fail(409,'onboarding_conflict','Organisationen er ændret. Hent den igen.');
  return json({onboarding:await readOnboarding(db,org,user)});
}
