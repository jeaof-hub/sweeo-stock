import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const app = fs.readFileSync(new URL("../app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const sql = fs.readFileSync(new URL("../supabase/19_dashboard_metrics.sql", import.meta.url), "utf8");
const adjustmentFix = fs.readFileSync(new URL("../supabase/20_dashboard_exclude_adjustments.sql", import.meta.url), "utf8");
const en = fs.readFileSync(new URL("../i18n.js", import.meta.url), "utf8");
const zh = fs.readFileSync(new URL("../i18n-zh-TW.js", import.meta.url), "utf8");

test("dashboard has a complete tab and view", () => {
  for (const id of ["tabDashboard", "viewDashboard", "dashboardCards", "dashboardReorder", "dashboardTop"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(app, new RegExp(id));
  }
});

test("dashboard RPC is authenticated, role scoped and read only", () => {
  assert.match(sql, /security definer/i);
  assert.match(sql, /caller_role is null/i);
  assert.match(sql, /revoke all on function public\.dashboard_summary\(\) from public, anon/i);
  assert.match(sql, /grant execute on function public\.dashboard_summary\(\) to authenticated/i);
  assert.match(sql, /caller_role in \('admin','owner','founder'\)/i);
  assert.doesNotMatch(sql, /\b(insert|update|delete|truncate)\s+(into\s+|public\.)?(items|movements|dispatch_requests|dispatch_request_lines|invoices)\b/i);
});

test("dashboard calculations exclude deleted movements and use Bangkok periods", () => {
  assert.match(sql, /timezone\('Asia\/Bangkok', now\(\)\)/i);
  assert.match(sql, /m\.deleted_at is null/g);
  assert.match(sql, /date_trunc\('week'/i);
  assert.match(sql, /date_trunc\('month'/i);
  assert.match(sql, /r\.status='approved'/i);
});

test("outbound dashboard statistics exclude both kinds of stock adjustment", () => {
  const sourceFilters = adjustmentFix.match(/lower\(trim\(coalesce\(m\.source,''\)\)\)<>\s*'adjustment'/gi) || [];
  const legacyFilters = adjustmentFix.match(/lower\(trim\(coalesce\(m\.dept,''\)\)\)<>\s*'stock adjust'/gi) || [];
  assert.equal(sourceFilters.length, 2, "source adjustment must be excluded from weekly and monthly metrics");
  assert.equal(legacyFilters.length, 2, "legacy Stock Adjust must be excluded from weekly and monthly metrics");
  assert.doesNotMatch(adjustmentFix, /\b(insert|update|delete|truncate)\s+(into\s+|public\.)?(items|movements|dispatch_requests|dispatch_request_lines|invoices)\b/i);
});

test("dashboard labels exist in English and Traditional Chinese", () => {
  for (const label of ["ภาพรวม", "สินค้าที่ควรสั่งผลิต", "คำขอรออนุมัติ", "ส่งออกสัปดาห์นี้", "สินค้าส่งออกสูงสุดเดือนนี้"]) {
    assert.ok(en.includes(`"${label}"`), `missing English: ${label}`);
    assert.ok(zh.includes(`"${label}"`), `missing Chinese: ${label}`);
  }
});
