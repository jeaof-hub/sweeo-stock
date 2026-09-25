import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../supabase/functions/login-username/index.ts", import.meta.url), "utf8")
  .replace(/^import .*;\n/m, "");

function makeFunction() {
  const users = [
    { username: "aof", email: "aof@example.com", is_active: true },
    { username: "disabled", email: "disabled@example.com", is_active: false },
  ];
  let handler, passwordChecks = 0, limitChecks = 0, allow = true;
  const createClient = (_, key) => key === "service-key"
    ? {
      rpc: async () => { limitChecks++; return { data: allow, error: null }; },
      from: () => ({ select: () => ({ eq: (_, username) => ({ maybeSingle: async () => ({ data: users.find(u => u.username === username) || null, error: null }) }) }) }),
    }
    : { auth: { signInWithPassword: async ({ email, password }) => {
      passwordChecks++;
      if (email === "aof@example.com" && password === "CorrectPassword1!") return { data: { session: { access_token: "access", refresh_token: "refresh" } }, error: null };
      return { data: null, error: new Error("Invalid login credentials") };
    } } };
  const Deno = { env: { get: key => ({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key", SUPABASE_ANON_KEY: "anon-key" })[key] }, serve: fn => { handler = fn; } };
  new Function("createClient", "Deno", source)(createClient, Deno);
  return {
    call: async body => {
      const response = await handler(new Request("https://example.supabase.co/functions/v1/login-username", { method: "POST", body: JSON.stringify(body) }));
      return { status: response.status, body: await response.json() };
    },
    get passwordChecks() { return passwordChecks; },
    get limitChecks() { return limitChecks; },
    block() { allow = false; },
  };
}

test("username login uses the existing password and returns only session tokens", async () => {
  const fn = makeFunction();
  const result = await fn.call({ username: "AOF", password: "CorrectPassword1!" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { access_token: "access", refresh_token: "refresh" });
  assert.equal(fn.passwordChecks, 1);
  assert.equal(fn.limitChecks, 1);
});

test("rate limiting happens before username validation and account lookup", async () => {
  const fn = makeFunction();
  fn.block();
  const result = await fn.call({ username: "not valid!", password: "WrongPassword1!" });
  assert.equal(result.status, 429);
  assert.equal(fn.limitChecks, 1);
  assert.equal(fn.passwordChecks, 0);
});

test("unknown, disabled and wrong-password attempts share a generic error", async () => {
  const fn = makeFunction();
  for (const [username, password] of [["missing", "CorrectPassword1!"], ["disabled", "CorrectPassword1!"], ["aof", "WrongPassword1!"]]) {
    const result = await fn.call({ username, password });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
    assert.equal(JSON.stringify(result.body).includes("@"), false);
  }
  assert.equal(fn.passwordChecks, 3);
  assert.equal(fn.limitChecks, 3);
});
