import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync,readdirSync} from 'node:fs';
import {sqliteD1} from '../scripts/sqlite-d1.mjs';
import {handleApi} from '../server/api.mjs';
const ORIGIN='https://finch.test';
async function fixture(){const DB=sqliteD1();for(const f of readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort())DB.sqlite.exec(readFileSync('drizzle/'+f,'utf8'));const env={DB,AUTH_SECRET:'connection-test-secret-at-least-32-characters'};const call=async(path,method='GET',data,origin=ORIGIN)=>{const r=await handleApi(new Request(ORIGIN+path,{method,headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.10',...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})}),env);return {status:r.status,data:await r.json()};};return {DB,call};}
test('a pre-login connection rendezvous carries no account access and connects both browsers idempotently',async()=>{
 const f=await fixture(),created=await f.call('/api/connections','POST',{});assert.equal(created.status,201);assert.equal(created.data.status,'waiting');const route='/api/connections/'+created.data.id;
 assert.equal((await f.call(route)).data.agent,null);assert.equal((await f.call(route+'/start','POST',{agent_name:'Codex'})).data.status,'connected');assert.equal((await f.call(route+'/start','POST',{agent_name:'Codex'})).status,200);assert.equal((await f.call(route)).data.agent,'Codex');
 assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM users').get().n,0);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM sessions').get().n,0);assert.equal((await f.call('/api/me?connect='+created.data.id)).status,401);assert.equal((await f.call('/api/organizations/'+created.data.id+'?connect='+created.data.id)).status,401);
 assert.deepEqual(Object.keys((await f.call(route)).data).sort(),['agent','expires_at','id','status']);
});
test('connection channels expire, reject foreign-origin mutations and are bounded by creation rate limits',async()=>{
 const f=await fixture(),created=await f.call('/api/connections','POST',{}),route='/api/connections/'+created.data.id;
 assert.equal((await f.call(route+'/start','POST',{agent_name:''})).status,400);assert.equal((await f.call(route+'/start','POST',{agent_name:'Codex'},'https://evil.test')).status,403);
 await f.DB.prepare('UPDATE agent_connections SET expires_at=0 WHERE id=?').bind(created.data.id).run();assert.equal((await f.call(route)).status,404);assert.equal((await f.call(route+'/start','POST',{agent_name:'Codex'})).status,404);
 for(let i=0;i<29;i++)assert.equal((await f.call('/api/connections','POST',{})).status,201);assert.equal((await f.call('/api/connections','POST',{})).status,429);assert.equal(f.DB.sqlite.prepare('SELECT COUNT(*) AS n FROM agent_connections').get().n,29);
});
function connectionBrowser(href,fetch,userAgent='Ordinary Chrome',modelApi=true){let poll;const location={href,search:new URL(href).search};const window={},context={window,location,navigator:{userAgent,modelContext:modelApi?{}:undefined},document:{hidden:false,modelContext:modelApi?{}:undefined,addEventListener(){}},history:{replaceState(_state,_title,url){location.href=String(url);location.search=new URL(url).search;}},URL,URLSearchParams,Response,AbortSignal,fetch,setInterval:fn=>{poll=fn;return 1;},clearInterval(){}};vm.runInNewContext(readFileSync('connection.js','utf8'),context);return {api:window.FinchConnection,poll:()=>poll?.(),location};}
test('ordinary browsers keep the connection page until an agent starts in another browser, without trusting WebMCP API presence',async()=>{
 let channel={id:'11111111-1111-4111-8111-111111111111',status:'waiting',agent:null,expires_at:Date.now()+100000};const fetch=async(path,init)=>{if(path.endsWith('/start'))channel={...channel,status:'connected',agent:JSON.parse(init.body).agent_name};return Response.json({...channel});};
 const human=connectionBrowser(ORIGIN+'/?org=22222222-2222-4222-8222-222222222222',fetch);let humanLogins=0,agentLogins=0;
 await human.api.initialize({onChange(){},onConnected:async()=>humanLogins++});assert.equal(human.api.agentBrowser,false);assert.equal(human.api.connected,false);assert.equal(humanLogins,0);assert.ok(human.api.url().includes('org=22222222'));assert.ok(human.api.url().includes('ua=agent'));
 const agent=connectionBrowser(human.api.url(),fetch,'Codex');await agent.api.initialize({onChange(){},onConnected:async()=>agentLogins++});assert.equal(agent.api.agentBrowser,true);assert.equal(agentLogins,0);
 assert.equal(agent.api.loginAllowed,true);assert.equal(human.api.loginAllowed,false);
 await agent.api.start('Codex');assert.equal(agentLogins,1);await human.poll();assert.equal(humanLogins,1);assert.equal(human.api.connected,true);assert.equal(human.api.loginAllowed,false);await human.poll();assert.equal(humanLogins,1);
 for(const ua of ['Claude/1.0','GitHubCopilot/1.0','VSCode/1.0','ChatGPT/1.0'])assert.equal(connectionBrowser(ORIGIN,fetch,ua).api.agentBrowser,true);
 assert.equal(connectionBrowser(ORIGIN,fetch,'Electron/40.0 Chrome/144').api.loginAllowed,false);
});
test('ordinary browsers never load account data or show login even after another browser connects',async()=>{
 const elements=new Map(),calls=[];const window={FinchConnection:{connected:false,loginAllowed:false},addEventListener(){}};
 const document={body:{appendChild(el){elements.set(el.id,el);}},getElementById:id=>elements.get(id),createElement:()=>({hidden:false,setAttribute(){},classList:{remove(){},add(){}},innerHTML:''}),addEventListener(){},dispatchEvent(){}};
 vm.runInNewContext(readFileSync('storage.js','utf8'),{window,document,location:{href:ORIGIN+'/',origin:ORIGIN,pathname:'/'},history:{replaceState(){}},URL,Response,AbortSignal,CustomEvent:class{},setInterval(){return 1;},clearInterval(){},setTimeout(){return 1;},fetch:async path=>{calls.push(path);return Response.json({error:'login_required',message:'Log ind'},{status:401});}});
 await window.FinchStorage.initialize({onLoad(){},onOrganizationChange(){},deferUntilConnected:true});await window.FinchStorage.activate();assert.deepEqual(calls,[]);assert.equal(elements.get('account-gate').hidden,true);assert.ok(!elements.get('account-gate').innerHTML.includes('login-form'));
 window.FinchConnection.connected=true;await window.FinchStorage.activate();assert.deepEqual(calls,[]);assert.equal(elements.get('account-gate').hidden,true);
 window.FinchConnection.loginAllowed=true;await window.FinchStorage.activate();assert.deepEqual(calls,['/api/me']);assert.equal(elements.get('account-gate').hidden,false);assert.ok(elements.get('account-gate').innerHTML.includes('login-form'));
});
function loginWaitBrowser(){
 const elements=new Map(),listeners=new Map(),timers=new Map(),intervals=new Map(),calls=[];let next=0,authenticated=false;
 const organization={id:'22222222-2222-4222-8222-222222222222',name:'Testorganisation',revision:0};
 const state={tasks:[],graph:{nodes:[],edges:[]},events:[]};
 const window={FinchConnection:{connected:true,loginAllowed:true},addEventListener(){}};
 const document={body:{appendChild(el){elements.set(el.id,el);}},getElementById:id=>elements.get(id),createElement:()=>({hidden:false,setAttribute(){},classList:{remove(){},add(){}},innerHTML:''}),
   addEventListener(name,fn){if(!listeners.has(name))listeners.set(name,new Set());listeners.get(name).add(fn);},removeEventListener(name,fn){listeners.get(name)?.delete(fn);},dispatchEvent(ev){for(const fn of [...(listeners.get(ev.type)||[])])fn(ev);}};
 vm.runInNewContext(readFileSync('storage.js','utf8'),{window,document,location:{href:ORIGIN+'/',origin:ORIGIN,pathname:'/'},history:{replaceState(){}},URL,Response,AbortSignal,structuredClone,CustomEvent:class{constructor(type){this.type=type;}},
   setInterval(fn,ms){const id=++next;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),setTimeout(fn,ms){const id=++next;timers.set(id,{fn,ms});return id;},clearTimeout:id=>timers.delete(id),
   fetch:async path=>{calls.push(path);if(path==='/api/me')return authenticated?Response.json({user:{id:'user',email:'demo@example.test'},organizations:[]}):Response.json({error:'login_required',message:'Log ind'},{status:401});if(path==='/api/organizations')return Response.json({organization,state});throw new Error('Unexpected route '+path);}});
 return {api:window.FinchStorage,connection:window.FinchConnection,elements,listeners,timers,intervals,calls,authenticate(){authenticated=true;}};
}
test('agent environments can log in and fill the profile before start_conversation',async()=>{
 const b=loginWaitBrowser();b.connection.connected=false;await b.api.initialize({onLoad(){},onOrganizationChange(){}});
 assert.deepEqual(b.calls,['/api/me']);assert.equal(b.elements.get('account-gate').hidden,false);assert.ok(b.elements.get('account-gate').innerHTML.includes('login-form'));
 b.authenticate();await b.api.activate({checkSession:true});assert.ok(b.elements.get('account-gate').innerHTML.includes('organization-form'));assert.equal(b.api.ready,false);
 await b.api.create('Testorganisation',null,{description:'Et lokalt testprojekt',roleTitle:'Ejer'});assert.equal(b.api.ready,true);assert.equal(b.connection.connected,false);
});
test('login wait detects a verified login in another tab but waits for organisation creation without replacing the profile form',async()=>{
 const b=loginWaitBrowser();await b.api.initialize({onLoad(){},onOrganizationChange(){},deferUntilConnected:true});
 let finished=false;const waiting=b.api.waitForReady({timeout_seconds:40}).then(r=>{finished=true;return r;});await b.api.activate();
 assert.ok(b.elements.get('account-gate').innerHTML.includes('login-form'));assert.equal(finished,false);
 b.authenticate();await [...b.intervals.values()].find(t=>t.ms===4000).fn();assert.ok(b.elements.get('account-gate').innerHTML.includes('organization-form'));assert.equal(finished,false);
 const count=b.calls.length;await [...b.intervals.values()].find(t=>t.ms===4000).fn();assert.equal(b.calls.length,count);
 await b.api.create('Testorganisation',null,{description:'Et lokalt testprojekt',roleTitle:'Ejer'});assert.equal((await waiting).status,'ready');assert.equal(b.api.ready,true);assert.equal(b.listeners.get('finch-account-change').size,0);assert.equal(b.timers.size,0);assert.equal([...b.intervals.values()].filter(t=>t.ms===4000).length,0);
});
test('login waits time out or cancel cleanly without granting access or discarding the login form',async()=>{
 const b=loginWaitBrowser();await b.api.initialize({onLoad(){},onOrganizationChange(){},deferUntilConnected:true});
 const timed=b.api.waitForReady({timeout_seconds:1});await b.api.activate();const form=b.elements.get('account-gate').innerHTML;
 [...b.timers.values()].find(t=>t.ms===1000).fn();assert.equal((await timed).status,'timeout');assert.equal(b.api.ready,false);assert.equal(b.elements.get('account-gate').innerHTML,form);
 const abort=new AbortController(),cancelled=b.api.waitForReady({signal:abort.signal});abort.abort();assert.equal((await cancelled).status,'cancelled');
 assert.equal(b.listeners.get('finch-account-change').size,0);assert.equal(b.timers.size,0);assert.equal(b.intervals.size,0);
 assert.equal((await b.api.waitForReady({signal:abort.signal})).status,'cancelled');assert.equal(b.intervals.size,0);
});
