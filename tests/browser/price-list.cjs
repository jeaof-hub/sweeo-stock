/* UI regression for the founder/owner price list. Supabase is simulated with FAKE prices.
 * No production data or permissions are touched. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const base = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const output = process.env.SCREENSHOT_DIR || '/tmp/sweeo-price-list';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const fake = [
  { sort_order: 1, category: 'Bulb', commercial_name: 'Test Bulb 5w', watt: '5W', pack_triplep: '10 x 10', pack_project: '10 x 10', triplep_ex_vat: 1.11, triplep_in_vat: 1.19, project_ex_vat: 2.22, project_in_vat: 2.38 },
  { sort_order: 2, category: 'Solar', commercial_name: 'Test Solar 100w (LED50W)', project_name: 'Test Solar 120w (LED50W)', watt: '50W', pack_triplep: '3', pack_project: '4', triplep_ex_vat: 1234.5, triplep_in_vat: 1320.92, project_ex_vat: null, project_in_vat: null },
];
const mock = role => `window.supabase={createClient(){
 window.priceCalls=0;
 function query(data,name){const q={then(a,b){if(name==='from:price_list')window.priceCalls++;return Promise.resolve({data,error:null}).then(a,b)}};for(const k of ['select','eq','is','not','order','range','limit','in','gte','lte'])q[k]=()=>q;return q;}
 return {
  rpc(name){return query(name==='my_role'?${JSON.stringify(role)}:name==='my_username'?'tester':[], 'rpc:'+name)},
  from(name){return query(name==='price_list'?${JSON.stringify(fake)}:[], 'from:'+name)},
  channel(){const c={on(){return c},subscribe(){return c}};return c},removeChannel(){},
  auth:{onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',{user:{id:'u1',email:'t@example.test'}}),0)},signOut(){return Promise.resolve({})}}
 };
}};`;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chrome });
  try {
    for (const [role, visible] of [['founder', true], ['owner', true], ['admin', false], ['warehouse', false], ['auditor', false]]) {
      for (const vp of [{ width: 390, height: 844, name: 'mobile' }, { width: 1280, height: 800, name: 'desktop' }]) {
        const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height }, serviceWorkers: 'block' });
        await page.route('**/supabase.js', r => r.fulfill({ contentType: 'application/javascript', body: mock(role) }));
        await page.addInitScript(() => localStorage.setItem('sweeo-language', 'th'));
        await page.goto(base); await page.waitForFunction(() => !document.getElementById('tabs').hidden); await page.waitForTimeout(500);
        assert.equal(await page.evaluate(() => !document.getElementById('tabPrices').hidden), visible, `${role} tab visibility`);
        if (visible) {
          await page.click('#tabPrices'); await page.waitForTimeout(300);
          assert.match(await page.textContent('#priceList'), /1,234\.50/);
          assert.match(await page.textContent('#priceList'), /TP 3 \/ PJ 4/);
          await page.fill('#priceQuery', '120w'); await page.waitForTimeout(100);
          assert.equal(await page.locator('#priceList .price-row:not(.price-row-head)').count(), 1);
          await page.fill('#priceQuery', '');
          await page.screenshot({ path: `${output}/${role}-${vp.name}.png`, fullPage: true });
        } else {
          assert.equal(await page.evaluate(() => window.priceCalls), 0, `${role} must not request prices`);
        }
        await page.close();
      }
    }
    console.log('price list browser test passed');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
