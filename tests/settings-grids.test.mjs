import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const team={canManage:true,roles:[{id:'r1',title:'Drift',description:'Ansvar i organisationen',revision:2}],members:[{id:'m1',name:'Maja',email:'maja@example.test',roleId:'r1',inGraph:true,revision:3,status:'active'},{id:'m2',name:'Bo',email:'bo@example.test',roleId:null,inGraph:false,revision:4,status:'invited'}],inbound:{revision:7,enabled:false,allowedSenders:['source@example.test'],members:[{email:'maja@example.test',name:'Maja',allowed:true}],recent:[]}};
function setup(){const window={};vm.runInNewContext(readFileSync('settings-grids.js','utf8'),{window,document:{addEventListener(){}},FormData,Set,Map});window.FinchSettingsGrids.configure({team:()=>team,statuses:{active:'Medlem',invited:'Inviteret'}});return window.FinchSettingsGrids;}
const data=values=>{const d=new FormData();for(const [k,v] of Object.entries(values))d.set(k,v);return d;};
test('bulk member edits retain individual names and revisions and only change the explicitly chosen fields',()=>{
 const api=setup(),editor={mode:'bulk',targets:team.members};const ops=api.operations('members',editor,data({roleId:'__keep__',graph:'hide'}));
 assert.equal(ops.length,2);assert.equal(ops[0].data.name,'Maja');assert.equal(ops[1].data.name,'Bo');assert.equal(ops[0].data.revision,3);assert.equal(ops[1].data.revision,4);assert.equal(ops[0].data.roleId,'r1');assert.equal(ops[1].data.roleId,null);assert.equal(ops[0].data.inGraph,false);
 const role=api.operations('members',editor,data({roleId:'r1',graph:'keep'}));assert.equal(role[1].data.roleId,'r1');assert.equal(role[0].data.inGraph,true);assert.equal(role[1].data.inGraph,false);
 assert.throws(()=>api.operations('members',editor,data({roleId:'__keep__',graph:'keep'})),/Vælg en ændring/);
});
test('grid detail saves use the displayed revision and cannot change a member email',()=>{
 const ops=setup().operations('members',{mode:'item',id:'m1'},data({__revision:1,name:'Nyt navn',roleId:'r1',email:'other@example.test',inGraph:'on'}));assert.equal(ops[0].data.revision,1);assert.equal(ops[0].data.email,undefined);assert.equal(ops[0].path,'/members/m1');
});
test('sender CRUD preserves mail enablement and unrelated sender settings',()=>{
 const api=setup();const create=api.operations('senders',{mode:'create'},data({email:'NEW@example.test'}))[0];assert.equal(create.data.enabled,false);assert.equal(create.data.revision,7);assert.deepEqual([...create.data.allowedSenders],['source@example.test','new@example.test']);assert.equal(create.data.blockedMembers,undefined);
 assert.throws(()=>api.operations('senders',{mode:'create'},data({email:'*@example.test'})),/jokertegn/);
 assert.throws(()=>api.operations('senders',{mode:'create'},data({email:'source@example.test'})),/findes allerede/);
});
test('role grid rows show assignment counts and role updates preserve stale versions for server conflict checks',()=>{
 const api=setup();assert.equal(api.rows('roles')[0].memberCount,1);const op=api.operations('roles',{mode:'item',id:'r1'},data({__revision:0,title:'Drift',description:'Opdateret ansvar'}))[0];assert.equal(op.data.revision,0);assert.equal(op.method,'PUT');assert.equal(op.path,'/roles/r1');
});
