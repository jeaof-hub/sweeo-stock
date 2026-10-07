/* Mobile UI regression for the display-only auditor → Executive rename.
 * Supabase is simulated. No production data or permissions are changed.
 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const output = process.env.SCREENSHOT_DIR || '/tmp/sweeo-executive-label';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const expected = { th: 'ผู้บริหาร', en: 'Executive', 'zh-TW': '主管' };

const mockClient = `window.supabase={createClient(){
 window.testDbCalls=[];
 function query(data,name){const q={then(a,b){window.testDbCalls.push(name);return Promise.resolve({data,error:null}).then(a,b)}};for(const k of ['select','eq','is','not','order','range','limit'])q[k]=()=>q;return q;}
 return {
  rpc(name){return query(name==='my_role'?'auditor':name==='my_username'?'executive':[], 'rpc:'+name)},
  from(name){return query([], 'from:'+name)},
  channel(){const c={on(){return c},subscribe(){return c}};return c},removeChannel(){},
  auth:{onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',{user:{id:'executive-user',email:'executive@example.test'}}),0)}}
 };
}};`;

(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:chrome});
 try {
  for(const lang of Object.keys(expected)){
   const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   await page.addInitScript(value=>localStorage.setItem('sweeo-language',value),lang);
   await page.route('https://fonts.googleapis.com/**',route=>route.abort());
   await page.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({body:''}));
   await page.route('**/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:mockClient}));
   await page.goto(base,{waitUntil:'networkidle'});
   await page.waitForFunction(label=>document.querySelector('#roleBadge')?.textContent===label,expected[lang]);
   assert.equal(await page.locator('#roleBadge').textContent(),expected[lang]);
   for(const selector of ['#actions','#newItemBtn','#outBtn','#inBtn','#exportBtn','#auditMenuBtn','#changesMenuBtn','#tabPending','#tabMine','#tabDeliveryNotes','#tabInvoices']){
    assert.equal(await page.locator(selector).evaluate(element=>element.hidden),true,`${lang} exposes ${selector}`);
   }
   assert.equal(await page.evaluate(()=>testDbCalls.includes('from:invoices')),false,`${lang} fetched hidden invoices`);
   assert.deepEqual(errors,[]);
   await page.screenshot({path:path.join(output,`executive-${lang}.png`),fullPage:true});
   console.log('PASS',lang,expected[lang]);
   await page.close();
  }
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
