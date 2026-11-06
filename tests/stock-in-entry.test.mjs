import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';

const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');

test('stock-in insert strips dispatch-only fields that movements does not have', () => {
  assert.doesNotMatch(app, /from\("movements"\)\.insert\(entryDraft\.rows\)/, 'raw draft rows must not be inserted into movements');
  assert.match(app, /from\("movements"\)\.insert\(entryDraft\.rows\.map\(movementRow\)\)/);
  const helper = app.match(/const movementRow = (\(\{[^)]*\}\) => \w+);/);
  assert.ok(helper, 'movementRow helper missing');
  const movementRow = eval(helper[1]);
  const row = movementRow({item_id: 'r1', kind: 'in', qty: 5, purpose: 'sale', return_required: false, line_note: '', customer: 'STOCK IN'});
  assert.deepEqual(row, {item_id: 'r1', kind: 'in', qty: 5, customer: 'STOCK IN'});
});

test('review dialog says stock-in adds stock instead of deducting it', () => {
  const line = app.split('\n').find(l => l.includes('$("erMode").textContent ='));
  assert.ok(line);
  assert.match(line, /entryDraft\.kind === "in" \? "รายการนี้จะเพิ่มยอดสต็อกทันที"/);
  assert.match(line, /"รายการนี้จะตัดยอดสต็อกทันที"/);
  for (const file of ['i18n.js', 'i18n-zh-TW.js']) {
    assert.ok(readFileSync(new URL('../' + file, import.meta.url), 'utf8').includes('"รายการนี้จะเพิ่มยอดสต็อกทันที"'), file);
  }
});
