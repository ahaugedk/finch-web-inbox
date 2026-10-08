window.FinchWork=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));let host;
  const context=()=>window.FinchStorage.work || {administratorId:null,viewerId:window.FinchStorage.user?.id,members:[]};
  const assignee=t=>context().members.some(m=>m.assigneeId===t?.assigneeId)?t.assigneeId:context().administratorId;
  const mine=t=>!!t&&!!context().viewerId&&assignee(t)===context().viewerId;
  const member=t=>context().members.find(m=>m.assigneeId===assignee(t));
  function phase(t){if(t.kind==='case')return ({pending:'active',draft:'open',active:'active',done:'done',discarded:'done'})[t.phase]||'done';if(t.kind==='info')return t.read?'done':'open';if(t.agentWorkStatus==='done')return 'done';if(t.agentWorkStatus==='working')return 'active';return t.response?(t.response.seen?'done':'active'):'open';}
  const agentCompleted=t=>phase(t)==='done'&&(t.kind==='case'&&t.phase==='done'||t.agentWorkStatus==='done');
  function inScope(t){const s=host.state();if(s.view==='agent')return s.agentFilter==='done'?agentCompleted(t):phase(t)==='active';if(s.view!=='organization')return !t.organizationSetup&&mine(t)&&phase(t)!=='active';const member=s.organizationMember||context().viewerId;return !t.organizationSetup&&assignee(t)===member&&phase(t)===(s.organizationFilter==='done'?'done':'open');}
  function normalizeNavigation({migrateLegacy=false}={}){
    const s=host.state(),ctx=context();
    if(migrateLegacy&&(s.view==='inbox'&&s.listFilter==='active'||s.view==='organization'&&(!s.organizationMember||s.organizationMember==='agent')))s.view='agent';
    if(!['open','done'].includes(s.listFilter))s.listFilter='open';
    if(!['open','done'].includes(s.agentFilter))s.agentFilter='open';
    if(!ctx.members.some(m=>m.assigneeId===s.organizationMember))s.organizationMember=ctx.viewerId||ctx.members[0]?.assigneeId;
    if(!['open','done'].includes(s.organizationFilter))s.organizationFilter='open';
  }
  function openTask(t,{keepOrganization=false,keepAgent=false}={}){
    const s=host.state(),p=phase(t);s.view=p==='active'||t.organizationSetup||keepAgent&&agentCompleted(t)?'agent':keepOrganization||!mine(t)?'organization':'inbox';
    if(s.view==='agent')s.agentFilter=p==='done'?'done':'open';
    s.listFilter=p==='done'?'done':'open';s.selected=s.selectedStick=t.id;
    if(s.view==='organization'){s.organizationMember=assignee(t);s.organizationFilter=s.listFilter;}
  }
  function assignment(input={},parent){
    const ctx=context();const target=input.assignee_id || (parent?assignee(parent):ctx.administratorId);const candidate=ctx.members.find(m=>m.assigneeId===target);
    if(!candidate)throw new Error('Modtageren skal være et aktivt medlem af organisationen. Hent get_assignment_candidates.');
    const ids=input.assignment_statement_ids || parent?.assignmentEvidence?.map(e=>e.statementId) || [];
    const reason=input.assignment_reason || parent?.assignmentReason || 'Ingen anden modtager er angivet. Organisationens administrator modtager opgaven.';
    if(target!==ctx.administratorId&&(!candidate.roleId || reason.trim().length<20 || !ids.includes(candidate.statementIds[0])))throw new Error('Brug medlemmets rollebeskrivelse fra grafen og begrund tildelingen konkret.');
    return {assigneeId:target,assignmentReason:reason.slice(0,600),assignmentEvidence:candidate.roleId&&ids.includes(candidate.statementIds[0])?[{statementId:candidate.statementIds[0],conceptId:`org-role-${candidate.roleId}`,text:candidate.roleDescription,conceptLabel:candidate.roleTitle,source:'settings'}]:[],assignmentRevision:parent?.assignmentRevision || 0};
  }
  const assignmentSchema={assignee_id:{type:'string',maxLength:36,description:'Modtagerens assignee_id fra get_assignment_candidates. Udeladt: sagens modtager eller organisationens administrator.'},assignment_reason:{type:'string',maxLength:600,description:'Hvorfor netop dette arbejde matcher personens ansvar i grafen. Mindst 20 tegn ved et andet medlem end administratoren.'},assignment_statement_ids:{type:'array',maxItems:20,items:{type:'string',maxLength:100},description:'Udsagns-id’er fra kandidatens rollebeskrivelse i grafen. Brug det konkrete ansvar, ikke titel alene.'}};
  async function reassign(taskId,input){
    const task=host.state().tasks.find(t=>t.id===taskId);if(!task)throw new Error('Opgaven findes ikke.');const selected=assignment(input);
    await window.FinchStorage.flush();const org=window.FinchStorage.organization.id;
    const response=await fetch(`/api/organizations/${org}/work/${encodeURIComponent(taskId)}/assignment`,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({...selected,assignmentStatementIds:input.assignment_statement_ids || [],revision:window.FinchStorage.organization.revision,assignmentRevision:task.assignmentRevision || 0}),signal:AbortSignal.timeout(12000)});
    const result=await response.json();if(!response.ok)throw new Error(result.message||'Tildelingen kunne ikke gemmes.');if(org!==window.FinchStorage.organization?.id)throw new Error('Organisationen er skiftet.');await window.FinchStorage.reloadCurrent();return result;
  }
  const definitions=[
    {name:'get_assignment_candidates',description:'Hent aktive medlemmer og administratoren med deres konkrete rollebeskrivelser og udsagns-id’er fra grafen. Vurdér arbejdet mod ansvaret før du opretter/tildeler en opgave. Skjulte personer kan modtage opgaver gennem deres rolle, men må ikke tilføjes i grafen. Uden et passende medlem modtager administratoren opgaven.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
    {name:'assign_task',description:'Tildel eller omfordel en eksisterende arbejdsopgave til et aktivt medlem på baggrund af rollebeskrivelsen i grafen. Brug assignee_id, konkret assignment_reason og assignment_statement_ids fra get_assignment_candidates. Administratoren er fallback. Ændrer kun denne opgaves modtager; nye spørgsmål i sagen arver sagens modtager, medmindre du angiver en anden.',inputSchema:{type:'object',properties:{task_id:{type:'string',maxLength:12},...assignmentSchema},required:['task_id','assignee_id']}},
    {name:'complete_task',description:'Markér et besvaret spørgsmål eller en arbejdsopgave som Afklaret, når du har behandlet svaret og udført det nødvendige arbejde. Indtil da ligger svaret i Agent-visningen. Brug complete_case til sager.',inputSchema:{type:'object',properties:{task_id:{type:'string',maxLength:12},summary:{type:'string',maxLength:500},statement_ids:{type:'array',items:{type:'string'},maxItems:20}},required:['task_id','summary']}},
  ];
  async function tool(name,input){
    if(name==='get_assignment_candidates'){await window.FinchStorage.reloadCurrent();return {status:'ok',...context(),guidance_for_agent:'Vælg den person, hvis dokumenterede ansvar passer til opgaven. Brug administratoren, når der ikke er et match. Opfind aldrig medarbejdernes ansvar. Personers graf-synlighed ændres kun i Indstillinger.'};}
    if(name==='assign_task'){const result=await reassign(input.task_id,input);return {status:'ok',...result};}
    const task=host.state().tasks.find(t=>t.id===input.task_id);if(!task || task.kind==='case')throw new Error('Brug complete_case til sager. Opgaven skal være et spørgsmål, en opgave eller information.');
    if(task.kind!=='info'&&!task.response)throw new Error('Opgaven skal først være besvaret.');
    const evidence=host.evidence(input.statement_ids);if(evidence.error)throw new Error(evidence.error);
    task.agentWorkStatus='done';task.agentResult={summary:String(input.summary||'').trim().slice(0,500),at:Date.now(),knowledgeEvidence:evidence.items};if(task.kind==='info'&&mine(task))task.read=true;
    if(host.state().view==='agent'&&host.state().selected===task.id)host.state().agentFilter='done';
    host.save();host.render();return {status:'ok',task_id:task.id,guidance_for_agent:'Opgaven er afklaret og ligger hos modtageren under Afklaret.'};
  }
  function nav(){
    const s=host.state();const tasks=s.tasks;
    return `<div class="list-header list-header-actions">${context().viewerId===context().administratorId?(window.FinchList?.create('Nyt medlem',{'data-work-invite':''})||''):''}</div>`+context().members.map(m=>{
      const waiting=tasks.filter(t=>assignee(t)===m.assigneeId&&phase(t)==='open').length;
      return `<button type="button" class="item organization-person${s.organizationMember===m.assigneeId?' is-active':''}"${s.organizationMember===m.assigneeId?' aria-current="true"':''} data-action="org-member" data-member="${esc(m.assigneeId)}"><span class="item-title-line"><strong class="subject">${esc(m.name)}</strong><b class="item-count" aria-label="${waiting} ventende ${waiting===1?'opgave':'opgaver'}" title="${waiting} ventende ${waiting===1?'opgave':'opgaver'}">${waiting}</b></span></button>`;
    }).join('');
  }
  function createDialog(kind){
    const ctx=context(),s=host.state(),orgId=window.FinchStorage.organization?.id;if(!orgId)return;
    let dialog=document.getElementById('work-create-dialog');if(!dialog){dialog=document.createElement('dialog');dialog.id='work-create-dialog';dialog.className='entity-dialog';dialog.addEventListener('cancel',event=>{if(dialog.querySelector('form')?.dataset.busy)event.preventDefault();});document.body.append(dialog);}
    const label=kind==='agent'?'Opgave til agenten':'Opgave til en bruger';
    const target=s.view==='organization'?s.organizationMember:ctx.viewerId;
    dialog.innerHTML=`<header><h2 id="work-create-title">${label}</h2><button type="button" class="link" data-work-close>Luk</button></header><form id="work-create-form" data-kind="${kind}" data-org="${esc(orgId)}" data-request="${crypto.randomUUID()}">
      <label>Titel<input name="title" maxlength="80" required></label><label>Beskriv opgaven<textarea name="description" rows="5" maxlength="4000" required></textarea></label>
      ${kind==='user'?`<label>Modtager<select name="assigneeId" required>${ctx.members.map(m=>`<option value="${esc(m.assigneeId)}"${m.assigneeId===target?' selected':''}>${esc(m.name)}</option>`).join('')}</select></label>`:'<p class="muted">Opgaven lægges i agentens kø. Du kan følge fremdriften i tidslinjen.</p>'}
      <p class="account-error" role="alert" hidden></p><button type="submit" class="btn">${kind==='agent'?'Send til agenten':'Opret opgave'}</button></form>`;
    dialog.setAttribute('aria-labelledby','work-create-title');dialog.showModal();dialog.querySelector('input').focus();
  }
  globalThis.document?.addEventListener('click',event=>{
    const button=event.target.closest('[data-work-create]');if(button){createDialog(button.dataset.workCreate);return;}
    if(event.target.closest('[data-work-close]')){const dialog=document.getElementById('work-create-dialog');if(!dialog?.querySelector('form')?.dataset.busy)dialog?.close();}
    if(event.target.closest('[data-work-invite]'))host.invite().catch(error=>host.toast(error.message));
  });
  globalThis.document?.addEventListener('submit',async event=>{
    if(event.target.id!=='work-create-form')return;event.preventDefault();const form=event.target;if(form.dataset.busy)return;
    const values=new FormData(form),orgId=form.dataset.org,kind=form.dataset.kind,controls=[...form.querySelectorAll('button,input,select,textarea')];
    form.dataset.busy='true';controls.forEach(c=>c.disabled=true);const error=form.querySelector('[role=alert]');error.hidden=true;
    try{
      if(orgId!==window.FinchStorage.organization?.id)throw new Error('Organisationen er skiftet. Luk formularen, og prøv igen.');
      await window.FinchStorage.flush();
      if(orgId!==window.FinchStorage.organization?.id)throw new Error('Organisationen er skiftet.');
      const response=await fetch(`/api/organizations/${orgId}/work`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,title:values.get('title'),description:values.get('description'),requestId:form.dataset.request,...(kind==='user'?{assigneeId:values.get('assigneeId')}:{})}),signal:AbortSignal.timeout(12000)});
      const result=await response.json();if(!response.ok)throw new Error(result.message||'Opgaven kunne ikke oprettes.');
      if(orgId!==window.FinchStorage.organization?.id)throw new Error('Opgaven er gemt i den tidligere organisation.');
      await window.FinchStorage.reloadCurrent();const task=host.state().tasks.find(t=>t.id===result.taskId);
      document.getElementById('work-create-dialog').close();if(task)host.open(task);host.toast(kind==='agent'?'Opgaven er sendt til agenten':'Opgaven er oprettet');
    }catch(problem){error.hidden=false;error.textContent=problem.message;}
    finally{delete form.dataset.busy;controls.forEach(c=>c.disabled=false);}
  });
  function assignmentHtml(t){const m=member(t);return `<span class="task-assignee">Til ${esc(m?.name||'administratoren')}${m?.isAdministrator?' · Administrator':''}</span>${`<details class="task-routing"><summary>Grundlag for tildeling</summary><p>${esc(t.assignmentReason || 'Ingen anden modtager er angivet. Organisationens administrator modtager opgaven.')}</p>${host.renderEvidence?host.renderEvidence(t.assignmentEvidence || []):(t.assignmentEvidence||[]).map(e=>`<p><strong>${esc(e.conceptLabel)}</strong> · ${esc(e.text)}</p>`).join('')}</details>`}`;}
  return {configure(options){host=options;},context,assignee,mine,member,phase,agentCompleted,inScope,normalizeNavigation,openTask,assignment,assignmentSchema,definitions,tool,reassign,nav,assignmentHtml};
})();
