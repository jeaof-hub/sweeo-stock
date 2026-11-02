import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration=await readFile(new URL("../supabase/30_dispatch_line_quantity_reapproval.sql",import.meta.url),"utf8");
const mirror=await readFile(new URL("../supabase/migrations/20261102150000_dispatch_line_quantity_reapproval.sql",import.meta.url),"utf8");
const app=await readFile(new URL("../app.js",import.meta.url),"utf8");

test("migration mirror is exact and records a line-level approval lifecycle",()=>{
  assert.equal(mirror,migration);
  for(const value of ["qty_change_requested_qty","qty_change_requested_by","qty_change_reviewed_by","qty_change_rejection_reason"]) assert.match(migration,new RegExp(value));
  for(const action of ["request_qty_change","approve_qty_change","reject_qty_change"]) assert.match(migration,new RegExp(`'${action}'`));
});

test("requesting a quantity change does not touch stock",()=>{
  const requestBody=migration.match(/create or replace function public\.request_dispatch_line_qty_change[\s\S]*?end \$\$;/)?.[0]||"";
  assert.doesNotMatch(requestBody,/update public\.movements/);
  assert.doesNotMatch(requestBody,/insert into public\.movements/);
  assert.match(requestBody,/actor_role not in \('founder','owner','admin'\)/);
  assert.match(requestBody,/target\.invoice_id is not null/);
});

test("approval atomically supersedes the movement and applies the new integer quantity",()=>{
  assert.match(migration,/drop constraint if exists movements_dispatch_request_line_id_key/);
  assert.match(migration,/unique index if not exists movements_live_dispatch_line_idx/);
  assert.match(migration,/set deleted_at=now\(\),deleted_by=auth\.uid\(\)/);
  assert.match(migration,/requested_qty=qty_change_requested_qty/);
  assert.match(migration,/approved_qty=qty_change_requested_qty,movement_id=new_movement_id/);
  assert.match(migration,/ผู้ขอแก้จำนวนไม่สามารถอนุมัติรายการของตนเอง/);
});

test("warehouse and auditor are rejected and invoice or void cannot race a pending change",()=>{
  assert.match(migration,/errcode='42501'/);
  assert.match(migration,/รายการนี้กำลังรออนุมัติการแก้จำนวน/);
  assert.match(migration,/prevent_pending_qty_change_void/);
  assert.match(migration,/role='warehouse'/);
  assert.match(migration,/role='auditor'/);
});

test("UI exposes edit, review, pending state and blocks printing and invoicing",()=>{
  assert.match(app,/data-qty-edit=/);
  assert.match(app,/data-qty-approve=/);
  assert.match(app,/data-qty-reject=/);
  assert.match(app,/request_dispatch_line_qty_change/);
  assert.match(app,/approve_dispatch_line_qty_change/);
  assert.match(app,/reject_dispatch_line_qty_change/);
  assert.match(app,/มีรายการแก้จำนวนรออนุมัติ จึงยังพิมพ์ไม่ได้/);
  assert.match(app,/qty_change_status !== "pending"/);
});
