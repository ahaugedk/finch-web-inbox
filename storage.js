// Account identity lives in an HttpOnly cookie; workspace data lives on the server.
// Browser storage is read ONLY for the explicit migration of older prototypes.
window.FinchStorage = (() => {
  const escape = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  let user = null; let organizations = []; let organization = null;let invitations=[];
  let current = null; let dirty = 0; let saved = 0; let saving = null;
  let saveTimer; let pollTimer; let error = null; let switching = false;
  let challengeId = null; let loginEmail = ''; let onState = () => {}; let onSwitch = () => {};
  let epoch = 0; let initialized = false;let activation=null; let backgroundActivity=()=>false;
  let work=null;let onboarding=null;const navigation=new Map();
  const viewKeys=['view','listFilter','agentFilter','selected','selectedStick','graphFocus','organizationMember','organizationFilter'];
  const controlRenders=new WeakMap();
  let accountSignature='';

  async function request(path, method = 'GET', data) {
    const response = await fetch(path, {
      method, credentials: 'same-origin', cache: 'no-store',
      headers: data ? { 'Content-Type': 'application/json' } : {},
      ...(data ? { body: JSON.stringify(data) } : {}),
      signal: AbortSignal.timeout(12000),
    });
    const result = await response.json();
    if (!response.ok) { const e = new Error(result.message || 'Kunne ikke forbinde til Finch.'); Object.assign(e, { status: response.status, code: result.error }); throw e; }
    return result;
  }
  function emit() {
    const signature=JSON.stringify({user:user?.id,controls:controls(),onboarding,initialized,switching,gateHidden:document.getElementById('account-gate')?.hidden,error:error?.message});
    if(signature!==accountSignature){accountSignature=signature;document.dispatchEvent(new CustomEvent('finch-account-change'));}
    renderSaveStatus();
  }
  function updateSummary(next) {
    organization = next;
    const i = organizations.findIndex((o) => o.id === next.id);
    if (i < 0) organizations.push(next); else organizations[i] = next;
  }
  function adopt(result) {
    const next={...result.state,...(navigation.get(`${user?.id}:${result.organization.id}`)||{})};
    const background=organization?.id===result.organization.id;
    const revisionChanged=organization?.revision!==result.organization.revision;
    const workChanged=JSON.stringify(work)!==JSON.stringify(result.work||null);
    const onboardingChanged=JSON.stringify(onboarding)!==JSON.stringify(result.onboarding||null);
    const changed=JSON.stringify(current)!==JSON.stringify(next);
    updateSummary(result.organization);
    work=result.work || null;onboarding=result.onboarding || null;current=next; dirty = saved = 0; error = null;
    const url = new URL(location.href); url.searchParams.delete('s'); url.searchParams.set('org', organization.id);
    history.replaceState(null, '', url);
    if(!background||changed||revisionChanged||workChanged||onboardingChanged)onState(structuredClone(current),{background,revisionChanged,workChanged,onboardingChanged});
    emit();
  }
  function gate() {
    let el = document.getElementById('account-gate');
    if (!el) { el = document.createElement('div'); el.id = 'account-gate'; el.className = 'account-gate'; document.body.appendChild(el); }
    return el;
  }
  function notice(message) {
    const el = document.getElementById('account-error'); if (el) { el.textContent = message; el.hidden = false; }
  }
  function renderLogin(message = '') {
    if(window.FinchConnection&&!window.FinchConnection.loginAllowed){gate().hidden=true;return;}
    const el = gate(); el.hidden = false;
    el.innerHTML = `<section class="account-card" aria-labelledby="login-title">
      <span class="brand">finch</span><h1 id="login-title">Dit arbejde. Klar igen.</h1>
      <p>Log ind med din email. Dine organisationer, opgaver og viden følger med — også i din agents browser.</p>
      <form id="login-form">
        ${challengeId ? `<p>Vi har sendt en kode til <strong>${escape(loginEmail)}</strong>.</p>
          <label for="login-code">Engangskode</label><input id="login-code" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{8}" minlength="8" maxlength="8" required autofocus>
          <button class="btn" type="submit">Log ind</button><button class="link" type="button" data-account="change-email">Brug en anden email eller få en ny kode</button>`
          : `<label for="login-email">Email</label><input id="login-email" name="email" type="email" autocomplete="email" value="${escape(loginEmail)}" required autofocus>
          <button class="btn" type="submit">Send engangskode</button>`}
        <p id="account-error" class="account-error" role="alert" ${message ? '' : 'hidden'}>${escape(message)}</p>
      </form><small>Koden gælder i 10 minutter. Ingen adgangskode.</small></section>`;
  }
  function renderCreate() {
    const el = gate(); el.hidden = false;
    el.innerHTML = `<section class="account-card organization-onboarding-card" aria-labelledby="org-title"><span class="brand">finch</span>
      <h1 id="org-title">${organizations.length ? 'Ny organisation' : 'Din første organisation'}</h1>
      <p>Giv din agent et udgangspunkt, så den kan forstå jeres arbejde og foreslå en relevant første opgave.</p>
      <form id="organization-form"><div class="onboarding-form-grid">
      <label for="organization-name">Organisationens navn<input id="organization-name" name="name" maxlength="80" required autofocus autocomplete="organization"></label>
      <label for="organization-website"><span>Hjemmeside <span class="onboarding-field-optional">valgfrit</span></span><input id="organization-website" name="website" inputmode="url" maxlength="2048" placeholder="https://jeres-hjemmeside.dk"><small>Agenten bruger den offentlige hjemmeside til at lære jer at kende.</small></label></div>
      <label for="organization-description">Hvad laver organisationen?<textarea id="organization-description" name="description" maxlength="2000" rows="3" required placeholder="Hvad leverer I, og hvem arbejder I for?"></textarea></label>
      <div class="onboarding-person-fields"><h2>Din rolle</h2><label for="organization-role">Rolle eller jobtitel<input id="organization-role" name="roleTitle" maxlength="80" required placeholder="Fx salgschef eller driftsansvarlig" autocomplete="organization-title"></label>
      <label for="organization-responsibility"><span>Dit ansvar <span class="onboarding-field-optional">valgfrit</span></span><textarea id="organization-responsibility" name="roleDescription" maxlength="2000" rows="2" placeholder="Hvad har du ansvar for hos jer?"></textarea></label><small>Du bliver administrator. Din rolle gemmes i organisationens indstillinger; din person vises først i grafen, hvis du vælger det dér.</small></div>
      <div class="onboarding-form-actions"><button class="btn" type="submit">Opret organisation</button>${organizations.length ? '<button class="link" type="button" data-account="cancel-create">Tilbage</button>' : '<button class="link" type="button" data-account="logout">Log ud</button>'}</div>
      <p id="account-error" class="account-error" role="alert" hidden></p></form>${legacySessions().length ? '<button class="link" data-account="import-menu">Importér en tidligere session fra denne browser</button>' : ''}</section>`;
    emit();
  }
  function renderInvitations() {
    const el=gate();el.hidden=false;
    el.innerHTML=`<section class="account-card"><span class="brand">finch</span><h1>Invitationer</h1><p>Du er logget ind som ${escape(user.email)}. Acceptér for at dele organisationens arbejde.</p>
      ${invitations.map(i=>`<article class="invite-card"><h2>${escape(i.organizationName)}</h2>${i.roleTitle?`<p>Arbejdsrolle: ${escape(i.roleTitle)}</p>`:''}<small>Invitationen gælder til ${new Date(i.expiresAt).toLocaleDateString('da-DK')}</small><div><button class="btn" data-account="accept-invite" data-invite="${escape(i.invitationId)}">Acceptér invitation</button><button class="link" data-account="decline-invite" data-invite="${escape(i.invitationId)}">Afvis</button></div></article>`).join('') || '<p>Ingen gyldige invitationer til denne email. Log ind med den inviterede adresse, eller bed ejeren sende invitationen igen.</p>'}
      <p id="account-error" class="account-error" role="alert" hidden></p><button class="link" data-account="own-organizations">Mine organisationer</button><button class="link" data-account="logout">Log ud</button></section>`;
  }
  function renderInvitationStatus(invitation){
    const accepted=invitation.status==='accepted';const el=gate();el.hidden=false;
    el.innerHTML=`<section class="account-card"><span class="brand">finch</span><h1>${accepted?'Invitationen er accepteret':invitation.status==='declined'?'Invitationen er afvist':'Invitationen er ikke aktiv'}</h1><p>${accepted?`Du er medlem af <strong>${escape(invitation.organizationName)}</strong>. Du kan fortsætte til organisationens arbejde.`:'Linket er udløbet eller invitationen er ikke længere aktiv. Bed administratoren sende en ny invitation.'}</p>${accepted?`<button class="btn" data-account="open-invited-org" data-org="${escape(invitation.organizationId)}">Åbn organisationen</button>`:''}<button class="link" data-account="own-organizations">Mine organisationer</button><button class="link" data-account="logout">Log ud</button><p id="account-error" class="account-error" role="alert" hidden></p></section>`;
  }
  async function loadAccount() {
    const result = await request('/api/me'); user = result.user; organizations = result.organizations;invitations=result.invitations || [];
    const invitationId=new URL(location.href).searchParams.get('invite');
    if(invitationId){try{const result=await request(`/api/invitations/${encodeURIComponent(invitationId)}`);if(result.invitation.status!=='invited'){renderInvitationStatus(result.invitation);emit();return;}invitations=invitations.filter(i=>i.invitationId===invitationId);}catch{invitations=[];}renderInvitations();emit();return;}
    if(!organizations.length && invitations.length){renderInvitations();emit();return;}
    const requested = new URL(location.href).searchParams.get('org');
    // A link grants no access. Only organization ids returned for this account can be selected.
    const selected = organizations.find((o) => o.id === requested) || organizations.find((o) => o.id === result.lastOrgId) || organizations[0];
    if (requested && !organizations.some((o) => o.id === requested)) {
      gate().hidden = false;
      gate().innerHTML = `<section class="account-card"><span class="brand">finch</span><h1>Organisationen er ikke på din konto</h1><p>Log ind med samme email som i din anden browser, eller åbn en af dine egne organisationer.</p><button class="btn" data-account="own-organizations">Mine organisationer</button><button class="link" data-account="logout">Log ud</button></section>`;
      return;
    }
    if (selected) { await select(selected.id, false); gate().hidden = true; }
    else renderCreate();
    emit();
    clearInterval(pollTimer); pollTimer = setInterval(poll, 2000);
  }
  async function select(orgId, flushFirst = true) {
    if (switching) throw new Error('Vent, mens organisationen skifter.');
    if (flushFirst) await flush();
    switching = true; ++epoch; clearTimeout(saveTimer); onSwitch();
    try {
      const result = await request(`/api/organizations/${encodeURIComponent(orgId)}/select`, 'POST', {});
      adopt(result); gate().hidden = true;
    } catch (e) { if (current) onState(structuredClone(current)); throw e; }
    finally { switching = false; emit(); }
  }
  function changed(state) {
    if (!organization || switching) return;
    navigation.set(`${user.id}:${organization.id}`,Object.fromEntries(viewKeys.filter(k=>state[k]!==undefined).map(k=>[k,state[k]])));
    const copy=structuredClone(state);
    const content=value=>JSON.stringify(Object.fromEntries(Object.keys(value||{}).filter(k=>!viewKeys.includes(k)).sort().map(k=>[k,value[k]])));
    if(content(copy)===content(current)){current=copy;return;}
    current = copy; dirty++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => flush().catch(() => {}), 250);
    renderSaveStatus();
  }
  async function flush() {
    if (error?.code === 'revision_conflict') throw error;
    if (!organization || saved === dirty) return;
    if (saving) { await saving; if (saved !== dirty) return flush(); return; }
    const turn = epoch; const revision = organization.revision; const orgId = organization.id;
    const generation = dirty; const snapshot = structuredClone(current);
    saving = (async () => {
      try {
        const result = await request(`/api/organizations/${orgId}`, 'PUT', { revision, state: snapshot });
        if (turn !== epoch) return;
        updateSummary(result.organization); saved = generation; error = null; emit();
      } catch (e) { error = e; renderSaveStatus(); throw e; }
      finally { saving = null; renderSaveStatus(); }
    })();
    await saving;
    if (saved !== dirty) return flush();
  }
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)poll();});
  async function poll() {
    if (!organization || switching || saving || saved !== dirty || (document.hidden&&!backgroundActivity()) || error) return;
    const turn = epoch; const orgId = organization.id; const generation = dirty;
    try {
      const result = await request(`/api/organizations/${orgId}?revision=${organization.revision}`);
      if (turn !== epoch || saved !== dirty || generation !== dirty || result.unchanged) return;
      adopt(result);
    } catch (e) {
      if (e.status === 401) {
        ++epoch; onSwitch(); user = organization = current = work = onboarding = null; organizations = []; navigation.clear();
        clearInterval(pollTimer); renderLogin(e.message); emit();
      }
      else if(e.status===404){++epoch;onSwitch();organization=current=work=onboarding=null;dirty=saved=0;clearInterval(pollTimer);await loadAccount();}
      else { error = e; renderSaveStatus(); }
    }
  }
  function renderSaveStatus() {
    let el = document.getElementById('save-status');
    if (!el) { el = document.createElement('div'); el.id = 'save-status'; el.className = 'save-status'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    const hidden=!user||!organization;if(el.hidden!==hidden)el.hidden=hidden;
    if (error) {
      el.classList.add('has-error');
      el.innerHTML = `<span>${escape(error.message || 'Kunne ikke gemme. Dine ændringer er her stadig.')}</span>
        ${error.code === 'revision_conflict' ? '<button data-account="export">Gem mine ændringer som fil</button><button data-account="reload">Hent serverens version</button>' : '<button data-account="retry">Prøv igen</button>'}`;
    } else { el.classList.remove('has-error');const text=saved!==dirty||saving?'Gemmer…':'Gemt';if(el.textContent!==text)el.textContent=text; }
  }
  function controls() {
    if (!user) return '';
    return `<div class="account-controls"><details class="organization-picker"><summary aria-label="Skift organisation">Organisationer<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></summary><div class="organization-menu">
      ${organizations.map((o) => `<button type="button" data-account="select" data-org="${escape(o.id)}" ${o.id === organization?.id ? 'aria-current="true"' : ''}>${escape(o.name)}</button>`).join('')}
      <button type="button" data-account="create">+ Ny organisation</button>
      ${invitations.length?`<button type="button" data-account="invitations">Invitationer (${invitations.length})</button>`:''}
      ${legacySessions().length ? '<button type="button" data-account="import-menu">Importér gammel session</button>' : ''}
      <small>${escape(user.email)}</small><button type="button" data-account="logout">Log ud</button></div></details></div>`;
  }
  function renderControls(container) {
    if(!container)return;
    const markup=controls(),scope=`${user?.id || ''}:${organization?.id || ''}`,previous=controlRenders.get(container);
    // A save or poll must not replace the menu the user is interacting with.
    if(previous?.markup===markup&&previous.scope===scope)return;
    const picker=container.querySelector('.organization-picker');
    const preserve=!!picker?.open&&(!previous||previous.scope===scope);
    const focused=container.contains(document.activeElement)?document.activeElement:null;
    const focusKey=focused?{account:focused.dataset?.account,org:focused.dataset?.org,summary:focused.tagName==='SUMMARY'}:null;
    container.innerHTML=markup;controlRenders.set(container,{markup,scope});
    const next=container.querySelector('.organization-picker');
    if(preserve&&next){
      next.open=true;
      if(focusKey){const target=focusKey.summary?next.querySelector('summary'):[...next.querySelectorAll('[data-account]')].find(el=>el.dataset.account===focusKey.account&&el.dataset.org===focusKey.org);(target||next.querySelector('summary'))?.focus({preventScroll:true});}
    }
  }
  function legacySessions() {
    const sessions = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i); if (!key?.startsWith('finch-webmcp:v1:')) continue;
        try { const state = JSON.parse(localStorage.getItem(key)); if (state?.graph?.nodes?.length || state?.tasks?.length) sessions.push({ key, name: state.workspace?.name || state.graph.nodes.find((n) => n.type === 'virksomhed')?.label || key.split(':').at(-1), state }); } catch {}
      }
    } catch {}
    return sessions;
  }
  function importMenu() {
    const el = gate(); el.hidden = false;
    el.innerHTML = `<section class="account-card"><span class="brand">finch</span><h1>Behold dit tidligere arbejde</h1><p>Vælg den session, du vil kopiere til en organisation på din konto. Den gamle kopi bevares i browseren.</p>
      ${legacySessions().map((s, i) => `<button class="import-choice" data-account="import" data-index="${i}">${escape(s.name)}<small>${s.state.graph.nodes.length} begreber · ${s.state.tasks.length} opgaver</small></button>`).join('')}
      <button class="link" data-account="cancel-create">Tilbage</button><p id="account-error" class="account-error" role="alert" hidden></p></section>`;
  }
  async function create(name, state, profile) {
    await flush();
    const result = await request('/api/organizations', 'POST', { name, ...(state ? { state } : {}),...(profile?{profile}:{}) });
    ++epoch; onSwitch(); adopt(result); gate().hidden = true;emit();
    return result.organization;
  }
  function exportState() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(current, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'finch-organisation.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  document.addEventListener('submit', async (event) => {
    if (!['login-form', 'organization-form'].includes(event.target.id)) return;
    event.preventDefault(); const form = event.target; const submit = form.querySelector('[type=submit]'); submit.disabled = true;
    const data = new FormData(form);
    try {
      if (form.id === 'organization-form') await create(String(data.get('name')),null,Object.fromEntries(['website','description','roleTitle','roleDescription'].map(key=>[key,String(data.get(key)||'')])));
      else if (!challengeId) {
        loginEmail = String(data.get('email')).trim(); const result = await request('/api/auth/request-code', 'POST', { email: loginEmail }); challengeId = result.challengeId; renderLogin();
      } else {
        await request('/api/auth/verify-code', 'POST', { challengeId, code: String(data.get('code')).trim() }); challengeId = null; await loadAccount();
      }
    } catch (e) { notice(e.message); } finally { submit.disabled = false; }
  });
  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-account]'); if (!button) return;
    const action = button.dataset.account;
    if(window.FinchConnection&&!window.FinchConnection.loginAllowed)return;
    if(['select','create','invitations','logout','import-menu'].includes(action))button.closest('.organization-picker')?.removeAttribute('open');
    try {
      if (action === 'change-email') { challengeId = null; renderLogin(); }
      else if (action === 'create') { await flush(); renderCreate(); }
      else if (action === 'select') await select(button.dataset.org);
      else if (action === 'cancel-create') { if (organization) gate().hidden = true; else renderCreate(); }
      else if (action === 'own-organizations') { const url = new URL(location.href); url.searchParams.delete('org');url.searchParams.delete('invite'); history.replaceState(null, '', url); await loadAccount(); }
      else if(action==='invitations'){await flush();const result=await request('/api/me');invitations=result.invitations || [];renderInvitations();}
      else if(action==='accept-invite'||action==='decline-invite'){
        await flush();button.disabled=true;const result=await request(`/api/invitations/${encodeURIComponent(button.dataset.invite)}/${action==='accept-invite'?'accept':'decline'}`,'POST',{});
        const url=new URL(location.href);url.searchParams.set('invite',button.dataset.invite);history.replaceState(null,'',url);await loadAccount();
      }
      else if(action==='open-invited-org'){const url=new URL(location.href);url.searchParams.delete('invite');url.searchParams.set('org',button.dataset.org);history.replaceState(null,'',url);await loadAccount();}
      else if (action === 'logout') {
        await flush(); await request('/api/auth/logout', 'POST', {}); ++epoch; onSwitch();
        user = organization = current = null;work=onboarding=null;navigation.clear(); organizations = [];invitations=[]; clearInterval(pollTimer); loginEmail = ''; challengeId = null; renderLogin(); emit();
      } else if (action === 'import-menu') importMenu();
      else if (action === 'import') {
        const legacy = legacySessions()[Number(button.dataset.index)]; if (legacy) {
          const migrated = structuredClone(legacy.state);
          for (const node of migrated.graph.nodes) { if (!Array.isArray(node.statements)) node.statements = node.description ? [{ id: `${node.id}#legacy`, text: node.description }] : []; }
          migrated.events ||= []; await create(legacy.name, migrated);
        }
      } else if (action === 'retry') { error = null; await flush(); await poll(); renderSaveStatus(); }
      else if (action === 'export') exportState();
      else if (action === 'reload') {
        if (confirm('Hent serverens version? Eksportér først, hvis du vil beholde dine ændringer fra denne browser.')) {
          ++epoch; onSwitch(); adopt(await request(`/api/organizations/${organization.id}`));
        }
      }
    } catch (e) { if (gate().hidden) { error = e; renderSaveStatus(); } else notice(e.message); }
    finally {if(button.isConnected)button.disabled=false;}
  });
  window.addEventListener('beforeunload', (event) => {
    if (dirty !== saved) { event.preventDefault(); event.returnValue = ''; }
  });
  return {
    controls, renderControls, changed, flush, select, create,
    async reloadCurrent(){const turn=epoch,orgId=organization?.id;await flush();if(turn!==epoch||orgId!==organization?.id)throw new Error("Organisationen er skiftet.");const result=await request(`/api/organizations/${orgId}`);if(turn!==epoch||orgId!==organization?.id)throw new Error("Organisationen er skiftet.");adopt(result);},
    get ready() { return initialized && !!user && !!organization && gate().hidden && !switching && !error; },
    get organization() { return organization; },
    get work(){return work;},
    get onboarding(){return onboarding?structuredClone(onboarding):null;},
    get user(){return user?{...user}:null;},
    get error() { return error; },
    get organizations() { return organizations.map((o) => ({ ...o })); },
    get sessionUrl() { const url=new URL(location.pathname,location.origin);if(organization)url.searchParams.set('org',organization.id);return (globalThis.FinchSite?.canonicalUrl(url)||url).href; },
    waitForReady({timeout_seconds=40,signal}={}){
      if(!window.FinchConnection?.connected)return Promise.resolve({status:'connection_required'});
      if(this.ready)return Promise.resolve({status:'ready'});
      const seconds=Math.min(60,Math.max(1,Number.isFinite(Number(timeout_seconds))?Number(timeout_seconds):40));
      return new Promise(resolve=>{
        let settled=false,checking=false,timer,poll;
        const finish=result=>{if(settled)return;settled=true;clearTimeout(timer);clearInterval(poll);document.removeEventListener('finch-account-change',changed);signal?.removeEventListener('abort',aborted);resolve(result);};
        const changed=()=>{if(this.ready)finish({status:'ready'});else if(error)finish({status:'persistence_error',error:error.message});};
        const aborted=()=>finish({status:'cancelled'});
        const check=async()=>{if(settled||checking)return;checking=true;try{
          // A verified cookie may have arrived in another tab of this browser.
          // Never reload a signed-in user's unfinished organisation form.
          if(!user)await this.activate({checkSession:true});
          changed();
        }catch(e){finish({status:'error',error:e.message});}finally{checking=false;}};
        if(signal?.aborted){aborted();return;}
        document.addEventListener('finch-account-change',changed);signal?.addEventListener('abort',aborted,{once:true});
        timer=setTimeout(()=>finish(this.ready?{status:'ready'}:{status:'timeout'}),seconds*1000);
        poll=setInterval(check,4000);changed();check();
      });
    },
    async activate({checkSession=false}={}){
      if(window.FinchConnection&&!window.FinchConnection.loginAllowed)return;
      if(initialized){if(checkSession&&!user){try{await loadAccount();emit();}catch(e){if(e.status!==401)notice(e.message);}}return;}if(activation)return activation;
      activation=(async()=>{const el=gate();el.hidden=false;el.innerHTML='<section class="account-card"><span class="brand">finch</span><p>Henter dine organisationer…</p></section>';
        try{await loadAccount();}catch(e){renderLogin(e.status===401?'':e.message);}initialized=true;emit();
      })().finally(()=>activation=null);return activation;
    },
    async initialize({ onLoad, onOrganizationChange, shouldPollInBackground,deferUntilConnected=false }) {
      onState = onLoad; onSwitch = onOrganizationChange;backgroundActivity=shouldPollInBackground || (()=>false);
      if(deferUntilConnected){gate().hidden=true;return;}
      await this.activate();
    },
  };
})();
