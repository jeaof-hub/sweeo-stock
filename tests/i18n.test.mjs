import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
function setup(lang) {
  const selector={setAttribute(){},addEventListener(){}};
  const body={nodeType:1,matches:()=>false,hasAttribute:()=>false,childNodes:[]};
  const context={window:{},localStorage:{getItem:()=>lang},document:{documentElement:{},body,getElementById:()=>selector},Node:{TEXT_NODE:3,ELEMENT_NODE:1},MutationObserver:class{observe(){}}};
  vm.createContext(context);
  for(const file of ['i18n-zh-TW.js','i18n.js']) vm.runInContext(readFileSync(new URL('../'+file,import.meta.url),'utf8'),context);
  return context;
}
test('Taiwan language persists, sets document locale, and exposes three-language selection',()=>{
 const c=setup('zh-TW');assert.equal(c.document.documentElement.lang,'zh-TW');assert.equal(c.document.title,'SWEEO 庫存管理');assert.equal(c.document.getElementById().value,'zh-TW');
});
test('every existing English interface label has a Traditional Chinese translation',()=>{
 const source=readFileSync(new URL('../i18n.js',import.meta.url),'utf8');const c=setup('zh-TW');
 const english=vm.runInNewContext(source.slice(source.indexOf('  const english'),source.indexOf('  const dynamic'))+';english;');
 for(const key of Object.keys(english)){assert.ok(c.window.SWEEO_ZH_TW[key],key);assert.doesNotMatch(c.window.SWEEO_I18N.translate(key),/[ก-๙]/,key);}
});
test('Chinese stock and invoice messages keep quantities and identifiers intact',()=>{
 const t=setup('zh-TW').window.SWEEO_I18N.translate;
 assert.equal(t('แสดง 428 จาก 471 รายการ'),'顯示 428／471 項商品');
 assert.equal(t('พอขายอีก 99.3 เดือน'),'預估可售 99.3 個月');
 assert.equal(t('ผูกแล้ว · INV-2026/001'),'已連結 · INV-2026/001');
 assert.equal(t('ขอ 30 · ขายออก · ไม่คืน'),'申請數量：30 · 銷售 · 不須歸還');
 assert.equal(t('LSA-T8C090628-GS คงเหลือ -5 · พร้อมเบิก -5'),'LSA-T8C090628-GS · 庫存：-5 · 可領取：-5');
 assert.equal(t('ปิดการใช้งาน aof@example.com?'),'確定停用 aof@example.com？');
});
test('product identifiers and stored free text are not translated',()=>{
 const t=setup('zh-TW').window.SWEEO_I18N.translate;
 for(const value of ['5991301252T','LSA-T8C090628-GS','บริษัท ทริปเปิล พี จำกัด','SWEEO LED 6500K','INV-2026-001'])assert.equal(t(value),value);
});
test('Thai and English translation behavior remains available',()=>{
 assert.equal(setup('th').window.SWEEO_I18N.translate('คงเหลือ'),'คงเหลือ');
 assert.equal(setup('en').window.SWEEO_I18N.translate('คงเหลือ'),'Balance');
 assert.equal(setup('en').window.SWEEO_I18N.translate('พอขายอีก 2 เดือน'),'About 2 months remaining');
 assert.equal(setup('invalid').document.documentElement.lang,'th');
});
test('auditor display label is Executive in all three interface languages',()=>{
 assert.equal(setup('th').window.SWEEO_I18N.translate('ผู้บริหาร'),'ผู้บริหาร');
 assert.equal(setup('en').window.SWEEO_I18N.translate('ผู้บริหาร'),'Executive');
 assert.equal(setup('zh-TW').window.SWEEO_I18N.translate('ผู้บริหาร'),'主管');
});
test('the legacy Founder misspelling is absent from user-facing and administration sources',()=>{
 const misspelling=new RegExp('Found'+'ator','i');
 for(const file of ['app.js','index.html','i18n.js','i18n-zh-TW.js','README.md','supabase/functions/manage-users/index.ts']){
  assert.doesNotMatch(readFileSync(new URL('../'+file,import.meta.url),'utf8'),misspelling,file);
 }
});
