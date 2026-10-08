import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const context = { window: {} };
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../dispatch-view.js', import.meta.url), 'utf8'), context);
const view = context.window.SWEEO_DISPATCH_VIEW;

test('delivery-note tab follows the requested role visibility', () => {
  for (const role of ['warehouse', 'admin', 'owner', 'founder']) assert.equal(view.canSeeDeliveryNotes(role), true, role);
  for (const role of ['auditor', '', null]) assert.equal(view.canSeeDeliveryNotes(role), false, String(role));
});

test('delivery-note list filters, searches and sorts newest first', () => {
  const rows = [
    { id: 'old', status: 'approved', delivery_note_no: 'DN-00001', customer: 'Alpha', document_date: '2026-09-01', created_at: '2026-09-01T00:00:00Z' },
    { id: 'new', status: 'pending', delivery_note_no: 'DN-00002', customer: 'Beta', document_date: '2026-10-02', created_at: '2026-10-02T00:00:00Z' }
  ];
  assert.deepEqual([...view.filterRequests(rows)].map(row => row.id), ['new', 'old']);
  assert.deepEqual([...view.filterRequests(rows, { query: 'alpha' })].map(row => row.id), ['old']);
  assert.deepEqual([...view.filterRequests(rows, { query: '2026-10-02' })].map(row => row.id), ['new']);
  assert.deepEqual([...view.filterRequests(rows, { query: '02/10/2569' })].map(row => row.id), ['new']);
  assert.deepEqual([...view.filterRequests(rows, { status: 'approved' })].map(row => row.id), ['old']);
});

test('invoice state is correct at delivery-note level', () => {
  const request = { id: 'a', status: 'approved' };
  const base = [{ request_id: 'a' }, { request_id: 'a' }];
  assert.equal(view.invoiceState(request, base), 'รอ INV');
  assert.equal(view.invoiceState(request, [{ ...base[0], invoice_id: 'inv' }, base[1]]), 'INV บางส่วน');
  assert.equal(view.invoiceState(request, [{ ...base[0], invoice_id: 'inv' }, { ...base[1], no_invoice_reason: 'free sample' }]), 'ครบ');
  assert.equal(view.invoiceState({ ...request, status: 'pending' }, base), '');
});

test('only pending drafts and approved delivery notes can be opened', () => {
  assert.equal(view.printLabel('pending'), 'ดูใบส่งของฉบับร่าง');
  assert.equal(view.printLabel('approved'), 'พิมพ์ / บันทึก PDF');
  assert.equal(view.printLabel('rejected'), '');
  assert.equal(view.printLabel('cancelled'), '');
});

test('app connects print actions to approval, immediate dispatch and INV cards', () => {
  const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
  assert.match(app, /showDispatchSuccess\(id, "อนุมัติคำขอและตัดยอดเรียบร้อยแล้ว"\)/);
  assert.match(app, /showDispatchSuccess\(savedRequestId, "เบิกสินค้าและตัดยอดเรียบร้อยแล้ว"\)/);
  assert.match(app, /data-print-request=/);
  assert.match(app, /approved_qty \?\? line\.requested_qty/);
  assert.doesNotMatch(app, /window\.open\(/);
  assert.match(app, /history\.pushState\(\{ \.\.\.history\.state, deliveryNote:true/);
  assert.match(app, /window\.addEventListener\('popstate'/);
  assert.match(app, /window\.addEventListener\('keydown'/);
  assert.match(app, /\$\('deliveryNotePrint'\)\.onclick=.*window\.print/);
});

test('delivery-note counts translate in English and Traditional Chinese', () => {
  const setup = lang => {
    const selector = { setAttribute() {}, addEventListener() {} };
    const body = { nodeType: 1, matches: () => false, hasAttribute: () => false, childNodes: [] };
    const c = { window: {}, localStorage: { getItem: () => lang }, document: { documentElement: {}, body, getElementById: () => selector }, Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, MutationObserver: class { observe() {} } };
    vm.createContext(c);
    for (const file of ['i18n-zh-TW.js', 'i18n.js']) vm.runInContext(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'), c);
    return c.window.SWEEO_I18N.translate;
  };
  assert.equal(setup('en')('12 ใบส่งของ'), '12 delivery notes');
  assert.equal(setup('zh-TW')('12 ใบส่งของ'), '12 張出貨單');
});
