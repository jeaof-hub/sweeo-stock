import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { buildNotificationFlex, lineLeavePath, verifyLineSignature } from "../supabase/functions/_shared/line.ts";

const migration = await readFile(new URL("../supabase/migrations/20261013100000_line_l1.sql", import.meta.url), "utf8");
const mirror = await readFile(new URL("../supabase/23_line_l1.sql", import.meta.url), "utf8");
const webhook = await readFile(new URL("../supabase/functions/line-webhook/index.ts", import.meta.url), "utf8");
const notify = await readFile(new URL("../supabase/functions/line-notify/index.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../app.js", import.meta.url), "utf8");
const retryMigration = await readFile(new URL("../supabase/24_line_l1_retry_and_cron.sql", import.meta.url), "utf8");
const retryMigrationTimestamped = await readFile(new URL("../supabase/migrations/20261013130000_line_l1_retry_and_cron.sql", import.meta.url), "utf8");

test("migration mirror stays identical and private LINE tables use RLS", () => {
  assert.equal(mirror, migration);
  for (const table of ["staff_line_links", "line_link_codes", "line_link_attempts", "line_processed_events", "line_settings", "line_notification_recipients", "notification_outbox"])
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, "i"));
  assert.match(migration, /revoke all on public\.staff_line_links[\s\S]+public\.notification_outbox from public,anon,authenticated/i);
});

test("service actor RPCs and web wrappers are separated", () => {
  assert.match(migration, /grant execute on function public\.create_dispatch_request_as[\s\S]+public\.approve_dispatch_request_as[\s\S]+public\.reject_dispatch_request_as[^;]+to service_role/i);
  assert.match(migration, /auth\.uid\(\)/);
  assert.match(migration, /can_review_dispatch_as/);
});

test("webhook authenticates the raw body before parsing and deduplicates", () => {
  assert.ok(webhook.indexOf("request.text()") < webhook.indexOf("JSON.parse(rawBody)"));
  assert.ok(webhook.indexOf("verifyLineSignature") < webhook.indexOf("JSON.parse(rawBody)"));
  assert.match(webhook, /line_processed_events/);
  assert.doesNotMatch(webhook, /multicast|broadcast/);
});

test("group and room joins reply once then leave while other events stay silent", () => {
  assert.equal(lineLeavePath({ type: "group", groupId: "G/1" }), "/v2/bot/group/G%2F1/leave");
  assert.equal(lineLeavePath({ type: "room", roomId: "R/1" }), "/v2/bot/room/R%2F1/leave");
  assert.match(webhook, /if \(event\.type === "join"\)[\s\S]+replySafely[\s\S]+leaveLine/);
  assert.doesNotMatch(webhook, /sourceType === "group" \|\| sourceType === "room"\) \{\s*await replySafely/);
});

test("retry migration uses claimed_at, fails clearly without pg_cron and schedules maintenance", () => {
  assert.equal(retryMigrationTimestamped, retryMigration);
  assert.match(retryMigration, /add column if not exists claimed_at timestamptz/i);
  assert.match(retryMigration, /status='processing',attempts=attempts\+1,error=null,claimed_at=now\(\)/i);
  assert.match(retryMigration, /claimed_at<now\(\)-interval '2 minutes'/i);
  assert.match(retryMigration, /raise exception 'pg_cron is required/i);
  assert.match(retryMigration, /cron\.schedule\('sweeo-line-maintenance','\* \* \* \* \*'/i);
});

test("signature verification accepts only the matching HMAC", async () => {
  const secret = "test-secret", body = '{"events":[]}';
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  const signature = Buffer.from(bytes).toString("base64");
  assert.equal(await verifyLineSignature(body, signature, secret), true);
  assert.equal(await verifyLineSignature(body + " ", signature, secret), false);
});

test("notification flex limits visible products to ten", () => {
  const lines = Array.from({ length: 12 }, (_, i) => ({ item_id: String(i), requested_qty: 1 }));
  const itemNames = new Map(lines.map((line, i) => [line.item_id, `Product ${i}`]));
  const message = buildNotificationFlex({ kind: "pending", lang: "th", request: { id: "id", customer: "C" }, requesterName: "A", lines, itemNames, siteUrl: "https://example.test/" });
  const encoded = JSON.stringify(message);
  assert.match(encoded, /Product 9/); assert.doesNotMatch(encoded, /Product 10/); assert.match(encoded, /2/);
});

test("frontend exposes link, settings, quota and language persistence", () => {
  for (const text of ["my_line_status", "create_line_link_code", "line_settings_view", "line_admin_overview", "set_my_preferred_language", "lineQuotaBanner"])
    assert.match(app, new RegExp(text));
  assert.match(notify, /\/v2\/bot\/message\/push/);
});
