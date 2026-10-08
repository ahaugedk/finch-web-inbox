import test from 'node:test';
import assert from 'node:assert/strict';
import '../site-config.js';
const site=globalThis.FinchSite;
test('existing Finch contact links move domains without rewriting other organizations email data',()=>{
  assert.equal(site.contactUrl('mailto:hello@orderly.ai?subject=Hej'),'mailto:hello@finch.dk?subject=Hej');
  assert.equal(site.contactUrl('mailto:other@orderly.ai'),'mailto:other@orderly.ai');
  assert.equal(site.contactUrl('mailto:hello@orderly.ai.example'),'mailto:hello@orderly.ai.example');
});
test('hosted prompts move to Finch while preserving organization, connection and invitation fragments',()=>{
  const old='https://mcp.orderly.ai/?org=org-id&connect=connection-id#invite=private-token';
  const url=site.canonicalUrl(old);
  assert.equal(url.origin,'https://mit.finch.dk');
  assert.equal(url.search,'?org=org-id&connect=connection-id');
  assert.equal(url.hash,'#invite=private-token');
  assert.equal(site.canonicalUrl('http://127.0.0.1:8787/?org=local').href,'http://127.0.0.1:8787/?org=local');
  assert.equal(site.canonicalUrl('https://unrelated.example/').origin,'https://unrelated.example');
});
test('legacy navigation redirects but APIs, webhooks, assets and local previews stay on their original origin',()=>{
  assert.equal(site.navigationRedirect(new Request('https://mcp.orderly.ai/?connect=connection-id')),'https://mit.finch.dk/?connect=connection-id');
  for(const url of ['https://mcp.orderly.ai/api/webhooks/resend/inbound','https://mcp.orderly.ai/app.js','http://127.0.0.1:8787/','https://mit.finch.dk/'])assert.equal(site.navigationRedirect(new Request(url)),null);
  assert.equal(site.navigationRedirect(new Request('https://mcp.orderly.ai/',{method:'POST'})),null);
  assert.equal(site.publicOrigin('https://mcp.orderly.ai/api/','https://mit.finch.dk'),'https://mit.finch.dk');
  assert.equal(site.publicOrigin('http://localhost:8787/api/','https://mit.finch.dk'),'http://localhost:8787');
  assert.throws(()=>site.publicOrigin('https://mit.finch.dk/api/','http://mit.finch.dk'));
  assert.throws(()=>site.publicOrigin('https://mit.finch.dk/api/','https://mit.finch.dk/unsafe'));
});
