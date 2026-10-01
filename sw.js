/* SWEEO offline shell. Production data and authentication requests bypass caches. */
const CACHE_NAME = "sweeo-shell-v2";
const SHELL = [
  "./", "./index.html", "./style.css?v=realtime-1", "./theme.js?v=zh-TW-1", "./pwa.js?v=1", "./app.js?v=realtime-1",
  "./realtime-lifecycle.js?v=1", "./i18n.js?v=realtime-1", "./i18n-zh-TW.js?v=realtime-1",
  "./delivery-note.js?v=zh-TW-1", "./scanner.js?v=phase-5-3", "./config.js",
  "./site.webmanifest", "./assets/sweeo-logo.png", "./assets/app-icon-192.png",
  "./assets/app-icon-512.png", "./assets/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("sweeo-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

function isProductionData(url) {
  return url.hostname.endsWith(".supabase.co") || /\/(rest|auth|functions|realtime|storage)\/v\d\//.test(url.pathname);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isProductionData(url)) return;

  event.respondWith(fetch(request).then(response => {
    if (response.ok && response.type === "basic") {
      const cacheKey = request.mode === "navigate" ? new Request("./index.html") : request;
      event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, response.clone())));
    }
    return response;
  }).catch(async () => {
    if (request.mode === "navigate") return caches.match("./index.html");
    return caches.match(request);
  }));
});
