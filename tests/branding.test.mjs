import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import '../brand-model.js';
import {customPageDocument} from '../server/pages.mjs';
const model=globalThis.FinchBrandModel;
const base=()=>({revision:1,theme:{accent:'#003399',body_font:'Arial, sans-serif'},stylesheet:'.topbar { border-bottom: 3px solid #003399; }',fonts:[],logo:null,source_url:'https://example.org'});
test('branding rejects CSS network paths, injection values and unscoped asset URLs',()=>{
  assert.equal(model.validate(base()),null);
  for(const stylesheet of ['@import "https://example.org/x.css";','.a {background:u/**/rl(https://example.org)}','.a{background:u\\72l(https://example.org)}','@font-face{src:local(foo)}'])assert.ok(model.validate({...base(),stylesheet}));
  assert.ok(model.validate({...base(),theme:{accent:'red;display:none'}}));
  assert.ok(model.validate({...base(),logo:{data_url:'https://example.org/logo.svg',alt:'X'}}));
  assert.ok(model.validate({...base(),fonts:[{file_id:'11111111-1111-4111-8111-111111111111',family:"X'; src:url(x)",weight:400,style:'normal'}]}));
  assert.equal(model.validate(undefined),null);
});
test('branding tools merge changes, reject stale revisions and reset without altering work',async()=>{
  const state={tasks:[{id:'keep'}],pages:[{id:'keep-page'}]};const window={FinchBrandModel:model,FinchStorage:{organization:{id:'org-a'}},FinchData:{tool:async()=>{throw new Error('Foreign file');}}};
  const document={getElementById(){return null;},head:{append(){}}};
  class Sheet{cssRules=[];replaceSync(){}}
  vm.runInNewContext(readFileSync('branding.js','utf8'),{window,document,CSSStyleSheet:Sheet,CSSRule:{STYLE_RULE:1,KEYFRAMES_RULE:7},console});
  const api=window.FinchBranding;api.configure({state:()=>state,save(){},render(){}});
  await api.tool('set_branding',{revision:0,theme:{accent:'#003399'},source_url:'https://example.org'});
  await api.tool('set_branding',{revision:1,theme:{heading_font:'Georgia, serif'}});assert.equal(state.branding.theme.accent,'#003399');assert.equal(state.branding.theme.heading_font,'Georgia, serif');
  await assert.rejects(api.tool('set_branding',{revision:1,theme:{text:'#000000'}}),/ændret/);
  await assert.rejects(api.tool('set_branding',{revision:2,logo:{file_id:'11111111-1111-4111-8111-111111111111',alt:'Logo'}}),/Foreign/);assert.equal(state.branding.revision,2);
  await api.tool('reset_branding',{revision:2});assert.equal(state.branding.active,false);assert.equal(state.tasks[0].id,'keep');assert.equal(state.pages[0].id,'keep-page');
});
test('custom page theme variables, CSS, logos and embedded fonts arrive without account access',()=>{
  const brand={...base(),logo:{data_url:'data:image/png;base64,AAAA',alt:'Company'},fonts:[{file_id:'11111111-1111-4111-8111-111111111111',family:'Company Font',weight:400,style:'normal',data_url:'data:font/woff2;base64,AAAA'}]};
  const html=customPageDocument({id:'test',component:{tag_name:'test-page',html:'',css:'',javascript:''}},'token',brand);
  assert.match(html,/--petrol:#003399/);assert.match(html,/finch/);assert.match(html,/themeCss:config.themeCss/);assert.match(html,/data:font\/woff2;base64,AAAA/);assert.doesNotMatch(html,/\/api\/organizations\//);
});
