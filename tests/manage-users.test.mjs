import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/manage-users/index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/m, "");

function makeFunction() {
  const staff = [
    { user_id: "c8ca56f6-28a1-4854-be30-fb99e3e26887", email: "founder@example.com", name: "Founder", role: "founder", is_active: true, created_at: "2026-09-24" },
    { user_id: "11111111-1111-4111-8111-111111111111", email: "editor@example.com", name: "Editor", role: "editor", is_active: true, created_at: "2026-09-24" },
  ];
  let invites = 0, handler;
  const builder = () => {
    let rowFilter = () => true;
    let patch;
    const chain = {
      select() { return chain; },
      eq(field, value) { const before = rowFilter; rowFilter = row => before(row) && row[field] === value; return chain; },
      order() { return Promise.resolve({ data: staff.filter(rowFilter), error: null }); },
      maybeSingle() { return Promise.resolve({ data: staff.find(rowFilter) || null, error: null }); },
      update(value) { patch = value; return chain; },
      insert(value) { const row = { ...value, created_at: "2026-09-24" }; staff.push(row); return { select: () => ({ single: async () => ({ data: row, error: null }) }) }; },
      single() { const row = staff.find(rowFilter); Object.assign(row, patch); return Promise.resolve({ data: row, error: null }); },
    };
    return chain;
  };
  const admin = {
    auth: {
      getUser: async token => token === "bad-token" ? { data: { user: null }, error: new Error("invalid") } : { data: { user: { id: token === "editor-token" ? staff[1].user_id : staff[0].user_id } }, error: null },
      admin: { inviteUserByEmail: async () => { invites++; return { data: { user: { id: "22222222-2222-4222-8222-222222222222" } }, error: null }; } },
    },
    from: () => builder(),
  };
  const Deno = { env: { get: key => key === "SUPABASE_URL" ? "https://example.supabase.co" : "test-secret" }, serve: fn => { handler = fn; } };
  new Function("createClient", "Deno", source)(() => admin, Deno);
  return { call: async (token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await handler(new Request("https://example.supabase.co/functions/v1/manage-users", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  }, staff, get invites() { return invites; } };
}

test("requires a verified active Founder before any user operation", async () => {
  const fn = makeFunction();
  assert.equal((await fn.call(null, { action: "list" })).status, 401);
  assert.equal((await fn.call("bad-token", { action: "list" })).status, 401);
  assert.equal((await fn.call("editor-token", { action: "list" })).status, 403);
  assert.equal(fn.invites, 0);
});

test("cannot create or modify Founder through the web API", async () => {
  const fn = makeFunction();
  assert.equal((await fn.call("founder-token", { action: "invite", email: "next@example.com", name: "Next", role: "founder" })).status, 400);
  assert.equal((await fn.call("founder-token", { action: "update", user_id: fn.staff[0].user_id, role: "viewer" })).status, 403);
  assert.equal(fn.staff[0].role, "founder");
  assert.equal(fn.invites, 0);
});

test("Founder can invite an Editor and change a member to Viewer", async () => {
  const fn = makeFunction();
  const invite = await fn.call("founder-token", { action: "invite", email: "new@example.com", name: "New", role: "editor" });
  assert.equal(invite.status, 201);
  assert.equal(fn.invites, 1);
  assert.equal(fn.staff[2].role, "editor");
  const update = await fn.call("founder-token", { action: "update", user_id: fn.staff[1].user_id, role: "viewer", is_active: false });
  assert.equal(update.status, 200);
  assert.equal(fn.staff[1].role, "viewer");
  assert.equal(fn.staff[1].is_active, false);
});
