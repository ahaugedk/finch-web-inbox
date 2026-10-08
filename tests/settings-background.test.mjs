import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function fixture(){
  const listeners={},timers=[],organization={id:'test-org',name:'Test',revision:0};
  let writes=0,html='',release,paused=false,requests=0,dirty=false;
  const box={classList:{toggle(){},remove(){}},querySelectorAll:()=>[],querySelector:()=>({textContent:''}),contains:node=>!!node?.inSettings,
    get innerHTML(){return html;},set innerHTML(value){html=value;writes++;},get firstElementChild(){return html?{}:null;}};
  const document={activeElement:null,getElementById:id=>id==='settings-view'?box:null,addEventListener:(type,fn)=>listeners[type]=fn};
  const grid={configure(){},activate(){},dispose(){},reset(){},html:()=>'<div>Grid</div>',get dirty(){return dirty;}};
  const window={FinchStorage:{organization},FinchSettingsGrids:grid,FinchNotifications:{paint(){}},FinchData:{tool:async()=>({files:[]})},FinchBranding:{snapshot:()=>({revision:0}),logo:()=>''},FinchBrandModel:{defaults:{},current:()=>({})}};
  vm.runInNewContext(readFileSync('settings.js','utf8'),{window,document,FormData,AbortSignal,setTimeout:fn=>timers.push(fn),
    fetch:async()=>{requests++;const data={organizationRevision:organization.revision,canManage:true,roles:[{id:"r1",title:"Rolle "+organization.revision,description:"Lokalt ansvar"}],members:[],inbound:null};if(paused)await new Promise(resolve=>release=resolve);return {ok:true,json:async()=>data};}});
  const api=window.FinchSettings;api.configure({state:()=>({view:'settings'})});
  return {api,document,organization,box,timers,listeners,writes:()=>writes,requests:()=>requests,pause(){paused=true;},release(){paused=false;release();},dirty(value){dirty=value;},focus(){document.activeElement={inSettings:true,matches:()=>true,closest:()=>box};}};
}
test('settings defer a revision refresh while a clean control is focused and resume on blur',async()=>{
  const f=fixture();await f.api.render();const writes=f.writes(),requests=f.requests();f.focus();f.organization.revision++;
  await f.api.render({background:true});assert.equal(f.writes(),writes);assert.equal(f.requests(),requests);
  const input=f.document.activeElement;f.document.activeElement=null;f.listeners.focusout({target:input});f.timers.shift()();await f.api.render({background:true});
  assert.equal(f.writes(),writes+1);assert.equal(f.requests(),requests+1,'the deferred change must eventually reach the UI');
});
test('settings do not replace a control focused during an already running background request',async()=>{
  const f=fixture();await f.api.render();const writes=f.writes();f.organization.revision++;f.pause();const refresh=f.api.render({background:true});
  f.focus();f.release();await refresh;assert.equal(f.writes(),writes,'the post-request focus guard must preserve the actual input node');
  f.document.activeElement=null;await f.api.render({background:true});assert.equal(f.writes(),writes+1,'loaded but unrendered data must not be forgotten');
});
test('typing during a background request preserves a draft even after focus moves away',async()=>{
  const f=fixture();await f.api.render();const writes=f.writes();f.organization.revision++;f.pause();const refresh=f.api.render({background:true});f.dirty(true);f.release();await refresh;
  await f.api.render({background:true});assert.equal(f.writes(),writes);f.dirty(false);await f.api.render({background:true});assert.equal(f.writes(),writes+1);
});
