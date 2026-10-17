// Offline shell.  Online: always the newest files from the site (and the
// cache refreshed with them).  Offline: the cached copy.  So an update
// shows up the first time the app is opened with a connection.
const VERSION = "avb-player-v104";
const FILES = ["./", "index.html", "styles.css", "app.js", "analysis-worker.js", "stretch-worker.js", "player-worklet.js",
  "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-192.png", "icons/maskable-512.png",
  "vendor/rubberband.esm.js", "vendor/rubberband.wasm", "encode-worker.js", "vendor/lame.min.js",
  "vendor/fonts/pjs-latin.woff2", "vendor/fonts/pjs-latin-ext.woff2"];

self.addEventListener("install", e => {
  // "reload": straight from the site, never the browser's HTTP cache (GitHub Pages keeps files 10 min)
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION && k !== "avb-inbox").map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const req = e.request;
  // Share -> AVB Player (Android's share sheet): keep the files in an inbox, open the player on them
  if (req.method === "POST" && new URL(req.url).pathname.endsWith("/share")) {
    e.respondWith((async () => {
      const form = await req.formData();
      const files = form.getAll("audio").filter(f => f && typeof f !== "string");
      const inbox = await caches.open("avb-inbox");
      let i = 0;
      for (const f of files) {
        await inbox.put(`inbox/${Date.now()}-${i++}`, new Response(f, { headers: {
          "Content-Type": f.type || "application/octet-stream", "X-Name": encodeURIComponent(f.name || "Shared song"),
          "X-Modified": String(f.lastModified || Date.now()) } }));
      }
      return Response.redirect("./?shared=" + files.length, 303);
    })());
    return;
  }
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(VERSION);
    try {
      const res = await fetch(req, { cache: "no-cache" });
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (_) {
      return (await cache.match(req, { ignoreSearch: true })) || (await cache.match("./")) || Response.error();
    }
  })());
});
