import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source=readFileSync(new URL('../delivery-pdf.js',import.meta.url),'utf8');
function setup(){
  const calls=[];
  class MockFile { constructor(parts,name,options){this.parts=parts;this.name=name;this.type=options.type;} }
  class MockPdf {
    constructor(options){calls.push(['pdf',options]);}
    addPage(...args){calls.push(['page',...args]);}
    addImage(...args){calls.push(['image',...args]);}
    output(kind){calls.push(['output',kind]);return {kind};}
  }
  const context={window:{html2canvas:async page=>({toDataURL:()=>`data:${page.id}`}),jspdf:{jsPDF:MockPdf}},File:MockFile,Date,Promise,document:{createElement(){throw new Error('libraries should already be present')},head:{appendChild(){}}}};
  vm.createContext(context);vm.runInContext(source,context);
  return {api:context.window.SWEEO_DELIVERY_PDF,calls};
}

test('iOS standalone detection includes iPhone and touch-capable iPadOS Macintosh',()=>{
  const {api}=setup(),standalone=()=>({matches:true}),browser=()=>({matches:false});
  assert.equal(api.isIosStandalone({userAgent:'iPhone',standalone:true,maxTouchPoints:1},browser),true);
  assert.equal(api.isIosStandalone({userAgent:'Macintosh',standalone:false,maxTouchPoints:5},standalone),true);
  assert.equal(api.isIosStandalone({userAgent:'iPhone',standalone:false,maxTouchPoints:1},browser),false);
  assert.equal(api.isIosStandalone({userAgent:'Android',standalone:true,maxTouchPoints:5},standalone),false);
});

test('PDF renderer creates one A4 landscape page per delivery page at scale 2',async()=>{
  const {api,calls}=setup();
  const pages=[{id:'original'},{id:'copy'}];
  const file=await api.createFile({querySelectorAll:()=>pages},'TD-00001.pdf');
  assert.equal(file.name,'TD-00001.pdf');assert.equal(file.type,'application/pdf');
  assert.equal(calls[0][0],'pdf');assert.equal(calls[0][1].orientation,'landscape');assert.equal(calls[0][1].unit,'mm');assert.equal(calls[0][1].format,'a4');assert.equal(calls[0][1].compress,true);
  assert.equal(calls.filter(call=>call[0]==='page').length,1);
  const images=calls.filter(call=>call[0]==='image');assert.equal(images.length,2);
  for(const image of images) assert.deepEqual(image.slice(3,8),[10,10,277,190,undefined]);
  assert.deepEqual(calls.at(-1),['output','blob']);
});

test('lazy CDN dependencies are pinned with SHA-512 SRI and do not open another page',()=>{
  const {api}=setup();
  for(const library of Object.values(api.libraries)){
    assert.match(library.url,/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\//);
    assert.match(library.integrity,/^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
  assert.doesNotMatch(source,/window\.open|URL\.createObjectURL|<iframe/i);
  assert.match(source,/script\.crossOrigin = "anonymous"/);
});
