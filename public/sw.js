/* CoachBuild service worker.
   The cache name is tied to the app version (passed as ?v=<version> on register),
   so every version bump creates a fresh cache and evicts the old one — installed
   PWAs never serve a stale UI. */
const VERSION = new URL(self.location).searchParams.get("v") || "0";
const CACHE = `coachbuild-v${VERSION}`;
const SHELL = ["/"];

// Icon/data CDN cache — deliberately NOT tied to VERSION above (its name
// never changes across a deploy) because coachless's static-files URLs are
// patch-versioned (.../static-files/16.13.1/...): a given URL's bytes never
// change, so a redeploy has no reason to evict already-cached icons the way
// the app-shell cache below does. Measured perf audit (v0.18.1, /history)
// found 2MB of repeat-visit icon waste with zero cross-origin caching.
const ICON_CACHE = "coachbuild-icons-v1";
const ICON_ORIGIN = "https://cdn.coachless.gg";
const ICON_PATH_PREFIX = "/static-files/";

self.addEventListener("install", (event) => {
  // v0.31.0 (SW update toast, Feature 4): this used to call self.skipWaiting()
  // unconditionally here, which meant a new SW version activated (and started
  // serving fetches) silently on every deploy — there was no "waiting" phase
  // for the client to detect and prompt on. Removed so an UPDATE (a new SW
  // installing while one is already active for this scope) follows the
  // standard lifecycle instead: installing -> installed -> WAITING, parked
  // until ServiceWorkerRegister.tsx explicitly posts "SKIP_WAITING" (only
  // once the user taps the toast — see the message listener below). A
  // first-ever install (no existing active worker for this scope) is
  // UNAFFECTED: the browser activates it immediately regardless, since
  // there's nothing to wait for.
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

// v0.31.0 (SW update toast, Feature 4): the client-side half of the
// standard "new version waiting, refresh to update" pattern — postMessage's
// payload is the plain string "SKIP_WAITING" (see ServiceWorkerRegister.tsx),
// matched loosely against the common {type:"SKIP_WAITING"} shape too in case
// a future caller (or browser devtools) sends that form instead.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING" || (event.data && event.data.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            // ICON_CACHE is intentionally excluded — see its declaration
            // comment above. Without this it'd match "coachbuild-" and get
            // wiped on every version bump along with the old shell cache,
            // defeating the whole point of decoupling it from VERSION.
            .filter((k) => k.startsWith("coachbuild-") && k !== CACHE && k !== ICON_CACHE)
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

  // Live companion script + version file: never intercepted by the SW, never
  // precached, never cached. The companion self-updates by fetching
  // /companion.version on launch and /live-setup always needs the freshest
  // .ps1 -- vercel.json sets no-store on both at the HTTP layer already,
  // this is belt-and-suspenders so a stale SW build can never shadow them.
  if (url.origin === self.location.origin && (url.pathname === "/companion.ps1" || url.pathname === "/companion.version")) {
    return;
  }

  // Icon/data CDN: cache-first. These URLs are patch-versioned
  // (immutable — the same URL never serves different bytes), so there's
  // nothing to revalidate; a cache hit is always correct and skips the
  // network entirely on repeat visits.
  if (url.origin === ICON_ORIGIN && url.pathname.startsWith(ICON_PATH_PREFIX)) {
    event.respondWith(
      caches.open(ICON_CACHE).then(async (cache) => {
        const cached = await cache.match(req);
        if (cached) return cached;
        try {
          const res = await fetch(req);
          // <img src> cross-origin requests are "no-cors" by default, so a
          // successful fetch comes back as an opaque response (type
          // "opaque", status 0, `ok` false) — there's no way to distinguish
          // an opaque 200 from an opaque 403/404 from inside the SW, so this
          // caches any opaque response same as an explicit `res.ok`. Worst
          // case (a genuinely broken icon URL gets cached) is unchanged
          // UX-wise: the browser still fails to decode it as an image and
          // IconWithFallback's onError still swaps in the fallback glyph —
          // it just no longer re-hits the network to fail the same way
          // twice. Deliberately unbounded/no LRU — icons are a few KB each
          // and the URL space is naturally capped by how many
          // champs/items/runes/patches a user actually views; revisit if
          // storage quota ever becomes a real complaint.
          if (res.ok || res.type === "opaque") {
            cache.put(req, res.clone());
          }
          return res;
        } catch {
          // Offline with no cache entry — let the <img> tag's own onError
          // fallback (IconWithFallback) handle it, same as it does today.
          return Response.error();
        }
      })
    );
    return;
  }

  // Only handle same-origin requests for everything else; let other
  // cross-origin CDNs manage their own caching.
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
