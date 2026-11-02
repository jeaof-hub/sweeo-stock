import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildRevisionFlex } from "../supabase/functions/line-notify/revision.ts";

const migration = await readFile(new URL("../supabase/32_line_revision_notifications.sql", import.meta.url), "utf8");
const mirror = await readFile(new URL("../supabase/migrations/20261102180000_line_revision_notifications.sql", import.meta.url), "utf8");
const notify = await readFile(new URL("../supabase/functions/line-notify/index.ts", import.meta.url), "utf8");
const base = { lang: "th", request: { id: "req-1", delivery_note_no: "TD-1", customer: "Pine Field" }, itemName: "LRM-KitW2228", requesterName: "Admin", siteUrl: "https://x.test/" };

test("migration mirror is exact and covers both revision kinds", () => {
  assert.equal(mirror, migration);
  assert.match(migration, /check \(kind in \('pending','result','qty_change','add_line'\)\)/);
  assert.match(migration, /after update of qty_change_status on public\.dispatch_request_lines/);
  assert.match(migration, /after insert on public\.dispatch_line_additions/);
  assert.match(migration, /r\.user_id<>p_requested_by/);
  assert.match(migration, /s\.role in \('founder','owner','admin'\)/);
});

test("quantity change card shows old and new quantity and links to the pending tab", () => {
  const msg = buildRevisionFlex({ ...base, kind: "qty_change", fromQty: 10, toQty: 12, purpose: "sale", reason: "ลูกค้าเพิ่ม" });
  const text = JSON.stringify(msg);
  assert.match(text, /ขออนุมัติแก้จำนวน/); assert.match(text, /10 → 12 ชิ้น/); assert.match(text, /ลูกค้าเพิ่ม/);
  assert.match(text, /\?tab=pending&request=req-1/);
  assert.doesNotMatch(text, /"type":"postback"/);
});

test("added product card shows quantity and purpose, in Traditional Chinese when preferred", () => {
  const th = JSON.stringify(buildRevisionFlex({ ...base, kind: "add_line", fromQty: null, toQty: 5, purpose: "gift", reason: "" }));
  assert.match(th, /ขออนุมัติเพิ่มสินค้า/); assert.match(th, /5 ชิ้น/); assert.match(th, /แถม/);
  const zh = JSON.stringify(buildRevisionFlex({ ...base, lang: "zh-TW", kind: "add_line", fromQty: null, toQty: 5, purpose: "gift", reason: "" }));
  assert.match(zh, /待核准：新增商品/); assert.match(zh, /贈品/);
});

test("line-notify routes revision kinds before the request card path", () => {
  assert.ok(notify.indexOf('job.kind === "qty_change" || job.kind === "add_line"') < notify.indexOf("buildNotificationFlex({"));
  assert.match(notify, /from\("dispatch_line_additions"\)/);
});
