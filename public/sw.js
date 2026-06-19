/* CoachBuild service worker.
   The cache name is tied to the app version (passed as ?v=<version> on register),
   so every version bump creates a fresh cache and evicts the old one — installed
   PWAs never serve a stale UI. */
const VERSION = new URL(self.location).searchParams.get("v") || "0";
const CACHE = `coachbuild-v${VERSION}`;
const SHELL = ["/"];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("coachbuild-") && k !== CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Only handle same-origin requests; let the coachless CDN manage its own caching.
  if (url.origin !== self.location.origin) return;

  // Live build data: network-first (fresh ok responses only), offline fallback to cache.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // App shell / static assets: network-first so a redeploy always serves fresh
  // HTML + current chunk hashes; fall back to cache only when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
