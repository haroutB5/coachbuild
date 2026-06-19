"use client";

import { useEffect } from "react";

// Registers the service worker with the current app version as a query param.
// When the version bumps, the registration URL changes → the browser installs a
// new SW → the version-tied cache rotates and stale caches are evicted.
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
