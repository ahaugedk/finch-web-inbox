import '../data-controls.js';
import '../brand-model.js';
// Custom code runs in a separate, opaque-origin document, never in Finch's account context.
export const PAGE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; frame-src blob:; connect-src 'none'; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
export function validPages(pages) {
  return pages === undefined || (Array.isArray(pages) && pages.length <= 30 && pages.every(p =>
    p && /^[a-f0-9-]{36}$/.test(p.id) && typeof p.title === 'string' && p.title.length <= 80 &&
    ['requested', 'proposed', 'approved', 'ready', 'rejected', 'archived'].includes(p.status) &&
    Array.isArray(p.tableIds) && p.tableIds.length <= 20 && p.tableIds.every(id => /^[a-f0-9-]{36}$/.test(id)) &&
    (p.fileIds===undefined||(Array.isArray(p.fileIds)&&p.fileIds.length<=50&&p.fileIds.every(id=>/^[a-f0-9-]{36}$/.test(id)))) &&
    (p.writableTableIds===undefined||(Array.isArray(p.writableTableIds)&&p.writableTableIds.length<=20&&p.writableTableIds.every(id=>p.tableIds.includes(id)))) &&
    (!p.agentAction||(typeof p.agentAction.name==='string'&&p.agentAction.name.length>0&&p.agentAction.name.length<=80&&typeof p.agentAction.label==='string'&&p.agentAction.label.length>0&&p.agentAction.label.length<=80)) &&
    (!p.component || (typeof p.component.html === 'string' && typeof p.component.css === 'string' && typeof p.component.javascript === 'string' &&
      p.component.html.length <= 60000 && p.component.css.length <= 30000 && p.component.javascript.length <= 80000 &&
      /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(p.component.tag_name))) && (!p.ui || Array.isArray(p.ui))));
}
export function customPageDocument(page, token, branding = {revision:0,theme:{},stylesheet:'',logo:null,fonts:[]},dashboardLibraries={scripts:[],css:''}) {
  const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
  const declarations=globalThis.FinchBrandModel.declarations(branding);
  const fonts=branding.fonts.map(f=>`@font-face{font-family:"${f.family}";src:url("${f.data_url}");font-weight:${f.weight};font-style:${f.style};font-display:swap}`).join('\n');
  const themeCss=`:host{${declarations};font-family:var(--sans);color:var(--ink)}h1,h2,h3{font-family:var(--serif)}`;
  const config = safeJson({ token, pageId: page.id, component: page.component, values: page.values || {}, valuesRevision:page.valuesRevision||0,branding, declarations, fonts, themeCss,dashboardLibraries,controlsSource:globalThis.FinchControlLibrary.source });
  return `<!doctype html><html lang="da"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>
  (() => {
    const config = ${config}; const pending = new Map(); const files=new Map(),pdfPreviews=new Map(),localHandlers=new Map();let currentValues=config.values,valuesRevision=config.valuesRevision,saveQueue=Promise.resolve();let fileBytes=0;let seq = 0;
    const call = (method, input = {}) => new Promise((resolve, reject) => {
      const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(new Error('Forbindelsen til Finch svarede ikke.')); }, 30000);
      pending.set(id, { resolve, reject, timer });
      parent.postMessage({ channel: 'finch-page', token: config.token, id, method, input }, '*');
    });
    addEventListener('message', event => {
      if (event.source !== parent || event.data?.channel !== 'finch-page-result' || event.data.token !== config.token) return;
      const item = pending.get(event.data.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(event.data.id);
      if (event.data.error) item.reject(new Error(event.data.error)); else item.resolve(event.data.result);
    });
    const readFile=fileId=>{
      if(files.has(fileId))return files.get(fileId);
      const promise=call('read_file',{file_id:fileId}).then(result=>{
        const memoryBytes=result.bytes.byteLength+(result.preview_bytes?.byteLength||0);if(fileBytes+memoryBytes>50*1024*1024)throw new Error('Siden har nået grænsen for filvisninger. Frigiv en fil med finch.releaseFile.');
        const bytes=new Uint8Array(result.bytes);const url=URL.createObjectURL(new Blob([result.preview_bytes||bytes],{type:result.preview.type}));fileBytes+=memoryBytes;
        return {...result,bytes,url,memoryBytes};
      }).catch(error=>{if(files.get(fileId)===promise)files.delete(fileId);throw error;});files.set(fileId,promise);return promise;
    };
    const renderPdfPage=async(fileId,options={})=>{const result=await call('render_pdf',{...options,file_id:fileId});if(fileBytes+result.bytes.byteLength>50*1024*1024)throw new Error('Frigiv tidligere filvisninger med finch.releaseFile.');const url=URL.createObjectURL(new Blob([result.bytes],{type:'image/png'}));fileBytes+=result.bytes.byteLength;pdfPreviews.set(url,{fileId,size:result.bytes.byteLength});return {...result,bytes:new Uint8Array(result.bytes),url};};
    const releaseFile=async fileId=>{const promise=files.get(fileId);if(promise){files.delete(fileId);try{const result=await promise;URL.revokeObjectURL(result.url);fileBytes-=result.memoryBytes;}catch{}}for(const [url,preview]of pdfPreviews)if(preview.fileId===fileId){URL.revokeObjectURL(url);fileBytes-=preview.size;pdfPreviews.delete(url);}};
    addEventListener('pagehide',()=>{for(const fileId of new Set([...files.keys(),...Array.from(pdfPreviews.values(),p=>p.fileId)]))releaseFile(fileId);});
    let ready; const readyPromise = new Promise(resolve => ready = resolve);
    const emit=(name,values={})=>{if(typeof name!=='string'||!name.trim())throw new Error('Giv sidehændelsen et navn.');if(values&&typeof values==='object'&&!Array.isArray(values))currentValues=values;for(const handler of localHandlers.get(name)||[])handler(values);return {status:'ok',local:true};};
    const on=(name,handler)=>{if(typeof handler!=='function')throw new Error('Angiv en lokal handler.');if(!localHandlers.has(name))localHandlers.set(name,new Set());localHandlers.get(name).add(handler);return ()=>localHandlers.get(name)?.delete(handler);};
    const saveValues=async(values=currentValues)=>{const snapshot=JSON.parse(JSON.stringify(values));const operation=saveQueue.catch(()=>{}).then(async()=>{const result=await call('save_values',{values:snapshot,revision:valuesRevision});currentValues=snapshot;valuesRevision=result.revision;return result;});saveQueue=operation;return operation;};
    const requestAgent=(name,values=currentValues,options={})=>{if(navigator.userActivation&&!navigator.userActivation.isActive)return Promise.reject(new Error('Start agentarbejde med et brugerklik.'));return call('request_agent',{name,values,request_id:options.request_id||crypto.randomUUID()});};
    window.finch = Object.freeze({ pageId: config.pageId, html: config.component.html, css: config.component.css, get values(){return currentValues;}, branding:config.branding, themeCss:config.themeCss,
      ready: readyPromise, get root() { const host = document.querySelector(config.component.tag_name); return host?.shadowRoot || host; },
      queryTable: input => call('query_table', input), getTable: tableId => call('get_table', { table_id: tableId }),
      getRow:(tableId,rowId)=>call('get_row',{table_id:tableId,row_id:rowId}),insertRows:(tableId,rows)=>call('insert_rows',{table_id:tableId,rows}),
      updateRow:(tableId,rowId,values,revision)=>call('update_row',{table_id:tableId,row_id:rowId,values,revision}),deleteRow:(tableId,rowId,revision)=>call('delete_row',{table_id:tableId,row_id:rowId,revision}),
      getFile:fileId=>call('get_file',{file_id:fileId}),readFile,getFileUrl:async fileId=>(await readFile(fileId)).url,releaseFile,renderPdfPage,
      downloadFile:fileId=>{if(navigator.userActivation&&!navigator.userActivation.isActive)return Promise.reject(new Error('Klik på en knap for at hente filen.'));return call('download_file',{file_id:fileId});},
      emit,on,saveValues,requestAgent,get echarts(){return window.echarts;},get Tabulator(){return window.Tabulator;},get tabulatorCss(){return config.dashboardLibraries.css;},
    });
    const base = document.createElement('style'); base.textContent = config.fonts+':root{'+config.declarations+'}html,body{margin:0;min-height:100%;background:var(--mineral);color:var(--ink);font:16px var(--sans)}*{box-sizing:border-box}'+config.branding.stylesheet; document.head.append(base);
    addEventListener('error', event => parent.postMessage({channel:'finch-page', token:config.token, method:'report_error', input:{message:event.message}}, '*'));
    addEventListener('unhandledrejection', event => parent.postMessage({channel:'finch-page', token:config.token, method:'report_error', input:{message:String(event.reason?.message || event.reason)}}, '*'));
    for(const source of config.dashboardLibraries.scripts){const vendor=document.createElement('script');vendor.textContent=source;document.head.append(vendor);}
    globalThis.FinchTabulatorCss=config.dashboardLibraries.css;
    const controls=document.createElement('script');controls.textContent=config.controlsSource+';globalThis.FinchControlLibrary=createFinchControlLibrary(globalThis);FinchControlLibrary.install(finch);';document.head.append(controls);
    const script = document.createElement('script'); script.textContent = config.component.javascript; document.head.append(script);
    if (!customElements.get(config.component.tag_name)) customElements.define(config.component.tag_name, class extends HTMLElement {
      connectedCallback() { const root = this.attachShadow({mode:'open'}); const style = document.createElement('style'); style.textContent = config.themeCss+'\\n'+config.component.css+'\\n'+config.branding.stylesheet; root.append(style); const body = document.createElement('div'); body.innerHTML = config.component.html; root.append(body); }
    });
    const host = document.createElement(config.component.tag_name); document.body.append(host);
    if(host.shadowRoot){const theme=document.createElement('style');theme.textContent=config.themeCss+'\\n'+config.branding.stylesheet;host.shadowRoot.append(theme);}
    ready(host);
  })();
  </script></body></html>`;
}
