window.FinchNotifications=(()=>{
  let host,userId=null,orgId=null,enabled=false,busy=false,polling=false,notice='',registration=null;
  let generation=0,counts=new Map(),seen=new Map(),baseTitle='finch',stopped=false;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const supported=()=>window.isSecureContext&&typeof window.Notification==='function';
  const allowed=()=>supported()&&Notification.permission==='granted';
  async function request(path,method='GET',data){
    const response=await fetch(path,{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000),
      headers:data?{'Content-Type':'application/json'}:{},...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json();if(!response.ok){const e=new Error(result.message||'Notifikationerne kunne ikke opdateres.');e.status=response.status;throw e;}return result;
  }
  function paint(){
    const box=document.getElementById('notification-settings');if(!box)return;
    let message=notice;
    if(!message&&!supported())message='Denne browser understøtter ikke systemnotifikationer. Du kan stadig se nye opgaver i Finch og antallet i fanens titel.';
    else if(!message&&Notification.permission==='denied')message='Browseren har blokeret systemnotifikationer. Tillad dem i browserens indstillinger, eller åbn Finch i din almindelige browser.';
    else if(!message&&enabled&&!allowed())message='Notifikationer er slået til på din konto. Giv også denne browser tilladelse.';
    else if(!message&&enabled)message='Slået til. Hvis browseren eller styresystemet skjuler beskederne, kan du prøve en testnotifikation.';
    else if(!message)message='Slået fra. Beskeder i Finch og antallet i fanens titel vises stadig.';
    box.innerHTML=`<h3>Notifikationer</h3><p>Få besked, når en ny opgave venter på dig. Gælder dine egne opgaver i de organisationer, hvor du slår det til.</p>
      <p class="notification-status" role="status">${esc(message)}</p><div class="settings-actions">
      ${enabled?`<button type="button" class="btn btn-ghost" data-notification="disable"${busy?' disabled':''}>Slå fra for denne organisation</button>`:''}
      ${supported()&&Notification.permission!=='denied'&&(!enabled||!allowed())?`<button type="button" class="btn" data-notification="enable"${busy||!orgId?' disabled':''}>${enabled?'Tillad i denne browser':'Slå notifikationer til'}</button>`:''}
      ${enabled&&allowed()?`<button type="button" class="btn btn-ghost" data-notification="test"${busy?' disabled':''}>Send testnotifikation</button>`:''}
      <a class="link" href="${esc(window.FinchStorage.sessionUrl)}" target="_blank" rel="noopener">Åbn Finch i en almindelig browser</a></div>
      <small>Indstillingen gemmes på din konto for denne organisation. Browserens tilladelse gælder denne browser. Hold Finch åbent; baggrundsbeskeder kan blive forsinket, hvis browseren sætter fanen på pause. Opgavens indhold vises ikke i systemnotifikationer.</small>`;
  }
  async function worker(){
    if(!('serviceWorker' in navigator))return null;
    if(registration)return registration;
    registration=await navigator.serviceWorker.register('/notification-sw.js',{scope:'/'});
    await Promise.race([navigator.serviceWorker.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Notifikationsforbindelsen tog for lang tid.')),8000))]);
    return registration;
  }
  async function display(org,ids,test=false){
    const title=test?'Finch · Testnotifikation':`${org.name} · ${ids.length===1?'Ny arbejdsopgave':`${ids.length} nye arbejdsopgaver`}`;
    const options={body:test?'Notifikationer virker i denne browser.':'Der venter arbejde på dig i Finch.',tag:`finch:${userId}:${org.id}${test?':test':''}`,
      data:{userId,orgId:org.id,taskId:ids[0]||null},silent:false};
    try{const sw=await worker();if(sw){await sw.showNotification(title,options);return;}}catch{}
    const notification=new Notification(title,options);
    notification.onclick=()=>{notification.close();window.focus();if(!test)open(options.data);};
    // A constructor succeeding is not proof that the OS actually displayed it.
  }
  function banner(org,ids){
    let box=document.getElementById('notification-banner');if(!box){box=document.createElement('aside');box.id='notification-banner';box.className='notification-banner';box.setAttribute('aria-live','polite');document.body.appendChild(box);}
    box.hidden=false;box.innerHTML=`<div><strong>${esc(org.name)}</strong><p>${ids.length===1?'En ny opgave venter på dig.':`${ids.length} nye opgaver venter på dig.`}</p></div>
      <button type="button" class="link" data-notification="open" data-org="${esc(org.id)}" data-task="${esc(ids[0])}">Åbn</button><button type="button" class="notification-dismiss" data-notification="dismiss" aria-label="Luk beskeden">×</button>`;
  }
  function title(base){if(base)baseTitle=base;const active=window.FinchStorage.organization?.id;
    if(base&&active&&host&&window.FinchStorage.ready)counts.set(active,host.state().tasks.filter(t=>window.FinchWork.mine(t)&&window.FinchWork.phase(t)==='open').length);
    const total=[...counts.values()].reduce((a,b)=>a+b,0);document.title=`${total?`(${total}) `:''}${baseTitle}`;
  }
  async function poll(){
    if(polling||stopped||!window.FinchStorage.user)return;polling=true;const turn=generation,account=window.FinchStorage.user.id;
    try{
      const summary=await request('/api/notifications');if(turn!==generation||account!==window.FinchStorage.user?.id)return;
      counts=new Map(summary.organizations.map(o=>[o.id,o.count]));
      for(const org of summary.organizations){
        const previous=seen.get(org.id);const fresh=org.waitingIds.filter(id=>previous&&!previous.has(id));seen.set(org.id,new Set(org.waitingIds));
        if(fresh.length)banner(org,fresh);
      }
      title();
      if(allowed()&&summary.organizations.some(o=>o.enabled)){
        const result=await request('/api/notifications','POST',{});if(turn!==generation||account!==window.FinchStorage.user?.id)return;
        for(const org of result.organizations)if(org.newTaskIds.length){banner(org,org.newTaskIds);try{await display(org,org.newTaskIds);}catch{notice='Systemnotifikationen kunne ikke vises. Brug beskederne i Finch, eller prøv din almindelige browser.';paint();}}
      }
    }catch(e){if(e.status===401){stopped=true;counts.clear();seen.clear();title();}/* Temporary outages retry on the next interval. */}
    finally{polling=false;}
  }
  async function accountChanged(){
    const user=window.FinchStorage.user,org=window.FinchStorage.organization;
    if(userId===user?.id&&orgId===org?.id)return;
    if(userId!==user?.id){counts.clear();seen.clear();document.getElementById('notification-banner')?.setAttribute('hidden','');}
    ++generation;userId=user?.id||null;orgId=org?.id||null;enabled=false;busy=false;notice='';stopped=!user;
    if(!user){counts.clear();seen.clear();document.getElementById('notification-banner')?.setAttribute('hidden','');title();return;}
    const turn=generation;
    if(org)try{const settings=await request(`/api/organizations/${org.id}/notifications`);if(turn!==generation)return;enabled=settings.enabled;}catch{notice='Indstillingen kunne ikke hentes. Prøv igen om lidt.';}
    paint();poll();
  }
  async function open(data){
    if(data.userId&&data.userId!==window.FinchStorage.user?.id)return;
    if(!window.FinchStorage.organizations.some(o=>o.id===data.orgId))return;
    try{if(window.FinchStorage.organization?.id!==data.orgId)await window.FinchStorage.select(data.orgId);else await window.FinchStorage.reloadCurrent();
      const task=host.state().tasks.find(t=>t.id===data.taskId);if(task&&window.FinchWork.mine(task))host.open(task.id);else host.toast('Opgaven er ikke længere i din indbakke.');
      document.getElementById('notification-banner')?.setAttribute('hidden','');title();
    }catch(e){host.toast(e.message);}
  }
  async function deepLink(){
    const url=new URL(location.href),taskId=url.searchParams.get('task');if(!taskId||!window.FinchStorage.ready)return;
    url.searchParams.delete('task');history.replaceState(null,'',url);await open({orgId:url.searchParams.get('org'),taskId});
  }
  document.addEventListener('click',async event=>{
    const button=event.target.closest('[data-notification]');if(!button)return;const action=button.dataset.notification;
    if(action==='dismiss'){document.getElementById('notification-banner').hidden=true;return;}
    if(action==='open'){await open({orgId:button.dataset.org,taskId:button.dataset.task});return;}
    if(busy||!window.FinchStorage.ready)return;busy=true;const turn=generation;notice='';
    try{
      if(action==='enable'){
        // Start the permission request directly in the click event, before network I/O.
        const permissionRequest=Notification.requestPermission();
        notice='Venter på browserens tilladelse…';paint();
        let timer;
        const permission=await Promise.race([permissionRequest,new Promise(resolve=>{timer=setTimeout(()=>resolve('unavailable'),20000);})]);clearTimeout(timer);
        if(turn!==generation)return;
        if(permission==='unavailable'){notice='Browseren svarede ikke på tilladelsen. Brug beskederne i Finch, eller åbn Finch i din almindelige browser og slå notifikationer til dér.';return;}
        if(permission!=='granted'){notice='Browseren gav ikke tilladelse. Du kan stadig bruge beskeder i Finch.';return;}
        await request(`/api/organizations/${orgId}/notifications`,'PUT',{enabled:true});if(turn!==generation)return;enabled=true;notice='';poll();
      }else if(action==='disable'){
        await request(`/api/organizations/${orgId}/notifications`,'PUT',{enabled:false});if(turn!==generation)return;enabled=false;
        try{const sw=await navigator.serviceWorker?.getRegistration('/');for(const n of await sw?.getNotifications()||[])if(n.data?.userId===userId&&n.data?.orgId===orgId)n.close();}catch{}
      }else if(action==='test'){await display(window.FinchStorage.organization,[],true);notice='Testen er sendt til browseren. Hvis du ikke ser beskeden, kontrollér browserens og styresystemets notifikationsindstillinger.';}
    }catch(e){if(turn===generation)notice=e.message||'Browseren kunne ikke vise notifikationen.';}
    finally{if(turn===generation){busy=false;paint();}}
  });
  document.addEventListener('finch-account-change',()=>{accountChanged();deepLink();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){poll();paint();}});
  window.addEventListener('focus',()=>{poll();paint();});
  navigator.serviceWorker?.addEventListener('message',event=>{if(event.data?.type==='finch-notification-open')open(event.data);});
  setInterval(poll,15000);
  return {configure(options){host=options;},paint,title};
})();
