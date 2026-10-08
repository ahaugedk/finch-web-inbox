import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync('content.js', 'utf8'), context);
const validate = context.window.ORDERLY.validateKnowledgeInput;
const qualified = { text: 'Hastefragt over 5.000 kr. godkendes af [[Disponent]].', organization_specific_reason: 'Brugeren bekræftede denne konkrete godkendelsesgrænse som organisationens interne mandat.' };
const input = (statements) => ({ concepts: [{ label: 'Hastefragt', type: 'regel', statements }] });

test('unqualified statements are rejected before any graph write', () => {
  assert.ok(validate(input(['En motor leverer kraft til lastbilen.'])));
  assert.ok(validate(input([{ text: 'En motor leverer kraft til lastbilen.' }])));
  assert.ok(validate(input([{ text: qualified.text, organization_specific_reason: 'Specifikt.' }])));
});
test('every statement in a mixed batch must have its own organizational basis', () => {
  assert.equal(validate(input([qualified])), null);
  assert.ok(validate(input([qualified, { text: 'Planlægning er vigtigt.' }])));
  assert.ok(validate({ concepts: [{ label: 'Begreb', statements: [] }] }));
});
test('an answer with no new organizational knowledge can be acknowledged without writing facts', () => {
  assert.equal(validate({ concepts: [], skip_reason: 'Svaret bekræftede kun noget, der allerede står i grafen.' }), null);
  assert.ok(validate({ concepts: [] }));
  assert.ok(validate({ ...input([qualified]), skip_reason: 'Ingen ny viden.' }));
});
