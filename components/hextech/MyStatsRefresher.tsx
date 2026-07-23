"use client";

import { useEffect, useRef, useState } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// MyStatsRefresher — standalone client component, NOT wired into
// app/mystats/page.tsx yet (that file is owned by a concurrent global-nav
// redesign — see HANDOFF-engy.md for the exact one-line mounting
// instructions once that lands). On mount, fires ONE POST
// /api/mystats/refresh (lib/mystats/refresh.ts's server-side cooldown makes
// this safe even if the page remounts the component repeatedly across
// navigations) and shows a small "Updating…" pill for the duration of the
// request. Calls `onRefreshed()` only when the server actually found new
// games — the page is expected to re-fetch /api/mystats/summary in response.
// Renders nothing on skipped/error/accountUnresolved, by design (silent —
// this is a background nicety, not something that should ever show an error
// state to the user).
// ─────────────────────────────────────────────────────────────────────────────

export interface MyStatsRefresherProps {
  onRefreshed: () => void;
}

interface RefreshResponse {
  accountUnresolved?: boolean;
  refreshed?: boolean;
  skipped?: boolean;
  newGames?: number;
  latest?: string | null;
  error?: boolean;
}

export default function MyStatsRefresher({ onRefreshed }: MyStatsRefresherProps) {
  const [updating, setUpdating] = useState(false);
  // startedRef guards against firing the POST twice under React StrictMode's
  // dev-only double-invoke of effects (mount -> cleanup -> mount). mountedRef
  // is what actually gates applying the response -- it's flipped back to
  // true on the second (real) mount, so the in-flight fetch kicked off
  // during the first (StrictMode-discarded) mount still lands normally; it
  // only stays false permanently on a genuine unmount.
  const startedRef = useRef(false);
  const mountedRef = useRef(true);
  const onRefreshedRef = useRef(onRefreshed);
  onRefreshedRef.current = onRefreshed;

  useEffect(() => {
    mountedRef.current = true;
    if (!startedRef.current) {
      startedRef.current = true;
      setUpdating(true);
      fetch("/api/mystats/refresh", { method: "POST" })
        .then((res) => res.json())
        .then((data: RefreshResponse) => {
          if (!mountedRef.current) return;
          if (data.refreshed && (data.newGames ?? 0) > 0) {
            onRefreshedRef.current();
          }
          // skipped (cooldown) / error / accountUnresolved -- silent, per contract
        })
        .catch(() => {
          // network failure -- same silent contract as a server-reported error
        })
        .finally(() => {
          if (mountedRef.current) setUpdating(false);
        });
    }
    return () => {
      mountedRef.current = false;
    };
  }, []);

  if (!updating) return null;

  return (
    <span role="status" aria-live="polite" className="inline-flex items-center gap-1.5 text-[11px] font-medium text-mut">
      <span
        aria-hidden="true"
        className="h-2.5 w-2.5 rounded-full border-[1.5px] border-mut/40 border-t-mut animate-spin"
      />
      Updating…
    </span>
  );
}
