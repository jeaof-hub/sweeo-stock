/* Run with Playwright available in NODE_PATH and a local web server on BASE_URL.
 * Camera streams and OCR are simulated; these are not physical-device tests.
 * ENGINE=webkit tests WebKit; ENGINE=chromium uses Chrome via CHROME_PATH.
 */
const {chromium,webkit}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const engine=process.env.ENGINE||'chromium';
const output=process.env.SCREENSHOT_DIR||'/tmp/sweeo-scanner-dialog';
const base=process.env.BASE_URL||'http://127.0.0.1:8765/';
const mockClient=`window.supabase={createClient(){
 const items=[['r046','5991301242T','LSA-T8C090628-G'],['r047','5991301252T','LSA-T8C090628-GS'],['r178','5991600051T','LHC-TTG01-200-65']].map(([id,code,model],i)=>({id,code,model,spec:'SWEEO LED',type:'LED',dept:'Retail',opening:1000,rop:40,avg_month:10,active:true,sort_order:i+1}));
 function query(data){const q={then(a,b){return Promise.resolve({data,error:null}).then(a,b)}};for(const k of ['select','eq','is','not','order','range','limit'])q[k]=()=>q;return q;}
 return {rpc(n){return query(n==='my_role'?'warehouse':n==='my_username'?'preview':[]);},from(n){return query(n==='items'?items:[]);},channel(){const c={on(){return c},subscribe(){return c}};return c;},removeChannel(){},auth:{onAuthStateChange(cb){setTimeout(()=>cb('INITIAL_SESSION',{user:{id:'preview',email:'preview@example.test'}}),0);}}};}};`;
(async()=>{
 fs.mkdirSync(output,{recursive:true});
 const browser=await (engine==='webkit'?webkit:chromium).launch({headless:true,...(engine==='chromium'?{executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const page=await browser.newPage({viewport:{width:engine==='webkit'?390:412,height:844},deviceScaleFactor:1,isMobile:true,hasTouch:true,reducedMotion:'reduce'});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://fonts.googleapis.com/**',r=>r.abort());
 await page.route('https://cdnjs.cloudflare.com/**',r=>r.fulfill({body:''}));
 await page.route('**/supabase.js',r=>r.fulfill({contentType:'application/javascript',body:mockClient}));
 await page.addInitScript(({engine})=>{
  const camera=window.testCamera={streams:[],ocr:[],permissions:[],deferPermission:false,deny:false,torchCalls:[]};
  const getUserMedia=async()=>{
   if(camera.deny)throw Error('Permission denied');
   const canvas=document.createElement('canvas');canvas.width=1280;canvas.height=720;
   const ctx=canvas.getContext('2d');
   const paint=()=>{ctx.fillStyle='#b8bec3';ctx.fillRect(0,0,1280,720);ctx.fillStyle='#ede9e1';ctx.fillRect(150,120,980,480);ctx.fillStyle='#20242a';ctx.font='bold 56px sans-serif';ctx.fillText('SWEEO',210,210);ctx.font='38px sans-serif';ctx.fillText('LSA-T8C090628-G',210,290);ctx.fillText('5991301242T',210,360);ctx.font='24px sans-serif';ctx.fillText('SIMULATED CAMERA / TEST FIXTURE',210,535);};
   paint();
   const stream=canvas.captureStream(10);
   const timer=setInterval(paint,100);camera.streams.push(stream);
   const track=stream.getVideoTracks()[0],stop=track.stop.bind(track);
   track.stop=()=>{clearInterval(timer);stop();};track.getCapabilities=()=>({torch:true});track.applyConstraints=async c=>{camera.torchCalls.push(c.advanced[0].torch);};
   if(camera.deferPermission)await new Promise(resolve=>camera.permissions.push(resolve));
   return stream;
  };
  Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>{try{return await getUserMedia();}catch(error){camera.error=String(error);throw error;}}}});
  window.Tesseract={createWorker:async()=>({setParameters:async()=>{},recognize:()=>new Promise(resolve=>camera.ocr.push(resolve)),terminate:async()=>{}})};
 },{engine});
 const check=async(name,fn)=>{await fn();console.log('PASS',engine,name);};
 const open=async()=>{await page.locator('#scanProduct').click();await page.waitForFunction(()=>testCamera.error||(document.querySelector('#scanner').open&&document.querySelector('#scannerVideo').videoWidth>0));assert.equal(await page.evaluate(()=>testCamera.error),undefined);};
 const close=async()=>{await page.locator('#scannerClose').click();await page.waitForFunction(()=>!document.querySelector('#scanner').open&&!history.state?.sweeoScanner);};
 const resolveOCR=async text=>{await page.waitForFunction(()=>testCamera.ocr.length>0);await page.evaluate(t=>testCamera.ocr.shift()({data:{text:t}}),text);};
 const allStopped=()=>page.waitForFunction(()=>testCamera.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended')));
 try{
 await page.goto(base,{waitUntil:'networkidle'});await page.locator('#outBtn').click();
 await page.locator('#eLines .picker input').first().fill('5991600051T');await page.locator('#eLines .sugg button').first().click();await page.locator('#eLines .qtyin').first().fill('7');
 await check('camera is a fullscreen modal above the preserved entry form',async()=>{
  await open();
  assert.equal(await page.locator('#scanner').evaluate(e=>e.matches(':modal')),true);
  assert.equal(await page.locator('#dEntry').evaluate(e=>e.open),true);
  const rect=await page.locator('#scanner').boundingBox();assert.equal(rect.x,0);assert.equal(rect.y,0);assert.equal(rect.width,page.viewportSize().width);assert.ok(Math.abs(rect.height-page.viewportSize().height)<1);
  assert.equal(await page.locator('#scannerVideo').getAttribute('playsinline'),'');
  await page.screenshot({path:path.join(output,engine+'-simulated-camera.png')});
 });
 await check('torch is clickable (simulated torch capability)',async()=>{await page.locator('#scannerTorch').click();assert.deepEqual(await page.evaluate(()=>testCamera.torchCalls),[true]);});
 await check('close stops every track, keeps existing form data; late OCR is discarded',async()=>{
  await close();await allStopped();await resolveOCR('5991301242T LSA-T8C090628-G');
  assert.equal(await page.locator('#dEntry').evaluate(e=>e.open),true);assert.equal(await page.locator('#eLines .line').count(),1);assert.equal(await page.locator('#eLines .qtyin').first().inputValue(),'7');
 });
 await check('automatic match adds a line and focuses quantity',async()=>{
  await open();await resolveOCR('5991301242T LSA-T8C090628-G');await page.waitForFunction(()=>!document.querySelector('#scanner').open);await allStopped();
  assert.equal(await page.locator('#eLines .line').count(),2);assert.equal(await page.locator('[data-item="r046"] .qtyin').evaluate(e=>document.activeElement===e),true);
 });
 await check('second model adds a second scanned line; duplicate goes to original line',async()=>{
  await open();await resolveOCR('5991301252T LSA-T8C090628-GS');await page.waitForFunction(()=>!document.querySelector('#scanner').open);
  assert.equal(await page.locator('#eLines .line').count(),3);
  await page.locator('[data-item="r046"] .qtyin').fill('12');
  await open();await resolveOCR('5991301242T LSA-T8C090628-G');await page.waitForFunction(()=>!document.querySelector('#scanner').open);
  assert.equal(await page.locator('#eLines .line').count(),3);assert.equal(await page.locator('[data-item="r046"] .qtyin').inputValue(),'12');
 });
 await check('fuzzy candidates accept real clicks above the modal form',async()=>{
  await open();await resolveOCR('9991301242T LSA-T8C090628-');await page.locator('#scannerResults button').first().click();await page.waitForFunction(()=>!document.querySelector('#scanner').open);assert.equal(await page.locator('#eLines .line').count(),3);
 });
 await check('manual entry stops camera and focuses the form',async()=>{
  await open();await page.locator('#scannerManual').click();await allStopped();assert.equal(await page.locator('#dEntry').evaluate(e=>e.open),true);assert.equal(await page.locator('#eLines .picker input').last().evaluate(e=>document.activeElement===e),true);await resolveOCR('');
 });
 await check('Escape closes only the camera',async()=>{
  await open();await page.keyboard.press('Escape');await allStopped();assert.equal(await page.locator('#dEntry').evaluate(e=>e.open),true);assert.equal(await page.locator('#scanner').evaluate(e=>e.open),false);await resolveOCR('');
 });
 await check('browser Back closes only camera; reopen still works',async()=>{
  await open();await page.evaluate(()=>history.back());await page.waitForFunction(()=>!document.querySelector('#scanner').open);await allStopped();assert.equal(await page.locator('#dEntry').evaluate(e=>e.open),true);assert.equal(page.url(),base);await resolveOCR('');
 });
 await check('closing parent form stops camera and discards late results',async()=>{
  await open();const before=await page.locator('#eLines').innerHTML();await page.evaluate(()=>document.querySelector('#dEntry').close());await allStopped();await resolveOCR('5991301242T LSA-T8C090628-G');assert.equal(await page.locator('#eLines').innerHTML(),before);assert.equal(await page.locator('#scanner').evaluate(e=>e.open),false);
 });
 await check('camera permission resolving after close immediately stops its stream',async()=>{
  await page.locator('#outBtn').click();await page.evaluate(()=>testCamera.deferPermission=true);await page.locator('#scanProduct').click();await page.waitForFunction(()=>testCamera.permissions.length===1);await close();await page.evaluate(()=>testCamera.permissions.shift()());await allStopped();assert.equal(await page.locator('#scannerVideo').evaluate(e=>e.srcObject),null);await page.evaluate(()=>testCamera.deferPermission=false);
 });
 await check('an old OCR result cannot alter a newly opened scanner session',async()=>{
  await open();await page.waitForFunction(()=>testCamera.ocr.length===1);await close();await open();await page.waitForFunction(()=>testCamera.ocr.length===2);await resolveOCR('5991301242T LSA-T8C090628-G');assert.equal(await page.locator('#eLines .line[data-item]').count(),0);assert.equal(await page.locator('#scanner').evaluate(e=>e.open),true);await resolveOCR('5991301252T LSA-T8C090628-GS');await page.waitForFunction(()=>!document.querySelector('#scanner').open);assert.equal(await page.locator('#eLines .line[data-item="r047"]').count(),1);
 });
 assert.deepEqual(errors,[]);console.log('All scanner dialog checks passed. Camera and OCR were simulated.');
 }catch(error){console.error(await page.evaluate(()=>({status:document.querySelector('#scannerStatus')?.textContent,hint:document.querySelector('#scannerHint')?.textContent,video:document.querySelector('#scannerVideo')?.readyState,streams:window.testCamera?.streams.length,cameraError:window.testCamera?.error})));console.error(errors);throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
