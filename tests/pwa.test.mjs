import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const manifest = JSON.parse(fs.readFileSync(new URL("../site.webmanifest", import.meta.url), "utf8"));
const source = fs.readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const pwa = fs.readFileSync(new URL("../pwa.js", import.meta.url), "utf8");

function pngSize(path) {
  const data = fs.readFileSync(new URL(path, import.meta.url));
  return [data.readUInt32BE(16), data.readUInt32BE(20)];
}

test("manifest is installable and points to correctly sized icons", () => {
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  const icons = new Map(manifest.icons.map(icon => [icon.sizes, icon]));
  assert.deepEqual(pngSize("../assets/app-icon-192.png"), [192, 192]);
  assert.deepEqual(pngSize("../assets/app-icon-512.png"), [512, 512]);
  assert.ok(icons.has("192x192"));
  assert.ok(icons.has("512x512"));
});

test("service worker bypasses Supabase and every cross-origin request", () => {
  const listeners = {};
  const context = {
    URL, Promise,
    self: {
      location: { origin: "https://stock.example" },
      addEventListener: (name, handler) => { listeners[name] = handler; },
      skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() }
    },
    caches: { match: () => Promise.resolve(null), open: () => Promise.resolve({ addAll: () => Promise.resolve(), put: () => Promise.resolve() }), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true) },
    fetch: () => Promise.resolve({ ok: true, type: "basic", clone() { return this; } })
  };
  vm.runInNewContext(source, context);
  for (const url of ["https://abc.supabase.co/rest/v1/items", "https://cdn.example/app.js", "https://stock.example/rest/v1/items"]) {
    let intercepted = false;
    listeners.fetch({ request: { url, method: "GET", mode: "cors" }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, `${url} must bypass cache`);
  }
  let intercepted = false;
  listeners.fetch({ request: { url: "https://stock.example/style.css?v=1", method: "GET", mode: "cors" }, respondWith: () => { intercepted = true; } });
  assert.equal(intercepted, true, "same-origin shell asset should use the cache strategy");
});

test("service worker versions its shell and removes older shell caches", () => {
  assert.match(source, /const CACHE_NAME = "sweeo-shell-v\d+"/);
  assert.match(source, /key\.startsWith\("sweeo-shell-"\).*key !== CACHE_NAME/);
  assert.match(source, /ignoreSearch:\s*true/);
  assert.match(pwa, /beforeinstallprompt/);
  assert.match(pwa, /navigator\.serviceWorker\.register\("\.\/sw\.js"/);
  for (const required of ["./index.html", "./style.css", "./app.js", "./pwa.js", "./site.webmanifest"]) assert.ok(source.includes(`"${required}"`), `${required} missing from shell`);
});
