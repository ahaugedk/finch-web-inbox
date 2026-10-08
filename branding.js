window.FinchBranding = (() => {
  const model=window.FinchBrandModel;
  const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let host;let applied='';
  const snapshot=()=>host.state().branding || {revision:0,theme:{},stylesheet:'',logo:null,fonts:[],source_url:''};
  const assetUrl=id=>`/api/organizations/${window.FinchStorage.organization.id}/branding/assets/${id}`;
  function scopedCss(css) {
    const sheet=new CSSStyleSheet();sheet.replaceSync(css);
    const convert=rules=>Array.from(rules).map(rule=>{
      if(rule.type===CSSRule.STYLE_RULE){
        const selector=rule.selectorText.replace(/(^|[\s,(>+~])(?:html|body|:root)(?=$|[\s,.#:[>+~)])/g,'$1#app');
        return `:where(#app):is(${selector}), :where(#app) :is(${selector}){${rule.style.cssText}}`;
      }
      if(rule.type===CSSRule.KEYFRAMES_RULE)return rule.cssText;
      if(rule.cssRules){const header=rule.cssText.slice(0,rule.cssText.indexOf('{'));return `${header}{${convert(rule.cssRules)}}`;}
      return '';
    }).join('\n');
    return convert(sheet.cssRules);
  }
  function clear() {for(const id of ['organization-theme','organization-stylesheet'])document.getElementById(id)?.remove();applied='';}
  function apply() {
    const brand=host.state().branding;const org=window.FinchStorage.organization?.id;
    const key=org+':'+JSON.stringify(brand || null);if(applied===key)return;
    clear();applied=key;if(!brand || !org || brand.active===false)return;
    const problem=model.validate(brand);if(problem){console.warn('Finch branding:',problem);return;}
    const theme=document.createElement('style');theme.id='organization-theme';
    const fonts=brand.fonts.map(f=>`@font-face{font-family:"${f.family}";src:url("${assetUrl(f.file_id)}");font-weight:${f.weight};font-style:${f.style};font-display:swap}`).join('\n');
    theme.textContent=`${fonts}\n${Object.keys(brand.theme).length?`:root{${model.declarations(brand)}}`:''}\n#app{font-family:var(--sans)}\n${brand.theme.accent?'#app .btn,#app .btn-primary{background:var(--petrol);color:var(--accent-text)}#app .btn-ghost{background:var(--paper);color:var(--ink)}':''}\n${brand.theme.radius?'#app input,#app textarea,#app select,#app .c-card,#app .c-callout,#app .organization-picker summary,#app .btn{border-radius:var(--brand-radius)}':''}`;
    document.head.append(theme);
    const custom=document.createElement('style');custom.id='organization-stylesheet';custom.textContent=scopedCss(brand.stylesheet);document.head.append(custom);
  }
  function logo() {
    const l=host.state().branding?.active!==false && host.state().branding?.logo;if(!l)return '';
    return `<img class="organization-logo" src="${esc(l.data_url || assetUrl(l.file_id))}" alt="${esc(l.alt)}" referrerpolicy="no-referrer">`;
  }
  const S=(maxLength,description)=>({type:'string',maxLength,description});
  const themeSchema={type:'object',additionalProperties:false,properties:Object.fromEntries(Object.keys(model.defaults).map(key=>[key,S(key.endsWith('_font')?160:10, key.endsWith('_font')?'Skriftfamilier som CSS font-family.':key==='radius'?'0px–24px.':'Sekscifret hex-farve.')]))};
  const revision={type:'integer',minimum:0,description:'Aktuel revision fra get_branding.'};
  const definitions=[
    {name:'get_branding',description:'Læs organisationens tema, CSS, logo, skrifter, kilde og revision samt standardtema og stabile CSS-variabler. Undersøg virksomhedens hjemmeside før du tilpasser den samlede oplevelse.',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true}},
    {name:'set_branding',description:'Tilpas HELE organisationens oplevelse ud fra dens hjemmeside/design: tema, skrift, overflader, layout-CSS og eventuelt logo. Gemmes på serveren og følger organisationen. Angiv revision fra get_branding. Udeladte egenskaber bevares; theme flettes med eksisterende theme. stylesheet er CSS for arbejdsfladen (#app); login og gemmestatus er udenfor. Brug stabile variable og klasser fra get_branding. CSS kan ikke hente ressourcer; brug logo og fonts. Logo er base64 data_url eller file_id fra upload_file; fonts er organisationsfiler med korrekt MIME-type. Ingen eksterne URL’er for billeder/skrifter. Custom WebComponents får finch.branding, finch.themeCss og CSS-variablerne; tilføj finch.themeCss til egne Shadow DOM styles. Bevar læsbarhed, fokusmarkeringer, navigation og godkendelsesknapper.',inputSchema:{type:'object',properties:{revision,theme:themeSchema,stylesheet:S(24000,'Komplet custom stylesheet, som erstatter den tidligere CSS. Scopes automatisk til #app. Ingen @import, @font-face, url(), backslash escapes eller netværk. Brug get_branding for klasser/variable.'),source_url:S(2000,'HTTPS-hjemmesiden, som designet bygger på.'),logo:{anyOf:[{type:'null'},{type:'object',properties:{file_id:S(36,'Fil-id fra upload_file; billede højst 1 MB.'),data_url:S(150000,'Base64 data:image/png|jpeg|webp|svg+xml; højst 150.000 tegn.'),alt:S(120,'Tilgængelig tekst for logoet, typisk organisationens navn.')},required:['alt']}]},fonts:{type:'array',maxItems:4,items:{type:'object',properties:{file_id:S(36,'Fil-id til WOFF2/WOFF/TTF/OTF, højst 1 MB.'),family:S(160,'Skriftfamilie, uden CSS-syntaks.'),weight:{type:'integer',minimum:100,maximum:900},style:{type:'string',enum:['normal','italic']}},required:['file_id','family','weight','style']}}},required:['revision']}},
    {name:'reset_branding',description:'Nulstil organisationens udseende til Finch-standard. Bevarer alle sider, data, opgaver og viden. Kræver brugerens ønske.',inputSchema:{type:'object',properties:{revision},required:['revision']}},
  ];
  async function verifyAsset(fileId,kind) {
    const result=await window.FinchData.tool('get_file',{file_id:fileId});const file=result.file;
    const allowed=kind==='logo'?['image/png','image/jpeg','image/webp','image/svg+xml']:['font/woff2','font/woff','font/ttf','font/otf','application/font-woff','application/x-font-ttf','application/x-font-opentype'];
    if(!allowed.includes(file.content_type) || file.size_bytes>1048576)throw new Error(`${kind==='logo'?'Logoet':'Skriften'} skal være en understøttet fil på højst 1 MB med korrekt MIME-type.`);
  }
  async function tool(name,input) {
    const previous=snapshot();
    if(name==='get_branding')return {status:'ok',branding:previous,defaults:model.defaults,css_variables:model.variables,selectors:['.intro-header','.topbar','.organization-logo','.organization-heading','.rail','.commandbar','.list','.pane','.view-graph','.kg-heading','.node-detail','.view-data','.data-sidebar','.data-main','.view-pages','.custom-page-header','.custom-page-components','.c-card','.c-table','.btn','.f'],guidance_for_agent:'Læs virksomhedens hjemmeside og dens faktiske farver, logo, skrifter og CSS. Brug publicerede assets; opfind ikke et nyt logo. Tilføj kun branding, der understøttes af kilden eller brugerens ønske. Rå designfiler/stylesheet hører i branding og filer, ikke i vidensgrafen.'};
    if(previous.revision!==input.revision)throw new Error('Udseendet er ændret. Hent get_branding igen.');
    const next=name==='reset_branding'?{revision:previous.revision+1,active:false,theme:{},stylesheet:'',logo:null,fonts:[],source_url:''}:{...previous,active:true,revision:previous.revision+1,theme:{...previous.theme,...input.theme},...Object.fromEntries(['stylesheet','logo','fonts','source_url'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]]))};
    if(!['set_branding','reset_branding'].includes(name))throw new Error('Ukendt branding-tool.');
    const problem=model.validate(next);if(problem)throw new Error(problem);
    if(next.fonts.some(f=>!/^[a-zA-Z0-9 _-]+$/.test(f.family)))throw new Error('fonts.family skal være et enkelt familienavn uden anførselstegn eller komma.');
    scopedCss(next.stylesheet); // Parse before any state mutation.
    const org=window.FinchStorage.organization.id;
    if(next.logo?.file_id)await verifyAsset(next.logo.file_id,'logo');
    for(const f of next.fonts)await verifyAsset(f.file_id,'font');
    if(org!==window.FinchStorage.organization?.id || snapshot().revision!==input.revision)throw new Error('Organisationen eller udseendet er ændret. Hent konteksten igen.');
    host.state().branding=next;host.save();host.render();
    return {status:'ok',branding:next,guidance_for_agent:'Organisationens udseende er gemt og anvendt. Kontrollér topbar, indbakke, graf, data, custom sider og smal visning. Ret evt. med seneste revision.'};
  }
  return {configure(options){host=options;},definitions,tool,apply,clear,logo,snapshot};
})();
