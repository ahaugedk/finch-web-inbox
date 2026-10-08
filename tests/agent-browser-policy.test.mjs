import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const app=readFileSync('app.js','utf8');
function content(){const window={};vm.runInNewContext(readFileSync('content.js','utf8'),{window});return window.ORDERLY;}

test('briefing distinguishes background work from control of the human browser',()=>{
  const {BRIEFING,BROWSER_POLICY}=content();
  assert.equal(BRIEFING.browser_policy,BROWSER_POLICY);
  for(const word of ['klikke','scrolle','indtaste','DOM','genindlæse','skifte faner','navigere','webmcp.call','webmcp.listTools','show_view','focus: false','isolere'])assert.ok(BROWSER_POLICY.includes(word),word);
  assert.doesNotMatch(JSON.stringify(BRIEFING),/du må selv bygge siden|så vis grafen med focus: true|Test WebComponenten og dens dataforbindelse i browseren/);
});

test('both connection and work prompts contain the same browser policy',()=>{
  const window={ORDERLY:content(),FinchInvitation:{active:false},FinchStorage:{ready:false},FinchConnection:{url:()=> 'https://finch.test/'}};
  const source=app.slice(app.indexOf('  function buildPrompt()'),app.indexOf('  // ---------- Rendering ----------'));
  const prompt=vm.runInNewContext(source+';buildPrompt',{window});
  assert.ok(prompt().includes(window.ORDERLY.BROWSER_POLICY));
  window.FinchStorage.ready=true;
  assert.ok(prompt().includes(window.ORDERLY.BROWSER_POLICY));
  assert.doesNotMatch(prompt(),/Du har mandat til at bygge siden undervejs/);
});

test('invitation prompts protect the recipient browser too',()=>{
  const window={ORDERLY:content(),FinchConnection:{agentBrowser:false}};
  vm.runInNewContext(readFileSync('invitations.js','utf8'),{window,location:new URL('https://finch.test/?invite=11111111-1111-4111-8111-111111111111'),URL,URLSearchParams,document:{addEventListener(){}}});
  assert.ok(window.FinchInvitation.prompt().includes(window.ORDERLY.BROWSER_POLICY));
});

test('every tool result reminds existing agents, including login, timeout and errors',async()=>{
  let result;
  const window={ORDERLY:content()};
  const source=app.slice(app.indexOf('  async function runTool('),app.indexOf('  async function executeTool('));
  const run=vm.runInNewContext(source+';runTool',{window,executeTool:async()=>result});
  for(const status of ['ok','login_required','timeout','organization_changed','error']){
    result={status,guidance_for_agent:'Continue',error:status==='error'?'Invalid input':undefined};
    const actual=await run({},{});
    assert.equal(actual.status,status);assert.equal(actual.browser_policy,window.ORDERLY.BROWSER_POLICY);assert.equal(actual.guidance_for_agent,result.guidance_for_agent);
  }
});

test('agent-created tasks do not select, mark as read or open a new work item',()=>{
  const state={view:'inbox',selected:'T-human',selectedStick:'T-human',listFilter:'resolved',tasks:[],seq:0};
  const source=app.slice(app.indexOf('  function addTask('),app.indexOf('  function createQuestion('));
  const add=vm.runInNewContext(source+';addTask',{state,window:{FinchWork:{assignment:()=>({assigneeId:'human'})}},taskById:()=>null,clock:()=> '12.00',saveState(){},render(){},toast(){}});
  const task=add({title:'New agent question'});
  assert.equal(state.view,'inbox');assert.equal(state.selected,'T-human');assert.equal(state.selectedStick,'T-human');assert.equal(state.listFilter,'resolved');assert.equal(task.read,false);
});
