"use client";

import { useEffect, useState, useRef } from "react";
import { SW_UPDATE_DISMISSED_STORAGE_KEY, isUpdateDismissed } from "./swUpdateDismiss";

// Registers the service worker with the current app version as a query param.
// When the version bumps, the registration URL changes → the browser installs a
// new SW → the version-tied cache rotates and stale caches are evicted.
//
// v0.31.0 (SW update toast, Feature 4): sw.js's `install` handler used to call
// self.skipWaiting() unconditionally, so a new SW version activated (and took
// over fetches) silently — there was no "waiting" phase to hook a prompt onto.
// That call is now gated (see sw.js) so an UPDATE (a new SW installing while
// one is already active and controlling this page) follows the standard
// lifecycle: installing -> installed -> WAITING, parked until this component
// posts "SKIP_WAITING" — which only happens once the user taps the toast
// below. A first-ever install (no existing controller yet) is unaffected: the
// browser activates it immediately since there's nothing to wait for, so no
// toast appears on a fresh install.
// v0.51.1: dismiss persistence moved to localStorage, keyed to the specific
// waiting worker's scriptURL — see swUpdateDismiss.ts's header for the full
// rationale (sessionStorage was per-tab and unreliable across iOS PWA
// relaunches, which read to users as "the toast keeps re-appearing even
// though I'm already on the latest version"). During a heavy deploy day
// every new version still legitimately shows its own toast once; dismissing
// one version never suppresses a later, genuinely different one. The app is
// network-first, so a dismissed SW update just means slightly stale cached
// assets until the next natural load.

export default function ServiceWorkerRegister() {
  const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(null);
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null);
  const dismissed = isUpdateDismissed(dismissedVersion, waitingWorker?.scriptURL ?? null);

  // Hydrate the last-dismissed version from localStorage on mount (SSR-safe).
  useEffect(() => {
    try {
      setDismissedVersion(localStorage.getItem(SW_UPDATE_DISMISSED_STORAGE_KEY));
    } catch {
      /* localStorage unavailable (private mode / disabled) — just show the toast */
    }
  }, []);
  // Loop guard for the controllerchange -> reload below: controllerchange can
  // in principle fire more than once in a session (another tab could also
  // trigger the same skipWaiting), and a reload-on-every-fire would loop.
  const reloadedRef = useRef(false);
  // Audit P1 (2026-07-18): reload ONLY when THIS tab requested the update.
  // On a first-ever install (no prior controller) the fresh SW activates
  // immediately and clients.claim() flips the controller null->worker, firing
  // controllerchange — an unconditional reload would bounce every new visitor
  // seconds after first load. Cross-tab skipWaiting also lands here; those
  // tabs are network-first and degrade fine without a forced reload.
  const updateRequestedRef = useRef(false);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const v = process.env.NEXT_PUBLIC_APP_VERSION || "0";
    let cancelled = false;

    navigator.serviceWorker
      .register(`/sw.js?v=${v}`)
      .then((reg) => {
        if (cancelled) return;

        // A worker may already be sitting in "waiting" if it finished
        // installing before this effect ran (e.g. install completed in a
        // background tab, or a very fast install racing this fetch) —
        // surface the toast immediately rather than only on a live
        // updatefound event. `navigator.serviceWorker.controller` present
        // means this is a real update, not the very first install.
        if (reg.waiting && navigator.serviceWorker.controller) {
          setWaitingWorker(reg.waiting);
        }

        reg.addEventListener("updatefound", () => {
          const newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener("statechange", () => {
            if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
              setWaitingWorker(newWorker);
            }
          });
        });
      })
      .catch(() => {
        /* ignore registration failures (e.g. unsupported/insecure context) */
      });

    // Fires once the waiting worker actually takes control (after this
    // component posts SKIP_WAITING below, or from another tab doing the
    // same) — single, loop-guarded reload so the fresh SW's assets/cache
    // are actually in effect for this page. No mid-anything deferral: this
    // tab has no long-running state worth protecting from an unprompted
    // reload once the user has explicitly tapped "Refresh".
    function onControllerChange() {
      if (!updateRequestedRef.current) return;
      if (reloadedRef.current) return;
      reloadedRef.current = true;
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);

    return () => {
      cancelled = true;
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, []);

  if (!waitingWorker || dismissed) return null;

  function applyUpdate() {
    updateRequestedRef.current = true;
    waitingWorker?.postMessage("SKIP_WAITING");
  }

  function dismiss() {
    if (!waitingWorker) return;
    const { scriptURL } = waitingWorker;
    setDismissedVersion(scriptURL);
    try {
      localStorage.setItem(SW_UPDATE_DISMISSED_STORAGE_KEY, scriptURL);
    } catch {
      /* best-effort — the in-memory state already hides it this render */
    }
  }

  return (
    <div
      role="status"
      className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[200] flex items-center gap-3 bg-panel border border-line-gold rounded-xl px-4 py-2.5 shadow-[0_8px_24px_rgba(0,0,0,0.45)]"
    >
      <span className="text-[12.5px] text-txt font-medium">Update ready</span>
      <button
        type="button"
        onClick={applyUpdate}
        className="text-[12px] font-semibold text-bg bg-teal hover:bg-teal-hover rounded-lg px-3 py-1 transition-colors active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel"
      >
        Refresh
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss update notification"
        className="text-mut hover:text-txt text-[15px] leading-none px-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal focus-visible:ring-offset-2 focus-visible:ring-offset-panel rounded"
      >
        &times;
      </button>
    </div>
  );
}
