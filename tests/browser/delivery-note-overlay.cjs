/* Browser regression for the in-app delivery-note overlay and mobile back navigation. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const base = process.env.BASE_URL || 'http://127.0.0.1:8765/';
const output = process.env.SCREENSHOT_DIR || '/tmp/sweeo-delivery-overlay';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const requests = [
 {id:'req-approved',status:'approved',requester_id:'owner-user',requester_role:'owner',document_date:'2026-10-08',delivery_date:'2026-10-08',delivery_note_no:'TD-00001',customer:'Approved customer',doc_no:'',note:'',created_at:'2026-10-08T02:00:00Z'},
 {id:'req-pending',status:'pending',requester_id:'owner-user',requester_role:'owner',document_date:'2026-10-08',delivery_date:'2026-10-08',delivery_note_no:'TD-00002',customer:'Pending customer',doc_no:'',note:'',created_at:'2026-10-08T03:00:00Z'}
];
const lines = requests.map((request,index)=>({id:'line-'+index,request_id:request.id,item_id:'item-1',requested_qty:50,approved_qty:request.status==='approved'?40:null,purpose:'sale',return_required:false,line_note:''}));
const mockClient = `window.testPrintCount=0;window.print=()=>window.testPrintCount++;
window.supabase={createClient(){
 const tables={items:[{id:'item-1',active:true,code:'5991301118T',model:'LRM-KitW2228',spec:'SWEEO LED Circular 22W',type:'Retail',dept:'Retail',opening:100,avg_month:1,rop:1}],movements:[],stock_audit:[],dispatch_requests:${JSON.stringify(requests)},dispatch_request_lines:${JSON.stringify(lines)},invoices:[]};
 function query(data,name){const q={then(a,b){return Promise.resolve({data,error:null}).then(a,b)}};for(const k of ['select','eq','is','not','order','range','limit','abortSignal'])q[k]=()=>q;return q;}
 return {
  rpc(name){const data=name==='my_role'?'owner':name==='my_username'?'owner':name==='staff_display_names'?[{user_id:'owner-user',name:'Owner'}]:name==='dashboard_summary'?{}:[];return query(data,'rpc:'+name)},
  from(name){return query(tables[name]||[],'from:'+name)},
  channel(){const callbacks=[];const c={on(event,filter,cb){if(event==='postgres_changes')callbacks.push(cb);return c},subscribe(cb){setTimeout(()=>cb('SUBSCRIBED'),0);window.testChannelEvent=()=>callbacks.forEach(fn=>fn({}));return c}};return c},removeChannel(){},realtime:{setAuth(){}},
  auth:{onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',{access_token:'token',user:{id:'owner-user',email:'owner@example.test'}}),0)},signOut(){return Promise.resolve()}}
 };
}};`;

(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await chromium.launch({headless:true,executablePath:chrome});
 try {
  for(const device of [{name:'iphone-safari',width:390,height:844,isMobile:true,hasTouch:true},{name:'iphone-pwa',width:390,height:844,isMobile:true,hasTouch:true,standalone:true},{name:'android-chrome',width:412,height:915,isMobile:true,hasTouch:true},{name:'android-pwa',width:412,height:915,isMobile:true,hasTouch:true,standalone:true},{name:'desktop-chrome',width:1280,height:900,isMobile:false,hasTouch:false}]){
   const page=await browser.newPage({viewport:{width:device.width,height:device.height},isMobile:device.isMobile,hasTouch:device.hasTouch,reducedMotion:'reduce'});
   const errors=[];page.on('pageerror',error=>errors.push(error.message));
   if(device.standalone) await page.addInitScript(()=>{
    Object.defineProperty(navigator,'standalone',{configurable:true,value:true});
    const original=window.matchMedia.bind(window);
    window.matchMedia=query=>query==='(display-mode: standalone)'?{matches:true,media:query,addEventListener(){},removeEventListener(){}}:original(query);
   });
   await page.route('https://fonts.googleapis.com/**',route=>route.abort());
   await page.route('https://cdnjs.cloudflare.com/**',route=>route.fulfill({body:''}));
   await page.route('**/supabase.js',route=>route.fulfill({contentType:'application/javascript',body:mockClient}));
   await page.goto(base,{waitUntil:'networkidle'});
   await page.waitForFunction(()=>!document.querySelector('#tabDeliveryNotes').hidden);
   await page.click('#tabDeliveryNotes');
   await page.evaluate(()=>{document.body.style.minHeight='3000px';scrollTo(0,500)});
   await page.evaluate(()=>document.querySelector('[data-request="req-approved"] [data-request-action="delivery"]').click());
   await page.waitForFunction(()=>!document.querySelector('#deliveryNoteOverlay').hidden);
   assert.equal(await page.locator('#deliveryNoteOverlay .delivery-page').count(),2);
   assert.equal(await page.locator('#deliveryNoteOverlay .draft-mark').count(),0);
   assert.equal(await page.evaluate(()=>history.state?.deliveryNote),true);
   await page.evaluate(()=>testChannelEvent());
   await page.waitForTimeout(900);
   assert.equal(await page.locator('#deliveryNoteOverlay').evaluate(el=>el.hidden),false,'realtime reload closed overlay');
   await page.click('#deliveryNotePrint');
   assert.equal(await page.evaluate(()=>testPrintCount),1);
   await page.screenshot({path:path.join(output,device.name+'.png'),fullPage:false});
   if(device.name==='desktop-chrome') await page.pdf({path:path.join(output,'delivery-note.pdf'),format:'A4',landscape:true,printBackground:true});
   await page.click('#deliveryNoteBack');
   await page.waitForFunction(()=>document.querySelector('#deliveryNoteOverlay').hidden);
   await page.waitForFunction(()=>Math.abs(scrollY-500)<2);
   assert.equal(await page.evaluate(()=>history.state?.deliveryNote||false),false);
   await page.locator('[data-request="req-pending"] [data-request-action="delivery"]').click();
   await page.waitForFunction(()=>!document.querySelector('#deliveryNoteOverlay').hidden);
   assert.equal(await page.locator('#deliveryNoteOverlay .draft-mark').count(),2);
   await page.goBack();
   await page.waitForFunction(()=>document.querySelector('#deliveryNoteOverlay').hidden);
   await page.locator('[data-request="req-approved"] [data-request-action="delivery"]').click();
   await page.keyboard.press('Escape');
   await page.waitForFunction(()=>document.querySelector('#deliveryNoteOverlay').hidden);
   assert.deepEqual(errors,[]);
   console.log('PASS',device.name);
   await page.close();
  }
 } finally { await browser.close(); }
})().catch(error=>{console.error(error);process.exitCode=1});
