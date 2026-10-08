window.FinchOnboarding=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const steps=[
    {view:'inbox',selector:'[data-view="inbox"]',title:'Din indbakke',text:'Venter er opgaver, der kræver dit svar. Afklaret er det færdige arbejde. Opgaver, som agenten arbejder på eller skal behandle, findes under Agent-ikonet. Åbn en opgave for at se felter, beslutninger og forløb.'},
    {view:'organization',selector:'[data-view="organization"]',title:'Organisationens arbejde',text:'Her ser du alle medlemmers ventende og afklarede opgaver. Opgaver fordeles efter roller og ansvar; din egen indbakke viser kun dine opgaver. Agentens fælles arbejdskø har sit eget ikon.'},
    {view:'graph',selector:'[data-view="graph"]',title:'Jeres viden',text:'Grafen rummer jeres særlige regler, processer og præferencer. Agenten bygger videre på den, og opgavernes forløb kan vise, hvilke udsagn en beslutning bygger på.'},
    {view:'data',selector:'[data-view="data"]',title:'Tabeller og filer',text:'Tabeller og Filer har hver sit ikon. Brug + over listen til at beskrive en ny tabel eller uploade en fil. Agenten modtager en opgave til at oprette tabellen eller gennemgå filen. Grafen kan pege på de relevante data.'},
    {view:null,selector:'[data-action="new-page"]',title:'Egne sider',text:'Plusset åbner et ønske til en ny side, fx et overblik eller en konfigurator baseret på jeres tabeller. Agenten bygger siden. Den kan også foreslå sider, som du godkender i indbakken.'},
    {view:'settings',selector:'[data-view="settings"]',title:'Indstillinger',text:'Invitér kolleger, beskriv arbejdsroller og vælg, hvem der vises i grafen. Her finder du også mailindgangen og dine personlige notifikationer.'},
  ];
  let host,busy=false,error='',dialog=null,key='',tourKey='',generation=0,finishing=false;
  const moved=new Map();const context=()=>window.FinchStorage.onboarding;
  function agentContext(){const c=context();if(!c)return null;const {workFocus,...profile}=c.profile;return {
    organization_profile:profile,phase:c.phase,case_id:c.caseId,
    clarification_guidance:window.ORDERLY?.KNOWLEDGE_CLARIFICATION_INSTRUCTION,
    learning_review_guidance:window.ORDERLY?.LEARNING_REVIEW_INSTRUCTION,
    first_task_idea:host.state().tasks.find(t=>t.id===c.caseId)?.firstTaskRequest?.idea??workFocus??'',
    organization_setup_tasks:host.state().tasks.filter(t=>t.organizationSetup).map(t=>({case_id:t.id,title:t.title,phase:t.phase,progress:t.progress||0,...t.organizationSetup})),
    setup_guidance:'Start med de ventende organization_setup_tasks, også hvis det valgfrie første-opgave-forløb springes over. Læs get_case og følg opgavens instructions og dependsOn. Meld start og konkrete fund med update_case og progress. Gem viden med add_knowledge, rå data/filer med datatools og design med set_branding. Afslut hver opgave med complete_case og et faktuelt resultat; der kræves ikke brugerens godkendelse af disse klargøringsopgaver. Uden hjemmeside bruges kun briefet; opfind ikke rå data eller designkilder. Når klargøringen er færdig, fortsætter du det valgfrie første-opgave-forløb nedenfor.',
    guidance_for_agent:host.state().tasks.some(t=>t.organizationSetup&&t.phase==='active')?'Udfør først de ventende organization_setup_tasks efter setup_guidance. De er allerede bestilt gennem organisationsbriefet, også hvis brugeren springer introduktionen over. Brug update_case til start og fund og complete_case til hvert resultat. Hent get_state igen, når klargøringen er afsluttet, og fortsæt det valgfrie første-opgave-forløb.':c.phase==='offered'?'Brug den udfyldte organisationsprofil som udgangspunkt. Spørg ikke igen om navn, hjemmeside, beskrivelse eller den oplyste rolle. Brugeren får tilbudt et forløb til den første opgave; vent på onboarding_started, før du laver kladden.':
      c.phase==='active'?'Brugeren har valgt første-opgave-forløbet. Det er primært DIN opgave at finde på et kreativt, realistisk forslag ud fra organisationsprofilen, rollen og den viden og data, klargøringen gav. Bed ikke brugeren finde på opgaven eller genudfylde onboarding. first_task_idea er en valgfri retning fra brugeren; når den er tom, foreslår du selv noget konkret, relevant og gerne uventet. Forklar kort, hvorfor forslaget passer til organisationen. Brug draft_case med onboardingens case_id, mindst ét redigerbart felt og tydeligt fiktive eksempeldata. Stil kun konkrete, nødvendige afklaringer, knyttet til samme case_id. Brugeren retter og godkender på siden; start ikke løsningen før case_created.':
      c.phase==='skipped'?'Brugeren sprang første-opgave-forløbet over. Genstart det ikke og stil ikke onboarding-spørgsmål. Profilen er stadig organisationens udgangspunkt. Vent på brugerens konkrete arbejde eller instruktion.':
      'Introduktionen er afsluttet. Fortsæt det aktuelle arbejde fra get_state; gentag ikke onboarding. Den godkendte sag løses med de almindelige sagstools.',
  };}
  function toolInput(name,input={}){
    const c=context();if(!c)return {input};
    const setup=host.state().tasks.find(t=>t.id===(input.case_id||input.task_id)&&t.organizationSetup);
    if(setup){
      if(['update_case','complete_case'].includes(name)&&setup.organizationSetup.dependsOn?.some(id=>host.state().tasks.find(t=>t.id===id)?.phase!=='done'))return {error:'Afslut først klargøringsopgavens afhængigheder fra get_case.'};
      if(['update_case','complete_case','get_case','ask_user','post_task','assign_task'].includes(name))return {input};
      return {error:'Klargøringsopgaven er agentarbejde. Brug update_case og complete_case; opret ikke en ny kladde eller send mail fra den.'};
    }
    const ownCase=input.case_id===c.caseId||input.task_id===c.caseId;
    if(c.phase==='active'&&name==='draft_case'&&(!input.case_id||ownCase)&&host.state().tasks.some(t=>t.organizationSetup&&t.phase==='active'))return {error:'Afslut først organisationens klargøringsopgaver. Foreslå derefter en realistisk introduktionsopgave ud fra den gemte viden og data.'};
    const requestedLater=input.case_id&&input.case_id!==c.caseId&&host.state().tasks.some(t=>t.id===input.case_id&&t.kind==='case'&&t.phase==='pending');
    if(['offered','skipped'].includes(c.phase)&&name==='draft_case'&&!requestedLater)return {error:c.phase==='offered'?'Vent på at brugeren vælger første-opgave-forløbet.':'Brugeren sprang introduktionen over. Foreslå ikke automatisk en ny introduktionsopgave. En senere konkret Ny opgave-forespørgsel kan bruge sit eget case_id.'};
    if(c.phase!=='active')return {input};
    if(['update_case','complete_case'].includes(name)&&(!input.case_id||ownCase)&&!['active','done'].includes(host.state().tasks.find(t=>t.id===c.caseId)?.phase))return {error:'Brugeren skal godkende og oprette den første opgave, før du arbejder på den.'};
    if(name==='assign_task'&&ownCase&&input.assignee_id!==window.FinchWork.context().administratorId)return {error:'Organisationens ophavsmand skal godkende den første opgave. Bevar tildelingen indtil den er oprettet.'};
    if(['draft_case','ask_user','post_task','draft_email'].includes(name)){
      if(input.case_id&&input.case_id!==c.caseId)return {error:'Brug introduktionens case_id til den første opgave og dens afklaringer.'};
      if(input.assignee_id&&input.assignee_id!==window.FinchWork.context().administratorId)return {error:'Introduktionen og dens afklaringer skal gå til organisationens ophavsmand.'};
      return {input:{...input,case_id:input.case_id||c.caseId}};
    }
    if(name==='ask_user_batch'){
      if(input.questions?.some(q=>q.case_id&&q.case_id!==c.caseId||q.assignee_id&&q.assignee_id!==window.FinchWork.context().administratorId))return {error:'Introduktionens spørgsmål skal høre til samme sag og gå til organisationens ophavsmand.'};
      return {input:{...input,questions:input.questions?.map(q=>({...q,case_id:q.case_id||c.caseId}))}};
    }
    return {input};
  }
  function prepare(){
    const c=context();if(!c?.canManage)return;
    const state=host.state();
    if(c.phase==='active'){
      const questions=state.tasks.filter(t=>t.caseId===c.caseId&&window.FinchWork.mine(t)&&window.FinchWork.phase(t)==='open');
      const selected=questions.find(t=>t.id===state.selected)||questions[0]||state.tasks.find(t=>t.id===c.caseId);
      state.view='inbox';if(selected){state.view=window.FinchWork.phase(selected)==='active'?'agent':'inbox';state.selected=selected.id;state.selectedStick=selected.id;state.listFilter=window.FinchWork.phase(selected)==='done'?'done':'open';host.detail();}
    }else if(['completed','skipped'].includes(c.phase)&&!c.tutorialDone){
      const nextKey=`${window.FinchStorage.organization.id}:${c.tutorialStep}`;
      if(nextKey!==tourKey){tourKey=nextKey;const step=steps[c.tutorialStep];if(step?.view)state.view=step.view;
        if(c.tutorialStep===0){state.listFilter='open';state.selected=null;state.selectedStick=null;}
      }
    }
  }
  function restore(){for(const [id,placeholder] of moved){const element=document.getElementById(id);if(element&&placeholder.isConnected)placeholder.replaceWith(element);}moved.clear();}
  function close(){restore();if(dialog?.isConnected){dialog.close();dialog.remove();}dialog=null;key='';}
  function move(id,slot){const element=document.getElementById(id);if(!element||element.parentElement===slot)return;
    if(!moved.has(id)){const placeholder=document.createComment(`onboarding-${id}`);element.before(placeholder);moved.set(id,placeholder);}slot.appendChild(element);
  }
  function updateActivity(){const text=document.getElementById('onboarding-activity');if(text&&host){
    const phase=host.phase?.();
    text.textContent=['unheard','idle'].includes(phase?.kind)?'Din agent venter ikke på siden lige nu. Brug Kopiér prompt til at genoptage arbejdet i chatten; jeres profil og opgaver er gemt.':phase?.kind==='waiting'?'Din agent venter på dit valg eller svar på siden.':host.activity()|| (host.state().agent?'Din agent bruger profilen og jeres hjemmeside til at forberede opgaven.':'Forbind din egen agent med prompten. Finch starter ikke en agent på egen hånd.');
  }}
  function render(){
    if(!host)return;const c=context(),root=document.getElementById('app');
    if(!c?.canManage||!window.FinchStorage.ready){close();document.getElementById('onboarding-tour')?.remove();return;}
    if(['offered','active'].includes(c.phase)){
      document.getElementById('onboarding-tour')?.remove();
      const nextKey=`${window.FinchStorage.organization.id}:${c.phase}`;
      if(!dialog?.isConnected||key!==nextKey){close();key=nextKey;dialog=document.createElement('dialog');dialog.id='onboarding-dialog';dialog.className=`onboarding-modal is-${c.phase}`;dialog.setAttribute('aria-labelledby','onboarding-title');
        dialog.innerHTML=`<header class="onboarding-modal-header"><div><span class="page-overline">Kom i gang med ${esc(c.profile.name)}</span><h2 id="onboarding-title" tabindex="-1">${c.phase==='offered'?'Prøv en opgave fra jeres hverdag':'Din første opgave'}</h2></div><button type="button" class="link" data-onboarding="skip">Spring forløbet over</button></header>
          <p id="onboarding-error" class="account-error" role="alert" hidden></p>
          ${c.phase==='offered'?`<div class="onboarding-offer"><p>Lad agenten foreslå en kreativ, realistisk opgave ud fra jeres organisation og din rolle. Du kan rette forslaget og godkende det, før arbejdet starter.</p>
          <dl class="onboarding-profile-summary"><div><dt>Organisation</dt><dd>${esc(c.profile.description)}</dd></div><div><dt>Din rolle</dt><dd>${esc(c.profile.roleTitle)}</dd></div></dl>
          <label class="first-task-idea" for="first-task-idea">Din idé til første opgave <span class="onboarding-field-optional">valgfrit</span><textarea id="first-task-idea" maxlength="1200" rows="2" placeholder="Lad feltet være tomt, så finder agenten på et forslag.">${esc(c.profile.workFocus||'')}</textarea></label>
          <p class="onboarding-example-note">Forslaget bruger fiktive eksempeldata. Du kan erstatte dem med dine egne oplysninger, før du opretter opgaven.</p>
          <div class="onboarding-offer-actions"><button type="button" class="btn" data-onboarding="start">Find min første opgave</button><button type="button" class="btn btn-ghost" data-action="copy"><span>Kopiér prompt</span></button></div><small>Organisationen og dit brief er gemt. Giv din agent prompten, så den kan udføre klargøringsopgaverne under Agent. Første-opgave-forløbet er valgfrit; klargøringen fortsætter, hvis du springer det over.</small></div>`:
          `<div class="onboarding-agent-note"><p id="onboarding-activity" role="status"></p><button type="button" class="link" data-action="copy"><span>Kopiér prompt</span></button></div><div id="onboarding-work"></div><footer id="onboarding-work-actions"></footer>`}`;
        root.appendChild(dialog);dialog.addEventListener('cancel',event=>{event.preventDefault();mutate('skip');});dialog.showModal();document.getElementById('onboarding-title').focus({preventScroll:true});
      }
      const notice=document.getElementById('onboarding-error');notice.hidden=!error;notice.textContent=error;
      dialog.querySelectorAll('[data-onboarding]').forEach(b=>b.disabled=busy);
      if(c.phase==='active'){
        const task=host.state().tasks.find(t=>t.id===c.caseId);const selected=host.state().tasks.find(t=>t.id===host.state().selected);
        document.getElementById('onboarding-title').textContent=selected&&selected.kind!=='case'?'En afklaring før første opgave':task?.phase==='draft'?'Ret og godkend din første opgave':'Din agent finder en realistisk opgave';
        move('pane',document.getElementById('onboarding-work'));move('commandbar',document.getElementById('onboarding-work-actions'));updateActivity();
        const approve=dialog.querySelector('#commandbar button[value="create"]');if(approve)approve.textContent='Godkend og opret opgave';
        const discard=dialog.querySelector('#commandbar button[value="discard"]');if(discard)discard.textContent='Spring forløbet over';
        if(task&&['active','done'].includes(task.phase)&&task.createdAt&&!finishing&&!busy){finishing=true;mutate('complete').finally(()=>finishing=false);}
      }
      return;
    }
    close();
    document.querySelectorAll('.onboarding-highlight').forEach(el=>el.classList.remove('onboarding-highlight'));
    if(c.tutorialDone){document.getElementById('onboarding-tour')?.remove();return;}
    const step=steps[c.tutorialStep];if(!step)return;
    let tour=document.getElementById('onboarding-tour');if(!tour){tour=document.createElement('section');tour.id='onboarding-tour';tour.className='onboarding-tour';tour.setAttribute('role','dialog');tour.setAttribute('aria-label','Kort rundvisning');root.appendChild(tour);}
    const tourMarkupKey=`${c.tutorialStep}:${busy}:${error}`;
    if(tour.dataset.step!==tourMarkupKey){tour.dataset.step=tourMarkupKey;tour.innerHTML=`<header><span class="page-overline">Rundvisning · ${c.tutorialStep+1} af ${steps.length}</span><button type="button" class="link" data-onboarding="dismiss"${busy?' disabled':''}>Spring over</button></header><h3>${esc(step.title)}</h3><p>${esc(step.text)}</p>${error?`<p class="account-error" role="alert">${esc(error)}</p>`:''}<footer>${c.tutorialStep?`<button type="button" class="btn btn-ghost" data-onboarding="back"${busy?' disabled':''}>Tilbage</button>`:'<span></span>'}<button type="button" class="btn" data-onboarding="next"${busy?' disabled':''}>${c.tutorialStep===steps.length-1?'Åbn min indbakke':'Næste'}</button></footer>`;}
    document.querySelector(`#rail ${step.selector}`)?.classList.add('onboarding-highlight');
  }
  async function mutate(action){
    if(busy||!window.FinchStorage.ready)return;const idea=action==='start'?document.getElementById('first-task-idea')?.value||'':null;busy=true;error='';const turn=generation,org=window.FinchStorage.organization.id;render();
    try{
      await window.FinchStorage.flush();const c=context();
      const tutorial=['next','back','dismiss'].includes(action);
      const response=await fetch(`/api/organizations/${org}/onboarding/${tutorial?'tutorial':action}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(12000),body:JSON.stringify({revision:c.revision,organizationRevision:window.FinchStorage.organization.revision,...(tutorial?{action}:{}),...(action==='start'?{idea}:{})})});
      const result=await response.json();if(turn!==generation)return;if(!response.ok)throw new Error(result.message||'Introduktionen kunne ikke gemmes.');
      await window.FinchStorage.reloadCurrent();if(turn!==generation)return;
      if(tutorial&&result.onboarding.tutorialDone)host.inbox();
      host.render();
    }catch(e){if(turn!==generation)return;error=e.message;try{await window.FinchStorage.reloadCurrent();}catch{} }
    finally{if(turn===generation){busy=false;render();}}
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-onboarding]');if(button){event.preventDefault();mutate(button.dataset.onboarding);}});
  document.addEventListener('finch-account-change',()=>render());
  return {configure(options){host=options;},context,agentContext,toolInput,prepare,render,updateActivity,skip:()=>mutate('skip'),
    reset(){generation++;busy=false;finishing=false;error='';tourKey='';close();document.getElementById('onboarding-tour')?.remove();document.querySelectorAll('.onboarding-highlight').forEach(el=>el.classList.remove('onboarding-highlight'));},
  };
})();
