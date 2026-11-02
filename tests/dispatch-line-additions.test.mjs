import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration = await readFile(new URL("../supabase/31_dispatch_line_additions.sql", import.meta.url), "utf8");
const mirror = await readFile(new URL("../supabase/migrations/20261102170000_dispatch_line_additions.sql", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const body = name => migration.match(new RegExp(`create or replace function public\\.${name}[\\s\\S]*?end \\$\\$;`))?.[0] || "";

test("migration mirror is exact", () => assert.equal(mirror, migration));

test("proposing an addition never touches stock and is limited to founder/owner/admin", () => {
  const fn = body("request_dispatch_line_addition");
  assert.doesNotMatch(fn, /public\.movements/);
  assert.match(fn, /actor_role not in \('founder','owner','admin'\)/);
  assert.match(fn, /status<>'approved'/);
  assert.match(fn, /แก้ไขจำนวน/);
});

test("approval is atomic, checks stock and forbids self-approval", () => {
  const fn = body("approve_dispatch_line_addition");
  assert.match(fn, /target\.requested_by=auth\.uid\(\)/);
  assert.match(fn, /for update/);
  assert.match(fn, /errcode='23514'/);
  assert.match(fn, /insert into public\.dispatch_request_lines/);
  assert.match(fn, /insert into public\.movements/);
  assert.match(fn, /'approve_add_line'/);
});

test("rejection keeps history and does not touch stock", () => {
  const fn = body("reject_dispatch_line_addition");
  assert.doesNotMatch(fn, /public\.movements/);
  assert.match(fn, /status='rejected'/);
});

test("INV is frozen while any revision is pending and uniqueness applies to active lines only", () => {
  assert.match(migration, /dispatch_line_revision_invoice_guard/);
  assert.match(migration, /on public\.dispatch_request_lines\(request_id,item_id\) where voided_at is null/);
  assert.match(migration, /SWEEO_ROLLBACK_ADD_LINE/);
});

test("frontend wires the add-product workflow and blocks printing during revisions", () => {
  assert.match(html, /id="dAddLine"/);
  for (const rpc of ["request_dispatch_line_addition", "approve_dispatch_line_addition", "reject_dispatch_line_addition", "cancel_dispatch_line_addition"]) assert.match(app, new RegExp(rpc));
  assert.match(app, /table: "dispatch_line_additions"/);
  assert.match(app, /request\.status==="approved"&&hasPendingRevision\(id\)/);
  assert.match(app, /canManageStock\(\)&&request\.status==="approved" \? `<button class="btn sm" type="button" data-add-line/);
});
