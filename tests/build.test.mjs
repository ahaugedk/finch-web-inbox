import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

test('production Worker serves the account UI and fails closed without runtime bindings', async () => {
  execFileSync(process.execPath, ['scripts/build.mjs']);
  const { default: worker } = await import('../dist/server/index.js');
  const page = await worker.fetch(new Request('https://finch.test/'), {});
  assert.equal(page.status, 200); assert.match(await page.text(), /storage\.js/);
  const storage = await worker.fetch(new Request('https://finch.test/storage.js'), {});
  assert.equal(storage.status, 200); assert.match(await storage.text(), /\/api\/me/);
  const notifications=await worker.fetch(new Request('https://finch.test/notifications.js'),{});
  assert.equal(notifications.status,200);assert.match(await notifications.text(),/requestPermission/);
  const sw=await worker.fetch(new Request('https://finch.test/notification-sw.js'),{});
  assert.equal(sw.status,200);assert.match(sw.headers.get('Content-Type'),/javascript/);assert.match(await sw.text(),/notificationclick/);
  const pdf=await worker.fetch(new Request('https://finch.test/assets/pdfjs/pdf.min.mjs'),{});assert.equal(pdf.status,200);assert.match(pdf.headers.get('Content-Type'),/javascript/);assert.equal(await pdf.text(),readFileSync('assets/pdfjs/pdf.min.mjs','utf8'));
  assert.equal((await worker.fetch(new Request('https://finch.test/.env'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://finch.test/server/api.mjs'), {})).status, 404);
  assert.equal((await worker.fetch(new Request('https://finch.test/api/me'), {})).status, 503);
  const source = readFileSync('dist/server/index.js', 'utf8');
  assert.doesNotMatch(source, /LOCAL ONLY|local-development-secret|Login code for/);
  const hosting = JSON.parse(readFileSync('dist/.openai/hosting.json', 'utf8'));
  assert.equal(hosting.d1, 'DB'); assert.equal(hosting.static, undefined);
});
