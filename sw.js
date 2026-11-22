// Keeps a copy of the app on the phone so it opens instantly and works offline.
const VERSION = "9199fbb696"; // replaced by publish.sh each time the app is updated
const CACHE = "recipe-booklet-" + VERSION;
const FILES = [
  "./", "index.html", "style.css", "app.js", "engine.js", "manifest.json",
  "icons/apple-touch-icon.png", "icons/icon-192.png", "icons/icon-512.png",
  "vendor/pdf-lib.min.js", "vendor/pdf.min.js", "vendor/pdf.worker.min.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
