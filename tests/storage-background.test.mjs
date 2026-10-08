import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
test('incoming server work refreshes a hidden tab only while an agent waits, and navigation cannot overwrite newer work',async()=>{
  const elements=new Map(),listeners=new Map(),calls=[];let poll,waiting=false,lastState,loads=0,accountEvents=0,lastChange;
  const orgId='11111111-1111-1111-1111-111111111111';
  let server={organization:{id:orgId,name:'Test',revision:0},state:{agent:'Testagent',workspace:{name:'Test',tagline:''},tasks:[],pages:[],events:[],graph:{nodes:[],seq:0},seq:0,view:'inbox',listFilter:'open',selected:null},work:{}};
  const document={hidden:true,body:{appendChild(el){elements.set(el.id,el);}},getElementById:id=>elements.get(id),createElement:()=>({classList:{remove(){},add(){},toggle(){}},hidden:false,setAttribute(){},innerHTML:''}),addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent(){accountEvents++;}};
  const sandbox={window:{addEventListener(){}},document,location:{href:'https://finch.test/',origin:'https://finch.test',pathname:'/',search:''},history:{replaceState(){}},URL,structuredClone,AbortSignal,Response,CustomEvent:class{},setTimeout:()=>1,clearTimeout(){},clearInterval(){},setInterval:fn=>{poll=fn;return 1;},fetch:async(path,init)=>{
    calls.push({path,method:init.method,data:init.body&&JSON.parse(init.body)});
    if(path==='/api/me')return Response.json({user:{id:'owner',email:'owner@example.test'},organizations:[server.organization],lastOrgId:orgId,invitations:[]});
    if(init.method==='PUT'){const input=JSON.parse(init.body);assert.equal(input.revision,server.organization.revision);server={...server,state:input.state,organization:{...server.organization,revision:server.organization.revision+1}};return Response.json({organization:server.organization});}
    if(path.endsWith(`?revision=${server.organization.revision}`))return Response.json({unchanged:true});
    return Response.json(structuredClone(server));
  }};
  vm.runInNewContext(readFileSync('storage.js','utf8'),sandbox);const storage=sandbox.window.FinchStorage;
  await storage.initialize({onLoad:(s,change)=>{lastState=s;lastChange=change;loads++;},onOrganizationChange(){},shouldPollInBackground:()=>waiting});
  assert.equal(calls.length,2);await poll();assert.equal(calls.length,2);
  storage.changed({...lastState,view:'graph',selected:null});await storage.flush();assert.equal(calls.length,2);
  server={...server,organization:{...server.organization,revision:1},state:{...server.state,tasks:[{id:'S-201',kind:'case',phase:'active',inboundEmail:{id:'mail'}}]}};
  waiting=true;await poll();assert.equal(lastState.tasks[0].id,'S-201');assert.equal(lastState.view,'graph');assert.equal(storage.organization.revision,1);
  storage.changed({...lastState,workspace:{name:'Test',tagline:'Updated'}});await storage.flush();const saved=calls.at(-1);assert.equal(saved.method,'PUT');assert.equal(saved.data.state.tasks[0].id,'S-201');
  waiting=false;const before=calls.length;await poll();assert.equal(calls.length,before);document.hidden=false;await poll();assert.equal(calls.length,before+1);
  const beforeLoads=loads,beforeEvents=accountEvents;
  await storage.reloadCurrent();await storage.reloadCurrent();
  assert.equal(loads,beforeLoads,'reading identical state must not redraw the workspace');assert.equal(accountEvents,beforeEvents,'reading identical account data must not redraw the header');
  server={...server,organization:{...server.organization,revision:server.organization.revision+1}};await poll();
  assert.equal(loads,beforeLoads+1);assert.equal(lastChange.background,true);assert.equal(lastChange.revisionChanged,true);assert.equal(lastChange.workChanged,false);assert.equal(accountEvents,beforeEvents,'revision-only updates must keep account controls intact');
  server={...server,work:{members:[{name:'New responsibility'}]}};await storage.reloadCurrent();
  assert.equal(lastChange.workChanged,true,'role and assignment context updates must still reach the UI');
});
