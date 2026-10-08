import '../file-model.js';
import {organizationAccess} from './team.mjs';
import {dataFileInfo,dataFileInTables} from './data.mjs';
export async function handlePageFileApi(request,env,{db,user,fail,json}){
  const route=new URL(request.url).pathname.match(/^\/api\/organizations\/([a-f0-9-]{36})\/pages\/([a-f0-9-]{36})\/files\/([a-f0-9-]{36})(\/content)?$/);if(!route)return null;
  if(request.method!=='GET')fail(405,'method_not_allowed','Sider kan kun læse filer.');
  const org=await organizationAccess(db,route[1],user),page=org&&JSON.parse(org.state_json).pages?.find(p=>p.id===route[2]&&p.status==='ready');
  if(!page)fail(404,'page_not_found','Siden findes ikke, eller du har ikke adgang.');
  const file=await db.first('SELECT * FROM stored_files WHERE id=? AND organization_id=? AND deleted_at IS NULL',route[3],org.id);
  if(!file||!((page.fileIds||[]).includes(file.id)||await dataFileInTables(db,org.id,page.tableIds,file.id,fail)))fail(404,'page_file_not_found','Filen findes ikke i sidens valgte datakilder.');
  const url=`/api/organizations/${org.id}/pages/${page.id}/files/${file.id}/content`;
  if(!route[4])return json({file:{...dataFileInfo(file,org.id),download_url:url},preview:globalThis.FinchFileModel.preview(file)});
  if(!env.BUCKET)fail(503,'files_unavailable','Filopbevaring er ikke tilgængelig lige nu.');
  const object=await env.BUCKET.get(file.object_key);if(!object)fail(404,'file_missing','Filens indhold findes ikke.');
  return new Response(object.body,{headers:{'Content-Type':'application/octet-stream','Content-Length':String(file.size_bytes),'Content-Disposition':`attachment; filename="${file.name.replace(/[^a-zA-Z0-9._-]/g,'_')}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox",'Referrer-Policy':'no-referrer'}});
}
