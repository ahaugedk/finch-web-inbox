import test from 'node:test';
import assert from 'node:assert/strict';
import '../grid-ui.js';
const ui=globalThis.FinchGridUI;
test('selection freezes row revisions across background updates until the user explicitly reselects',()=>{
 const selected=new ui.Selection(),first={id:'a',revision:1,values:{name:'Før'}};selected.select([first]);first.values.name='Changed outside';selected.select([{id:'a',revision:2,values:{name:'Efter'}}]);
 assert.equal(selected.records[0].revision,1);assert.equal(selected.records[0].values.name,'Før');selected.clear();selected.select([{id:'a',revision:2}]);assert.equal(selected.records[0].revision,2);
});
test('batch deletion records partial success, keeps failed versions, and continues independent rows',async()=>{
 const items=[{id:'a',revision:0},{id:'b',revision:4},{id:'c',revision:2}],called=[];
 const result=await ui.batch(items,async item=>{called.push(item.id);if(item.id==='b')throw new Error('Rækken er ændret.');});
 assert.deepEqual(called,['a','b','c']);assert.deepEqual(result.succeeded.map(r=>r.id),['a','c']);assert.equal(result.failed[0].item.revision,4);assert.equal(result.failed[0].error.message,'Rækken er ændret.');
});
test('shared row forms preserve typed unchanged values and validate changes before sending',()=>{
 const columns=[{name:'name',type:'text',required:true},{name:'power',type:'number'},{name:'enabled',type:'boolean'},{name:'config',type:'json'},{name:'empty',type:'text'}];
 const original={name:'Motor',power:0,enabled:false,config:{kw:100},empty:''};
 assert.deepEqual(ui.recordValues(columns,original,{name:'Motor',power:'0',enabled:'false',config:'{"kw":100}',empty:''}),original);
 assert.equal(ui.recordValues(columns,original,{name:'Motor',power:'350',enabled:'true',config:'{"kw":100}',empty:''}).power,350);
 assert.throws(()=>ui.recordValues(columns,original,{name:'',power:'0',enabled:'false',config:'{"kw":100}',empty:''}),/feltet/);
 assert.throws(()=>ui.recordValues(columns,original,{name:'Motor',power:'NaN',enabled:'false',config:'{"kw":100}',empty:''}),/tal/);
});
test('row editor saves with a button click when sandboxed forms cannot submit',async()=>{
 function element(tag){return {tagName:tag.toUpperCase(),children:[],listeners:{},append(...nodes){this.children.push(...nodes);},setAttribute(){},addEventListener(name,fn){this.listeners[name]=fn;},showModal(){},close(){},remove(){this.removed=true;},reportValidity(){return true;}};}
 const body=element('body'),scope={structuredClone,document:{body,createElement:element,getElementById:()=>null}};
 const factory=new Function('return '+ui.factorySource)(),local=factory(scope),saved=[];
 const dialog=local.editRecord({columns:[{name:'name',type:'text',required:true}],record:{values:{name:'Test'},source_url:''},onSave:async value=>saved.push(value)});
 const visit=node=>[node,...node.children.flatMap(visit)],button=visit(dialog).find(node=>node.textContent==='Gem række');assert.equal(button.type,'button');
 await button.listeners.click({preventDefault(){}});assert.equal(saved.length,1);assert.deepEqual(saved[0],{values:{name:'Test'},source_url:''});assert.equal(dialog.removed,true);
});
