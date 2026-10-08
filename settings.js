window.FinchSettings=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let host;let team=null;let org=null;let loadedRevision=-1;let loadedBrandRevision=-1;let generation=0;let busy=false;let error='';let brandFiles=[];let brandDirty=false;let brandPendingRevision=null;
  let selectedSection='members',renderedRevision=-1;const dirtySections=new Set();
  const sectionItems=[
    {id:'members',title:'Medlemmer og invitationer',description:'Personer, adgang og synlighed i grafen'},
    {id:'roles',title:'Arbejdsroller',description:'Ansvar og mandat i organisationen'},
    {id:'branding',title:'Udseende',description:'Logo, farver og skrifter'},
    {id:'inbound',title:'Opgaver via email',description:'Mailadresse og tilladte afsendere'},
    {id:'notifications',title:'Notifikationer',description:'Dine beskeder om nye opgaver'},
  ];
  const availableSections=()=>sectionItems.filter(item=>(!item.ownerOnly||team?.canManage)&&(item.id!=='inbound'||team?.inbound));
  const statuses={active:'Medlem',accepted:'Accepteret · afventer første login',invited:'Inviteret',sending:'Sender…',failed:'Mail kunne ikke sendes',expired:'Invitation udløbet',declined:'Invitation afvist',revoked:'Adgang fjernet'};
  const gear='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 3-.7 2.4-2.1 1.2-2.4-.6-1.5 2.6 1.7 1.8v2.4l-1.7 1.8 1.5 2.6 2.4-.6 2.1 1.2L9 21h3l.7-2.4 2.1-1.2 2.4.6 1.5-2.6-1.7-1.8v-2.4l1.7-1.8-1.5-2.6-2.4.6-2.1-1.2L12 3z"/><circle cx="10.5" cy="12" r="3"/></svg>';
  function rail(){return `<button class="rail-settings${host.state().view==='settings'?' is-current':''}" data-action="view" data-view="settings" title="Indstillinger" data-label="Indstillinger" aria-label="Indstillinger"${host.state().view==='settings'?' aria-current="page"':''}>${gear}</button>`;}
  function reset(){rendering=null;generation++;org=null;team=null;loadedRevision=-1;loadedBrandRevision=-1;busy=false;error='';brandFiles=[];brandDirty=false;brandPendingRevision=null;selectedSection='members';renderedRevision=-1;dirtySections.clear();window.FinchSettingsGrids.reset();document.getElementById('settings-view')?.classList.remove('settings-detail-open');}
  function base(){return `/api/organizations/${window.FinchStorage.organization.id}/settings`;}
  async function request(path='',method='GET',data){
    const currentOrg=window.FinchStorage.organization?.id;const response=await fetch(base()+path,{method,credentials:'same-origin',cache:'no-store',headers:data?{'Content-Type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{}),signal:AbortSignal.timeout(20000)});
    const result=await response.json();if(currentOrg!==window.FinchStorage.organization?.id)throw new Error('Organisationen er skiftet.');
    if(!response.ok){const e=new Error(result.message||'Indstillingerne kunne ikke gemmes.');e.status=response.status;throw e;}return result;
  }
  async function load(){const turn=generation;const currentOrg=window.FinchStorage.organization?.id;const result=await request();const catalog=result.canManage?await window.FinchData.tool('list_data',{}):null;if(turn!==generation||currentOrg!==window.FinchStorage.organization?.id)return;team=result;brandFiles=(catalog?.files||[]).filter(f=>['image/png','image/jpeg','image/webp','image/svg+xml'].includes(f.content_type)&&f.size_bytes<=1048576);org=currentOrg;loadedRevision=result.organizationRevision;}
  function roleOptions(selected){return `<option value="">Ingen arbejdsrolle</option>${team.roles.map(r=>`<option value="${r.id}"${r.id===selected?' selected':''}>${esc(r.title)}</option>`).join('')}`;}
  function inboundHtml(owner){
    const mail=team.inbound;if(!mail)return '';
    const status={accepted:'Oprettet',rejected:'Afvist',failed:'Afventer genforsøg',processing:'Modtager'};
    return `<section class="settings-section inbound-settings"><h3>Opgaver via email</h3><p>Send en mail med opgaven til organisationens adresse. Emne og tekst bliver en sag under Agent. Agenten behandler sagen, når den er aktiv.</p>
      ${mail.address?`<label class="inbound-address">Organisationens mailadresse<input readonly value="${esc(mail.address)}" aria-label="Organisationens mailadresse"></label>`:'<p class="settings-note">Mailadressen oprettes, første gang administratoren gemmer mailindstillingerne.</p>'}
      ${!mail.available?'<p class="settings-note">Mailforbindelsen klargøres. Du kan gemme afsenderlisten nu og aktivere modtagelse, når forbindelsen er klar.</p>':''}
      ${owner?`<form id="inbound-settings-form" class="settings-form" data-revision="${mail.revision}">
        <label class="settings-check"><input type="checkbox" name="enabled"${mail.enabled?' checked':''}${mail.available?'':' disabled'}>Modtag opgaver via email</label>
        <button class="btn" type="submit">Gem mailindstillinger</button></form>`:`<p>Mailmodtagelse er ${mail.enabled?'slået til':'slået fra'}. Administratoren vælger de tilladte afsendere.</p>`}
      <p class="inbound-limit-note">Vedhæftninger gemmes privat under Filer: højst 10 filer, 10 MB pr. fil og 20 MB samlet. Afsenderadressen og domænets ægthed kontrolleres, før en opgave oprettes.</p>
      <p class="settings-note">Alle aktive medlemmer kan sende opgaver til organisationen, når mailmodtagelse er slået til.</p>
      <div class="settings-mail-views" role="group" aria-label="Mailindgangens lister"><button type="button" class="btn btn-ghost" data-grid-mail-view="senders">Ekstra afsendere</button>${owner?'<button type="button" class="btn btn-ghost" data-grid-mail-view="mailLog">Modtagelser</button>':''}</div>
      ${['senders',...(owner?['mailLog']:[])].map(kind=>`<div data-grid-mail-panel="${kind}" hidden>${window.FinchSettingsGrids.html(kind)}</div>`).join('')}</section>`;
  }
  function brandingHtml(owner){
    const brand=window.FinchBranding.snapshot(),model=window.FinchBrandModel;
    const theme=model.current(brand.active===false?null:brand),color=(key,label)=>`<label class="branding-color">${label}<input type="color" name="${key}" value="${esc(theme[key])}"></label>`;
    if(!owner)return '<section class="settings-section"><h3>Udseende</h3><p>Organisationens administrator redigerer logo, farver og skrifter.</p></section>';
    const main=[['accent','Primær farve'],['on_accent','Tekst på primær farve'],['background','Baggrund'],['surface','Overflader'],['text','Tekstfarve'],['muted','Sekundær tekst']];
    const advanced=[['surface_alt','Alternativ overflade'],['surface_inset','Indrykket overflade'],['accent_soft','Fremhævning'],['secondary','Sekundær farve'],['border','Kanter'],['rail','Ikonliste'],['graph_background','Grafens baggrund'],['graph_text','Grafens tekst']];
    return `<section class="settings-section branding-settings"><h3>Udseende</h3><p>Tilpas hele arbejdsfladen til organisationens visuelle identitet.</p>
      <form id="branding-settings-form" class="settings-form" data-revision="${brand.revision}">
        <div class="branding-logo-settings">${window.FinchBranding.logo()?`<div class="branding-logo-preview">${window.FinchBranding.logo()}</div>`:''}<div><label>Logo<select name="logo"><option value="keep">${brand.logo?'Behold nuværende logo':'Intet logo'}</option><option value="none">Fjern logo</option>${brandFiles.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('')}</select></label><label>Upload nyt logo<input name="logoUpload" type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml"></label><small>PNG, JPEG, WebP eller SVG. Højst 1 MB. En upload erstatter valget ovenfor.</small><label>Logoets tekst<input name="logoAlt" maxlength="120" value="${esc(brand.logo?.alt||window.FinchStorage.organization?.name||'')}"></label></div></div>
        <fieldset class="branding-colors"><legend>Farver</legend>${main.map(([k,l])=>color(k,l)).join('')}</fieldset>
        <div class="branding-fonts"><label>Brødtekstskrift<input name="body_font" maxlength="160" value="${esc(theme.body_font)}" placeholder="Arial, sans-serif"></label><label>Overskriftsskrift<input name="heading_font" maxlength="160" value="${esc(theme.heading_font)}" placeholder="Georgia, serif"></label><label>Afrunding<select name="radius">${Array.from({length:25},(_,n)=>`<option value="${n}px"${theme.radius===n+'px'?' selected':''}>${n} px</option>`).join('')}</select></label></div>
        ${brand.fonts?.length?`<small>Egne indlæste skrifter: ${esc([...new Set(brand.fonts.map(f=>f.family))].join(', '))}. De bevares, når du gemmer.</small>`:''}
        <details class="branding-advanced"><summary>Avanceret udseende</summary><fieldset class="branding-colors"><legend>Øvrige farver</legend>${advanced.map(([k,l])=>color(k,l)).join('')}</fieldset><label>Organisationens stylesheet<textarea name="stylesheet" rows="8" maxlength="24000" spellcheck="false">${esc(brand.stylesheet)}</textarea></label><small>CSS til arbejdsfladen. Brug temaets farver og skrifter; eksterne imports og ressourceadresser er ikke tilladt.</small><label>Kilde til designet<input name="source_url" type="url" maxlength="2000" placeholder="https://organisation.dk" value="${esc(brand.source_url||'')}"></label></details>
        <div class="settings-actions"><button class="btn" type="submit">Gem udseende</button><button class="link" type="button" data-setting-action="reload-branding">Genindlæs udseende</button><button class="link" type="button" data-setting-action="reset-branding">Nulstil til Finch-standard</button></div>
        <small>Nulstilling fjerner logo, farver, skrifter og stylesheet fra udseendet. Organisationens filer og arbejde bevares.</small>
      </form></section>`;
  }
  async function mutateBrand(form,resetBrand=false){
    if(busy||!team?.canManage)return;busy=true;error='';const turn=generation,orgId=window.FinchStorage.organization?.id;
    const controls=[...form.querySelectorAll('button,input,select,textarea')];controls.forEach(c=>c.disabled=true);
    try{
      // Read values before disabling, since FormData omits disabled controls.
      controls.forEach(c=>c.disabled=false);const data=new FormData(form);controls.forEach(c=>c.disabled=true);
      await window.FinchStorage.flush();
      let revision=Number(form.dataset.revision);
      if(brandPendingRevision!==null){if(window.FinchBranding.snapshot().revision!==brandPendingRevision)throw new Error('Udseendet er ændret. Genindlæs det før du gemmer.');revision=brandPendingRevision;brandPendingRevision=null;}
      const input={revision};
      if(!resetBrand){
        if(window.FinchBranding.snapshot().revision!==revision)throw new Error('Udseendet er ændret. Genindlæs det før du gemmer.');
        input.theme=Object.fromEntries(Object.keys(window.FinchBrandModel.defaults).map(k=>[k,String(data.get(k))]));input.stylesheet=String(data.get('stylesheet')||'');input.source_url=String(data.get('source_url')||'').trim();
        const draft={...window.FinchBranding.snapshot(),theme:input.theme,stylesheet:input.stylesheet,source_url:input.source_url};const problem=window.FinchBrandModel.validate(draft);if(problem)throw new Error(problem);
        const logoChoice=data.get('logo'),file=data.get('logoUpload');
        if(file?.size){
          if(file.size>1048576||!['image/png','image/jpeg','image/webp','image/svg+xml'].includes(file.type))throw new Error('Vælg et billede på højst 1 MB i PNG, JPEG, WebP eller SVG.');
          const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
          const result=await window.FinchData.tool('upload_file',{name:file.name,content_type:file.type,content_base64:btoa(binary),description:'Organisationens logo'});input.logo={file_id:result.file.id,alt:String(data.get('logoAlt')||'')};
        }else if(logoChoice==='none')input.logo=null;
        else if(logoChoice!=='keep')input.logo={file_id:logoChoice,alt:String(data.get('logoAlt')||'')};
        else if(window.FinchBranding.snapshot().logo)input.logo={...window.FinchBranding.snapshot().logo,alt:String(data.get('logoAlt')||'')};
      }
      if(turn!==generation||orgId!==window.FinchStorage.organization?.id)return;
      await window.FinchBranding.tool(resetBrand?'reset_branding':'set_branding',input);brandPendingRevision=window.FinchBranding.snapshot().revision;
      await window.FinchStorage.flush();brandPendingRevision=null;brandDirty=false;dirtySections.delete('branding');
      if(turn!==generation)return;await load();draw();host.toast(resetBrand?'Udseendet er nulstillet til Finch-standard':'Organisationens udseende er gemt');
    }catch(e){if(turn!==generation)return;error=e.message;const notice=document.getElementById('settings-error');if(notice){notice.hidden=false;notice.textContent=error;notice.scrollIntoView({block:'nearest'});}}
    finally{if(turn===generation){busy=false;controls.forEach(c=>c.disabled=false);}}
  }
  function selectSection(id,openDetail=false){
    const item=availableSections().find(item=>item.id===id);if(!item)return;
    selectedSection=id;const box=document.getElementById('settings-view');if(!box)return;
    box.querySelectorAll('[data-settings-section]').forEach(button=>{const selected=button.dataset.settingsSection===id;button.classList.toggle('is-active',selected);if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');});
    box.querySelectorAll('[data-settings-panel]').forEach(panel=>panel.hidden=panel.dataset.settingsPanel!==id);

    box.classList.toggle('settings-has-grid',['members','roles','inbound'].includes(id));window.FinchSettingsGrids.activate(id);
    const title=box.querySelector('#settings-section-title');if(title)title.textContent=item.title;
    if(openDetail){box.classList.add('settings-detail-open');box.querySelector('.settings-page').scrollTop=0;if(window.matchMedia('(max-width:760px)').matches)title?.focus({preventScroll:true});}
  }
  function draw(){
    const box=document.getElementById('settings-view');if(!box||host.state().view!=='settings')return;
    const owner=team?.canManage;loadedBrandRevision=window.FinchBranding.snapshot().revision;
    const items=availableSections();if(!items.some(item=>item.id===selectedSection))selectedSection=items[0].id;
    // Keep real form nodes, including selected files, when another section is saved.
    window.FinchSettingsGrids.dispose();renderedRevision=loadedRevision;
    const drafts=new Map([...box.querySelectorAll('[data-settings-panel]')].filter(panel=>dirtySections.has(panel.dataset.settingsPanel)&&!['members','roles','inbound'].includes(panel.dataset.settingsPanel)).map(panel=>[panel.dataset.settingsPanel,panel]));
    box.innerHTML=`<nav class="settings-list" aria-label="Indstillinger"><header><h2>Indstillinger</h2><p>${esc(window.FinchStorage.organization?.name)}</p></header><div class="settings-list-items">${items.map(item=>`<button type="button" class="item settings-list-item" data-settings-section="${item.id}" aria-controls="settings-panel-${item.id}"><strong class="subject">${item.title}</strong><span class="preview">${item.description}</span></button>`).join('')}</div></nav>
      <main class="settings-page"><button type="button" class="link settings-back" data-settings-back>← Indstillinger</button><header class="settings-section-header"><h2 id="settings-section-title" tabindex="-1"></h2></header>
      <p id="settings-error" class="account-error" role="alert"${error?'':' hidden'}>${esc(error)}</p>
      <div id="settings-panel-notifications" data-settings-panel="notifications" hidden><section id="notification-settings" class="settings-section notification-settings"></section></div>
      ${!team?'<p>Henter medlemmer og roller…</p>':`
      ${!owner?'<p class="settings-note">Ejeren administrerer medlemmer og roller. Som medlem deler du organisationens opgaver, viden, data og sider.</p>':''}
      <div id="settings-panel-branding" data-settings-panel="branding" hidden>${brandingHtml(owner)}</div>
      ${team.inbound?`<div id="settings-panel-inbound" data-settings-panel="inbound" hidden>${inboundHtml(owner)}</div>`:''}

      <div id="settings-panel-members" data-settings-panel="members" hidden>${window.FinchSettingsGrids.html('members')}</div>
      <div id="settings-panel-roles" data-settings-panel="roles" hidden>${window.FinchSettingsGrids.html('roles')}</div>`}
      </main>`;
    for(const [id,panel] of drafts){const replacement=box.querySelector(`#settings-panel-${id}`);if(replacement){replacement.replaceWith(panel);panel.querySelectorAll('select[name="roleId"]').forEach(select=>select.innerHTML=roleOptions(select.value));}else dirtySections.delete(id);}

    selectSection(selectedSection);
    window.FinchNotifications.paint();
  }
  async function renderSettings({background=false}={}){if(host.state().view!=='settings'||busy||brandDirty||dirtySections.size||window.FinchSettingsGrids.dirty)return;if(org===window.FinchStorage.organization?.id && team && loadedRevision===window.FinchStorage.organization.revision&&loadedBrandRevision===window.FinchBranding.snapshot().revision){if(renderedRevision!==loadedRevision)draw();else window.FinchSettingsGrids.activate(selectedSection);return;}
    const box=document.getElementById('settings-view');if(team&&box?.contains(document.activeElement)&&document.activeElement.matches('input,textarea,select'))return;
    const visual=()=>JSON.stringify({team:team&&Object.fromEntries(Object.entries(team).filter(([key])=>key!=='organizationRevision')),brand:window.FinchBranding.snapshot(),brandFiles,error});const before=visual();
    if(!team)draw();try{await load();if(!background||before!==visual()||!box?.firstElementChild)draw();else renderedRevision=loadedRevision;}catch(e){error=e.message;if(!background||before!==visual())draw();}}
  let rendering=null;
  function render(options){if(rendering)return rendering;const turn=generation;rendering=renderSettings(options).finally(()=>{if(turn===generation)rendering=null;});return rendering;}
  async function performGrid(operations,message){
    if(busy||!team?.canManage||!window.FinchStorage.ready)throw new Error('Kun administratoren kan ændre disse indstillinger.');
    busy=true;error='';const turn=generation;let completed=0;const box=document.getElementById('settings-view');if(box)box.inert=true;
    try{await window.FinchStorage.flush();for(const op of operations){if(turn!==generation)throw new Error('Organisationen er skiftet.');await request(op.path,op.method,op.data);completed++;}await window.FinchStorage.reloadCurrent();await load();if(turn!==generation)throw new Error('Organisationen er skiftet.');host.toast(message);}
    catch(e){if(turn===generation){try{await window.FinchStorage.reloadCurrent();await load();}catch{} }throw new Error((completed?`${completed} af ${operations.length} handlinger blev gemt. `:'')+e.message);}
    finally{if(turn===generation){busy=false;if(box)box.inert=false;}}
  }
  async function mutate(path,method,data,form){
    if(busy || !window.FinchStorage.ready)return;busy=true;error='';const turn=generation;
    const changedSection=selectedSection;
    const box=document.getElementById('settings-view');const controls=new Map([...(box?.querySelectorAll('button,input,select,textarea')||[])].map(control=>[control,control.disabled]));controls.forEach((_disabled,control)=>control.disabled=true);
    try{await window.FinchStorage.flush();await request(path,method,data);if(turn!==generation)return;dirtySections.delete(changedSection);await window.FinchStorage.reloadCurrent();await load();draw();host.toast(form?.id==='invite-member-form'?'Invitationen er sendt':'Indstillingerne er gemt');}
    catch(e){if(turn!==generation)return;error=e.message;const notice=document.getElementById('settings-error');if(notice){notice.hidden=false;notice.textContent=error;}if([409,503].includes(e.status)){try{if(e.status===409)dirtySections.delete(changedSection);await load();draw();}catch{}} }
    finally{if(turn===generation){busy=false;controls.forEach((disabled,control)=>{if(control.isConnected)control.disabled=disabled;});}}
  }
  function markDraft(event){if(event.target.closest('.tabulator,[data-grid-form]'))return;const panel=event.target.closest('[data-settings-panel]');if(panel)dirtySections.add(panel.dataset.settingsPanel);if(event.target.closest('#branding-settings-form'))brandDirty=true;}
  document.addEventListener('input',markDraft);
  document.addEventListener('change',markDraft);
  document.addEventListener('submit',event=>{
    if(event.target.id==='branding-settings-form'){event.preventDefault();mutateBrand(event.target);return;}
    const form=event.target.closest('#inbound-settings-form,#invite-member-form,#create-role-form,.member-form,.role-form');if(!form)return;event.preventDefault();
    const data=new FormData(form);
    if(form.id==='inbound-settings-form'){mutate('/inbound','PUT',{revision:Number(form.dataset.revision),enabled:data.has('enabled'),allowedSenders:team.inbound.allowedSenders});}
    else if(form.id==='invite-member-form')mutate('/members','POST',{email:data.get('email'),name:data.get('name'),roleId:data.get('roleId')||null,inGraph:data.has('inGraph')},form);
    else if(form.id==='create-role-form')mutate('/roles','POST',{title:data.get('title'),description:data.get('description')});
    else if(form.matches('.member-form'))mutate(`/members/${form.dataset.member}`,'PUT',{revision:Number(form.dataset.revision),name:data.get('name'),roleId:data.get('roleId')||null,inGraph:data.has('inGraph')});
    else mutate(`/roles/${form.dataset.role}`,'PUT',{revision:Number(form.dataset.revision),title:data.get('title'),description:data.get('description')});
  });
  document.addEventListener('click',event=>{
    const section=event.target.closest('[data-settings-section]');if(section){if(!busy)selectSection(section.dataset.settingsSection,true);return;}
    if(event.target.closest('[data-settings-back]')){document.getElementById('settings-view')?.classList.remove('settings-detail-open');document.querySelector(`[data-settings-section="${selectedSection}"]`)?.focus();return;}
    const button=event.target.closest('[data-setting-action]');if(!button)return;

    if(button.dataset.settingAction==='reset-branding'){mutateBrand(document.getElementById('branding-settings-form'),true);return;}
    if(button.dataset.settingAction==='reload-branding'){brandDirty=false;dirtySections.delete('branding');error='';draw();return;}
    const m=team?.members.find(m=>m.id===button.dataset.member),r=team?.roles.find(r=>r.id===button.dataset.role);
    if(button.dataset.settingAction==='resend'&&m)mutate(`/members/${m.id}/resend`,'POST',{revision:m.revision});
    else if(button.dataset.settingAction==='revoke'&&m)mutate(`/members/${m.id}`,'DELETE',{revision:m.revision});
    else if(button.dataset.settingAction==='delete-role'&&r)mutate(`/roles/${r.id}`,'DELETE',{revision:r.revision});
  });
  return {configure(options){host=options;window.FinchSettingsGrids.configure({team:()=>team,statuses,busy:()=>busy,perform:performGrid,redraw:draw,markDirty:kind=>dirtySections.add(['senders','mailLog'].includes(kind)?'inbound':kind),clearDirty:kind=>dirtySections.delete(['senders','mailLog'].includes(kind)?'inbound':kind),refresh:async()=>{try{await load();draw();}catch(e){error=e.message;draw();}}});},render,rail,reset,async openMemberCreation(){await render();if(!team?.canManage)throw new Error('Kun administratoren kan invitere medlemmer.');selectSection('members',true);window.FinchSettingsGrids.openCreate('members');},async roles(){const result=await request();return result.roles;}};
})();
