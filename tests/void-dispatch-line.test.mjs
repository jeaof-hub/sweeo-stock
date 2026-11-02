import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration=await readFile(new URL("../supabase/29_void_dispatch_lines.sql",import.meta.url),"utf8");
const timestamped=await readFile(new URL("../supabase/migrations/20261102100000_void_dispatch_lines.sql",import.meta.url),"utf8");
const app=await readFile(new URL("../app.js",import.meta.url),"utf8");
const view=await readFile(new URL("../dispatch-view.js",import.meta.url),"utf8");
const notify=await readFile(new URL("../supabase/functions/line-notify/index.ts",import.meta.url),"utf8");
const webhook=await readFile(new URL("../supabase/functions/line-webhook/index.ts",import.meta.url),"utf8");

test("migration mirror is exact and preserves void history",()=>{
  assert.equal(timestamped,migration);
  for(const column of ["voided_at","voided_by","void_reason"])assert.match(migration,new RegExp(`add column if not exists ${column}`));
  assert.match(migration,/action in \([^)]*'void_line'/s);
  assert.match(migration,/entity in \([^)]*'dispatch_lines'/s);
  assert.doesNotMatch(migration,/delete from public\.dispatch_request_lines/i);
});

test("void RPC is atomic, locked, role checked and restores stock by soft delete",()=>{
  assert.match(migration,/actor_role not in \('founder','owner','admin'\)/);
  assert.match(migration,/from public\.dispatch_request_lines where id=p_line_id for update/);
  assert.match(migration,/from public\.dispatch_requests where id=target\.request_id for update/);
  assert.match(migration,/from public\.movements[\s\S]*for update/);
  assert.match(migration,/request_row\.status<>'approved'/);
  assert.match(migration,/target\.voided_at is not null/);
  assert.match(migration,/length\(trim\(coalesce\(p_reason,''\)\)\)<2/);
  assert.match(migration,/กรุณาถอดรายการนี้ออกจาก INV ก่อน/);
  assert.match(migration,/set deleted_at=now\(\),deleted_by=auth\.uid\(\)/);
  assert.match(migration,/no_invoice_reason=null,no_invoice_by=null,no_invoice_at=null/);
  assert.match(migration,/remaining=0 then update public\.dispatch_requests set status='cancelled'/);
  assert.match(migration,/errcode='42501'/);
});

test("movement RPC blocks dispatch movements",()=>{
  assert.match(migration,/target\.dispatch_request_line_id is not null/);
  assert.match(migration,/รายการนี้มาจากคำขอเบิก กรุณาลบจากหน้าใบส่งของ/);
});

test("all totals and external representations exclude voided lines",()=>{
  assert.match(migration,/l\.voided_at is null and l\.invoice_id is null/);
  assert.match(migration,/join public\.dispatch_request_lines l on l\.request_id=r\.id and l\.voided_at is null/);
  assert.match(view,/&& !line\.voided_at/);
  assert.match(app,/activeRequestLines/);
  assert.match(app,/allLines\.filter\(line=>!line\.voided_at\)/);
  assert.match(app,/!l\.voided_at && !l\.invoice_id/);
  assert.match(notify,/\.is\("voided_at", null\)/);
  assert.match(webhook,/\.is\("voided_at", null\)/);
});

test("only stock managers see the void control and the UI records a reason",()=>{
  assert.match(app,/canManageStock\(\)&&request\.status==="approved"&&!pending/);
  assert.match(app,/sb\.rpc\("void_dispatch_line",\{p_line_id:lineId,p_reason:reason\}\)/);
  assert.match(app,/reason\.length<2/);
  assert.match(app,/class="void-detail"/);
});

test("product movement rows open their detail on pointer and keyboard",()=>{
  assert.match(app,/class="entry-row" data-eid=/);
  assert.match(app,/entryRow\.dataset\.eid/);
  assert.match(app,/e\.key==="Enter" \|\| e\.key===" "/);
});
