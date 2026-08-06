"use client";

// ─────────────────────────────────────────────────────────────────────────────
// CountUp — a KPI number that rolls up to its value once, on mount.
//
// Adapted from React Bits' `CountUp` (reactbits.dev/text-animations/count-up)
// as ~40 lines of local code rather than a dependency: this app has THREE
// runtime deps (next/react/react-dom) and a decorative number roll is not a
// reason to make that four. Same idea, this repo's tokens and motion rules.
//
// Two things it must never do, both enforced below:
//  (1) Cause layout shift. The final formatted value is rendered as an
//      invisible ghost in the same grid cell, so the box is already the width
//      of "3,461" while the visible span still reads "412". CLS contribution
//      is zero by construction, not by measurement.
//  (2) Animate under `prefers-reduced-motion: reduce`. globals.css already
//      neutralises CSS animation/transition durations app-wide, but this is a
//      JS/rAF animation and that rule cannot reach it — so the final value is
//      committed immediately instead.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

/** `useLayoutEffect` warns when React renders on the server. Every consumer
 *  here is gated behind client-side fetched state, so the layout variant is
 *  what actually runs — but the isomorphic swap keeps the warning impossible
 *  if a future caller ever renders one of these during SSR. */
const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

function getReducedMotionSnapshot(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
    : false;
}

function subscribeToReducedMotion(onStoreChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (typeof mediaQuery.addEventListener === "function") {
    mediaQuery.addEventListener("change", onStoreChange);
    return () => mediaQuery.removeEventListener("change", onStoreChange);
  }
  mediaQuery.addListener(onStoreChange);
  return () => mediaQuery.removeListener(onStoreChange);
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeToReducedMotion, getReducedMotionSnapshot, () => false);
}

/** ease-out-quint — the "settles rather than stops" curve the rest of this
 *  wave uses for entrances (cubic-bezier(0.16, 1, 0.3, 1)'s scalar twin). */
function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

export interface CountUpProps {
  value: number;
  /** Formats BOTH the in-flight frames and the final value, so the ghost that
   *  reserves the width is formatted identically to what lands. */
  format?: (n: number) => string;
  durationMs?: number;
  className?: string;
}

export default function CountUp({ value, format, durationMs = 550, className }: CountUpProps) {
  const reduced = usePrefersReducedMotion();
  const fmt = format ?? ((n: number) => String(Math.round(n)));
  const [shown, setShown] = useState(value);
  const rafRef = useRef<number | null>(null);

  // Deps already gate this to a genuine value change — an extra "have I
  // animated to this number before?" ref is not just redundant, it BREAKS
  // under React StrictMode, whose dev-only mount -> cleanup -> mount cycle
  // cancels the first frame loop and then hits the guard on the re-run,
  // leaving every KPI frozen at 0. That is exactly what shipped for one
  // screenshot on 2026-07-29; do not reintroduce the guard.
  useIsomorphicLayoutEffect(() => {
    if (reduced) {
      setShown(value);
      return;
    }

    const from = 0;
    const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();
    setShown(from);

    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / durationMs);
      setShown(from + (value - from) * easeOutQuint(t));
      if (t < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [value, durationMs, reduced]);

  return (
    <span className={`grid tabular-nums ${className ?? ""}`}>
      {/* Width reservation — see header note (1). `invisible` keeps it in flow. */}
      <span className="col-start-1 row-start-1 invisible" aria-hidden="true">
        {fmt(value)}
      </span>
      {/* The live number is hidden from assistive tech mid-roll and the settled
          value is announced once, rather than ~35 intermediate numbers. */}
      <span className="col-start-1 row-start-1" aria-hidden="true">
        {fmt(shown)}
      </span>
      <span className="sr-only">{fmt(value)}</span>
    </span>
  );
}
