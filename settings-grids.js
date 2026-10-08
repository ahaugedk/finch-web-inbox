window.FinchSettingsGrids=(()=>{
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let host,mailView='senders';const tables=new Map(),readyTables=new WeakSet(),selections=new Map(),editors=new Map(),drafts=new Map();
  const labels={members:'Medlemmer og invitationer',roles:'Arbejdsroller',senders:'Ekstra afsendere',mailLog:'Seneste modtagelser'};
  const key=(kind,id)=>kind+':'+id;
  const selected=kind=>(selections.get(kind)||[]).filter(id=>rows(kind).some(row=>row.id===id));
  const owner=()=>!!host.team()?.canManage;
  const roleName=id=>host.team()?.roles.find(r=>r.id===id)?.title||'Ikke angivet';
  function rows(kind){const t=host.team();if(!t)return [];
    if(kind==='members')return t.members.filter(m=>m.status!=='revoked').map(m=>({...m,displayName:m.name||m.email,roleTitle:roleName(m.roleId),statusText:m.isOwner?'Ejer':host.statuses[m.status]||m.status,graphText:m.inGraph?'Ja':'Nej'}));
    if(kind==='roles')return t.roles.map(r=>({...r,memberCount:t.members.filter(m=>m.roleId===r.id&&m.status!=='revoked').length}));
    if(kind==='senders')return (t.inbound?.allowedSenders||[]).map(email=>({id:email,email}));
    return (t.inbound?.recent||[]).map(m=>({...m,time:new Date(m.createdAt).toLocaleString('da-DK'),statusText:({accepted:'Oprettet',rejected:'Afvist',failed:'Afventer genforsøg',processing:'Modtager'})[m.status]||m.status}));
  }
  function actions(kind){const n=selected(kind).length,b=host.busy(),chosen=rows(kind).filter(r=>selected(kind).includes(r.id));
    const button=(action,label,disabled=false,primary=false)=>`<button type="button" class="${primary?'btn':'btn btn-ghost'} grid-text-action" data-grid-action="${action}" data-grid-kind="${kind}"${disabled||b?' disabled':''}>${label}</button>`;
    const noun={members:['medlem','medlemmer'],roles:['rolle','roller'],senders:['afsender','afsendere'],mailLog:['modtagelse','modtagelser']}[kind],count=rows(kind).length;
    return `<div class="settings-grid-toolbar grid-toolbar"><div class="settings-grid-actions grid-toolbar-actions">${owner()&&kind!=='mailLog'?
      (button('edit','Redigér',!n||(kind!=='members'&&n!==1))+button('delete','Slet valgte',!n||(kind==='members'&&chosen.some(m=>m.isOwner||m.status==='revoked'))))+
      (kind==='members'?button('resend','Gensend invitation',!n||chosen.some(m=>m.isOwner||['active','accepted','revoked'].includes(m.status))):''):''}
      ${button('refresh','Genindlæs',false)}${n?button('clear','Ryd valg',false):''}</div><span class="settings-grid-selection grid-selection" role="status">${n?`${n} valgt`:`${count} ${noun[count===1?0:1]}`}</span>${owner()&&['members','roles','senders'].includes(kind)?globalThis.FinchGridUI.createHtml(kind==='members'?'Nyt medlem':kind==='roles'?'Ny rolle':'Ny afsender',{'data-grid-action':'create','data-grid-kind':kind}):'<span class="grid-read-only">Læsevisning</span>'}</div>`;
  }
  function html(kind){return `<div class="settings-grid-collection" data-grid-collection="${kind}"><div class="settings-grid-main"><div data-grid-toolbar="${kind}">${actions(kind)}</div><div class="settings-grid finch-crud-grid" id="settings-grid-${kind}" aria-label="${labels[kind]}"></div></div><aside class="settings-context" data-grid-context="${kind}" aria-label="Detaljer: ${labels[kind]}" hidden></aside></div>`;}
  function plain(cell){const span=document.createElement('span');span.textContent=String(cell.getValue()??'—');return span;}
  function nameCell(kind){return cell=>{const button=document.createElement('button');button.type='button';button.className='settings-grid-open';button.textContent=String(cell.getValue()||'—');button.dataset.gridOpen=kind;button.dataset.gridId=cell.getRow().getData().id;return button;};}
  function rowActions(kind){return {title:'Handlinger',field:'__actions',width:112,minWidth:112,maxWidth:112,resizable:false,frozen:true,headerSort:false,formatter:cell=>{
    const item=cell.getRow().getData(),box=document.createElement('div');box.className='grid-row-actions';
    const attrs={'data-grid-kind':kind,'data-grid-id':item.id};box.innerHTML=globalThis.FinchGridUI.iconHtml('edit','Redigér række',{...attrs,'data-grid-action':'edit-item'},host.busy())+globalThis.FinchGridUI.iconHtml('delete',item.isOwner?'Ejeren kan ikke slettes':'Slet række',{...attrs,'data-grid-action':'delete-item'},host.busy()||!!item.isOwner);return box;
  }};}
  function columns(kind){const choose={field:'__selection',formatter:'rowSelection',titleFormatter:'rowSelection',titleFormatterParams:{rowRange:'active'},hozAlign:'center',headerSort:false,width:44,resizable:false};
    const selection=owner()&&kind!=='mailLog'?[choose]:[];
    const c=(title,field,more={})=>({title,field,minWidth:140,headerFilter:'input',formatter:plain,...more});
    if(kind==='members')return [...selection,c('Navn','displayName',{formatter:nameCell(kind),minWidth:180}),c('Email','email',{minWidth:210}),c('Status','statusText',{minWidth:180}),c('Arbejdsrolle','roleTitle',{minWidth:180}),c('I grafen','graphText',{minWidth:100}),...(owner()?[rowActions(kind)]:[])];
    if(kind==='roles')return [...selection,c('Rolle','title',{formatter:nameCell(kind),minWidth:180}),c('Ansvar og mandat','description',{minWidth:240,widthGrow:3}),c('Tildelt','memberCount',{sorter:'number',minWidth:100,headerFilter:false}),...(owner()?[rowActions(kind)]:[])];
    if(kind==='senders')return [...selection,c('Emailadresse','email',{formatter:nameCell(kind),minWidth:240}),...(owner()?[rowActions(kind)]:[])];
    return [...selection,c('Modtaget','time'),c('Emne','subject',{formatter:nameCell(kind),minWidth:240,widthGrow:2}),c('Afsender','sender',{minWidth:210}),c('Status','statusText')];
  }
  function mount(kind){const element=document.getElementById('settings-grid-'+kind);if(!element||element.closest('[hidden]'))return;
    if(tables.has(kind)){const table=tables.get(kind);if(readyTables.has(table))table.redraw(true);context(kind);return;}
    const ids=selected(kind).filter(id=>rows(kind).some(r=>r.id===id));selections.set(kind,ids);
    const table=new window.Tabulator(element,{data:rows(kind),index:'id',layout:'fitColumns',height:470,columns:columns(kind),selectableRows:'highlight',pagination:true,paginationSize:25,paginationSizeSelector:[10,25,50,100],paginationCounter:'rows',placeholder:'Ingen poster.',locale:'da',langs:{da:{pagination:{page_size:'Rækker',page_title:'Vis side',first:'Første',first_title:'Første side',last:'Sidste',last_title:'Sidste side',prev:'Forrige',prev_title:'Forrige side',next:'Næste',next_title:'Næste side',counter:{showing:'Viser',of:'af',rows:'rækker',pages:'sider'}},headerFilters:{default:'Filtrér…'}}}});
    tables.set(kind,table);
    table.on('tableBuilt',()=>{if(tables.get(kind)!==table)return;readyTables.add(table);if(ids.length)table.selectRow(ids);toolbar(kind);});
    table.on('rowSelectionChanged',data=>{if(tables.get(kind)!==table)return;selections.set(kind,data.map(r=>r.id));toolbar(kind);});
    table.on('rowClick',(event,row)=>{if(!event.target.closest('input,button')&&!host.busy())open(kind,row.getData().id);});
    table.on('renderComplete',()=>{element.querySelectorAll('input[type=checkbox]').forEach(input=>input.setAttribute('aria-label',input.closest('.tabulator-header')?'Vælg alle filtrerede rækker':'Vælg række'));});
    context(kind);
  }
  function toolbar(kind){const element=document.querySelector(`[data-grid-toolbar="${kind}"]`);if(element)element.innerHTML=actions(kind);}
  function roleOptions(value,keep=false){return `${keep?`<option value="__keep__"${value==='__keep__'?' selected':''}>Behold eksisterende rolle</option>`:''}<option value=""${value===''?' selected':''}>Ingen arbejdsrolle</option>${(host.team()?.roles||[]).map(r=>`<option value="${esc(r.id)}"${r.id===value?' selected':''}>${esc(r.title)}</option>`).join('')}`;}
  function context(kind){const box=document.querySelector(`[data-grid-context="${kind}"]`);if(!box)return;
    const editor=editors.get(kind),item=editor?.id&&rows(kind).find(r=>r.id===editor.id);
    const visible=!!editor&&(editor.mode!=='item'||!!item),collection=box.closest('[data-grid-collection]');
    const changed=collection.classList.contains('has-context')!==visible;
    box.hidden=!visible;collection.classList.toggle('has-context',visible);
    const table=tables.get(kind);if(changed&&table&&readyTables.has(table))table.redraw(true);
    if(!visible){box.replaceChildren();return;}
    const mode=editor.mode,targets=editor.targets||[],d=drafts.get(key(kind,mode==='item'?editor.id:mode))||item||{};
    const close='<button type="button" class="link" data-grid-action="close" data-grid-kind="'+kind+'">Luk detaljer</button>';
    const heading=mode==='delete'?`Slet ${targets.length===1?(kind==='members'?'medlem':kind==='roles'?'rolle':'afsender'):`${targets.length} ${kind==='members'?'medlemmer/invitationer':kind==='roles'?'roller':'afsendere'}`}`:mode==='bulk'?`Redigér ${targets.length} medlemmer`:mode==='create'?kind==='members'?'Invitér kollega':kind==='roles'?'Ny arbejdsrolle':'Ny afsender':item.displayName||item.title||item.subject||item.email||'Mail uden emne';
    const formStart=`<form class="settings-form settings-grid-form" data-grid-form="${kind}" data-grid-mode="${mode}" data-grid-id="${esc(editor.id||'')}" data-revision="${d.revision??item?.revision??0}">`,save='<button class="btn" type="submit">'+(mode==='create'&&kind==='members'?'Send invitation':mode==='create'?'Opret':'Gem ændringer')+'</button>';
    let body;
    if(mode==='delete')body=`<p>${kind==='members'?'Medlemmerne fjernes fra listen og mister adgang til organisationen. Ventende invitationer annulleres. Opgaver og historik bevares; administratoren overtager opgaver uden en aktiv modtager.':kind==='roles'?'Rollerne fjernes også fra de medlemmer, som bruger dem.':'De valgte afsenderadresser fjernes fra tilladelseslisten.'}</p><ul>${targets.map(r=>`<li>${esc(r.displayName||r.title||r.email)}</li>`).join('')}</ul><button type="button" class="btn" data-grid-action="confirm-delete" data-grid-kind="${kind}">Bekræft sletning</button>`;
    else if(mode==='bulk')body=formStart+`<label>Arbejdsrolle<select name="roleId">${roleOptions(d.roleId??'__keep__',true)}</select></label><label>Synlighed i vidensgrafen<select name="graph"><option value="keep">Behold eksisterende valg</option><option value="show"${d.graph==='show'?' selected':''}>Vis i grafen</option><option value="hide"${d.graph==='hide'?' selected':''}>Skjul i grafen</option></select></label><small>Ændringerne gælder de ${targets.length} valgte medlemmer.</small>`+save+'</form>';
    else if(kind==='members'){
      const create=mode==='create';
      body=owner()?formStart+`${create?'<p>Invitationen sendes som et personligt link, som kan accepteres uden login.</p>':''}<label>Emailadresse${create?`<input type="email" name="email" value="${esc(d.email||'')}" required maxlength="254">`:`<input readonly value="${esc(item.email)}">`}</label><label>Navn<input name="name" maxlength="80" value="${esc(d.name||'')}"></label><label>Arbejdsrolle<select name="roleId">${roleOptions(d.roleId)}</select></label><label class="settings-check"><input type="checkbox" name="inGraph"${d.inGraph?' checked':''}>Vis i vidensgrafen</label>${create?'':`<p class="settings-status">${esc(item.statusText)}</p>`}`+save+'</form>':`<dl><dt>Email</dt><dd>${esc(item.email)}</dd><dt>Status</dt><dd>${esc(item.statusText)}</dd><dt>Arbejdsrolle</dt><dd>${esc(item.roleTitle)}</dd><dt>I grafen</dt><dd>${item.graphText}</dd></dl>`;
    }else if(kind==='roles')body=owner()?formStart+`<label>Rollenavn<input name="title" maxlength="80" value="${esc(d.title||'')}" required></label><label>Ansvar og mandat<textarea name="description" maxlength="2000" rows="8" required>${esc(d.description||'')}</textarea></label>`+save+'</form>':`<p class="settings-role-description">${esc(item.description)}</p>`;
    else if(kind==='senders')body=owner()?formStart+`<label>Emailadresse<input type="email" name="email" maxlength="254" value="${esc(d.email||'')}" required></label><p>Adressen må sende opgaver, når mailindgangen er aktiveret. Den får ikke konto- eller dataadgang.</p>`+save+'</form>':`<p>${esc(item.email)}</p>`;
    else body=`<dl><dt>Afsender</dt><dd>${esc(item.sender)}</dd><dt>Modtaget</dt><dd>${esc(item.time)}</dd><dt>Status</dt><dd>${esc(item.statusText)}</dd></dl>${item.reason?`<p>${esc(item.reason)}</p>`:''}${item.rejectionNoticeStatus?`<p>Afvisningsmail: ${esc(({sent:'Sendt',pending:'Afventer genforsøg',sending:'Sender',suppressed:'Ikke sendt',failed:'Afsendelse kunne ikke bekræftes'})[item.rejectionNoticeStatus]||item.rejectionNoticeStatus)}${item.rejectionNoticeReason?`<br>${esc(item.rejectionNoticeReason)}`:''}</p>`:''}${item.taskId?`<button type="button" class="btn" data-action="select-task" data-task="${esc(item.taskId)}">Åbn ${esc(item.taskId)}</button>`:''}<small>Modtagelseshistorikken er en læsevisning.</small>`;
    const deleteMember=kind==='members'&&mode==='item'&&owner()&&!item.isOwner?`<button type="button" class="btn btn-ghost" data-grid-action="delete-item" data-grid-kind="members" data-grid-id="${esc(item.id)}">Slet medlem</button>`:'';
    if(kind==='members'&&mode==='item'&&owner()&&item.isOwner)body+='<p class="settings-note">Organisationens ejer kan redigeres, men kan ikke slettes.</p>';
    box.innerHTML=`<header><h3>${esc(heading)}</h3><div class="settings-context-actions">${close}${deleteMember}</div></header>${body}<p class="settings-grid-error account-error" role="alert" hidden></p>`;
  }
  function open(kind,id,mode='item',targets=[]){if(host.busy())return;
    if(mode==='item'){
      if(!rows(kind).some(row=>row.id===id))return;
      const table=tables.get(kind);if(table&&readyTables.has(table)){table.deselectRow();table.selectRow(id);}
      selections.set(kind,[id]);toolbar(kind);
    }
    editors.set(kind,{id,mode,targets});context(kind);
  }
  function mailPatch(change){const mail=host.team().inbound;return {revision:mail.revision,enabled:mail.enabled,allowedSenders:[...mail.allowedSenders],...change};}
  function operations(kind,editor,data){const item=rows(kind).find(r=>r.id===editor.id),mode=editor.mode,revision=Number(data?.get('__revision'));
    if(kind==='members'){
      if(mode==='create')return [{path:'/members',method:'POST',data:{email:data.get('email'),name:data.get('name'),roleId:data.get('roleId')||null,inGraph:data.has('inGraph')}}];
      if(mode==='bulk'){const role=data.get('roleId'),graph=data.get('graph');if(role==='__keep__'&&graph==='keep')throw new Error('Vælg en ændring, før du gemmer.');return editor.targets.map(m=>({path:'/members/'+m.id,method:'PUT',data:{revision:m.revision,name:m.name,roleId:role==='__keep__'?m.roleId:role||null,inGraph:graph==='keep'?m.inGraph:graph==='show'}}));}
      return [{path:'/members/'+item.id,method:'PUT',data:{revision,name:data.get('name'),roleId:data.get('roleId')||null,inGraph:data.has('inGraph')}}];
    }
    if(kind==='roles')return [{path:'/roles'+(mode==='create'?'':'/'+item.id),method:mode==='create'?'POST':'PUT',data:{...(mode==='create'?{}:{revision}),title:data.get('title'),description:data.get('description')}}];
    if(kind==='senders'){const email=String(data.get('email')||'').trim().toLowerCase();if(!/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(email))throw new Error('Brug en fuld emailadresse uden jokertegn.');if(host.team().inbound.allowedSenders.includes(email)&&(mode==='create'||email!==item.email))throw new Error('Adressen findes allerede på afsenderlisten.');const list=host.team().inbound.allowedSenders.filter(e=>mode==='create'||e!==item.email);return [{path:'/inbound',method:'PUT',data:mailPatch({allowedSenders:[...new Set([...list,email])]})}];}
    throw new Error('Handlingen understøttes ikke.');
  }
  async function perform(kind,ops,message,clearKey){try{await host.perform(ops,message);if(clearKey)drafts.delete(clearKey);editors.delete(kind);selections.set(kind,[]);host.clearDirty(kind);host.redraw();}catch(e){const editor=editors.get(kind);if(editor?.mode==='delete'){editor.targets=editor.targets.filter(target=>rows(kind).some(r=>r.id===target.id&&(kind!=='members'||r.status!=='revoked')));if(!editor.targets.length)editors.delete(kind);}host.redraw();const box=document.querySelector(`[data-grid-context="${kind}"] .settings-grid-error`)||document.getElementById('settings-error');if(box){box.hidden=false;box.textContent=e.message;}}}
  async function confirmRemoval(kind,targets){const snapshot=structuredClone(targets),team=host.team(),organization=host.organizationId?.();
    const accepted=await globalThis.FinchGridUI.confirmDelete({items:snapshot.map(item=>({...item,label:item.displayName||item.title||item.email})),title:snapshot.length===1?'Slet række':`Slet ${snapshot.length} rækker`,description:kind==='members'?'Adgang og invitationer fjernes. Opgaver og historik bevares; administratoren overtager arbejde uden en aktiv modtager.':kind==='roles'?'Rollerne fjernes også fra de medlemmer, der bruger dem.':'De valgte afsenderadresser fjernes fra tilladelseslisten.'});
    if(!accepted||host.organizationId?.()!==organization||host.busy()||!owner())return;
    const ops=kind==='senders'?[{path:'/inbound',method:'PUT',data:{revision:team.inbound.revision,enabled:team.inbound.enabled,allowedSenders:team.inbound.allowedSenders.filter(email=>!snapshot.some(item=>item.email===email))}}]:snapshot.map(item=>({path:`/${kind}/${item.id}`,method:'DELETE',data:{revision:item.revision}}));
    await perform(kind,ops,'De valgte poster er slettet');
  }
  document.addEventListener('click',event=>{
    const row=event.target.closest('[data-grid-open]');if(row){open(row.dataset.gridOpen,row.dataset.gridId);return;}
    const tab=event.target.closest('[data-grid-mail-view]');if(tab){if(!host.busy()){mailView=tab.dataset.gridMailView;activate('inbound');}return;}
    const button=event.target.closest('[data-grid-action]');if(!button||!host||host.busy())return;const kind=button.dataset.gridKind,action=button.dataset.gridAction,chosen=rows(kind).filter(r=>selected(kind).includes(r.id));
    if(action==='refresh'){for(const id of drafts.keys())if(id.startsWith(kind+':'))drafts.delete(id);editors.delete(kind);host.clearDirty(kind);host.refresh();return;}if(action==='clear'){tables.get(kind)?.deselectRow();if(editors.get(kind)?.mode!=='create'){editors.delete(kind);context(kind);}return;}if(action==='close'){editors.delete(kind);context(kind);return;}
    if(!owner()||kind==='mailLog')return;
    if(action==='edit-item'){open(kind,button.dataset.gridId);return;}
    if(action==='delete-item'){const item=rows(kind).find(row=>row.id===button.dataset.gridId);if(item&&!(kind==='members'&&item.isOwner))confirmRemoval(kind,[item]);return;}
    if(action==='create'){open(kind,null,'create');return;}if(action==='edit'){if(chosen.length)open(kind,chosen[0].id,chosen.length>1?'bulk':'item',chosen);return;}
    if(action==='delete'){if(chosen.length&&!(kind==='members'&&chosen.some(m=>m.isOwner||m.status==='revoked')))confirmRemoval(kind,chosen);return;}
    if(action==='confirm-delete'){const editor=editors.get(kind);if(editor?.mode!=='delete')return;const targets=editor.targets;
      const ops=kind==='senders'?[{path:'/inbound',method:'PUT',data:mailPatch({allowedSenders:host.team().inbound.allowedSenders.filter(e=>!targets.some(t=>t.email===e))})}]:targets.map(r=>({path:`/${kind}/${r.id}`,method:'DELETE',data:{revision:r.revision}}));perform(kind,ops,'De valgte poster er fjernet');return;}
    if(action==='resend'){if(chosen.length&&chosen.every(m=>!m.isOwner&&!['active','accepted','revoked'].includes(m.status)))perform(kind,chosen.map(m=>({path:`/members/${m.id}/resend`,method:'POST',data:{revision:m.revision}})),'Invitationerne er gensendt');return;}
  });
  document.addEventListener('submit',event=>{const form=event.target.closest('[data-grid-form]');if(!form)return;event.preventDefault();if(!owner()||host.busy())return;const kind=form.dataset.gridForm,editor=editors.get(kind);if(!editor)return;try{const data=new FormData(form);data.set('__revision',form.dataset.revision);perform(kind,operations(kind,editor,data),kind==='members'&&editor.mode==='create'?'Invitationen er sendt':'Ændringerne er gemt',key(kind,editor.mode==='item'?editor.id:editor.mode));}catch(e){const notice=form.parentElement.querySelector('.settings-grid-error');notice.hidden=false;notice.textContent=e.message;}});
  function saveDraft(event){const form=event.target.closest('[data-grid-form]');if(!form||!host)return;const data=Object.fromEntries(new FormData(form));data.inGraph=!!form.querySelector('[name=inGraph]:checked');data.revision=Number(form.dataset.revision);drafts.set(key(form.dataset.gridForm,form.dataset.gridMode==='item'?form.dataset.gridId:form.dataset.gridMode),data);host.markDirty(form.dataset.gridForm);}
  document.addEventListener('input',saveDraft);document.addEventListener('change',saveDraft);
  function activate(section){if(section==='inbound'){if(!document.querySelector(`[data-grid-mail-panel="${mailView}"]`))mailView='senders';document.querySelectorAll('[data-grid-mail-panel]').forEach(panel=>panel.hidden=panel.dataset.gridMailPanel!==mailView);document.querySelectorAll('[data-grid-mail-view]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.gridMailView===mailView)));mount(mailView);}else if(['members','roles'].includes(section))mount(section);}
  function dispose(){const old=[...tables.values()];tables.clear();for(const table of old)table.destroy();}
  return {openCreate(kind){if(owner()&&!host.busy()){open(kind,null,'create');document.querySelector(`[data-grid-form="${kind}"] input`)?.focus();}},configure(options){host=options;},html,activate,dispose,reset(){dispose();selections.clear();editors.clear();drafts.clear();mailView='senders';},get dirty(){return !!drafts.size;},rows,operations};
})();
