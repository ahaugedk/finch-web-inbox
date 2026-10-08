window.FinchFileMedia=(()=>{
  const roots=new WeakMap();
  let pdfLibrary;
  async function pdfPage(bytes,options={}){
    if(bytes.byteLength>globalThis.FinchFileModel.maxFileBytes)throw new Error('PDF-filen er for stor.');
    const number=options.page_number??1,width=Math.min(1600,Math.max(200,Number(options.width)||900));
    if(!Number.isInteger(number)||number<1)throw new Error('Vælg et gyldigt PDF-sidenummer.');
    pdfLibrary||=import('/assets/pdfjs/pdf.min.mjs').catch(e=>{pdfLibrary=null;throw e;});
    const library=await pdfLibrary;library.GlobalWorkerOptions.workerSrc='/assets/pdfjs/pdf.worker.min.mjs';
    const task=library.getDocument({data:new Uint8Array(bytes.slice(0)),isEvalSupported:false,useWorkerFetch:false,useSystemFonts:true,useWasm:false});
    try{
      const pdf=await task.promise;if(number>pdf.numPages)throw new Error('Siden findes ikke i PDF-dokumentet.');
      const page=await pdf.getPage(number),unit=page.getViewport({scale:1});
      const scale=Math.min(width/unit.width,2400/unit.height,Math.sqrt(4000000/(unit.width*unit.height)));
      const viewport=page.getViewport({scale}),canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('PDF-siden kunne ikke vises.');
      return {bytes:await blob.arrayBuffer(),width:canvas.width,height:canvas.height,page_number:number,page_count:pdf.numPages};
    }finally{await task.destroy();}
  }
  const validId=id=>/^[a-f0-9-]{36}$/.test(id||'');
  function svgPreview(bytes){
    if(bytes.byteLength>1024*1024)throw new Error('SVG-filen er for stor til forhåndsvisning. Hent originalen.');
    const text=new TextDecoder().decode(bytes);if(/<!DOCTYPE|<!ENTITY/i.test(text))throw new Error('SVG-filen kan kun hentes som original.');
    const document=new DOMParser().parseFromString(text,'image/svg+xml'),root=document.documentElement;
    if(root.localName!=='svg'||root.namespaceURI!=='http://www.w3.org/2000/svg'||document.querySelector('parsererror')||root.querySelectorAll('*').length>2000)throw new Error('SVG-filen kunne ikke vises.');
    const tags=new Set(['svg','g','path','circle','ellipse','rect','line','polyline','polygon','text','tspan','title','desc','defs','clipPath','mask','linearGradient','radialGradient','stop','use']);
    const attrs=new Set(['xmlns','id','viewBox','d','x','y','x1','x2','y1','y2','cx','cy','r','rx','ry','width','height','points','transform','fill','fill-rule','fill-opacity','stroke','stroke-width','stroke-linecap','stroke-linejoin','stroke-dasharray','stroke-dashoffset','stroke-opacity','opacity','clip-path','clip-rule','mask','offset','stop-color','stop-opacity','gradientUnits','gradientTransform','spreadMethod','fx','fy','font-family','font-size','font-weight','text-anchor','dominant-baseline','preserveAspectRatio','href','xlink:href']);
    for(const element of [root,...root.querySelectorAll('*')]){
      if(element.namespaceURI!==root.namespaceURI||!tags.has(element.localName)){element.remove();continue;}
      for(const attribute of [...element.attributes]){
        const value=attribute.value;
        if(!attrs.has(attribute.name)||/javascript:|data:|https?:/i.test(value)&&attribute.name!=='xmlns'||['href','xlink:href'].includes(attribute.name)&&!/^#[a-zA-Z0-9_-]+$/.test(value)||/url\s*\(/i.test(value)&&!/^url\(#[a-zA-Z0-9_-]+\)$/.test(value))element.removeAttribute(attribute.name);
      }
    }
    return new TextEncoder().encode(new XMLSerializer().serializeToString(root)).buffer;
  }
  async function load(org,pageId,fileId,content=true){
    if(!validId(fileId))throw new Error('Ugyldig filreference.');
    const base=pageId?`/api/organizations/${org}/pages/${pageId}/files/${fileId}`:`/api/organizations/${org}/data/files/${fileId}`;
    const response=await fetch(base,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)}),result=await response.json();
    if(!response.ok)throw new Error(result.message||'Filen kunne ikke hentes.');
    const preview=globalThis.FinchFileModel.preview(result.file);
    if(!content)return {file:result.file,preview};
    if(result.file.size_bytes>globalThis.FinchFileModel.maxFileBytes)throw new Error('Filen er større end 10 MB. Hent originalen i stedet.');
    const data=await fetch(result.file.download_url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!data.ok){const error=await data.json().catch(()=>({}));throw new Error(error.message||'Filens indhold kunne ikke hentes.');}
    const bytes=await data.arrayBuffer();if(bytes.byteLength>globalThis.FinchFileModel.maxFileBytes)throw new Error('Filen er for stor til visning.');
    return {file:result.file,preview,bytes,...(preview.type==='image/svg+xml'?{preview_bytes:svgPreview(bytes)}:{})};
  }
  function clear(root){const previous=roots.get(root);if(previous){previous.cancelled=true;for(const url of previous.urls)URL.revokeObjectURL(url);roots.delete(root);}}
  function node(tag,text){const element=document.createElement(tag);if(text!==undefined)element.textContent=text;return element;}
  async function render(root,loader,active){
    clear(root);const cards=[...root.querySelectorAll('[data-finch-file]')];if(!cards.length)return;
    const record={urls:new Set(),cancelled:false,bytes:0,cache:new Map()};roots.set(root,record);
    const current=()=>!record.cancelled&&root.isConnected&&active();
    for(const card of cards){
      try{
        if(!current())break;
        const id=card.dataset.finchFile;const info=await loader(id,false);if(!current())break;
        card.replaceChildren();const header=node('div');header.className='file-preview-header';header.append(node('strong',info.file.name));
        const download=node('a','Hent original');download.href=info.file.download_url;download.download=info.file.name;download.className='link';header.append(download);card.append(header);
        const imageOnly=card.dataset.fileDisplay==='image',downloadOnly=card.dataset.fileDisplay==='download';
        if(imageOnly&&info.preview.kind!=='image')throw new Error('Denne filtype kan ikke vises som et billede.');
        if(!downloadOnly&&info.preview.kind!=='download'){
          if(!record.cache.has(id)){
            if(record.bytes+info.file.size_bytes>globalThis.FinchFileModel.maxPreviewBytes)throw new Error('Hent originalen for at se flere store filer.');
            const result=await loader(id,true);if(!current())break;if(record.bytes+result.bytes.byteLength>globalThis.FinchFileModel.maxPreviewBytes)throw new Error('Hent originalen for at se flere store filer.');record.bytes+=result.bytes.byteLength;record.cache.set(id,result);
          }
          const result=record.cache.get(id);const url=URL.createObjectURL(new Blob([result.preview_bytes||result.bytes],{type:result.preview.type}));record.urls.add(url);
          let media;
          if(result.preview.kind==='image'){media=node('img');media.alt=card.dataset.fileAlt||info.file.name;media.loading='lazy';media.src=url;media.addEventListener('error',()=>{const error=node('p','Billedet kunne ikke vises. Du kan hente originalen.');media.replaceWith(error);});}
          else if(result.preview.kind==='pdf'){
            media=node('div');media.className='file-pdf-preview';const controls=node('div'),previous=node('button','Forrige side'),next=node('button','Næste side'),counter=node('span','Henter PDF…'),pageImage=node('img');
            previous.type=next.type='button';previous.disabled=next.disabled=true;controls.className='file-pdf-controls';controls.append(previous,counter,next);pageImage.alt=`PDF: ${info.file.name}`;media.append(controls,pageImage);
            let number=1,total=1,pageUrl=null;
            const draw=async()=>{previous.disabled=next.disabled=true;counter.textContent='Henter PDF…';try{const page=await pdfPage(result.bytes,{page_number:number,width:900});if(!current())return;total=page.page_count;if(pageUrl){URL.revokeObjectURL(pageUrl);record.urls.delete(pageUrl);}pageUrl=URL.createObjectURL(new Blob([page.bytes],{type:'image/png'}));record.urls.add(pageUrl);pageImage.src=pageUrl;counter.textContent=`Side ${number} af ${total}`;}catch(e){if(current())counter.textContent=e.message;}finally{if(current()){previous.disabled=number<=1;next.disabled=number>=total;}}};
            previous.addEventListener('click',()=>{if(number>1){number--;draw();}});next.addEventListener('click',()=>{if(number<total){number++;draw();}});await draw();
          }
          else if(['audio','video'].includes(result.preview.kind)){media=node(result.preview.kind);media.controls=true;media.preload='metadata';media.src=url;}
          else {media=node('pre',new TextDecoder().decode(result.bytes.slice(0,200000)));media.className='file-text-preview';if(result.bytes.byteLength>200000)card.append(node('small','Forhåndsvisningen viser de første 200.000 bytes. Hent originalen for hele filen.'));}
          card.append(media);
        }else card.append(node('p',`${Math.max(1,Math.ceil(info.file.size_bytes/1024))} KB · ${info.file.content_type}`));
        if(card.dataset.fileCaption)card.append(node('figcaption',card.dataset.fileCaption));
      }catch(error){if(current())card.append(node('p',error.message||'Filen kunne ikke vises.'));}
    }
    if(!current()&&roots.get(root)===record)clear(root);
  }
  return {load,render,clear,pdfPage};
})();
