import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const app=readFileSync('app.js','utf8');
function setup(){
  const window={};vm.runInNewContext(readFileSync('content.js','utf8'),{window});
  window.FinchOnboarding={agentContext:()=>({organization_profile:{description:'Documented brief'}})};
  const state={tasks:[],graph:{nodes:[]},captureDue:false};let saves=0;
  const sandbox={window,state,FREE_ID:'fritekst',saveState:()=>saves++,needsUser:()=>false,
    answersFor:(_,values)=>Object.entries(values).map(([id,value])=>({id,value})),taskById:id=>state.tasks.find(t=>t.id===id),compactGraph:()=>state.graph,caseFields:c=>c.values};
  const reply=app.slice(app.indexOf('  const learningReview='),app.indexOf('  function settleWaiters('));
  const events=app.slice(app.indexOf('  function eventPayload('),app.indexOf('  const undeliveredEvents'));
  const api=vm.runInNewContext(reply+events+';({answeredPayload,eventPayload})',sandbox);
  return {...api,state,policy:window.ORDERLY,saves:()=>saves};
}

test('all response branches include one shared learning review while preserving user edits and comments',()=>{
  for(const variant of [{},{mail:true},{pageProposalId:'page'}])for(const action of ['approve-page','reject-page','send','revise']){
    const f=setup(),task={id:'T-1',caseId:'S-1',title:'Decision',...variant,response:{via:'ui',action,values:{mail:{body:'Only for this customer'},fritekst:'This applies only to this case'}}};
    f.state.captureDue=true;const result=f.answeredPayload(task);
    assert.equal(result.learning_review.guidance,f.policy.LEARNING_REVIEW_INSTRUCTION);assert.equal(result.learning_review.source.case_id,'S-1');assert.equal(f.state.captureDue,true);assert.equal(task.response.seen,true);assert.equal(f.saves(),1);
    if(task.mail||task.pageProposalId)assert.equal(result.comment,task.response.values.fritekst);
    if(task.mail)assert.equal(result.email.body,'Only for this customer');
    assert.deepEqual(f.state.graph.nodes,[]);
  }
});

test('human content events, including requests, case edits, files, email and onboarding carry learning review',()=>{
  const f=setup();f.state.tasks.push({id:'S-1',title:'Case',dataRequest:{kind:'file'},manualRequest:{description:'Human request'},pageRequest:{name:'Human action'},values:{scope:'For this order'}});
  for(const type of f.policy.HUMAN_INPUT_EVENTS){
    f.state.captureDue=false;
    const ev={id:'E-'+type,type,caseId:'S-1',detail:{description:'Human context'}};const result=f.eventPayload(ev);
    assert.equal(result.status,type);assert.equal(result.learning_review.guidance,f.policy.LEARNING_REVIEW_INSTRUCTION);assert.equal(result.learning_review.source.event_id,ev.id);assert.equal(f.state.captureDue,true);assert.equal(ev.delivered,true);
  }
  assert.deepEqual(f.state.graph.nodes,[]);
});

test('technical events do not request learning or clear an existing pending review',()=>{
  const f=setup();let result=f.eventPayload({id:'E-heartbeat',type:'heartbeat'});assert.equal(result.learning_review,undefined);assert.equal(f.state.captureDue,false);
  f.state.captureDue=true;result=f.eventPayload({id:'E-sync',type:'sync_complete'});assert.equal(result.learning_review,undefined);assert.equal(f.state.captureDue,true);
});

test('the consolidated policy covers free chat and scope confirmation without unqualified graph-write instructions',()=>{
  const f=setup(),rules=f.policy.BRIEFING.learning_from_human_input.join(' ');
  for(const text of ['Også chatinput uden en tilknyttet opgave','Et enkelt udsagn eller valg om en konkret sag','den understøttede afgrænsning','en afgrænset gruppe eller generelt','Login-koder','simulerede mails','concepts: []','skip_reason'])assert.ok(rules.includes(text),text);
  assert.doesNotMatch(f.policy.BRIEFING.cases.join(' '),/og læg svaret i grafen/);
  assert.doesNotMatch(app,/præferencer \(læg det i grafen\)|complete_case, og læg det, du lærte, i grafen/);
});
