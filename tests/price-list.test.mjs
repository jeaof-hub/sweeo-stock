import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const read = path => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const migration = await read("supabase/migrations/20261106150000_price_list.sql");
const app = await read("app.js");
const html = await read("index.html");
const sw = await read("sw.js");
const ctx = { window: {} }; vm.createContext(ctx); vm.runInContext(await read("price-list.js"), ctx);
const P = ctx.window.SWEEO_PRICE_LIST;

test("price_list is readable only by founder and owner, and is never writable from the app", () => {
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on table public\.price_list from public, anon, authenticated/);
  assert.match(migration, /for select to authenticated\s+using \(public\.is_founder_or_owner\(\)\)/);
  assert.doesNotMatch(migration, /grant (insert|update|delete|all)/i);
  assert.doesNotMatch(migration, /for (insert|update|delete|all)/i);
  assert.doesNotMatch(migration, /insert into public\.price_list/i);
  assert.doesNotMatch(migration, /supabase_realtime/);
});

test("only founder and owner see the price tab", () => {
  for (const role of ["founder", "owner"]) assert.equal(P.canSeePrices(role), true);
  for (const role of ["admin", "warehouse", "auditor", null, undefined, "visitor"]) assert.equal(P.canSeePrices(role), false);
  assert.match(app, /\$\("tabPrices"\)\.hidden = !priceView\.canSeePrices\(currentRole\)/);
  assert.match(app, /!priceView\.canSeePrices\(currentRole\) && !\$\("viewPrices"\)\.hidden\) setTab\("stock"\)/);
  assert.match(app, /priceRows = null/);
  assert.match(html, /id="tabPrices"[^>]*hidden/);
  assert.match(html, /<section id="viewPrices" hidden>/);
  assert.ok(sw.includes('"./price-list.js?v=1"'));
});

test("search, category filter, money and pack formatting", () => {
  const rows = [
    { sort_order: 2, category: "Floodlight", commercial_name: "LED Floodlight 50w DL/WW", watt: "50W", pack_triplep: "20", pack_project: "20" },
    { sort_order: 1, category: "Solar", commercial_name: "Solar LED Floodlight 100w (LED50W) 6500K", project_name: "Solar LED Floodlight 120w (LED50W) 6500K", watt: "50W", pack_triplep: "4", pack_project: "4" },
    { sort_order: 3, category: "UFO", commercial_name: "UFO 15w", watt: "15W", active: false },
  ];
  assert.deepEqual(P.filterPrices(rows, { query: "flood" }).map(r => r.sort_order), [1, 2]);
  assert.deepEqual(P.filterPrices(rows, { query: "120w" }).map(r => r.sort_order), [1]);
  assert.deepEqual(P.filterPrices(rows, { category: "Floodlight" }).map(r => r.sort_order), [2]);
  assert.equal(P.filterPrices(rows, { query: "ufo" }).length, 0);
  assert.deepEqual([...P.categories(rows)], ["Floodlight", "Solar", "UFO"]);
  assert.equal(P.money("1170.28"), "1,170.28");
  assert.equal(P.money(null), "-");
  assert.equal(P.packLabel({ pack_triplep: "10 x 10", pack_project: "10x10" }), "10 x 10");
  assert.equal(P.packLabel({ pack_triplep: "20", pack_project: "25" }), "TP 20 / PJ 25");
  assert.equal(P.packLabel({ pack_project: "6" }), "6");
});

test("no price rows are committed anywhere in the public repository", async () => {
  const files = ["app.js", "index.html", "price-list.js", "i18n.js", "i18n-zh-TW.js", "README.md"];
  for (const dir of ["supabase", "supabase/migrations", "tests"]) for (const f of await readdir(new URL(`../${dir}`, import.meta.url))) if (/\.(sql|mjs)$/.test(f)) files.push(`${dir}/${f}`);
  for (const file of files) {
    if (file === "tests/price-list.test.mjs" || file === "tests/price-list.sql") continue;
    const text = await read(file);
    assert.doesNotMatch(text, /insert into public\.price_list/i, file);
    assert.doesNotMatch(text, /triplep_ex_vat\s*[:=]\s*['"]?\d/i, file);
  }
});
