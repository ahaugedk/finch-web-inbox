import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
import {customPageDocument,PAGE_CSP,validPages} from '../server/pages.mjs';
import '../file-model.js';
const origin='https://finch.test';
async function fixture(){
 const DB=sqliteD1();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync('drizzle/'+f,'utf8'));
 const objects=new Map(),env={DB,AUTH_SECRET:'page-file-test-secret-at-least-thirty-two-chars',BUCKET:{put:async(k,b)=>objects.set(k,new Uint8Array(b)),get:async k=>objects.has(k)?{body:new Blob([objects.get(k)]).stream()}:null,delete:async k=>objects.delete(k)}};let code;
 async function call(route,cookie,method='GET',data,bytes,headers={}){const res=await handleApi(new Request(origin+route,{method,headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(data?{'Content-Type':'application/json'}:{}),...headers},...(data?{body:JSON.stringify(data)}:bytes?{body:bytes}:{})}),env,{sendMail:async(_,m)=>code=m.code,sendInvitation:async()=>{}});return {status:res.status,headers:res.headers,...(res.headers.get('Content-Type')?.includes('json')?{data:await res.json()}:{bytes:new Uint8Array(await res.arrayBuffer())})};}
 async function login(email){const start=await call('/api/auth/request-code',null,'POST',{email});return (await call('/api/auth/verify-code',null,'POST',{challengeId:start.data.challengeId,code})).headers.get('Set-Cookie').split(';')[0];}
 const owner=await login('owner@example.test'),outsider=await login('outsider@example.test'),org=(await call('/api/organizations',owner,'POST',{name:'Files'})).data.organization.id,other=(await call('/api/organizations',owner,'POST',{name:'Other'})).data.organization.id;
 const base='/api/organizations/'+org,id=crypto.randomUUID();let revision=0;
 async function save(change){const result=await call(base,owner);change(result.data.state);assert.equal((await call(base,owner,'PUT',{state:result.data.state,revision:result.data.organization.revision})).status,200);}
 async function upload(bytes,type='image/png',name='preview.png',orgId=org){const result=await call(`/api/organizations/${orgId}/data/files`,owner,'POST',null,bytes,{'Content-Type':type,'X-File-Name':encodeURIComponent(name)});assert.equal(result.status,201);return result.data.file;}
 async function page(files=[],tables=[]){await save(s=>s.pages=[{id,title:'Dokumenter',description:'Vis organisationsfiler',status:'ready',revision:revision++,tableIds:tables,fileIds:files,icon:'page',ui:[{type:'text',text:'Dokumenter'}]}]);}
 const path=fileId=>`${base}/pages/${id}/files/${fileId}`;
 return {DB,call,login,owner,outsider,org,other,base,id,save,upload,page,path};
}
test('selected page files round-trip larger blobs privately without the old inline limit and retain original bytes',async()=>{
 const f=await fixture(),bytes=new Uint8Array(2*1024*1024+19);bytes[0]=80;bytes[bytes.length-1]=19;const file=await f.upload(bytes);await f.page([file.id]);
 const meta=await f.call(f.path(file.id),f.owner);assert.equal(meta.status,200);assert.equal(meta.data.preview.kind,'image');assert.equal(meta.data.file.id,file.id);assert.equal(meta.data.file.download_url,f.path(file.id)+'/content');
 const content=await f.call(meta.data.file.download_url,f.owner);assert.equal(content.status,200);assert.deepEqual(content.bytes,bytes);assert.equal(content.headers.get('Content-Type'),'application/octet-stream');assert.equal(content.headers.get('Cache-Control'),'no-store');assert.match(content.headers.get('Content-Disposition'),/^attachment/);
 assert.equal((await f.call(f.path(file.id),null)).status,401);assert.equal((await f.call(f.path(file.id),f.outsider)).status,404);
 const unselected=await f.upload(new Uint8Array([1,2,3]));assert.equal((await f.call(f.path(unselected.id),f.owner)).status,404);
 const foreign=await f.upload(new Uint8Array([9]),'text/plain','other.txt',f.other);await f.page([file.id,foreign.id]);assert.equal((await f.call(f.path(foreign.id),f.owner)).status,404);
 await f.save(s=>s.pages[0].status='archived');assert.equal((await f.call(f.path(file.id),f.owner)).status,404);
});
test('table file columns grant scoped dynamic access only while a live row and live table reference the file',async()=>{
 const f=await fixture(),file=await f.upload(new Uint8Array([1,2,3]),'application/pdf','guide.pdf');
 const table=(await f.call(f.base+'/data/tables',f.owner,'POST',{name:'Models',columns:[{name:'document',type:'file'}]})).data.table;
 const inserted=await f.call(`${f.base}/data/tables/${table.id}/rows`,f.owner,'POST',{rows:[{values:{document:file.id}}]});assert.equal(inserted.status,201);
 await f.page([], [table.id]);assert.equal((await f.call(f.path(file.id),f.owner)).data.preview.kind,'pdf');
 const row=inserted.data.rows[0];assert.equal((await f.call(`${f.base}/data/tables/${table.id}/rows/${row.id}`,f.owner,'DELETE',{revision:row.revision})).status,200);assert.equal((await f.call(f.path(file.id),f.owner)).status,404);
 await f.call(`${f.base}/data/tables/${table.id}/rows`,f.owner,'POST',{rows:[{values:{document:file.id}}]});assert.equal((await f.call(f.path(file.id),f.owner)).status,200);
 assert.equal((await f.call(`${f.base}/data/tables/${table.id}`,f.owner,'DELETE',{revision:0})).status,200);assert.equal((await f.call(f.path(file.id),f.owner)).status,404);
});
test('members can view selected files, and revocation and file deletion immediately stop further reads',async()=>{
 const f=await fixture(),file=await f.upload(new Uint8Array([1]));await f.page([file.id]);const member=await f.login('member@example.test');const invite=await f.call(f.base+'/settings/members',f.owner,'POST',{email:'member@example.test',inGraph:false});await f.call(`/api/invitations/${invite.data.id}/accept`,member,'POST',{});
 assert.equal((await f.call(f.path(file.id)+'/content',member)).status,200);const team=await f.call(f.base+'/settings',f.owner),m=team.data.members.find(m=>m.id===invite.data.id);await f.call(f.base+'/settings/members/'+m.id,f.owner,'DELETE',{revision:m.revision});assert.equal((await f.call(f.path(file.id),member)).status,404);
 await f.call(f.base+'/data/files/'+file.id,f.owner,'DELETE',{revision:file.revision});assert.equal((await f.call(f.path(file.id),f.owner)).status,404);
});
test('preview formats are passive, file scopes validate and component CSP enables only local blob media',()=>{
 const preview=globalThis.FinchFileModel.preview;
 assert.equal(preview({content_type:'application/octet-stream',name:'guide.pdf'}).kind,'pdf');assert.equal(preview({content_type:'text/html',name:'image.png'}).kind,'download');assert.equal(preview({content_type:'image/svg+xml',name:'logo.svg'}).kind,'image');assert.equal(preview({content_type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',name:'data.xlsx'}).kind,'download');
 const p={id:crypto.randomUUID(),title:'Test',status:'ready',tableIds:[],fileIds:[]};assert.equal(validPages([p]),true);assert.equal(validPages([{...p,fileIds:['foreign']}]),false);assert.equal(validPages([{...p,fileIds:Array(51).fill(crypto.randomUUID())}]),false);
 assert.match(PAGE_CSP,/img-src data: blob:/);assert.match(PAGE_CSP,/frame-src blob:/);assert.match(PAGE_CSP,/media-src blob:/);assert.match(PAGE_CSP,/connect-src 'none'/);assert.match(PAGE_CSP,/object-src 'none'/);assert.doesNotMatch(PAGE_CSP,/allow-same-origin|https:/);
});
test('component file bridge caches local URLs, keeps raw bytes, rejects wrong message sources and revokes previews',async()=>{
 const id=crypto.randomUUID(),listeners=new Map(),requests=[],blobs=[],revoked=[];
 const parent={postMessage:message=>requests.push(message)},window={};
 const document={querySelector:()=>null,createElement:()=>({append(){},textContent:''}),head:{append(){}},body:{append(){}}};
 const sandbox={window,parent,document,addEventListener:(name,fn)=>listeners.set(name,fn),customElements:{get:()=>true},HTMLElement:class{},setTimeout:()=>1,clearTimeout(){},navigator:{userActivation:{isActive:false}},Blob,Uint8Array,URL:{createObjectURL:blob=>{blobs.push(blob);return 'blob:fixture-'+blobs.length;},revokeObjectURL:url=>revoked.push(url)}};
 const source=customPageDocument({id,component:{tag_name:'blob-preview',html:'',css:'',javascript:''}},id).match(/<script>([\s\S]*)<\/script>/)[1];vm.runInNewContext(source,sandbox);const api=window.finch;
 const first=api.readFile(id),second=api.readFile(id);assert.equal(requests.length,1);const request=requests[0];
 const bytes=new Uint8Array([1,2,3]).buffer,previewBytes=new TextEncoder().encode('<svg/>').buffer;
 const result={file:{id,name:'logo.svg'},preview:{kind:'image',type:'image/svg+xml'},bytes,preview_bytes:previewBytes};
 const deliver=source=>listeners.get('message')({source,data:{channel:'finch-page-result',token:id,id:request.id,result}});
 deliver({});assert.equal(blobs.length,0);deliver(parent);const read=await first;await second;assert.deepEqual(Array.from(read.bytes),[1,2,3]);assert.equal(await blobs[0].text(),'<svg/>');assert.equal(await api.getFileUrl(id),'blob:fixture-1');assert.equal(requests.length,1);
 await api.releaseFile(id);assert.deepEqual(revoked,['blob:fixture-1']);await assert.rejects(api.downloadFile(id),/Klik/);
 const again=api.readFile(id);assert.equal(requests.length,2);listeners.get('message')({source:parent,data:{channel:'finch-page-result',token:id,id:requests[1].id,error:'Filen er slettet'}});await assert.rejects(again,/slettet/);
 const pdf=api.renderPdfPage(id,{page_number:2,width:700});assert.equal(requests.at(-1).method,'render_pdf');listeners.get('message')({source:parent,data:{channel:'finch-page-result',token:id,id:requests.at(-1).id,result:{bytes:new Uint8Array([137,80,78,71]).buffer,page_number:2,page_count:3,width:700,height:500}}});const rendered=await pdf;assert.equal(rendered.page_count,3);assert.equal(rendered.url,'blob:fixture-2');assert.equal(blobs.at(-1).type,'image/png');await api.releaseFile(id);assert.deepEqual(revoked,['blob:fixture-1','blob:fixture-2']);
});
