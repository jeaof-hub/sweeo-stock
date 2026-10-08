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

test("service worker keeps the offline shell without relying on cache version changes", () => {
  assert.match(source, /const CACHE_NAME = "sweeo-shell-v\d+"/);
  assert.match(source, /key\.startsWith\("sweeo-shell-"\).*key !== CACHE_NAME/);
  assert.doesNotMatch(source, /ignoreSearch/);
  assert.match(source, /upgradingLegacyWorker[\s\S]{0,200}skipWaiting/);
  assert.match(source, /cache\.delete\(LEGACY_PWA_KEY\)/);
  assert.match(source, /event\.data\?\.type === "SKIP_WAITING"/);
  assert.match(pwa, /beforeinstallprompt/);
  assert.match(pwa, /navigator\.serviceWorker\.register\("\.\/sw\.js"/);
  assert.match(pwa, /registration\.waiting/);
  assert.match(pwa, /updatefound/);
  assert.match(pwa, /controllerchange/);
  assert.match(pwa, /SKIP_WAITING/);
  for (const required of ["./index.html", "./style.css?v=delivery-overlay-1", "./app.js?v=delivery-overlay-1", "./delivery-note.js?v=table-border-1", "./pwa.js?v=1", "./site.webmanifest"]) assert.ok(source.includes(`"${required}"`), `${required} missing from shell`);
  assert.match(source, /const CACHE_NAME = "sweeo-shell-v5"/);
  assert.ok(source.includes('"./delivery-pdf.js?v=1"'));
});

function createWorkerHarness(fetchImpl, cached = new Map()) {
  const listeners = {};
  const puts = [];
  const cache = {
    addAll: () => Promise.resolve(),
    put: (key, value) => { puts.push([typeof key === "string" ? key : key.url, value]); cached.set(typeof key === "string" ? key : key.url, value); return Promise.resolve(); }
  };
  const context = {
    URL, Request, Promise,
    self: {
      location: { origin: "https://stock.example" },
      addEventListener: (name, handler) => { listeners[name] = handler; },
      skipWaiting: () => Promise.resolve(), clients: { claim: () => Promise.resolve() }
    },
    caches: {
      match: key => Promise.resolve(cached.get(typeof key === "string" ? key : key.url)),
      open: () => Promise.resolve(cache), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true)
    },
    fetch: fetchImpl
  };
  vm.runInNewContext(source, context);
  return { listeners, puts };
}

async function dispatchFetch(handler, request) {
  let responsePromise;
  const background = [];
  handler({ request, respondWith: value => { responsePromise = value; }, waitUntil: value => background.push(value) });
  const response = await responsePromise;
  await Promise.all(background);
  return response;
}

test("same-origin app files are network-first and query versions use distinct cache keys", async () => {
  let revision = "server-v2";
  const { listeners, puts } = createWorkerHarness(async request => ({ ok: true, type: "basic", body: revision, clone() { return { ...this }; } }));
  const first = await dispatchFetch(listeners.fetch, new Request("https://stock.example/app.js?v=old"));
  assert.equal(first.body, "server-v2");
  revision = "server-v3";
  const second = await dispatchFetch(listeners.fetch, new Request("https://stock.example/app.js?v=new"));
  assert.equal(second.body, "server-v3");
  assert.deepEqual(puts.map(([key]) => key), ["https://stock.example/app.js?v=old", "https://stock.example/app.js?v=new"]);
});

test("offline app launch falls back to cached HTML and versioned assets", async () => {
  const cached = new Map([
    ["./index.html", { body: "offline-shell" }],
    ["https://stock.example/app.js?v=current", { body: "offline-js" }]
  ]);
  const { listeners } = createWorkerHarness(async () => { throw new Error("offline"); }, cached);
  const page = await dispatchFetch(listeners.fetch, { url: "https://stock.example/anything", method: "GET", mode: "navigate" });
  const script = await dispatchFetch(listeners.fetch, new Request("https://stock.example/app.js?v=current"));
  assert.equal(page.body, "offline-shell");
  assert.equal(script.body, "offline-js");
});
