import test from 'node:test';
import assert from 'node:assert/strict';
import {sendLoginCode} from '../server/mail.mjs';
test('delivery diagnostics report only classified status and never provider secrets or mail content',async()=>{
  const original=globalThis.fetch,log=console.error,events=[];
  try{
    console.error=(...args)=>events.push(args);
    globalThis.fetch=async()=>Response.json({name:'validation_error',message:'private recipient and secret code'}, {status:403});
    await assert.rejects(sendLoginCode({RESEND_API_KEY:'private-api-key',EMAIL_FROM:'Finch <login@mail.finch.dk>'},{email:'private@example.test',code:'12345678',challengeId:'fake'}),/403/);
    assert.deepEqual(events,[['finch_mail_delivery_failed',{kind:'login',status:403,provider_error:'validation_error'}]]);
    assert.ok(!JSON.stringify(events).includes('private'));
    globalThis.fetch=async()=>Response.json({name:'private-api-key',message:'private'},{status:401});
    await assert.rejects(sendLoginCode({RESEND_API_KEY:'private-api-key',EMAIL_FROM:'test@example.test'},{email:'private@example.test',code:'12345678',challengeId:'fake'}),/401/);
    assert.equal(events.at(-1)[1].provider_error,'unavailable');
  }finally{globalThis.fetch=original;console.error=log;}
});
