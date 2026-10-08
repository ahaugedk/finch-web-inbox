import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
function page(url,agentBrowser=false){
  const calls=[],listeners=new Map();let accepted=false;const window={FinchConnection:{agentBrowser}};
  vm.runInNewContext(readFileSync('content.js','utf8'),{window});
  vm.runInNewContext(readFileSync('invitations.js','utf8'),{window,location:new URL(url),URL,URLSearchParams,Response,AbortSignal,
    document:{addEventListener(name,fn){listeners.set(name,fn);}},fetch:async(path,options)=>{calls.push({path,...options});if(path.endsWith('/accept'))accepted=true;return Response.json({invitation:{status:accepted?'accepted':'invited',organizationName:'Testorganisation',organizationId:'22222222-2222-4222-8222-222222222222',expiresAt:Date.now()+86400000}});}});
  return {api:window.FinchInvitation,calls,async accept(){listeners.get('click')({target:{closest:()=>({dataset:{invitation:'accept'}})}});await new Promise(resolve=>setImmediate(resolve));}};
}
test('ordinary-browser invitations inspect and accept with no cookie and copy an agent URL that contains no invitation token',async()=>{
  const token='b'.repeat(64),p=page('https://finch.test/#invite='+token);assert.equal(p.api.active,true);await p.api.initialize({onChange(){}});
  assert.match(p.api.html(),/Acceptér invitation/);assert.doesNotMatch(p.api.html(),/login-form|Oplev finch/);assert.deepEqual(p.calls.map(c=>c.path),['/api/invitation-links/inspect']);
  await p.accept();assert.match(p.api.html(),/Invitationen er/);assert.match(p.api.html(),/accepteret/);assert.match(p.api.prompt(),/ua=agent&org=22222222/);assert.ok(!p.api.prompt().includes(token));
  assert.ok(p.calls.every(c=>c.credentials==='omit'));assert.ok(!p.calls.some(c=>c.path==='/api/me'||c.path.includes('/auth/')||c.path.includes('/connections')));
});
test('legacy record-id links have a dedicated explanation while agent browsers retain verified legacy acceptance',async()=>{
  const url='https://finch.test/?invite=11111111-1111-4111-8111-111111111111',p=page(url);assert.equal(p.api.active,true);await p.api.initialize({onChange(){}});assert.match(p.api.html(),/ældre invitationslink/);assert.equal(p.calls.length,0);assert.match(p.api.prompt(),/ua=agent&invite=/);assert.equal(page(url,true).api.active,false);
});
