/* SWEEO offline shell. Production data and authentication requests bypass caches. */
const CACHE_NAME = "sweeo-shell-v2";
const SHELL = [
  "./", "./index.html", "./style.css", "./theme.js", "./pwa.js", "./app.js", "./realtime-lifecycle.js",
  "./i18n.js", "./i18n-zh-TW.js", "./delivery-note.js", "./scanner.js",
  "./site.webmanifest", "./assets/sweeo-logo.png", "./assets/app-icon-192.png",
  "./assets/app-icon-512.png", "./assets/apple-touch-icon.png"
];

self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("sweeo-shell-") && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

function isProductionData(url) {
  return url.hostname.endsWith(".supabase.co") || /\/(rest|auth|functions|realtime|storage)\/v\d\//.test(url.pathname);
}

self.addEventListener("fetch", event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== self.location.origin || isProductionData(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) caches.open(CACHE_NAME).then(cache => cache.put("./index.html", response.clone()));
      return response;
    }).catch(() => caches.match("./index.html", { ignoreSearch: true })));
    return;
  }

  event.respondWith(caches.match(request, { ignoreSearch: true }).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === "basic") caches.open(CACHE_NAME).then(cache => cache.put(request, response.clone()));
    return response;
  })));
});
