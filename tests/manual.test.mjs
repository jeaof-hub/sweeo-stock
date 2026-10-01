import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const migration = fs.readFileSync(new URL("../supabase/22_app_manual.sql", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");
const source = fs.readFileSync(new URL("../manual.js", import.meta.url), "utf8");

test("manual table cannot be selected directly by browser roles", () => {
  assert.match(migration, /enable row level security/i);
  assert.match(migration, /revoke all on table public\.app_manual_sections from public, anon, authenticated/i);
  assert.doesNotMatch(migration, /create policy/i);
  assert.match(migration, /grant select, insert, update, delete on table public\.app_manual_sections to service_role/i);
});

test("get_manual derives the active role and exposes only role-listed sections", () => {
  assert.match(migration, /security definer/i);
  assert.match(migration, /s\.user_id = auth\.uid\(\) and s\.is_active/i);
  assert.match(migration, /'visitor'/i);
  assert.match(migration, /c\.caller_role = any\(m\.roles\)/i);
  assert.match(migration, /grant execute on function public\.get_manual\(text\) to anon, authenticated/i);
});

test("unsupported languages fall back to Thai and report fallback", () => {
  assert.match(migration, /p_lang in \('th','zh-TW'\) then p_lang else 'th'/i);
  assert.match(migration, /used_fallback/i);
});

test("manual rendering always passes marked output through DOMPurify", () => {
  const context = { window: {} };
  vm.runInNewContext(source, context);
  let received = "";
  const result = context.window.SWEEO_MANUAL.safeMarkdown("unsafe", { parse: () => '<script>alert(1)</script><img src=x onerror=alert(2)>' }, {
    sanitize(value) { received = value; return "SANITIZED"; }
  });
  assert.match(received, /script/);
  assert.equal(result, "SANITIZED");
  assert.match(source, /FORBID_TAGS/);
  assert.match(source, /FORBID_ATTR/);
});

test("manual dependencies are pinned and content is not cached by the service worker", () => {
  assert.match(html, /marked\/12\.0\.2\/marked\.min\.js/);
  assert.match(html, /dompurify\/3\.1\.6\/purify\.min\.js/);
  const sw = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
  assert.ok(sw.includes('"./manual.js?v=1"'));
  assert.doesNotMatch(sw, /app_manual_sections|body_md/);
});

test("private manual phrases are absent from every public source file", () => {
  const root = new URL("..", import.meta.url);
  const phrases = [
    ["บัญชีผู้ก่อตั้ง", "แก้ไขผ่านแอปไม่ได้"].join(""),
    ["擁有者無法看到", "或修改創辦人帳號"].join(""),
    ["ผู้บริหาร", "ดูภาพรวม"].join("")
  ];
  const skip = new Set([".git", "node_modules"]);
  function walk(url) {
    const out = [];
    for (const entry of fs.readdirSync(url, { withFileTypes: true })) {
      if (skip.has(entry.name)) continue;
      const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
      if (entry.isDirectory()) out.push(...walk(child));
      else if (/\.(?:js|mjs|html|css|md|sql|json|ts)$/.test(entry.name)) out.push(child);
    }
    return out;
  }
  for (const file of walk(root)) {
    const value = fs.readFileSync(file, "utf8");
    for (const phrase of phrases) assert.equal(value.includes(phrase), false, `${file.pathname} exposes manual content`);
  }
});
