// Service Worker — App-Dateien für schnellen Start zwischenspeichern
const CACHE = "pg-v1";
const SHELL = [
  ".",
  "index.html",
  "css/style.css",
  "js/app.js",
  "js/store.js",
  "js/nlu.js",
  "js/drive.js",
  "js/speech.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// App-Dateien: erst Netz (damit Updates ankommen), bei Offline aus dem Cache.
// API-Aufrufe (Google, Anthropic) gehen immer direkt ins Netz.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        const copy = resp.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return resp;
      })
      .catch(() => caches.match(e.request))
  );
});
