// Shared, pure branding contract for browser and Worker. No DOM or network access.
globalThis.FinchBrandModel = (() => {
  const defaults = {
    background:'#f4f3e8', surface:'#faf9f0', surface_alt:'#f7f6ec', surface_inset:'#eceadb',
    text:'#171717', muted:'#5f625c', accent:'#07565b', on_accent:'#ffffff', accent_soft:'#d4e4df',
    secondary:'#607a70', border:'#c6c9bb', rail:'#e6e4d6', graph_background:'#171717', graph_text:'#f4f3e8',
    body_font:'Satoshi, Arial, sans-serif', heading_font:"'Noto Serif Old Uyghur', Georgia, serif", radius:'0px',
  };
  const variables = {background:'mineral',surface:'paper',surface_alt:'paper-2',surface_inset:'paper-3',text:'ink',muted:'muted',accent:'petrol',on_accent:'accent-text',accent_soft:'mist',secondary:'sage',border:'brand-border',rail:'rail-surface',graph_background:'graph-bg',graph_text:'graph-text',body_font:'sans',heading_font:'serif',radius:'brand-radius'};
  const id = /^[a-f0-9-]{36}$/;
  const fontFamily = /^[a-zA-Z0-9 ,.'_-]{1,160}$/;
  const image = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[a-zA-Z0-9+/]+={0,2}$/;
  function cssError(css) {
    if(typeof css!=='string' || css.length>24000)return 'stylesheet skal være CSS på højst 24.000 tegn.';
    const plain=css.replace(/\/\*[\s\S]*?\*\//g,'');
    if(/@(?:import|font-face|namespace|charset)\b|url\s*\(|image-set\s*\(|expression\s*\(|javascript:|\\/i.test(plain))return 'CSS må ikke hente eksterne ressourcer. Tilføj logo og skrifter gennem logo/fonts; brug ikke @import, @font-face eller url().';
    return null;
  }
  function validate(brand) {
    if(brand===undefined || brand===null)return null;
    if(typeof brand!=='object' || Array.isArray(brand) || !Number.isSafeInteger(brand.revision) || brand.revision<0)return 'Ugyldigt organisationsdesign.';
    if(brand.active!==undefined && typeof brand.active!=='boolean')return 'active skal være en boolean.';
    if(!brand.theme || typeof brand.theme!=='object' || Array.isArray(brand.theme))return 'theme skal være et objekt.';
    for(const [key,value] of Object.entries(brand.theme)) {
      if(!Object.hasOwn(defaults,key))return `Ukendt theme-egenskab: ${key}.`;
      if(typeof value!=='string')return `theme.${key} skal være tekst.`;
      if(key.endsWith('_font')){if(!fontFamily.test(value))return `Ugyldig skriftfamilie: ${key}.`;}
      else if(key==='radius'){if(!/^(?:\d|1\d|2[0-4])px$/.test(value))return 'radius skal være 0px til 24px.';}
      else if(!/^#[a-f0-9]{6}$/i.test(value))return `theme.${key} skal være en sekscifret hex-farve.`;
    }
    const error=cssError(brand.stylesheet);if(error)return error;
    if(brand.source_url && (typeof brand.source_url!=='string' || brand.source_url.length>2000 || !/^https:\/\/[^\s]+$/.test(brand.source_url)))return 'source_url skal være en HTTPS-adresse.';
    if(brand.logo) {
      const l=brand.logo;
      if(typeof l!=='object' || Array.isArray(l) || (!!l.file_id===!!l.data_url) || (l.file_id && !id.test(l.file_id)) ||
        (l.data_url && (typeof l.data_url!=='string'||l.data_url.length>150000||!image.test(l.data_url))) ||
        typeof l.alt!=='string' || l.alt.length>120)return 'Logo skal være file_id eller et base64-billede, med alt-tekst. Højst 150.000 tegn for data_url.';
    }
    if(!Array.isArray(brand.fonts) || brand.fonts.length>4)return 'Der må være højst fire skrifter.';
    for(const f of brand.fonts)if(!f || !id.test(f.file_id) || typeof f.family!=='string' || f.family.length>160 || !/^[a-zA-Z0-9 _-]+$/.test(f.family) || !Number.isInteger(f.weight) || f.weight<100 || f.weight>900 || !['normal','italic'].includes(f.style))return 'Hver skrift skal have file_id, family, weight (100–900) og style (normal/italic).';
    return null;
  }
  function current(brand) {return {...defaults,...brand?.theme};}
  function declarations(brand) {
    const t=current(brand);const rgb=t.border.slice(1).match(/../g).map(s=>parseInt(s,16)).join(',');
    return Object.entries(t).map(([key,value])=>`--${variables[key]}:${value}`).join(';')+`;--white:${t.surface};--line:rgba(${rgb},.65);--hair:rgba(${rgb},.35);--edge:${t.border}`;
  }
  return Object.freeze({defaults:Object.freeze(defaults),variables:Object.freeze(variables),validate,cssError,current,declarations});
})();
