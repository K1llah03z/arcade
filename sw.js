/* NEON//GRID service worker — full offline support */
/* ── APP VERSION (semver) ─────────────────────────────────
   Bump this when you release, and keep it matching APP_VERSION
   in index.html:
     1.0.0 -> 1.0.1  PATCH  small fix / tweak
     1.0.x -> 1.1.0  MINOR  new feature or game added
     1.x.x -> 2.0.0  MAJOR  big redesign / breaking change
   Changing this string is what triggers the update banner. */
const APP_VERSION = "1.6.1";
/* ── RELEASE NOTES ────────────────────────────────────────
   Shown in the update banner. Keep 2-4 short lines; newest
   version only (users see the notes for the update they're
   about to install). Update these alongside APP_VERSION. */
const RELEASE_NOTES = [
  "Gem Drop: Flame Gem explosion now hits properly",
  "Gem Drop: music for every mode, streamed and cached",
  "Gem Drop: authentic Flame Gem fire and Star Gem flare",
];
const CACHE = "neon-grid-" + APP_VERSION;
const ASSETS = [
  "./",
  "./index.html",
  "./uno-audio.js",
  "./music.js",
  "./3DPinballSpaceCadet.htm",
  "./3DPinballSpaceCadet.js",
  "./3DPinballSpaceCadet.wasm",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-192.png",
  "./icons/icon-maskable-512.png",
  "./icons/icon-1024.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/favicon-64.png",
  "./music/blitz.mp3",
  "./music/butterfly.mp3",
  "./music/classic.mp3",
  "./music/icestorm.mp3",
  "./music/lose_blitz.mp3",
  "./music/lose_butterfly.mp3",
  "./music/lose_classic.mp3",
  "./music/lose_icestorm.mp3",
  "./music/lose_mine.mp3",
  "./music/lose_poker.mp3",
  "./music/menu.mp3",
  "./music/mine.mp3",
  "./music/poker.mp3",
  "./music/zen.mp3"
];
self.addEventListener("install", e => {
  /* addAll() rejects the whole install if a single file 404s, which would
     leave the app without an offline copy. Cache each asset on its own so a
     missing track can never sink the rest of the install. */
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(ASSETS.map(u =>
        c.add(new Request(u, { cache: "reload" }))
         .catch(err => console.warn("[sw] could not cache", u, err))
      )))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
/* Cache-first, falling back to network, then to cached index for navigations. */
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(hit => {
      if (hit) return hit;
      return fetch(e.request).then(res => {
        /* status 206 = partial content (audio seeking). Caching a partial
           response would poison the cache with a fragment of the track. */
        if (res && res.ok && res.status === 200 &&
            new URL(e.request.url).origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }).catch(() => {
        if (e.request.mode === "navigate") return caches.match("./index.html");
      });
    })
  );
});
self.addEventListener("message", e => {
  if (!e.data) return;
  if (e.data.type === "SKIP_WAITING") self.skipWaiting();
  if (e.data.type === "GET_VERSION" && e.ports[0]) e.ports[0].postMessage(APP_VERSION);
  if (e.data.type === "GET_INFO" && e.ports[0]) e.ports[0].postMessage({ version: APP_VERSION, notes: RELEASE_NOTES });
});
