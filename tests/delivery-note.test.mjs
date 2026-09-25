import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const context = { window: {} };
vm.runInNewContext(readFileSync(new URL("../delivery-note.js", import.meta.url), "utf8"), context);
const buildDocument = context.window.SWEEO_DELIVERY.buildDocument;
const base = {
  request: { id:"request-1", status:"approved", requester_id:"user-1", document_date:"2026-09-25", delivery_date:"2026-09-26", delivery_note_no:"TD-20260925-00001", customer:"Triple P", doc_no:"INV-1", note:"Handle carefully" },
  lines: [{ item_id:"item-1", code:"5991301118T", model:"LRM-KitW2228", requested_qty:50, approved_qty:40, purpose:"sale", return_required:false, line_note:"Boxed" }],
  itemById: () => ({ code:"5991301118T", model:"LRM-KitW2228", spec:"SWEEO LED Circular 22W" }),
  staffNames: { "user-1":"Aof" }, purposeNames:{ sale:"ขายออก" }, formatNumber:String, formatDate:String
};

test("approved delivery note uses approved quantity and creates original plus copy", () => {
  const html=buildDocument({ ...base, lang:"th" });
  assert.match(html, />40<\/td>/);
  assert.doesNotMatch(html, />50<\/td>/);
  assert.equal((html.match(/class="delivery-page"/g)||[]).length,2);
  assert.equal((html.match(/<tbody>/g)||[]).length,2);
  assert.equal((html.match(/class="item-row(?: blank-row)?"/g)||[]).length,20);
  assert.equal((html.match(/class="item-row blank-row"/g)||[]).length,18);
  assert.match(html,/ต้นฉบับ/); assert.match(html,/สำเนา/); assert.match(html,/TD-20260925-00001/);
  assert.match(html,/LASTER TECH \(THAILAND\) CO\., LTD\./);
  assert.doesNotMatch(html,/SWEEO TECHNOLOGY CO\., LTD\./);
  assert.match(html,/footer\{position:absolute;[^}]*bottom:2mm/);
});

test("more than ten products continue on numbered pages with ten rows each", () => {
  const lines=Array.from({length:11},(_,index)=>({ ...base.lines[0], item_id:`item-${index+1}` }));
  const html=buildDocument({ ...base, lines });
  assert.equal((html.match(/class="delivery-page"/g)||[]).length,4);
  assert.equal((html.match(/class="item-row(?: blank-row)?"/g)||[]).length,40);
  assert.match(html,/ต้นฉบับ · 2\/2/); assert.match(html,/สำเนา · 2\/2/);
});

test("pending delivery note uses requested quantity and is visibly marked draft", () => {
  const html=buildDocument({ ...base, request:{ ...base.request, status:"pending" }, lang:"en", purposeNames:{sale:"Sale"} });
  assert.match(html,/>50<\/td>/); assert.match(html,/DRAFT — PENDING APPROVAL/);
  assert.match(html,/TEMPORARY DELIVERY NOTE/);
});

test("document values are HTML escaped", () => {
  const html=buildDocument({ ...base, request:{ ...base.request, customer:"<script>alert(1)</script>" } });
  assert.doesNotMatch(html,/<script>alert\(1\)<\/script>/);
  assert.match(html,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});
