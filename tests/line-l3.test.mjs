import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { dispatchSummaryFlex, myRequestsFlex } from "../supabase/functions/_shared/line.ts";
import { matchLineProducts } from "../supabase/functions/_shared/product-match.ts";

const migration = await readFile(new URL("../supabase/27_line_l3_dispatch.sql", import.meta.url), "utf8");
const timestamped = await readFile(new URL("../supabase/migrations/20261014170000_line_l3_dispatch.sql", import.meta.url), "utf8");
const webhook = await readFile(new URL("../supabase/functions/line-webhook/index.ts", import.meta.url), "utf8");
const richMenuMigration = await readFile(new URL("../supabase/28_line_l3_rich_menu.sql", import.meta.url), "utf8");
const richMenuTimestamped = await readFile(new URL("../supabase/migrations/20261014173000_line_l3_rich_menu.sql", import.meta.url), "utf8");

const products = [
  { id: "elg", code: "1196G30301T", model: "ELG-150-36A", dept: "Project", balance: 20 },
  { id: "r046", code: "5991301242T", model: "LSA-T8C090628-G", dept: "Retail", balance: 30 },
  { id: "r047", code: "5991301252T", model: "LSA-T8C090628-GS", dept: "Retail", balance: 40 },
  { id: "lotlike", code: "---1600016T", model: "LOZ-FGD100H5-2304090", dept: "SPARE", balance: 1 },
];

test("L3 migration mirror is exact and sessions are private", () => {
  assert.equal(timestamped, migration);
  assert.match(migration, /create table if not exists public\.line_sessions/i);
  assert.match(migration, /alter table public\.line_sessions enable row level security/i);
  assert.match(migration, /revoke all on table public\.line_sessions from public,anon,authenticated/i);
  assert.match(migration, /grant select,insert,update,delete on table public\.line_sessions to service_role/i);
  assert.doesNotMatch(migration, /grant\s+all/i);
});

test("catalog returns active products with live balance", () => {
  assert.match(migration, /where i\.active/i);
  assert.match(migration, /m\.deleted_at is null/i);
  assert.match(migration, /i\.opening\+coalesce\(sum\(case when m\.kind='in' then m\.qty else -m\.qty end\)/i);
});

test("my requests rechecks the active actor and returns only their latest ten", () => {
  assert.match(migration, /s\.user_id=p_actor and s\.is_active/i);
  assert.match(migration, /r\.requester_id=p_actor/i);
  assert.match(migration, /s\.role in \('warehouse','admin','owner','founder'\)/i);
  assert.match(migration, /order by r\.created_at desc limit 10/i);
});

test("real arbitrary codes and exact sibling models resolve deterministically", () => {
  assert.equal(matchLineProducts("1196G30301T", products).match?.id, "elg");
  assert.equal(matchLineProducts("LSA-T8C090628-GS", products).match?.id, "r047");
  assert.equal(matchLineProducts("LSA-T8C090628-G 5991301242T", products).match?.id, "r046");
});

test("numeric lot text produces no product candidates", () => {
  const result = matchLineProducts("LOT 2605060001 Q'TY 30 PCS", products);
  assert.equal(result.match, null);
  assert.deepEqual(result.candidates, []);
});

test("fuzzy input requires the user to choose and never auto submits", () => {
  const result = matchLineProducts("9991301242T LSA-T8C090628-", products);
  assert.equal(result.match, null);
  assert.equal(result.candidates[0].product.id, "r046");
});

test("dispatch conversation expires in 30 minutes and validates quantity and balance", () => {
  assert.match(webhook, /Date\.now\(\) \+ 30 \* 60_000/);
  assert.match(webhook, /Number\.isInteger\(Number\(value\[2\]\)\)/);
  assert.match(webhook, /existingQty \+ qty > Number\(product\.balance \|\| 0\)/);
  assert.match(webhook, /addSessionLine/);
  assert.match(webhook, /create_dispatch_request_as/);
});

test("L3 commands and summary controls are available", () => {
  for (const command of ["ขอเบิกสินค้า", "คำขอของฉัน", "รออนุมัติ", "วิธีใช้", "ดูรายการ", "เสร็จ"]) assert.match(webhook, new RegExp(command));
  const summary = dispatchSummaryFlex({ customer: "Example", lines: [{ item_id: "r046", model: "LSA", qty: 2 }] });
  const encoded = JSON.stringify(summary);
  for (const action of ["dispatch_confirm", "dispatch_edit", "dispatch_cancel"]) assert.match(encoded, new RegExp(action));
  assert.match(JSON.stringify(myRequestsFlex([{ delivery_note_no: "TD-1", status: "pending", customer: "Example" }])), /TD-1/);
});

test("L3 sends replies only and never push messages", () => {
  assert.match(webhook, /replyLine/);
  assert.doesNotMatch(webhook, /\/v2\/bot\/message\/(push|broadcast|multicast)/);
});

test("role-specific rich menus are private and use the correct LINE endpoints", () => {
  assert.equal(richMenuTimestamped, richMenuMigration);
  assert.match(richMenuMigration, /grant execute on function public\.line_rich_menu_settings\(\),public\.line_save_rich_menus\(text,text\) to service_role/i);
  assert.doesNotMatch(richMenuMigration, /grant\s+all/i);
  assert.match(webhook, /api-data\.line\.me\/v2\/bot\/richmenu/);
  assert.match(webhook, /\/v2\/bot\/user\/all\/richmenu/);
  assert.match(webhook, /\["admin", "owner", "founder"\]\.includes\(actor\.role\)/);
  assert.match(webhook, /text === "ตั้งค่าเมนู"/);
});
