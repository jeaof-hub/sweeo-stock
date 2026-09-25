import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/manage-users/index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/m, "");

function makeFunction() {
  const staff = [
    { user_id: "c8ca56f6-28a1-4854-be30-fb99e3e26887", email: "founder@example.com", username: "founder", name: "Founder", role: "founder", is_active: true, created_at: "2026-09-24" },
    { user_id: "11111111-1111-4111-8111-111111111111", email: "warehouse@example.com", username: "warehouse", name: "Warehouse", role: "warehouse", is_active: true, created_at: "2026-09-24" },
    { user_id: "33333333-3333-4333-8333-333333333333", email: "owner@example.com", username: "owner", name: "Owner", role: "owner", is_active: true, created_at: "2026-09-24" },
  ];
  let creates = 0, passwordChanges = 0, deletes = 0, createdAuthOptions, handler;
  const builder = () => {
    let rowFilter = () => true;
    let patch;
    const chain = {
      select() { return chain; },
      eq(field, value) { const before = rowFilter; rowFilter = row => before(row) && row[field] === value; return chain; },
      neq(field, value) { const before = rowFilter; rowFilter = row => before(row) && row[field] !== value; return chain; },
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
      getUser: async token => token === "bad-token" ? { data: { user: null }, error: new Error("invalid") } : { data: { user: { id: token === "warehouse-token" ? staff[1].user_id : token === "owner-token" ? staff[2].user_id : staff[0].user_id } }, error: null },
      admin: {
        createUser: async options => { creates++; createdAuthOptions = options; return { data: { user: { id: "22222222-2222-4222-8222-222222222222" } }, error: null }; },
        updateUserById: async () => { passwordChanges++; return { data: {}, error: null }; },
        deleteUser: async () => { deletes++; return { data: {}, error: null }; },
      },
    },
    from: () => builder(),
  };
  const Deno = { env: { get: key => key === "SUPABASE_URL" ? "https://example.supabase.co" : "test-secret" }, serve: fn => { handler = fn; } };
  new Function("createClient", "Deno", source)(() => admin, Deno);
  return { call: async (token, body) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const response = await handler(new Request("https://example.supabase.co/functions/v1/manage-users", { method: "POST", headers, body: JSON.stringify(body) }));
    return { status: response.status, body: await response.json() };
  }, staff, get creates() { return creates; }, get passwordChanges() { return passwordChanges; }, get deletes() { return deletes; }, get createdAuthOptions() { return createdAuthOptions; } };
}

test("requires a verified active Founder or Owner before any user operation", async () => {
  const fn = makeFunction();
  assert.equal((await fn.call(null, { action: "list" })).status, 401);
  assert.equal((await fn.call("bad-token", { action: "list" })).status, 401);
  assert.equal((await fn.call("warehouse-token", { action: "list" })).status, 403);
  assert.equal((await fn.call("warehouse-token", { action: "create", email: "x@example.com", name: "X", role: "warehouse", password: "LongPassword1!" })).status, 403);
  assert.equal((await fn.call("warehouse-token", { action: "set_password", user_id: fn.staff[0].user_id, password: "LongPassword1!" })).status, 403);
  assert.equal(fn.creates, 0);
});

test("cannot create or modify Founder through the web API", async () => {
  const fn = makeFunction();
  assert.equal((await fn.call("founder-token", { action: "create", email: "next@example.com", name: "Next", role: "founder", password: "LongPassword1!" })).status, 400);
  assert.equal((await fn.call("founder-token", { action: "update", user_id: fn.staff[0].user_id, role: "auditor" })).status, 403);
  assert.equal((await fn.call("owner-token", { action: "update", user_id: fn.staff[0].user_id, role: "auditor" })).status, 404);
  assert.equal((await fn.call("owner-token", { action: "set_password", user_id: fn.staff[0].user_id, password: "AnotherPassword1!" })).status, 404);
  assert.equal((await fn.call("founder-token", { action: "set_password", user_id: fn.staff[0].user_id, password: "AnotherPassword1!" })).status, 403);
  assert.equal(fn.staff[0].role, "founder");
  assert.equal(fn.creates, 0);
  assert.equal(fn.passwordChanges, 0);
});

test("Founder creates a Warehouse member without email and can set a member password", async () => {
  const fn = makeFunction();
  const created = await fn.call("founder-token", { action: "create", email: "new@example.com", username: "new-user", name: "New", role: "warehouse", password: "LongPassword1!" });
  assert.equal(created.status, 201);
  assert.equal(fn.creates, 1);
  assert.equal(fn.createdAuthOptions.email_confirm, true);
  assert.equal(fn.createdAuthOptions.password, "LongPassword1!");
  assert.equal(created.body.password, undefined);
  assert.equal((await fn.call("founder-token", { action: "create", email: "short@example.com", name: "Short", role: "warehouse", password: "short" })).status, 400);
  assert.equal((await fn.call("founder-token", { action: "create", email: "legacy@example.com", name: "Legacy", role: "editor", password: "LongPassword1!" })).status, 400);
  assert.equal(fn.staff[3].role, "warehouse");
  assert.equal(fn.staff[3].username, "new-user");
  const pw = await fn.call("founder-token", { action: "set_password", user_id: fn.staff[1].user_id, password: "AnotherPassword1!" });
  assert.equal(pw.status, 200);
  assert.equal(fn.passwordChanges, 1);
  assert.equal(pw.body.password, undefined);
  const update = await fn.call("founder-token", { action: "update", user_id: fn.staff[1].user_id, username: "auditor-one", role: "auditor", is_active: false });
  assert.equal(update.status, 200);
  assert.equal(fn.staff[1].role, "auditor");
  assert.equal(fn.staff[1].is_active, false);
  assert.equal(fn.staff[1].username, "auditor-one");
});

test("Founder may grant Admin and Owner access but cannot grant Founder access", async () => {
  const fn = makeFunction();
  const update = await fn.call("founder-token", { action: "update", user_id: fn.staff[1].user_id, role: "admin" });
  assert.equal(update.status, 200);
  assert.equal(fn.staff[1].role, "admin");
  assert.equal((await fn.call("founder-token", { action: "update", user_id: fn.staff[1].user_id, role: "owner" })).status, 200);
  assert.equal(fn.staff[1].role, "owner");
  assert.equal((await fn.call("founder-token", { action: "update", user_id: fn.staff[1].user_id, role: "founder" })).status, 400);
});

test("Owner manages non-Founder accounts and cannot create Founder", async () => {
  const fn = makeFunction();
  const listed = await fn.call("owner-token", { action: "list" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.users.some(user => user.role === "founder"), false);
  assert.equal((await fn.call("owner-token", { action: "create", email: "auditor@example.com", username: "auditor", name: "Auditor", role: "auditor", password: "LongPassword1!" })).status, 201);
  assert.equal((await fn.call("owner-token", { action: "update", user_id: fn.staff[1].user_id, role: "admin" })).status, 200);
  assert.equal((await fn.call("owner-token", { action: "set_password", user_id: fn.staff[1].user_id, password: "AnotherPassword1!" })).status, 200);
  assert.equal((await fn.call("owner-token", { action: "create", email: "another@example.com", name: "Another", role: "founder", password: "LongPassword1!" })).status, 400);
});

test("Founder list includes the immutable Founder account", async () => {
  const fn = makeFunction();
  const listed = await fn.call("founder-token", { action: "list" });
  assert.equal(listed.status, 200);
  assert.equal(listed.body.users.filter(user => user.role === "founder").length, 1);
});

test("duplicate and invalid usernames are rejected before Auth user creation", async () => {
  const fn = makeFunction();
  const duplicate = await fn.call("founder-token", { action: "create", email: "other@example.com", username: "warehouse", name: "Other", role: "warehouse", password: "LongPassword1!" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error, "ชื่อผู้ใช้นี้มีบัญชีแล้ว");
  const invalid = await fn.call("founder-token", { action: "create", email: "invalid@example.com", username: "bad name", name: "Invalid", role: "warehouse", password: "LongPassword1!" });
  assert.equal(invalid.status, 400);
  assert.equal(fn.creates, 0);
});
