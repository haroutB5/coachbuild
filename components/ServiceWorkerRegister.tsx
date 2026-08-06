"use client";

import { useEffect } from "react";

// Registers the service worker with the current app version as a query param.
// When the version bumps, the registration URL changes → the browser installs a
// new SW → the version-tied cache rotates and stale caches are evicted.
//
// v0.101.0 — THE "UPDATE READY" TOAST IS GONE. It shipped in v0.31.0 (park the
// new worker in `waiting`, prompt, post SKIP_WAITING on tap) and was patched
// once in v0.51.1 for re-appearing at users who were already on the latest
// version. It kept re-appearing, for a reason no dismiss-persistence fix could
// reach: the toast rendered whenever a waiting worker existed, and a waiting
// worker exists until someone applies it. Ignore the toast rather than tapping
// Refresh or ✕, and every subsequent page load surfaced it again — several
// times per champ select, because the companion opens fresh tabs as the user
// hovers champions. Meanwhile the page itself was genuinely current: fetches
// are network-first, so the HTML, the chunks and the version in the footer all
// came from the newest deploy. The prompt was asking the user to update to what
// they were already looking at.
//
// sw.js now calls skipWaiting() on install again, so a new version activates by
// itself and rotates its cache. Nothing reloads the page: a forced reload
// mid-champ-select would re-fire the rune auto-export and stomp on rune edits
// the user just made in the client (the other half of this ship — see
// public/companion.ps1's ownership guard).
//
// This component is now registration only. It renders nothing.
export default function ServiceWorkerRegister() {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const v = process.env.NEXT_PUBLIC_APP_VERSION || "0";

    navigator.serviceWorker.register(`/sw.js?v=${v}`).catch(() => {
      /* ignore registration failures (e.g. unsupported/insecure context) */
    });
  }, []);

  return null;
}
