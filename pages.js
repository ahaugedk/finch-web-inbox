// Organisation-owned pages. Only a sandboxed frame executes authored JavaScript.
window.FinchPages = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text = (s, n) => typeof s === 'string' ? s.trim().slice(0, n) : '';
  const ID = /^[a-f0-9-]{36}$/;
  const icons = {
    chart: '<svg viewBox="0 0 24 24"><path d="M4 4v16h16M8 16v-5m5 5V7m5 9v-6"/></svg>',
    truck: '<svg viewBox="0 0 24 24"><path d="M3 6h11v11H3zM14 10h4l3 4v3h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/></svg>',
    calculator: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="1"/><path d="M8 7h8M8 11h1m3 0h1m3 0h1M8 15h1m3 0h1m3 0h1M8 18h1m3 0h1m3 0h1"/></svg>',
    calendar: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="1"/><path d="M7 3v4m10-4v4M3 10h18M7 14h3m4 0h3M7 17h3"/></svg>',
    page: '<svg viewBox="0 0 24 24"><path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6"/></svg>',
  };
  const plus = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>';
  // Icons are inserted in the parent, so only inert SVG geometry is accepted.
  function cleanIcon(input) {
    if (icons[input]) return icons[input].replace('<svg ', '<svg aria-hidden="true" ');
    if (typeof input !== 'string' || input.length > 4000) throw new Error('Vælg chart, truck, calculator, calendar, page eller et SVG-ikon på højst 4000 tegn.');
    const parsed = new DOMParser().parseFromString(input, 'image/svg+xml');
    const root = parsed.documentElement;
    const tags = new Set(['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon']);
    const attrs = new Set(['aria-hidden','viewBox','d','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','width','height','points','transform','fill','stroke','stroke-width','stroke-linecap','stroke-linejoin']);
    if (root.localName !== 'svg' || parsed.querySelector('parsererror') || root.querySelectorAll('*').length > 60) throw new Error('Ikonet skal være gyldigt SVG med enkle former.');
    for (const node of [root, ...root.querySelectorAll('*')]) {
      if (!tags.has(node.localName)) throw new Error('Ikonet må kun indeholde SVG-former.');
      for (const attr of [...node.attributes]) {
        if (attr.name === 'xmlns') { node.removeAttribute(attr.name); continue; }
        if (!attrs.has(attr.name) || /url\s*\(|[<>]|javascript:|data:/i.test(attr.value)) throw new Error('Ikonet indeholder en attribut, der ikke understøttes.');
        if (['fill','stroke'].includes(attr.name) && !['none','currentColor'].includes(attr.value)) throw new Error('Ikonet skal bruge currentColor eller none.');
      }
    }
    root.setAttribute('aria-hidden', 'true'); root.setAttribute('viewBox', root.getAttribute('viewBox') || '0 0 24 24');
    return new XMLSerializer().serializeToString(root);
  }
  let host; let mounted = ''; let frameContext = null; let catalog = []; let fileCatalog=[]; let catalogOrg = null; let generation = 0;let runtimeContext=null;const pendingKitSaves=new Map();
  const pages = () => host.state().pages ||= [];
  const find = id => pages().find(p => p.id === id);
  const summarize = p => ({ page_id:p.id, title:p.title, description:p.description, status:p.status, table_ids:p.tableIds, file_ids:p.fileIds||[],writable_table_ids:p.writableTableIds||[],agent_action:p.agentAction||null,runtime:'local', icon:p.icon, revision:p.revision, proposal_task_id:p.proposalTaskId });
  const string = (maxLength, description) => ({type:'string',maxLength,description});
  const tableSchema = {type:'array',maxItems:20,items:{type:'string',maxLength:36},description:'Organisationens datatabeller, som siden må læse. Id’er fra list_data.'};
  const fileSchema={type:'array',maxItems:50,items:{type:'string',maxLength:36},description:'Filer fra organisationens Data, som siden må vise. Filer refereret fra file-kolonner i table_ids er også tilgængelige.'};
  const writeSchema={...tableSchema,description:'Valgfrit: delmængde af table_ids, hvis rækker siden må oprette, rette og fjerne. Standard er læseadgang.'};
  const agentActionSchema={anyOf:[{type:'null'},{type:'object',properties:{name:string(80,'Navn på det asynkrone agentarbejde.'),label:string(80,'Synlig knaptekst, fx Bed agenten analysere.')},required:['name','label']}]};
  const definitions = [
    {name:'list_pages',description:'Opdag organisationens egne sider, ønsker og forslag. Find page_id før build_page eller get_page.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
    {name:'get_page',description:'Læs sidens ønske, kilder, gemte felter og hele UI- eller WebComponent-koden. Byg videre på eksisterende sider uden at glemme brugerens arbejde.',inputSchema:{type:'object',properties:{page_id:string(36,'Id fra list_pages.')},required:['page_id']},annotations:{readOnlyHint:true}},
    {name:'propose_page',description:'Foreslå en relevant ny side ud fra organisationens viden og rå data. Opretter en arbejdsopgave med Godkend/Afvis. Forslaget kan ikke bygges, før brugeren godkender det på siden. Vælg et meningsfuldt ikon; brug et eget SVG, hvis intet indbygget passer.',inputSchema:{type:'object',properties:{title:string(80,'Sidens navn.'),description:string(2000,'Hvad siden skal hjælpe brugeren med, og hvorfor den er relevant.'),table_ids:tableSchema,file_ids:fileSchema,writable_table_ids:writeSchema,agent_action:agentActionSchema,icon:string(4000,'chart, truck, calculator, calendar, page eller et custom SVG med viewBox, enkle former og currentColor.')},required:['title','description','icon']}},
    {name:'build_page',description:'Byg eller opdatér en side, som brugeren har ønsket eller godkendt. Angiv revision fra get_page. Brug ALLE de samme ui-komponenter som arbejdsopgaver, ELLER en fri WebComponent. Koden kører isoleret. Dashboardbiblioteker: Apache ECharts og Tabulator er inkluderet. Brug chart/data_grid/metric i ui eller <finch-chart>, <finch-data-grid>, <finch-metric> med element.config.binding. finch.echarts, finch.Tabulator og finch.tabulatorCss er til fri brug med finch.queryTable/getTable. ECharts animerer data- og visningsskift; bindings er scoped til table_ids. Brug altid data_grid/finch-data-grid til tabulær CRUD, så siderne følger den fælles UI. Kontrollerne får automatisk +, redigér/slet på hver række og batch-sletning, når tabellen er i writable_table_ids; ellers er den en tydelig læsevisning. WebComponent har finch.html, finch.css, finch.ready, finch.root, finch.values, await finch.queryTable(query), await finch.getTable(tableId) og lokal finch.emit(name,values)/finch.on(name,handler). Sider kører selvstændigt uden en aktiv agent. Gem personlige sideværdier med await finch.saveValues(values). Læs/ændr rækker med finch.getRow, insertRows, updateRow og deleteRow; ændringer kræver writable_table_ids og aktuelle rækkeversioner. Kun et eksplicit brugerklik må kalde await finch.requestAgent(name,values), som lægger en opgave under Agent og straks returnerer case_id. Brug WebComponent til beregninger og interaktion; ui er lokal formular/visning. Filer: await finch.getFile(fileId) giver metadata, await finch.readFile(fileId) giver {file,preview,bytes,url}, await finch.getFileUrl(fileId) giver en lokal blob-URL til img/audio/video. PDF vises med await finch.renderPdfPage(fileId,{page_number:1,width:900}), som giver en billed-URL og sidetal. Brug finch.downloadFile(fileId) fra et brugerklik og finch.releaseFile(fileId) til oprydning. bytes er Uint8Array; tekst læses med TextDecoder. SVG vises som en renset forhåndsvisning. HTML og Office-filer hentes som originaler; eksekvér aldrig rå filindhold. Ingen direkte netværksadgang; table_ids og file_ids er sidens datakilder; file-kolonner i de valgte tabeller giver også adgang til deres refererede filer. Brug image/file-komponenter i ui eller fil-API i en WebComponent. Blob-URL’er må ikke gemmes; gem file_id og hent igen. Definér gerne customElements.define(tag_name, class extends HTMLElement {...}); ellers monterer Finch html/css i en WebComponent, og javascript kan bruge finch.ready.then(...). Håndtér tomme data og fejl; brug virkelige data, aldrig fiktive nøgletal. Vælg et passende indbygget ikon eller lav custom SVG.',inputSchema:{type:'object',properties:{page_id:string(36,'Et requested/approved/ready page_id.'),revision:{type:'integer',minimum:0},title:string(80,'Sidens navn.'),icon:string(4000,'chart, truck, calculator, calendar, page eller eget SVG.'),table_ids:tableSchema,file_ids:fileSchema,writable_table_ids:writeSchema,agent_action:agentActionSchema,ui:{type:'array',maxItems:30,items:{type:'object'},description:'Samme komponenttræ som post_task. Felter gemmes som brugerens egne sideværdier. Ingen agentkobling som standard. Beregninger og egen forretningslogik bygges i en WebComponent. agent_action giver en valgfri eksplicit knap til asynkront agentarbejde.'},component:{type:'object',properties:{tag_name:string(60,'WebComponentens navn med bindestreg, fx truck-configurator.'),html:string(60000,'HTML-skabelon; tilgængelig som finch.html.'),css:string(30000,'CSS til komponenten; tilgængelig som finch.css.'),javascript:string(80000,'Fri JavaScript og/eller en customElements.define-definition. Brug finch API til data og hændelser.')},required:['tag_name','html','css','javascript']}},required:['page_id','revision','title','icon','table_ids']}},
    {name:'archive_page',description:'Fjern en side fra ikonlisten uden at slette det gemte arbejde. Kræver brugerens ønske. Kan gendannes med restore_page.',inputSchema:{type:'object',properties:{page_id:string(36,'Sidens id.'),revision:{type:'integer',minimum:0}},required:['page_id','revision']}},
    {name:'restore_page',description:'Gendan en arkiveret side og dens ikon.',inputSchema:{type:'object',properties:{page_id:string(36,'Sidens id.'),revision:{type:'integer',minimum:0}},required:['page_id','revision']}},
  ];
  async function verifyTables(ids) {
    if (!Array.isArray(ids) || ids.length > 20 || ids.some(id => typeof id !== 'string' || !ID.test(id))) throw new Error('table_ids skal være højst 20 gyldige tabel-id’er.');
    const org = window.FinchStorage.organization.id;
    const tables=[];
    for (const id of new Set(ids)) tables.push((await window.FinchData.tool('get_table',{table_id:id})).table);
    if (org !== window.FinchStorage.organization?.id) throw new Error('Organisationen er skiftet.');
    for(const table of tables) if(table && !catalog.some(t=>t.id===table.id))catalog.push(table);
    return [...new Set(ids)];
  }
  async function verifyFiles(ids){
    if(!Array.isArray(ids)||ids.length>50||ids.some(id=>typeof id!=='string'||!ID.test(id)))throw new Error('file_ids skal være højst 50 gyldige fil-id’er.');
    const org=window.FinchStorage.organization.id;
    for(const id of new Set(ids)){const result=await window.FinchData.tool('get_file',{file_id:id});if(!result.file)throw new Error('Filen findes ikke i organisationen.');if(!fileCatalog.some(f=>f.id===id))fileCatalog.push(result.file);}
    if(org!==window.FinchStorage.organization?.id)throw new Error('Organisationen er skiftet.');return [...new Set(ids)];
  }
  function verifyWrites(ids,tables){if(!Array.isArray(ids)||ids.length>20||ids.some(id=>!tables.includes(id)))throw new Error('writable_table_ids skal være en delmængde af sidens valgte tabeller.');}
  function cleanAgentAction(value){if(!value)return null;const name=text(value.name,80),label=text(value.label,80);if(!name||!label)throw new Error('Agentknappen skal have navn og synlig knaptekst.');return {name,label};}
  async function runtimeRequest(org,pageId,action,method='GET',data){
    const response=await fetch(`/api/organizations/${org}/pages/${pageId}/${action}`,{method,credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000),headers:{...(data?{'Content-Type':'application/json'}:{}),...(window.FinchStorage.user?.id?{'X-Finch-User':window.FinchStorage.user.id}:{})},...(data?{body:JSON.stringify(data)}:{})});
    const result=await response.json();if(!response.ok){const error=new Error(result.message||'Siden kunne ikke gemme.');error.status=response.status;throw error;}return action==='data'?{status:'ok',...result}:result;
  }
  async function saveKit(ctx){
    if(ctx.userId!==window.FinchStorage.user?.id)throw new Error('Dit login er ændret. Sideværdierne blev ikke gemt.');
    if(ctx.saving){await ctx.saving;if(ctx.saved!==ctx.changed)return saveKit(ctx);return;}
    if(ctx.saved===ctx.changed)return;
    const count=ctx.changed,values=structuredClone(ctx.values),status=document.getElementById('custom-page-save-status');if(status)status.textContent='Gemmer…';
    ctx.saving=(async()=>{const result=await runtimeRequest(ctx.org,ctx.pageId,'state','PUT',{values,revision:ctx.valueRevision,page_revision:ctx.revision});ctx.valueRevision=result.revision;ctx.saved=count;if(runtimeContext===ctx&&status)status.textContent='Gemt';})().finally(()=>ctx.saving=null);
    await ctx.saving;if(ctx.saved!==ctx.changed)return saveKit(ctx);
  }
  function retireKit(){const ctx=runtimeContext;if(!ctx)return;clearTimeout(ctx.timer);runtimeContext=null;if(ctx.saved===ctx.changed)return;const key=`${ctx.org}:${ctx.pageId}:${ctx.userId}`,save=saveKit(ctx);pendingKitSaves.set(key,save);save.catch(e=>host.toast(e.message)).finally(()=>{if(pendingKitSaves.get(key)===save)pendingKitSaves.delete(key);});}
  function newPage(input, status, ids, icon, fileIds=[]) {
    if (pages().length >= 30) throw new Error('Der kan højst være 30 sider og forslag i organisationen.');
    const writableTableIds=input.writable_table_ids||[];verifyWrites(writableTableIds,ids);
    const p = {id:crypto.randomUUID(),title:text(input.title,80),description:text(input.description,2000),tableIds:ids,fileIds,writableTableIds,agentAction:cleanAgentAction(input.agent_action),icon,status,revision:0,createdAt:Date.now(),values:{}};
    if (!p.title || !p.description) throw new Error('Navn og beskrivelse skal udfyldes.');
    pages().push(p); return p;
  }
  async function tool(name, input) {
    if (name === 'list_pages') return {status:'ok',pages:pages().map(summarize)};
    if (name === 'get_page') { const p=find(input.page_id); if (!p) throw new Error('Siden findes ikke i denne organisation.'); return {status:'ok',page:{...summarize(p),ui:p.ui,component:p.component,values:p.values},component_catalog:window.ORDERLY.COMPONENTS}; }
    if (name === 'propose_page') {
      const icon=cleanIcon(input.icon); const ids=await verifyTables(input.table_ids || []);const fileIds=await verifyFiles(input.file_ids||[]); const p=newPage(input,'proposed',ids,icon,fileIds);
      const task=host.addTask({kind:'task',from:host.state().agent || 'Agenten',title:`Ny side: ${p.title}`.slice(0,80),tag:'Sideforslag',preview:p.description.slice(0,140),intro:p.description,pageProposalId:p.id,
        ui:[{type:'text',text:`Datakilder: ${[...ids.map(id=>catalog.find(t=>t.id===id)?.name||id),...fileIds.map(id=>fileCatalog.find(f=>f.id===id)?.name||id)].join(', ')||'Ingen valgte tabeller eller filer.'}${p.writableTableIds.length?' · Siden kan ændre rækker i de angivne skrivetabeller.':''}`}],
        actions:[{value:'approve-page',label:'Godkend siden',primary:true},{value:'reject-page',label:'Afvis'}],submit:'Godkend siden'});
      p.proposalTaskId=task.id; host.save(); host.render(); return {status:'ok',page_id:p.id,task_id:task.id,guidance_for_agent:'Vent på brugerens godkendelse med wait_for_user. Byg ikke et proposed-forslag.'};
    }
    const p=find(input.page_id); if (!p) throw new Error('Siden findes ikke i denne organisation.');
    if (input.revision !== p.revision) throw new Error('Siden er ændret. Hent get_page igen.');
    if (name === 'archive_page' || name === 'restore_page') {
      if (name==='restore_page' && p.status!=='archived') throw new Error('Siden er ikke arkiveret.');
      if (name==='archive_page') {p.previousStatus=p.status;p.status='archived';} else p.status=p.previousStatus || 'ready';
      p.revision++;host.save();host.render();return {status:'ok',page:summarize(p)};
    }
    if (name !== 'build_page') throw new Error('Ukendt sidetool.');
    if (!['requested','approved','ready'].includes(p.status)) throw new Error('Brugeren skal først ønske eller godkende siden.');
    const title=text(input.title,80); if (!title) throw new Error('Siden skal have et navn.');
    const icon=cleanIcon(input.icon); const ids=await verifyTables(input.table_ids);const fileIds=await verifyFiles(input.file_ids??p.fileIds??[]);const writableTableIds=input.writable_table_ids??(p.writableTableIds||[]).filter(id=>ids.includes(id));verifyWrites(writableTableIds,ids);const agentAction=input.agent_action===undefined?p.agentAction||null:cleanAgentAction(input.agent_action);
    if(find(p.id)!==p || p.revision!==input.revision)throw new Error('Siden er ændret. Hent get_page igen.');
    if (!!input.component === Array.isArray(input.ui)) throw new Error('Angiv enten component eller ui.');
    let component=null, ui=null, warnings=[];
    if (input.component) {
      const c=input.component;
      if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(c.tag_name || '') || c.tag_name.length>60) throw new Error('tag_name skal være et gyldigt WebComponent-navn med bindestreg.');
      for (const [key,max] of [['html',60000],['css',30000],['javascript',80000]]) if (typeof c[key]!=='string' || c[key].length>max) throw new Error(`Ugyldigt eller for stort component.${key}.`);
      component={tag_name:c.tag_name,html:c.html,css:c.css,javascript:c.javascript};
    } else { const cleaned=host.cleanUi(input.ui);ui=cleaned.nodes;warnings=cleaned.warnings;if (!ui.length) throw new Error('Siden skal have mindst én gyldig UI-komponent.'); }
    const checkBindings=nodes=>{for(const node of nodes||[]){if(['chart','data_grid','metric'].includes(node.type)&&(!node.binding?.table_id||!ids.includes(node.binding.table_id)))throw new Error('Datakontroller skal binde til en af sidens valgte tabeller.');if(node.children)checkBindings(node.children);}};if(ui)checkBindings(ui);
    const approval=host.state().tasks.find(t=>t.id===p.proposalTaskId);if(approval?.response)approval.agentWorkStatus='done';
    Object.assign(p,{title,icon,tableIds:ids,fileIds,writableTableIds,agentAction,ui,component,status:'ready',revision:p.revision+1,updatedAt:Date.now()});
    host.save(); await window.FinchStorage.flush(); host.render(); return {status:'ok',page:summarize(p),warnings,guidance_for_agent:'Siden er gemt i baggrunden; brugerens visning er bevaret. Test data og handlinger i et separat, isoleret testmiljø, og ret fejl med build_page. Siden har sit eget ikon i venstre liste.'};
  }
  function rail() {
    return pages().filter(p=>p.status==='ready').map(p=>{let icon;try{icon=cleanIcon(p.icon);}catch{icon=cleanIcon('page');}return `<button data-action="open-page" data-page="${p.id}" data-label="${esc(p.title)}" title="${esc(p.title)}" aria-label="${esc(p.title)}"${host.state().view==='pages'&&host.state().pageId===p.id?' class="is-current" aria-current="page"':''}>${icon}</button>`;}).join('');
  }
  function newPageButton() {
    return `<button data-action="new-page" data-label="Ny side" title="Ny side" aria-label="Ny side"${host.state().view==='pages' && !host.state().pageId ? ' class="is-current"' : ''}>${plus}</button>`;
  }
  function proposalAnswer(task, action) {
    const p=find(task.pageProposalId);if (!p || p.status!=='proposed') return;
    p.status=action==='approve-page'?'approved':'rejected';task.agentWorkStatus=p.status==='approved'?'working':'done';p.revision++;host.save();
    host.signal(p.status==='approved'?'page_approved':'page_rejected',{page_id:p.id,title:p.title,description:p.description,table_ids:p.tableIds,file_ids:p.fileIds||[]});
  }
  function reset() { if(panel())window.FinchFileMedia?.clear(panel());retireKit();generation++;mounted='';frameContext=null;catalog=[];fileCatalog=[];catalogOrg=null; }
  async function loadCatalog() {
    const org=window.FinchStorage.organization?.id;if (!org || catalogOrg===org) return;
    const turn=generation;const result=await window.FinchData.tool('list_data',{});
    if (turn!==generation || org!==window.FinchStorage.organization?.id) return;
    catalog=result.tables;fileCatalog=result.files||[];catalogOrg=org;
  }
  function panel() { return document.getElementById('pages-view'); }
  function showError(message) { const box=document.getElementById('page-error');if (box) {box.textContent=message;box.hidden=false;} }
  async function render() {
    const box=panel(); if (!box || host.state().view!=='pages') {retireKit();frameContext=null;mounted='';if (box){window.FinchFileMedia?.clear(box);box.replaceChildren();}return;}
    const p=find(host.state().pageId);const org=window.FinchStorage.organization?.id;
    const key=`${org}:${p?.id || 'new'}:${p?.revision ?? 0}:${host.state().branding?.revision || 0}`;
    if (mounted===key) return;
    window.FinchFileMedia?.clear(box);retireKit();frameContext=null;mounted=key;
    if (!p) {
      const draft=host.state().pageDraft || {};
      box.innerHTML=`<div class="page-request"><span class="page-overline">Din arbejdsplads</span><h2>Hvilken side har du brug for?</h2><p>Beskriv, hvad du vil kunne se eller gøre. Din agent bygger siden ud fra dit ønske og organisationens data.</p>
        <form id="page-request-form"><label>Sidens navn<input name="title" maxlength="80" required value="${esc(draft.title)}" placeholder="Fx Lastbilkonfigurator"></label>
        <label>Dit ønske<textarea name="description" rows="5" maxlength="2000" required placeholder="Hvilke data skal siden bruge? Hvad skal du kunne sammenligne, beregne eller konfigurere?">${esc(draft.description)}</textarea></label>
        <fieldset><legend>Datatabeller</legend><div id="page-table-options">Henter tabeller…</div></fieldset><fieldset><legend>Filer og dokumenter</legend><div id="page-file-options">Henter filer…</div></fieldset><p id="page-error" class="account-error" role="alert" hidden></p><button class="btn" type="submit">Send til agenten</button></form>
        <section class="page-requests"><h3>Dine sider</h3>${pages().filter(p=>!['rejected','archived'].includes(p.status)).map(p=>`<button type="button" class="item" data-page-open="${p.id}"><strong class="subject">${esc(p.title)}</strong><span class="item-meta">${({ready:'Klar',requested:'Sendt til agenten',proposed:'Afventer godkendelse',approved:'Godkendt · klar til agenten'})[p.status]}</span></button>`).join('') || '<p>Du har ikke oprettet nogen sider endnu.</p>'}</section></div>`;
      try {await loadCatalog();if (mounted!==key) return; const options=document.getElementById('page-table-options');if(options) options.innerHTML=catalog.length?catalog.map(t=>`<div class="page-table-source"><label class="page-table-choice"><input type="checkbox" name="table_id" value="${t.id}"${draft.tableIds?.includes(t.id)?' checked':''}><span>${esc(t.name)}<small>${esc(t.description || '')}</small></span></label><label class="page-table-write"><input type="checkbox" name="writable_table_id" value="${t.id}"${draft.writableTableIds?.includes(t.id)?' checked':''}${draft.tableIds?.includes(t.id)?'':' disabled'}>Tillad ændring af rækker</label></div>`).join(''):'<p>Ingen tabeller endnu. Agenten kan oprette dem under Data.</p>';}
      catch(e){showError(e.message);const options=document.getElementById('page-table-options');if(options) options.textContent='Datakilderne kunne ikke hentes.';catalogOrg=null;}
      const files=document.getElementById('page-file-options');if(files)files.innerHTML=fileCatalog.length?fileCatalog.map(f=>`<label class="page-table-choice"><input type="checkbox" name="file_id" value="${f.id}"${draft.fileIds?.includes(f.id)?' checked':''}><span>${esc(f.name)}<small>${esc(f.description||f.content_type)}</small></span></label>`).join(''):'<p>Ingen filer endnu. Upload billeder og dokumenter under Data.</p>';
      return;
    }
    box.innerHTML=`<header class="custom-page-header"><div><h2>${esc(p.title)}</h2><p>${esc(p.description)}</p></div><button class="link" data-page-edit="${p.id}">Bed om ændringer</button></header><p id="page-error" class="account-error" role="alert" hidden></p><div id="custom-page-body"></div>`;
    const body=document.getElementById('custom-page-body');
    if (p.status!=='ready') {body.innerHTML=`<div class="page-pending"><h3>${p.status==='proposed'?'Afventer din godkendelse':'Dit ønske er sendt til agenten'}</h3><p>${p.status==='proposed'?'Åbn forslaget i indbakken for at godkende siden.':'Fortsæt samtalen med din agent. Siden dukker op her, når den er bygget.'}</p><button class="link" data-action="copy"><span>Kopiér prompt</span></button>${p.proposalTaskId?`<button class="btn" data-action="select-task" data-task="${p.proposalTaskId}">Åbn forslaget</button>`:''}</div>`;return;}
    if (p.component) {
      await window.FinchStorage.flush();if(mounted!==key || org!==window.FinchStorage.organization?.id) return;
      const frame=document.createElement('iframe');const token=crypto.randomUUID();
      frame.title=p.title;frame.setAttribute('sandbox','allow-scripts');frame.referrerPolicy='no-referrer';frame.className='custom-page-frame';
      frameContext={frame,org,pageId:p.id,token,tableIds:[...p.tableIds],revision:p.revision};
      frame.src=`/api/organizations/${org}/pages/${p.id}/render?token=${token}&v=${p.revision}`;body.append(frame);
    } else {
      const userId=window.FinchStorage.user?.id;await pendingKitSaves.get(`${org}:${p.id}:${userId}`)?.catch(()=>{});
      const runtime=await runtimeRequest(org,p.id,'state');if(mounted!==key||org!==window.FinchStorage.organization?.id)return;
      runtimeContext={org,userId,pageId:p.id,revision:p.revision,valueRevision:runtime.revision,values:runtime.values,changed:0,saved:0,saving:null,timer:null};
      const markup=host.renderUi(p.ui,p,runtime.values),inputs=/\bdata-field=/.test(markup);
      body.innerHTML=`<form id="custom-page-form" class="custom-page-components" data-page="${p.id}">${markup}<p id="custom-page-validation" class="account-error" hidden>Udfyld de obligatoriske felter.</p>${inputs?'<button type="submit" class="btn">Gem</button><small id="custom-page-save-status" role="status"></small>':''}${p.agentAction?`<button type="button" class="btn btn-ghost" data-page-agent="${p.id}">${esc(p.agentAction.label)}</button>`:''}</form>`;
      const active=()=>window.FinchStorage.organization?.id===org&&window.FinchStorage.user?.id===userId&&mounted===key&&host.state().view==='pages';
      const pageData=(operation,input)=>{if(!active())throw new Error('Siden er skiftet.');return runtimeRequest(org,p.id,'data','POST',{operation,input,page_revision:p.revision});};
      window.FinchControlLibrary.mount(body,{canWriteTable:tableId=>(p.writableTableIds||[]).includes(tableId),getRow:(tableId,rowId)=>pageData('get_row',{table_id:tableId,row_id:rowId}),insertRows:(tableId,rows,options={})=>pageData('insert_rows',{table_id:tableId,rows,request_id:options.request_id}),updateRow:(tableId,rowId,values,revision,source_url)=>pageData('update_row',{table_id:tableId,row_id:rowId,values,revision,source_url}),deleteRow:(tableId,rowId,revision)=>pageData('delete_row',{table_id:tableId,row_id:rowId,revision}),listFiles:async()=>{const results=await Promise.all((p.fileIds||[]).map(fileId=>window.FinchFileMedia.load(org,p.id,fileId,false).catch(()=>null)));return results.filter(Boolean).map(result=>result.file||result);},getTable:tableId=>{if(!active())throw new Error('Siden er skiftet.');return runtimeRequest(org,p.id,'data','POST',{operation:'get_table',input:{table_id:tableId},page_revision:p.revision});},queryTable:input=>{if(!active())throw new Error('Siden er skiftet.');return runtimeRequest(org,p.id,'data','POST',{operation:'query_table',input,page_revision:p.revision});}});
      window.FinchFileMedia.render(box,(id,content)=>window.FinchFileMedia.load(org,p.id,id,content),()=>window.FinchStorage.organization?.id===org&&mounted===key&&host.state().view==='pages').catch(()=>{});
    }
  }
  const activeContext = ctx => frameContext===ctx && ctx.frame.isConnected && host.state().view==='pages' && host.state().pageId===ctx.pageId && window.FinchStorage.ready && window.FinchStorage.organization?.id===ctx.org;
  window.addEventListener('message',async event=>{
    const ctx=frameContext;const msg=event.data;
    if(!ctx || event.source!==ctx.frame.contentWindow || msg?.channel!=='finch-page' || msg.token!==ctx.token || !activeContext(ctx)) return;
    try {
      let result;
      if(msg.method==='report_error') {showError(`Siden har en fejl: ${text(msg.input?.message,300)}. Bed agenten om at rette den.`);return;}
      if(msg.method==='save_values'){
        result=await runtimeRequest(ctx.org,ctx.pageId,'state','PUT',{values:msg.input?.values,revision:msg.input?.revision,page_revision:ctx.revision});
      }else if(msg.method==='request_agent'){
        if(navigator.userActivation&&!navigator.userActivation.isActive)throw new Error('Start agentarbejde med et brugerklik.');
        await window.FinchStorage.flush();result=await runtimeRequest(ctx.org,ctx.pageId,'agent-requests','POST',{...msg.input,page_revision:ctx.revision});
        if(activeContext(ctx))await window.FinchStorage.reloadCurrent();
      } else if(['get_file','read_file','download_file','render_pdf'].includes(msg.method)){
        if(msg.method==='download_file'&&navigator.userActivation&&!navigator.userActivation.isActive)throw new Error('Klik på en knap for at hente filen.');
        result=await window.FinchFileMedia.load(ctx.org,ctx.pageId,msg.input?.file_id,['read_file','render_pdf'].includes(msg.method));
        if(msg.method==='render_pdf'){if(result.preview.kind!=='pdf')throw new Error('Filen er ikke en PDF.');result={file:result.file,...await window.FinchFileMedia.pdfPage(result.bytes,msg.input)};}
        if(msg.method==='download_file'&&activeContext(ctx)){const link=document.createElement('a');link.href=result.file.download_url;link.download=result.file.name;document.body.appendChild(link);link.click();link.remove();result={status:'ok'};}
      } else {
        if(!['query_table','get_table','get_row','insert_rows','update_row','delete_row'].includes(msg.method) || !ctx.tableIds.includes(msg.input?.table_id)) throw new Error('Siden kan kun læse sine valgte datatabeller.');
        result=await runtimeRequest(ctx.org,ctx.pageId,'data','POST',{operation:msg.method,input:msg.input,page_revision:ctx.revision});
      }
      if(activeContext(ctx)) ctx.frame.contentWindow.postMessage({channel:'finch-page-result',token:ctx.token,id:msg.id,result},'*',result?.bytes?[result.bytes,...(result.preview_bytes?[result.preview_bytes]:[])]:[]);
    }catch(e){if(activeContext(ctx)) ctx.frame.contentWindow.postMessage({channel:'finch-page-result',token:ctx.token,id:msg.id,error:e.message,status:e.status},'*');}
  });
  document.addEventListener('input',event=>{
    const form=event.target.closest('#page-request-form');if(form){const tableInput=event.target.closest('input[name=table_id]');if(tableInput){const write=tableInput.closest('.page-table-source')?.querySelector('input[name=writable_table_id]');if(write){write.disabled=!tableInput.checked;if(!tableInput.checked)write.checked=false;}}const data=new FormData(form);host.state().pageDraft={title:data.get('title'),description:data.get('description'),tableIds:data.getAll('table_id'),fileIds:data.getAll('file_id'),writableTableIds:data.getAll('writable_table_id')};host.save();}
    const custom=event.target.closest('#custom-page-form');if(custom){
      if(event.target.type==='range'){const out=event.target.parentElement.querySelector('output');const unit=out.textContent.split(' ').slice(1).join(' ');out.textContent=`${event.target.value}${unit?' '+unit:''}`;}
      event.target.closest('[data-field]')?.classList.remove('is-missing');
      const ctx=runtimeContext;if(ctx&&ctx.pageId===custom.dataset.page){ctx.values=host.collect(custom);ctx.changed++;clearTimeout(ctx.timer);ctx.timer=setTimeout(()=>saveKit(ctx).catch(e=>showError(e.message)),400);}}
  });
  document.addEventListener('submit',async event=>{
    const form=event.target.closest('#page-request-form, #custom-page-form');if(!form)return;event.preventDefault();
    const org=window.FinchStorage.organization?.id;
    const submit=form.querySelector('[type=submit]');submit.disabled=true;
    try {
      if(!window.FinchStorage.ready) throw new Error('Log ind, og vælg en organisation først.');
      if(form.id==='page-request-form') {
        const data=new FormData(form);const ids=await verifyTables(data.getAll('table_id'));const fileIds=await verifyFiles(data.getAll('file_id'));if(org!==window.FinchStorage.organization?.id)return;
        const p=newPage({title:data.get('title'),description:data.get('description'),writable_table_ids:data.getAll('writable_table_id')},'requested',ids,cleanIcon('page'),fileIds);
        host.state().pageDraft=null;host.save();host.open(p.id);host.signal('page_requested',{page_id:p.id,title:p.title,description:p.description,table_ids:p.tableIds,file_ids:p.fileIds||[]});
      } else {
        const p=find(form.dataset.page);const values=host.collect(form);if(host.missingRequired(form,values)){document.getElementById('custom-page-validation').hidden=false;return;}
        const ctx=runtimeContext;if(!ctx||ctx.pageId!==p.id)throw new Error('Siden er skiftet.');ctx.values=values;ctx.changed++;clearTimeout(ctx.timer);await saveKit(ctx);host.toast('Dine sideværdier er gemt');
      }
      await window.FinchStorage.flush();
    }catch(e){showError(e.message);}finally{if(submit.isConnected)submit.disabled=false;}
  });
  document.addEventListener('click',event=>{
    const agent=event.target.closest('[data-page-agent]');if(agent){event.preventDefault();const p=find(agent.dataset.pageAgent),ctx=runtimeContext;if(!p?.agentAction||!ctx||agent.disabled)return;agent.disabled=true;const requestId=agent.dataset.requestId||crypto.randomUUID();agent.dataset.requestId=requestId;Promise.resolve().then(async()=>{await saveKit(ctx);await window.FinchStorage.flush();const result=await runtimeRequest(ctx.org,p.id,'agent-requests','POST',{name:p.agentAction.name,values:ctx.values,request_id:requestId,page_revision:p.revision});if(runtimeContext!==ctx)return;await window.FinchStorage.reloadCurrent();agent.dataset.requestId='';host.toast(`Agentopgaven ${result.case_id} er lagt under Agent`);}).catch(e=>showError(e.message)).finally(()=>{if(agent.isConnected)agent.disabled=false;});return;}
    const open=event.target.closest('[data-page-open]');if(open)host.open(open.dataset.pageOpen);
    const edit=event.target.closest('[data-page-edit]');if(edit){const p=find(edit.dataset.pageEdit);const body=document.getElementById('custom-page-body');frameContext=null;body.innerHTML=`<form id="page-revision-form" data-page="${p.id}"><label>Hvad vil du ændre?<textarea name="description" rows="4" required maxlength="2000"></textarea></label><button class="btn" type="submit">Send ændringsønske</button><button class="link" type="button" data-page-open="${p.id}">Tilbage</button></form>`;mounted='';}
  });
  document.addEventListener('submit',event=>{
    const form=event.target.closest('#page-revision-form');if(!form)return;event.preventDefault();const p=find(form.dataset.page);const description=text(new FormData(form).get('description'),2000);if(!description)return;
    host.signal('page_change_requested',{page_id:p.id,title:p.title,description,table_ids:p.tableIds,file_ids:p.fileIds||[]});host.toast('Ændringsønsket er sendt til agenten');host.open(p.id);
  });
  return {definitions,tool,rail,newPageButton,render,reset,proposalAnswer,cleanIcon,configure(options){host=options;},summaries:()=>pages().map(summarize)};
})();
