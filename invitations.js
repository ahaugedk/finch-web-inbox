// The email link confirms a membership invitation; workspace login remains separate.
window.FinchInvitation=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const address=new URL(location.href),value=new URLSearchParams(address.hash.slice(1)).get('invite')||address.searchParams.get('invite');
  const legacy=/^[a-f0-9-]{36}$/.test(value||'');
  const active=!!value&&(!legacy||!window.FinchConnection.agentBrowser);
  let invitation=null,ready=false,busy=false,error='',onChange=()=>{};
  async function request(action){
    const response=await fetch(`/api/invitation-links/${action}`,{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:value}),signal:AbortSignal.timeout(12000)});
    const result=await response.json();if(!response.ok)throw new Error(result.message||'Invitationen kunne ikke åbnes. Prøv igen.');return result.invitation;
  }
  async function inspect(){if(busy)return;busy=true;error='';onChange();try{invitation=await request('inspect');}catch(e){error=e.message;}finally{ready=true;busy=false;onChange();}}
  async function decide(action){if(busy||invitation?.status!=='invited')return;busy=true;error='';onChange();try{invitation=await request(action);}catch(e){error=e.message;}finally{busy=false;onChange();}}
  function prompt(){
    const url=globalThis.FinchSite?.canonicalUrl(new URL(location.pathname,location.origin))||new URL(location.pathname,location.origin);url.searchParams.set('ua','agent');
    if(legacy)url.searchParams.set('invite',value);else if(invitation?.status==='accepted')url.searchParams.set('org',invitation.organizationId);else return '';
    return [legacy?'Hjælp mig med at acceptere min invitation til Finch.':'Hjælp mig med arbejdet i min organisation i Finch. Jeg har accepteret invitationen på siden.',
      `1. Åbn ${url.href} i din indbyggede browser, så jeg kan se siden ved siden af chatten.`,
      '2. Kald sidens WebMCP-tool start_conversation. Jeg logger selv ind med den emailadresse, der modtog invitationen, og indtaster engangskoden på siden. Ved login_required: giv en kort status og kald wait_for_login. Gentag ved timeout; bed mig ikke skrive "klar" i chatten, og bed aldrig om koden i chatten.',
      '3. Hvis browseren ikke viser tools, kan du bruge await webmcp.call("start_conversation", {agent_name:"<dit navn>"}); webmcp.listTools() viser input. Følg organisationsbriefingen og get_state, og byg videre på eksisterende arbejde.',
      '4. Vent med wait_for_user, når jeg skal vælge eller svare. Gentag ved timeout, mens samtalen er aktiv. Stop, hvis jeg beder dig stoppe, eller det aftalte arbejde er færdigt.',
    ].join('\n');
  }
  function html(){
    const copy=()=>`<div class="actions"><button type="button" class="btn" data-action="copy"><span>Kopiér prompt</span></button><span class="hint">Fortsæt i Codex, Claude eller GitHub Copilot.</span></div><details class="prompt"><summary>Se prompten</summary><pre>${esc(prompt())}</pre></details>`;
    let body;
    if(legacy)body=`<h1>Du har modtaget <span class="outline">en invitation.</span></h1><p class="text">Dette er et ældre invitationslink. Kopiér prompten for at acceptere i din agents browser med den inviterede emailadresse. Administratoren kan også gensende invitationen med et nyt link, som kan accepteres direkte her.</p>${copy()}`;
    else if(error)body=`<h1>Invitationen kunne ikke åbnes.</h1><p class="text" role="alert">${esc(error)}</p><button type="button" class="btn" data-invitation="retry">Prøv igen</button>`;
    else if(!ready)body='<h1>Åbner invitationen<span class="dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></h1><p class="text" role="status">Kontrollerer invitationslinket.</p>';
    else if(invitation.status==='accepted')body=`<h1>Invitationen er <span class="outline">accepteret.</span></h1><p class="text" role="status">Du har accepteret invitationen til <strong>${esc(invitation.organizationName)}</strong>. Kopiér prompten for at åbne organisationens arbejde i din agents browser. Log ind dér med den emailadresse, der modtog invitationen.</p>${copy()}`;
    else if(invitation.status==='invited')body=`<h1>Invitation til <span class="outline">${esc(invitation.organizationName)}.</span></h1><p class="text">Acceptér invitationen for at blive medlem af organisationen. Det kræver ikke login her.${invitation.roleTitle?` Din arbejdsrolle er ${esc(invitation.roleTitle)}.`:''}</p><p class="hint">Linket gælder til ${esc(new Date(invitation.expiresAt).toLocaleDateString('da-DK'))}.</p><div class="actions"><button type="button" class="btn" data-invitation="accept"${busy?' disabled':''}>${busy?'Bekræfter…':'Acceptér invitation'}</button><button type="button" class="link" data-invitation="decline"${busy?' disabled':''}>Afvis invitation</button></div>`;
    else body=`<h1>${invitation.status==='declined'?'Invitationen er afvist.':invitation.status==='expired'?'Invitationslinket er udløbet.':'Invitationen er ikke længere aktiv.'}</h1><p class="text">${invitation.status==='declined'?'Du har afvist invitationen. Kontakt administratoren, hvis du ønsker en ny invitation.':'Bed organisationens administrator sende et nyt invitationslink. Har du allerede accepteret, kan du fortsætte i din agents browser med din emailadresse.'}</p>`;
    return `<div class="intro"><header class="intro-header"><span class="brand">finch</span></header><section class="stage invitation-stage"><p class="label">Invitation til organisationen</p>${body}</section></div>`;
  }
  document.addEventListener('click',event=>{const button=event.target.closest('[data-invitation]');if(!button||!active)return;const action=button.dataset.invitation;if(action==='retry')inspect();else if(['accept','decline'].includes(action))decide(action);});
  return {active,html,prompt,async initialize(options){onChange=options.onChange;if(legacy){ready=true;onChange();return;}await inspect();}};
})();
