import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { approvalButtons, confirmationFlex, pendingRequestsFlex, postbackData } from "../supabase/functions/_shared/line.ts";

const migration = await readFile(new URL("../supabase/26_line_l2_approval.sql", import.meta.url), "utf8");
const timestamped = await readFile(new URL("../supabase/migrations/20261014130000_line_l2_approval.sql", import.meta.url), "utf8");
const webhook = await readFile(new URL("../supabase/functions/line-webhook/index.ts", import.meta.url), "utf8");
const shared = await readFile(new URL("../supabase/functions/_shared/line.ts", import.meta.url), "utf8");

test("L2 migration mirror is exact and sessions are private", () => {
  assert.equal(timestamped, migration);
  assert.match(migration, /create table if not exists public\.line_action_sessions/i);
  assert.match(migration, /alter table public\.line_action_sessions enable row level security/i);
  assert.match(migration, /revoke all on table public\.line_action_sessions from public,anon,authenticated/i);
  assert.match(migration, /grant select,insert,update,delete on table public\.line_action_sessions to service_role/i);
  assert.doesNotMatch(migration, /grant\s+all/i);
});

test("pending-list RPC rechecks active reviewer role and dispatch rules", () => {
  assert.match(migration, /actor\.is_active/);
  assert.match(migration, /actor\.role in \('admin','owner','founder'\)/i);
  assert.match(migration, /r\.requester_id<>p_actor/i);
  assert.match(migration, /can_review_dispatch_as\(p_actor,r\.requester_role\)/i);
  assert.match(migration, /limit 10/i);
  assert.match(migration, /grant execute on function public\.line_pending_dispatch_requests\(uuid\) to service_role/i);
});

test("postback payload contains only action and request id", () => {
  const parsed = JSON.parse(postbackData("approve", "123"));
  assert.deepEqual(parsed, { a: "approve", r: "123" });
  assert.deepEqual(Object.keys(parsed).sort(), ["a", "r"]);
});

test("pending Flex exposes full approve, reject and partial web actions", () => {
  const buttons = approvalButtons("00000000-0000-0000-0000-000000000001", "https://example.test/");
  assert.equal(buttons.length, 3);
  assert.equal(buttons[0].action.type, "postback");
  assert.equal(JSON.parse(buttons[0].action.data).a, "approve");
  assert.equal(JSON.parse(buttons[1].action.data).a, "reject");
  assert.equal(buttons[2].action.type, "uri");
  assert.match(buttons[2].action.uri, /tab=pending/);
});

test("approval requires a five-minute confirmation session", () => {
  assert.match(webhook, /Date\.now\(\) \+ 5 \* 60_000/);
  assert.match(webhook, /awaiting_confirmation/);
  assert.match(webhook, /\.gt\("expires_at", new Date\(\)\.toISOString\(\)\)/);
  assert.match(webhook, /approve_dispatch_request_as/);
  const flex = confirmationFlex({ id: "00000000-0000-0000-0000-000000000001", delivery_note_no: "TD-1" }, 2, 5);
  assert.match(JSON.stringify(flex), /ยืนยันอนุมัติ/);
  assert.match(JSON.stringify(flex), /5 นาที/);
});

test("rejection waits for a reason and uses the shared service RPC", () => {
  assert.match(webhook, /awaiting_reason/);
  assert.match(webhook, /กรุณาระบุเหตุผลอย่างน้อย 2 ตัวอักษร/);
  assert.match(webhook, /reject_dispatch_request_as/);
});

test("handled and concurrent requests return a readable status without raw errors", () => {
  assert.match(webhook, /คำขอนี้ถูก\$\{action\}แล้วโดย/);
  assert.match(webhook, /latest\.request\?\.status !== "pending"/);
  assert.doesNotMatch(webhook, /textMessage\([^)]*error\.message/);
});

test("waiting command replies with at most ten actionable requests", () => {
  assert.match(webhook, /text === "รออนุมัติ"/);
  assert.match(webhook, /line_pending_dispatch_requests/);
  const flex = pendingRequestsFlex([{ id: "1", delivery_note_no: "TD-1", line_count: 1, total_qty: 2 }], "https://example.test/");
  assert.equal(flex.contents.contents.length, 1);
  assert.match(JSON.stringify(flex), /TD-1/);
});

test("L2 uses replies only and does not add push, broadcast or multicast", () => {
  assert.match(webhook, /replyLine/);
  assert.doesNotMatch(webhook, /\/v2\/bot\/message\/push|broadcast|multicast/);
  assert.match(shared, /อนุมัติเต็มจำนวน/);
});
