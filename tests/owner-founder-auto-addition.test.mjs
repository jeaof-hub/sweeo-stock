import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const migration = await readFile(new URL("../supabase/migrations/20261103100000_owner_founder_auto_approve_addition.sql", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");

test("founder and owner additions are atomic and immediately approved", () => {
  assert.match(migration, /if actor_role='admin' then/);
  assert.match(migration, /if p_qty>available then/);
  assert.match(migration, /insert into public\.dispatch_request_lines/);
  assert.match(migration, /insert into public\.movements/);
  assert.match(migration, /'approved',auth\.uid\(\),auth\.uid\(\),now\(\),new_line_id/);
  assert.match(migration, /'auto_approved',true/);
  assert.match(migration, /SWEEO_ROLLBACK_AUTO_ADD/);
});

test("admin additions remain pending without touching stock in their branch", () => {
  const branch = migration.match(/if actor_role='admin' then([\s\S]*?)return new_id;\s*end if;/)?.[1] || "";
  assert.match(branch, /insert into public\.dispatch_line_additions/);
  assert.doesNotMatch(branch, /public\.movements|public\.dispatch_request_lines/);
});

test("UI tells founder and owner that stock was deducted immediately", () => {
  assert.match(app, /\["founder","owner"\]\.includes\(currentRole\)/);
  assert.match(app, /เพิ่มสินค้าและตัดสต็อกแล้ว/);
});
