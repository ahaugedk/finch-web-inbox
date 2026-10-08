// Tabulator handles cells and editors; drafts remain separate from server records.
window.FinchTableEditor=(()=>{
  const sessions=new Map();let mounted=null;
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  const field=name=>'v_'+name;
  const raw=(value,column)=>value==null?'':column.type==='json'?JSON.stringify(value):column.type==='boolean'?String(value):value;
  function parse(value,column){
    if(value===''||value===null||value===undefined)return null;
    if(column.type==='number'){const n=Number(value);if(!Number.isFinite(n))throw new Error(`${column.label}: indtast et tal.`);return n;}
    if(column.type==='boolean'){if(value==='true'||value===true)return true;if(value==='false'||value===false)return false;throw new Error(`${column.label}: vælg Ja eller Nej.`);}
    if(column.type==='json'){try{return JSON.parse(value);}catch{throw new Error(`${column.label}: JSON er ugyldig.`);}}
    return String(value);
  }
  class Drafts{
    constructor(columns){this.columns=columns;this.rows=new Map();this.drafts=new Map();this.pinned=new Map();}
    ingest(rows){this.rows=new Map(rows.map(r=>[r.id,r]));for(const [id,d] of this.drafts){const latest=this.rows.get(id);if(!d.isNew&&latest&&latest.revision!==d.original.revision)d.conflict=true;}}
    edit(id,name,value){let d=this.drafts.get(id);if(!d){const original=this.rows.get(id)||this.pinned.get(id);if(!original)return;d={id,original:structuredClone(original),changes:{},source:original.source_url,isNew:false};this.drafts.set(id,d);}if(name==='__source')d.source=String(value||'');else d.changes[name]=value;d.error='';return d;}
    add(id,source){const d={id,isNew:true,original:{id,revision:0,values:{}},changes:{},source};this.drafts.set(id,d);return d;}
    payload(d){const values=Object.fromEntries(this.columns.map(c=>{const value=Object.hasOwn(d.changes,c.name)?parse(d.changes[c.name],c):d.original.values[c.name]??null;if(c.required&&(value===null||value===''))throw new Error(`${c.label}: feltet skal udfyldes.`);return [c.name,value];}));return {values,source_url:d.source||''};}
    grid(record){const d=this.drafts.get(record.id);return {__key:record.id,__source:d?.source??record.source_url??'',__actions:0,...Object.fromEntries(this.columns.map(c=>[field(c.name),d&&Object.hasOwn(d.changes,c.name)?d.changes[c.name]:raw(record.values[c.name],c)]))};}
    records(){return [...this.drafts.values()].filter(d=>d.isNew||!this.rows.has(d.id)).map(d=>d.original).concat([...this.pinned.values()].filter(r=>!this.rows.has(r.id)&&!this.drafts.has(r.id)),[...this.rows.values()]);}
  }
  function reformat(session,id){if(mounted!==session||!session.built)return;const row=session.table.getRow(id);if(!row)return;session.actionRevision=(session.actionRevision||0)+1;row.getCell('__actions').setValue(session.actionRevision);row.getElement().classList.toggle('is-row-draft',session.model.drafts.has(id));row.normalizeHeight();}
  function actions(cell,session){const id=cell.getRow().getIndex(),d=session.model.drafts.get(id),box=document.createElement('div');box.className='data-row-actions grid-row-actions';
    const button=(label,fn,disabled=false)=>{const icon=label==='Slet række'?'delete':label==='Annullér'?'close':label==='Genindlæs'?'reload':label==='Redigér række'?'edit':'save';box.append(globalThis.FinchGridUI.iconButton(icon,label,fn,disabled));};
    if(d)button(d.busy?'Gemmer…':d.pending?'Prøv igen':'Gem',()=>save(session,id),!!d.busy||session.busyIds.has(id));
    else button('Redigér række',()=>session.table.getRow(id)?.getCell(field(session.model.columns[0].name)).edit(),session.busyIds.has(id));
    if(d?.pending||d?.conflict||session.errors.has(id))button('Genindlæs',()=>reload(session,id),!!d?.busy||session.busyIds.has(id));
    else if(d)button('Annullér',()=>cancel(session,id),!!d.busy);
    if(!d?.isNew)button('Slet række',()=>remove(session,id),!!d?.busy||!!d?.pending||session.busyIds.has(id));
    const error=d?.error||session.errors.get(id);const status=document.createElement('span');status.className=error||d?.conflict?'data-row-error':'data-row-status';status.setAttribute('role','status');status.textContent=error||(d?.conflict?'Ændret af en anden. Genindlæs før gemning.':d?.isNew?'Ny række':d?'Ikke gemt':session.savedIds.has(id)?'Gemt':'');box.append(status);return box;
  }
  function columns(session){const {model}=session;return [{field:'__selection',formatter:'rowSelection',titleFormatter:'rowSelection',titleFormatterParams:{rowRange:'active'},width:44,hozAlign:'center',headerSort:false,resizable:false},...model.columns.map(c=>({title:(c.label||c.name)+(c.unit?` (${c.unit})`:''),titleFormatter:cell=>{const button=document.createElement('button');button.type='button';button.className='data-row-sort';button.textContent=cell.getValue();button.addEventListener('click',event=>{event.stopPropagation();session.ctx.onSort(c.name);});return button;},field:field(c.name),minWidth:c.type==='json'?220:150,widthGrow:c.type==='text'?2:1,headerSort:false,
    editor:c.type==='number'?'number':c.type==='date'?'date':['boolean','file'].includes(c.type)?'list':c.type==='json'?'textarea':'input',
    editable:cell=>{const id=cell.getRow().getIndex(),d=model.drafts.get(id);return !d?.busy&&!d?.pending&&!session.busyIds.has(id);},
    editorParams:()=>({elementAttributes:{'aria-label':c.label||c.name},itemFormatter:label=>{const span=document.createElement('span');span.textContent=label;return span;},...(c.type==='number'?{step:'any'}:{}),...(c.type==='boolean'?{values:[{value:'',label:'—'},{value:'true',label:'Ja'},{value:'false',label:'Nej'}]}:{}),...(c.type==='file'?{values:[{value:'',label:'Ingen fil'},...session.ctx.files.map(f=>({value:f.id,label:f.name}))]}:{})}),
    formatter:cell=>{const element=document.createElement('span');try{element.innerHTML=session.ctx.format(parse(cell.getValue(),c),c);}catch{element.textContent=String(cell.getValue());}return element;},
  }))].concat([
    {title:'Kilde',field:'__source',minWidth:190,headerSort:false,editor:'input',editorParams:{elementAttributes:{'aria-label':'Kilde-URL',type:'url',maxlength:'2000'}},editable:cell=>{const d=model.drafts.get(cell.getRow().getIndex());return !d?.busy&&!d?.pending;},formatter:cell=>{const value=cell.getValue();const a=document.createElement('a');if(/^https?:\/\//i.test(value)){a.href=value;a.target='_blank';a.rel='noopener noreferrer';a.textContent='Se kilde';return a;}const span=document.createElement('span');span.textContent=value||'—';return span;}},
    {title:'Handlinger',field:'__actions',width:112,minWidth:112,maxWidth:112,resizable:false,frozen:true,headerSort:false,variableHeight:true,formatter:cell=>actions(cell,session)},
  ]);}
  function mount(container,ctx){if(!container)return;const key=ctx.orgId+':'+ctx.userId+':'+ctx.table.id;let session=sessions.get(key);
    if(!session){session={key,model:new Drafts(ctx.table.columns),selection:new globalThis.FinchGridUI.Selection(),savedIds:new Set(),busyIds:new Set(),errors:new Map(),ctx};sessions.set(key,session);}
    session.ctx=ctx;const queryChanged=session.queryKey!==ctx.queryKey;if(queryChanged){session.queryKey=ctx.queryKey;session.model.pinned.clear();session.selection.clear();if(session.built)session.table.deselectRow();}
    const previous=new Map(session.model.rows);session.model.ingest(ctx.rows);
    if(mounted!==session||!session.table){if(mounted?.table){mounted.table.destroy();mounted.table=null;mounted.built=false;}
      mounted=session;session.element=container;session.built=false;session.ready=new Promise(resolve=>session.resolve=resolve);
      session.table=new window.Tabulator(container,{index:'__key',data:session.model.records().map(r=>session.model.grid(r)),layout:'fitColumns',maxHeight:500,columns:columns(session),placeholder:'Ingen rækker endnu. Tilføj den første med +.',editTriggerEvent:'click',selectableRows:'highlight',selectableRowsCheck:row=>!session.model.drafts.get(row.getIndex())?.pending&&!session.model.drafts.get(row.getIndex())?.busy&&!session.busyIds.has(row.getIndex()),rowFormatter:row=>row.getElement().classList.toggle('is-row-draft',session.model.drafts.has(row.getIndex()))});
      session.table.on('tableBuilt',()=>{session.built=true;session.resolve();if(session.selection.records.length)session.table.selectRow(session.selection.records.map(record=>record.id));toolbar(session);});
      session.table.on('cellEdited',cell=>{const name=cell.getField();if(!name||name==='__actions'||name==='__selection')return;session.model.edit(cell.getRow().getIndex(),name==='__source'?name:name.slice(2),cell.getValue());reformat(session,cell.getRow().getIndex());});
      session.table.on('rowSelectionChanged',data=>{if(session.batchBusy)return;session.selection.select(data.map(row=>session.model.rows.get(row.__key)||session.model.pinned.get(row.__key)||{id:row.__key,revision:0,isNew:true}));toolbar(session);});
      session.table.on('renderComplete',()=>container.querySelectorAll('input[type=checkbox]').forEach(input=>input.setAttribute('aria-label',input.closest('.tabulator-header')?'Vælg alle viste rækker':'Vælg række')));
    }else{
      if(session.element!==container){container.replaceWith(session.element);if(session.built)session.table.redraw(true);}
      if(session.built&&queryChanged){session.table.replaceData(session.model.records().map(r=>session.model.grid(r))).then(()=>toolbar(session));toolbar(session);return session;}
      if(session.built)for(const r of session.model.records()){
        const row=session.table.getRow(r.id);if(!row)session.table.addRow(session.model.grid(r));else if(!session.model.drafts.has(r.id)&&!same(previous.get(r.id),r))row.update(session.model.grid(r));else if(session.model.drafts.get(r.id)?.conflict)reformat(session,r.id);
      }
      if(session.built)for(const row of session.table.getRows()){const id=row.getIndex();if(!session.model.rows.has(id)&&!session.model.drafts.has(id)&&!session.model.pinned.has(id))row.delete();}
    }
    toolbar(session);return session;
  }
  async function addRow(){const s=mounted;if(!s)return;await s.ready;const d=s.model.add(crypto.randomUUID(),s.ctx.table.source_url);const row=await s.table.addRow(s.model.grid(d.original),true);row.getCell(field(s.model.columns[0].name)).edit();}
  async function save(s,id){const d=s.model.drafts.get(id);if(!d||d.busy)return;
    try{const payload=d.frozen||s.model.payload(d);d.busy=true;d.error='';reformat(s,id);toolbar(s);
      if(d.isNew)d.frozen=structuredClone(payload);
      const result=await s.ctx.request(`/tables/${s.ctx.table.id}/rows${d.isNew?'':'/'+id}`,d.isNew?'POST':'PUT',d.isNew?{request_id:id,rows:[payload]}:{...payload,revision:d.original.revision});
      const row=d.isNew?result.rows[0]:result.row;s.model.drafts.delete(id);s.model.rows.set(id,row);s.model.pinned.set(id,row);s.savedIds.add(id);if(s.selection.items.has(id))s.selection.items.set(id,structuredClone(row));
      if(mounted===s&&s.built){await s.table.getRow(id)?.update(s.model.grid(row));reformat(s,id);}
      await s.ctx.onSaved();
    }catch(error){d.error=error.message;d.pending=!!(d.isNew&&d.frozen&&(!error.status||error.status>=500||error.status===409));if(!d.pending)d.frozen=null;}
    finally{d.busy=false;reformat(s,id);toolbar(s);}
  }
  async function reload(s,id){const d=s.model.drafts.get(id);if(d?.busy)return;try{const {row}=await s.ctx.request(`/tables/${s.ctx.table.id}/rows/${id}`);s.errors.delete(id);s.model.drafts.delete(id);s.model.rows.set(id,row);s.model.pinned.set(id,row);if(s.selection.items.has(id))s.selection.items.set(id,structuredClone(row));if(!s.errors.size)s.batchError='';toolbar(s);if(mounted===s&&s.built){await s.table.getRow(id)?.update(s.model.grid(row));reformat(s,id);}}catch(error){if(d)d.error=error.message;else s.errors.set(id,error.message);reformat(s,id);}}
  async function remove(s,id){const record=s.model.drafts.get(id)?.original||s.model.rows.get(id)||s.model.pinned.get(id);if(record)await removeRows(s,[record]);}
  async function removeRows(s,records){if(s.batchBusy||!records.length||records.some(record=>s.model.drafts.get(record.id)?.busy||s.model.drafts.get(record.id)?.pending))return;const snapshot=structuredClone(records),org=s.ctx.orgId,user=s.ctx.userId,tableId=s.ctx.table.id;
    const accepted=await globalThis.FinchGridUI.confirmDelete({items:snapshot.map(record=>({...record,label:record.isNew?'Ny række':String(record.values?.[s.model.columns[0].name]??'Række')})),anchor:s.element});if(!accepted||mounted!==s||s.ctx.orgId!==org||s.ctx.userId!==user)return;
    s.batchBusy=true;s.batchError='';for(const record of snapshot)s.busyIds.add(record.id);toolbar(s);snapshot.forEach(record=>reformat(s,record.id));
    try{const result=await globalThis.FinchGridUI.batch(snapshot,async record=>{
      if(mounted!==s||s.ctx.orgId!==org||s.ctx.userId!==user)throw new Error('Visningen er skiftet.');
      const draft=s.model.drafts.get(record.id);if(draft?.busy||draft?.pending)throw new Error('Gemning er endnu ikke afklaret. Genindlæs rækken før sletning.');
      if(!record.isNew)await s.ctx.request(`/tables/${tableId}/rows/${record.id}`,'DELETE',{revision:record.revision});
      s.model.rows.delete(record.id);s.model.pinned.delete(record.id);s.model.drafts.delete(record.id);s.selection.remove(record.id);s.errors.delete(record.id);if(mounted===s)await s.table.getRow(record.id)?.delete();
    });
      for(const failure of result.failed){s.errors.set(failure.item.id,failure.error.message);reformat(s,failure.item.id);}
      if(result.failed.length)s.batchError=`${result.succeeded.length} slettet; ${result.failed.length} kunne ikke slettes. ${result.failed[0].error.message}`;
      if(result.succeeded.length&&mounted===s)await s.ctx.onSaved();
    }catch(error){s.batchError=error.message;}finally{s.batchBusy=false;for(const record of snapshot){s.busyIds.delete(record.id);reformat(s,record.id);}toolbar(s);}
  }
  function toolbar(s){if(mounted!==s)return;const box=s.element?.closest('.data-content')?.querySelector('[data-row-toolbar]');if(!box)return;
    const n=s.selection.records.length,disabled=s.batchBusy||s.selection.records.some(r=>s.model.drafts.get(r.id)?.busy||s.model.drafts.get(r.id)?.pending);
    const html=`<div class="grid-toolbar-actions"><button type="button" class="grid-text-action" data-row-grid-action="delete"${!n||disabled?' disabled':''}>Slet valgte</button><button type="button" class="grid-text-action" data-row-grid-action="refresh"${s.batchBusy?' disabled':''}>Genindlæs</button>${n?'<button type="button" class="grid-text-action" data-row-grid-action="clear">Ryd valg</button>':''}</div><span class="grid-selection" role="status">${n?`${n} valgt`:`${s.ctx.table.row_count} rækker`}</span>${globalThis.FinchGridUI.createHtml('Ny række',{'data-row-grid-action':'create'},s.batchBusy)}${s.batchError?`<p class="data-row-error" role="alert">${String(s.batchError).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}</p>`:''}`;
    if(box._finchHtml!==html){box._finchHtml=html;box.innerHTML=html;}
    if(!box._finchBound){box._finchBound=true;box.addEventListener('click',event=>{const action=event.target.closest('[data-row-grid-action]')?.dataset.rowGridAction;if(mounted!==s||s.batchBusy)return;if(action==='create')addRow();else if(action==='delete')removeRows(s,s.selection.records);else if(action==='clear')s.table.deselectRow();else if(action==='refresh')s.ctx.onSaved();});}
  }
  function cancel(s,id){const d=s.model.drafts.get(id);if(!d||d.busy)return;s.model.drafts.delete(id);if(d.isNew)s.table.getRow(id)?.delete();else{s.table.getRow(id)?.update(s.model.grid(s.model.rows.get(id)||d.original));reformat(s,id);}}
  function reset(){if(mounted?.table)mounted.table.destroy();mounted=null;sessions.clear();}
  return {mount,addRow,reset,Drafts};
})();
