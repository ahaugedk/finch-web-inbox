const BRAND_IMAGE_TYPES = new Set(['image/png','image/jpeg','image/webp','image/svg+xml']);
const BRAND_FONT_TYPES = new Set(['font/woff2','font/woff','font/ttf','font/otf','application/font-woff','application/x-font-ttf','application/x-font-opentype']);
export async function brandAsset(db, env, orgId, fileId, kind) {
  const file=await db.first('SELECT content_type, size_bytes, object_key FROM stored_files WHERE id = ? AND organization_id = ? AND deleted_at IS NULL',fileId,orgId);
  if(!file || file.size_bytes>1048576 || !(kind==='logo'?BRAND_IMAGE_TYPES:BRAND_FONT_TYPES).has(file.content_type) || !env.BUCKET)return null;
  const object=await env.BUCKET.get(file.object_key);if(!object)return null;
  return {file,object};
}
export async function embeddedBranding(db, env, orgId, brand) {
  if(!brand)return {revision:0,theme:{},stylesheet:'',logo:null,fonts:[]};
  const embedded={...brand,fonts:[]};
  const dataUrl=async(fileId,kind)=>{
    const asset=await brandAsset(db,env,orgId,fileId,kind);if(!asset)return null;
    const bytes=new Uint8Array(await asset.object.arrayBuffer());let binary='';
    for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return `data:${asset.file.content_type};base64,${btoa(binary)}`;
  };
  if(brand.logo?.file_id){const url=await dataUrl(brand.logo.file_id,'logo');embedded.logo=url?{alt:brand.logo.alt,data_url:url}:null;}
  for(const font of brand.fonts){const url=await dataUrl(font.file_id,'font');if(url)embedded.fonts.push({...font,data_url:url});}
  return embedded;
}
