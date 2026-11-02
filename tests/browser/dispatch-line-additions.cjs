/* Browser regression for adding a product to an approved delivery note.
 * Supabase is simulated. No production data or permissions are changed.
 * Run: python3 -m http.server 8765 & node tests/browser/dispatch-line-additions.cjs
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const output = process.env.SCREENSHOT_DIR || '/tmp/sweeo-add-line';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const request = {id:'req-1',status:'approved',requester_id:'wh-user',requester_role:'warehouse',document_date:'2026-11-02',delivery_date:'2026-11-02',delivery_note_no:'TD-20261102-00070',customer:'Pine Field',doc_no:'',note:'',created_at:'2026-11-02T02:00:00Z'};
const lines = [{id:'line-1',request_id:'req-1',item_id:'item-1',code:'5991301118T',model:'LRM-KitW2228',requested_qty:10,approved_qty:10,purpose:'sale',return_required:false,line_note:'',movement_id:'mv-1'}];
const items = [
 {id:'item-1',active:true,code:'5991301118T',model:'LRM-KitW2228',spec:'SWEEO LED Circular 22W',type:'Retail',dept:'Retail',opening:100,avg_month:1,rop:1},
 {id:'item-2',active:true,code:'5991100501T',model:'LHC-LD50-6570140-FL',spec:'LED Street Light 50W 6500K',type:'Project',dept:'Project',opening:40,avg_month:1,rop:1}
];

function mockClient(userId, role, additions) {
 return `window.testRpc=[];
window.supabase={createClient(){
 const tables={items:${JSON.stringify(items)},movements:[],stock_audit:[],dispatch_requests:${JSON.stringify([request])},dispatch_request_lines:${JSON.stringify(lines)},dispatch_line_additions:${JSON.stringify(additions)},invoices:[]};
 function query(data){const q={then(a,b){return Promise.resolve({data,error:null}).then(a,b)}};for(const k of ['select','eq','is','not','order','range','limit','abortSignal','lt'])q[k]=()=>q;return q;}
 return {
  rpc(name,args){window.testRpc.push({name,args});const data=name==='my_role'?'${role}':name==='my_username'?'${role}':name==='staff_display_names'?[{user_id:'founder-user',name:'Aof'},{user_id:'admin-user',name:'Admin A'},{user_id:'wh-user',name:'Aui'}]:name==='dashboard_summary'?{}:name.endsWith('_addition')?'ok':[];return query(data)},
  from(name){return query(tables[name]||[])},
  channel(){const c={on(){return c},subscribe(cb){setTimeout(()=>cb('SUBSCRIBED'),0);return c}};return c},removeChannel(){},realtime:{setAuth(){}},
  auth:{onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',{access_token:'token',user:{id:'${userId}',email:'${role}@example.test'}}),0)},signOut(){return Promise.resolve()},getSession(){return Promise.resolve({data:{session:{access_token:'token'}},error:null})}}
 };
}};`;
}

const pending = [{id:'add-1',request_id:'req-1',item_id:'item-2',qty:5,purpose:'gift',return_required:true,line_note:'แถมลูกค้า',status:'pending',requested_by:'admin-user',requested_at:'2026-11-02T05:00:00Z'}];

async function open(browser, userId, role, additions, viewport) {
 const page = await browser.newPage({viewport, isMobile: viewport.width < 600, hasTouch: viewport.width < 600, reducedMotion:'reduce'});
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'ไม่ต้องแถม' : undefined));
 await page.route('https://fonts.googleapis.com/**', r => r.abort());
 await page.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({body:''}));
 await page.route('**/supabase.js', r => r.fulfill({contentType:'application/javascript', body: mockClient(userId, role, additions)}));
 await page.goto(base, {waitUntil:'networkidle'});
 await page.waitForFunction(() => !document.querySelector('#tabDeliveryNotes').hidden);
 await page.click('#tabDeliveryNotes');
 await page.waitForSelector('[data-request="req-1"]');
 return { page, errors };
}

(async () => {
 fs.mkdirSync(output, {recursive:true});
 const browser = await chromium.launch({headless:true, executablePath: chrome});
 try {
  // 1. Reviewer (founder) sees the pending addition, can approve/reject, cannot print or set INV.
  {
   const { page, errors } = await open(browser, 'founder-user', 'founder', pending, {width:390, height:844});
   const card = page.locator('#deliveryNoteList [data-request="req-1"]');
   assert.equal(await card.locator('[data-add-approve="add-1"]').count(), 1, 'approve button missing');
   assert.equal(await card.locator('[data-add-reject="add-1"]').count(), 1, 'reject button missing');
   assert.equal(await card.locator('[data-request-action="delivery"]').count(), 0, 'print must be hidden while pending');
   assert.equal(await card.locator('[data-request-action="invoice"]').count(), 0, 'INV must be hidden while pending');
   assert.match(await card.innerText(), /รออนุมัติเพิ่มสินค้า/);
   await card.screenshot({path: path.join(output, 'reviewer-card-mobile.png')});
   await card.locator('[data-add-approve="add-1"]').click();
   await page.waitForFunction(() => testRpc.some(c => c.name === 'approve_dispatch_line_addition'));
   assert.deepEqual(await page.evaluate(() => testRpc.find(c => c.name === 'approve_dispatch_line_addition').args), {p_addition_id:'add-1'});
   await page.click('#tabPending');
   assert.equal(await page.locator('#pendingList [data-add-approve="add-1"]').count(), 1, 'pending tab must list the addition');
   assert.match(await page.locator('#pendingBadge').innerText(), /1/);
   await page.locator('#pendingList [data-request="req-1"]').screenshot({path: path.join(output, 'pending-tab-mobile.png')});
   assert.deepEqual(errors, []);
   await page.close();
  }
  // 2. The admin who proposed it can only cancel, not approve.
  {
   const { page, errors } = await open(browser, 'admin-user', 'admin', pending, {width:1280, height:900});
   const card = page.locator('#deliveryNoteList [data-request="req-1"]');
   assert.equal(await card.locator('[data-add-approve]').count(), 0, 'adder must not see approve');
   assert.equal(await card.locator('[data-add-cancel="add-1"]').count(), 1, 'adder should see cancel');
   assert.equal(await page.locator('#tabPending').isHidden() || (await page.locator('#pendingBadge').innerText()).trim() === '', true, 'own addition must not count as reviewable');
   assert.deepEqual(errors, []);
   await page.close();
  }
  // 3. With nothing pending: add-product dialog submits the proposal with all fields.
  {
   const { page, errors } = await open(browser, 'founder-user', 'founder', [], {width:390, height:844});
   const card = page.locator('#deliveryNoteList [data-request="req-1"]');
   assert.equal(await card.locator('[data-request-action="delivery"]').count(), 1, 'print visible when nothing pending');
   await card.locator('[data-add-line="req-1"]').click();
   await page.waitForSelector('#dAddLine[open]',{timeout:5000}).catch(e=>{throw new Error('add dialog did not open; page errors: '+JSON.stringify(errors))});
   const box = page.locator('#addLineBox');
   await box.locator('.picker input').fill('LRM-KitW2228');
   await box.locator('.sugg button[data-i="0"]').click();
   await box.locator('.qtyin').fill('3');
   await page.click('#addLineSave');
   assert.match(await page.locator('#addLineMsg').innerText(), /มีอยู่ในใบแล้ว/, 'duplicate active item must be blocked client-side');
   await box.locator('.picker input').fill('LHC-LD50');
   await box.locator('.sugg button[data-i="0"]').click();
   await box.locator('.qtyin').fill('5');
   await box.locator('.purpose').selectOption('gift');
   await box.locator('.return-required').check();
   await box.locator('.line-note').fill('แถมลูกค้า');
   await page.locator('#dAddLine .dlg').screenshot({path: path.join(output, 'add-dialog-mobile.png')});
   await page.click('#addLineSave');
   await page.waitForFunction(() => testRpc.some(c => c.name === 'request_dispatch_line_addition'));
   assert.deepEqual(await page.evaluate(() => testRpc.find(c => c.name === 'request_dispatch_line_addition').args),
     {p_request_id:'req-1',p_item_id:'item-2',p_qty:5,p_purpose:'gift',p_return_required:true,p_line_note:'แถมลูกค้า'});
   assert.deepEqual(errors, []);
   await page.close();
  }
  // 4. Warehouse never sees the add button.
  {
   const wh = await browser.newPage({viewport:{width:390,height:844}});
   await wh.route('https://fonts.googleapis.com/**', r => r.abort());
   await wh.route('https://cdnjs.cloudflare.com/**', r => r.fulfill({body:''}));
   await wh.route('**/supabase.js', r => r.fulfill({contentType:'application/javascript', body: mockClient('wh-user','warehouse',[])}));
   await wh.goto(base, {waitUntil:'networkidle'});
   await wh.waitForTimeout(800);
   assert.equal(await wh.locator('[data-add-line]').count(), 0, 'warehouse must not see add button');
   await wh.close();
  }
  console.log('dispatch line additions browser regression: PASS');
 } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exit(1); });
