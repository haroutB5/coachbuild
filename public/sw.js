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
  // v0.101.0 — skipWaiting is BACK, and the "Update ready" toast is gone with
  // it. History, so this doesn't get flip-flopped a third time:
  //
  // v0.31.0 removed this call so a new SW would park in WAITING and a toast
  // could offer "Refresh". v0.51.1 then had to fix that toast re-appearing
  // for users already on the latest version. It re-appeared anyway, because
  // the toast only ever hides for a version the user explicitly DISMISSES:
  // ignore it once and every later page load re-reads the still-waiting
  // worker and shows it again. The companion opens fresh tabs all through a
  // champ select, so "every later page load" meant several times a game —
  // while the page footer, served network-first, correctly showed the newest
  // version the whole time. Nagging someone to update to what they are
  // already reading is the definition of a false alarm.
  //
  // The prompt bought nothing anyway: fetches are network-first (see below),
  // so the app is never serving a stale UI regardless of which SW is active.
  // The only thing gated behind activation was the version-tied cache
  // rotation in `activate`, which nobody needs to consent to. So: activate
  // immediately, rotate the cache, and let the user carry on. Nothing
  // force-reloads the page either — a surprise reload mid-champ-select would
  // re-fire the rune auto-export, which is its own reported bug.
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {}))
  );
});

// Kept after the v0.101.0 toast removal even though nothing in the app posts
// this any more: a worker installed by an OLDER build can still be sitting in
// waiting on a returning user's device, and this is the one message that
// releases it. Harmless otherwise — skipWaiting() on an already-active worker
// is a no-op. Also the shape browser devtools sends.
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
            // Un-awaited on purpose (the response must not wait on the write),
            // which means a rejection has nowhere to go: on quota exhaustion
            // this throws an unhandled rejection inside the SW. Swallow it —
            // a failed icon cache write is not worth surfacing, and this cache
            // is deliberately unbounded (see above), so quota is its expected
            // long-run failure mode rather than a surprise.
            cache.put(req, res.clone()).catch(() => {});
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

  // The SW must honour `Cache-Control: no-store`, or it silently re-introduces
  // at the client exactly what the server set the header to prevent. Two real
  // cases, both live before this guard existed:
  //   - /api/mystats/* is `no-store` because it is PRIVATE (Riot ID, per-game
  //     KDA, champion pool). The SW was writing it verbatim into CacheStorage
  //     on disk, where it survived until the next version bump evicted it.
  //   - degraded/empty responses are deliberately `no-store` per gotcha (b) so
  //     a transient upstream glitch can't get pinned. The SW pinned them anyway
  //     and replayed them offline.
  // Checked here rather than by URL prefix so the header stays the single
  // source of truth: a future `no-store` route is covered without touching this.
  const isCacheable = (res) =>
    res.ok && !(res.headers.get("cache-control") || "").includes("no-store");

  // Live build data: network-first (fresh ok responses only), offline fallback to cache.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (isCacheable(res)) {
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
        if (isCacheable(res)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req))
  );
});
